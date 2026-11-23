import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  AcpDeferredToolObserver,
  AcpDeferredToolObserverContext,
  AcpToolCallSnapshot,
} from "@getpaseo/plugin/server/acp";

const PRIMARY_TRANSCRIPT_FILENAME = "transcript_full.jsonl";
const FALLBACK_TRANSCRIPT_FILENAME = "transcript.jsonl";
const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_RECONCILE_INTERVAL_MS = 1_000;
const MAX_RETIRED_TASK_IDS = 4_096;
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BACKGROUND_TASK_START =
  /^Created At:[^\n]*\nTool is running as a background task with task id: (\S+)\nTask Description: ([\s\S]*)$/;
const TASK_LOGS_MARKER = "\nTask logs are available at: ";
const GENERIC_TASK_CANCELLED =
  /^Created At:[^\n]*\n(?:Completed At:[^\n]*\n)?Task "([^"]+)" cancelled\.\s*$/;
const SYSTEM_TASK_ENDED = /content=Task id "([^"]+)" (was canceled|finished|failed) with result:/g;

interface TranscriptSource {
  logsDir: string;
  path: string;
  isFallback: boolean;
  dev: number;
  ino: number;
  offset: number;
}

interface ResolvedTranscriptSource {
  source: TranscriptSource;
  size: number;
}

export interface AntigravityBackgroundTaskObserverOptions {
  brainRoots?: readonly string[];
  reconcileIntervalMs?: number;
}

function defaultBrainRoots(): readonly string[] {
  const home = homedir();
  return [
    path.join(home, ".gemini", "antigravity-acp", "brain"),
    path.join(home, ".gemini", "antigravity-cli", "brain"),
    path.join(home, ".gemini", "antigravity", "brain"),
  ];
}

function normalizeCommand(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function isObservedExecuteTool(toolCall: AcpToolCallSnapshot): boolean {
  if (toolCall.kind === "execute" || toolCall.name === "run_command") return true;
  const input = toolCall.input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return typeof input.CommandLine === "string" || typeof input.command_line === "string";
  }
  return false;
}

function extractCommand(toolCall: AcpToolCallSnapshot): string | undefined {
  const input = toolCall.input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    let raw: string | undefined;
    if (typeof input.command_line === "string") raw = input.command_line;
    else if (typeof input.CommandLine === "string") raw = input.CommandLine;
    if (raw !== undefined) {
      const normalized = normalizeCommand(raw);
      return normalized.length > 0 ? normalized : undefined;
    }
  }
  if (toolCall.kind === "execute" || toolCall.name === "run_command") {
    const normalized = normalizeCommand(toolCall.title);
    return normalized.length > 0 ? normalized : undefined;
  }
  return undefined;
}

function hasTaskLifecycleMarker(line: string): boolean {
  return (
    line.includes("background task with task id:") ||
    line.includes("cancelled.") ||
    line.includes("was canceled with result:") ||
    line.includes("finished with result:") ||
    line.includes("failed with result:")
  );
}

async function statFile(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info : undefined;
  } catch {
    return undefined;
  }
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Observes Antigravity conversation transcripts asynchronously so backgrounded `run_command`
 * calls canceled via `manage_task(Action="kill")` are terminated cleanly even though
 * Antigravity ACP 1.5.0 emits no `tool_call_update` for them.
 */
export function createAntigravityBackgroundTaskObserver(
  context: AcpDeferredToolObserverContext,
  options?: AntigravityBackgroundTaskObserverOptions,
): AcpDeferredToolObserver {
  const brainRoots = options?.brainRoots ?? defaultBrainRoots();
  const reconcileIntervalMs = Math.max(
    10,
    options?.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
  );
  const conversationId = SAFE_CONVERSATION_ID.test(context.nativeSessionId)
    ? context.nativeSessionId
    : undefined;

  let disposed = false;
  let reconciling = false;
  let source: TranscriptSource | null = null;
  let watcher: FSWatcher | null = null;
  let watchedLogsDir: string | null = null;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let activePass: Promise<void> | null = null;
  let retryScheduled = false;

  const activeTasks = new Map<string, string>();
  const knownTasks = new Map<string, string>();
  const unclaimedCanceledTasks = new Map<string, string>();
  const retiredTaskIds = new Set<string>();

  function observedOpenTools(): AcpToolCallSnapshot[] {
    return context.openToolCalls().filter(isObservedExecuteTool);
  }

  function retireTaskId(taskId: string): void {
    if (retiredTaskIds.has(taskId)) return;
    if (retiredTaskIds.size >= MAX_RETIRED_TASK_IDS) {
      const oldest = retiredTaskIds.values().next().value;
      if (oldest !== undefined) retiredTaskIds.delete(oldest);
    }
    retiredTaskIds.add(taskId);
  }

  function resetParsedSourceState(): void {
    activeTasks.clear();
    knownTasks.clear();
    unclaimedCanceledTasks.clear();
  }

  function retireAllTrackedTasks(): void {
    for (const taskId of activeTasks.keys()) retireTaskId(taskId);
    for (const taskId of knownTasks.keys()) retireTaskId(taskId);
    for (const taskId of unclaimedCanceledTasks.keys()) retireTaskId(taskId);
    resetParsedSourceState();
  }

  function recordBackgroundTaskStart(rawContent: string): void {
    const content = rawContent.replace(/\r\n/g, "\n");
    const match = BACKGROUND_TASK_START.exec(content);
    if (!match) return;
    const [, taskId, rawDescription] = match;
    if (retiredTaskIds.has(taskId)) return;
    const logsIndex = rawDescription.lastIndexOf(TASK_LOGS_MARKER);
    const description = logsIndex === -1 ? rawDescription : rawDescription.slice(0, logsIndex);
    const command = normalizeCommand(description);
    if (!command) return;
    activeTasks.set(taskId, command);
    knownTasks.set(taskId, command);
    unclaimedCanceledTasks.delete(taskId);
  }

  function markTaskEnded(taskId: string, canceled: boolean): void {
    const command = activeTasks.get(taskId) ?? knownTasks.get(taskId);
    activeTasks.delete(taskId);
    knownTasks.delete(taskId);
    if (!canceled) {
      unclaimedCanceledTasks.delete(taskId);
      retireTaskId(taskId);
      return;
    }
    if (command && !retiredTaskIds.has(taskId)) {
      unclaimedCanceledTasks.set(taskId, command);
    }
  }

  function parseTranscriptLine(line: string): void {
    if (!hasTaskLifecycleMarker(line)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const record = parsed as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const status = typeof record.status === "string" ? record.status : undefined;
    const rawContent = typeof record.content === "string" ? record.content : undefined;
    if (!type || !rawContent) return;

    if (type === "RUN_COMMAND" && status === "RUNNING") {
      recordBackgroundTaskStart(rawContent);
      return;
    }

    if (type === "GENERIC" && status === "DONE") {
      const match = GENERIC_TASK_CANCELLED.exec(rawContent.replace(/\r\n/g, "\n"));
      if (match) markTaskEnded(match[1], true);
      return;
    }

    if (type === "SYSTEM_MESSAGE") {
      for (const match of rawContent.matchAll(SYSTEM_TASK_ENDED)) {
        markTaskEnded(match[1], match[2] === "was canceled");
      }
    }
  }

  async function resolveTranscriptSource(): Promise<ResolvedTranscriptSource | undefined> {
    if (!conversationId || disposed) return undefined;

    if (source) {
      if (source.isFallback) {
        const primaryPath = path.join(source.logsDir, PRIMARY_TRANSCRIPT_FILENAME);
        const primaryStats = await statFile(primaryPath);
        if (disposed) return undefined;
        if (primaryStats) {
          source = {
            logsDir: source.logsDir,
            path: primaryPath,
            isFallback: false,
            dev: primaryStats.dev,
            ino: primaryStats.ino,
            offset: 0,
          };
          resetParsedSourceState();
          return { source, size: primaryStats.size };
        }
      }

      const currentStats = await statFile(source.path);
      if (disposed) return undefined;
      if (currentStats) {
        if (
          currentStats.dev !== source.dev ||
          currentStats.ino !== source.ino ||
          currentStats.size < source.offset
        ) {
          source.dev = currentStats.dev;
          source.ino = currentStats.ino;
          source.offset = 0;
          resetParsedSourceState();
        }
        return { source, size: currentStats.size };
      }

      source = null;
      resetParsedSourceState();
    }

    for (const root of brainRoots) {
      const logsDir = path.join(root, conversationId, ".system_generated", "logs");
      const primaryPath = path.join(logsDir, PRIMARY_TRANSCRIPT_FILENAME);
      const primaryStats = await statFile(primaryPath);
      if (disposed) return undefined;
      if (primaryStats) {
        source = {
          logsDir,
          path: primaryPath,
          isFallback: false,
          dev: primaryStats.dev,
          ino: primaryStats.ino,
          offset: 0,
        };
        return { source, size: primaryStats.size };
      }

      const fallbackPath = path.join(logsDir, FALLBACK_TRANSCRIPT_FILENAME);
      const fallbackStats = await statFile(fallbackPath);
      if (disposed) return undefined;
      if (fallbackStats) {
        source = {
          logsDir,
          path: fallbackPath,
          isFallback: true,
          dev: fallbackStats.dev,
          ino: fallbackStats.ino,
          offset: 0,
        };
        return { source, size: fallbackStats.size };
      }
    }

    return undefined;
  }

  async function findExistingLogsDir(): Promise<string | undefined> {
    if (!conversationId || disposed) return undefined;
    if (source) return source.logsDir;
    for (const root of brainRoots) {
      const logsDir = path.join(root, conversationId, ".system_generated", "logs");
      if (await isDirectory(logsDir)) return logsDir;
      if (disposed) return undefined;
    }
    return undefined;
  }

  async function readNewTranscriptLines(current: TranscriptSource): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(current.path, "r");
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let readPos = current.offset;
      let pendingParts: Buffer[] = [];
      let pendingLength = 0;

      for (;;) {
        if (disposed) break;
        const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES, readPos);
        if (bytesRead === 0 || disposed) break;
        readPos += bytesRead;

        let sliceStart = 0;
        while (sliceStart < bytesRead) {
          const newlineIndex = chunk.indexOf(0x0a, sliceStart);
          if (newlineIndex === -1 || newlineIndex >= bytesRead) {
            const remainder = Buffer.from(chunk.subarray(sliceStart, bytesRead));
            pendingParts.push(remainder);
            pendingLength += remainder.length;
            break;
          }

          const segment = chunk.subarray(sliceStart, newlineIndex);
          let lineBytes: Buffer;
          if (pendingParts.length === 0) {
            lineBytes = segment;
          } else {
            pendingParts.push(segment);
            lineBytes = Buffer.concat(pendingParts, pendingLength + segment.length);
            pendingParts = [];
            pendingLength = 0;
          }

          if (lineBytes.length > 0) {
            parseTranscriptLine(lineBytes.toString("utf8"));
          }
          current.offset += lineBytes.length + 1;
          sliceStart = newlineIndex + 1;
        }
      }
    } catch {
      // File may have been removed or rotated mid-read; next sync will re-resolve it.
    } finally {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
    }
  }

  function closeWatcher(): void {
    if (!watcher) return;
    try {
      watcher.close();
    } catch {
      // Ignore watcher close errors.
    }
    watcher = null;
    watchedLogsDir = null;
  }

  function clearReconcileTimer(): void {
    if (reconcileTimer !== null) {
      clearTimeout(reconcileTimer);
      reconcileTimer = null;
    }
  }

  function stopMonitoring(): void {
    closeWatcher();
    clearReconcileTimer();
  }

  function attachWatcher(logsDir: string): void {
    if (disposed || watchedLogsDir === logsDir) return;
    closeWatcher();
    try {
      const nextWatcher = watch(logsDir, (_eventType, filename) => {
        if (disposed) return;
        const name = typeof filename === "string" ? filename : undefined;
        if (name && name !== PRIMARY_TRANSCRIPT_FILENAME && name !== FALLBACK_TRANSCRIPT_FILENAME) {
          return;
        }
        requestBackgroundSync();
      });
      nextWatcher.on("error", () => {
        if (watcher === nextWatcher) closeWatcher();
      });
      watcher = nextWatcher;
      watchedLogsDir = logsDir;
    } catch {
      // Directory may have vanished; fallback timer will retry on the next sync.
    }
  }

  function armReconcileTimer(): void {
    if (disposed || !conversationId || reconcileTimer !== null) return;
    if (observedOpenTools().length === 0) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      if (disposed) return;
      if (observedOpenTools().length === 0) {
        stopMonitoring();
        return;
      }
      requestBackgroundSync();
    }, reconcileIntervalMs);
    reconcileTimer.unref?.();
  }

  function ensureMonitoring(): void {
    if (disposed || !conversationId) return;
    armReconcileTimer();
    if (source) {
      attachWatcher(source.logsDir);
    }
  }

  function reconcileOpenTools(): void {
    if (disposed || unclaimedCanceledTasks.size === 0) return;
    const openTools = observedOpenTools();
    if (openTools.length === 0) {
      retireAllTrackedTasks();
      return;
    }

    const activeCommands = new Set(activeTasks.values());
    const openByCommand = new Map<string, AcpToolCallSnapshot[]>();
    for (const toolCall of openTools) {
      const command = extractCommand(toolCall);
      if (!command) continue;
      const list = openByCommand.get(command);
      if (list) list.push(toolCall);
      else openByCommand.set(command, [toolCall]);
    }

    const canceledByCommand = new Map<string, string[]>();
    for (const [taskId, command] of unclaimedCanceledTasks) {
      const list = canceledByCommand.get(command);
      if (list) list.push(taskId);
      else canceledByCommand.set(command, [taskId]);
    }

    const toTerminate: string[] = [];
    for (const [command, calls] of openByCommand) {
      if (activeCommands.has(command)) continue;
      const canceledTaskIds = canceledByCommand.get(command);
      // Random ACP toolCallIds prevent tying one cancellation to a specific call when multiple
      // identical calls remain open; wait until wire completions leave only canceled calls open.
      if (!canceledTaskIds || canceledTaskIds.length < calls.length) continue;

      for (let index = 0; index < calls.length; index += 1) {
        const taskId = canceledTaskIds[index];
        unclaimedCanceledTasks.delete(taskId);
        retireTaskId(taskId);
        toTerminate.push(calls[index].id);
      }
    }

    if (toTerminate.length === 0) return;
    reconciling = true;
    try {
      for (const toolCallId of toTerminate) {
        if (disposed) break;
        context.terminateToolCall(toolCallId, "canceled");
      }
    } finally {
      reconciling = false;
    }
  }

  async function syncOnce(): Promise<void> {
    if (disposed || !conversationId) return;

    const resolved = await resolveTranscriptSource();
    if (disposed) return;

    if (resolved && resolved.source.offset < resolved.size) {
      await readNewTranscriptLines(resolved.source);
      if (disposed) return;
    }

    if (observedOpenTools().length === 0) {
      retireAllTrackedTasks();
      stopMonitoring();
      return;
    }

    const logsDir = resolved?.source.logsDir ?? (await findExistingLogsDir());
    if (disposed) return;
    if (observedOpenTools().length === 0) {
      retireAllTrackedTasks();
      stopMonitoring();
      return;
    }
    if (logsDir) {
      attachWatcher(logsDir);
    }

    reconcileOpenTools();
    if (disposed) return;
    if (observedOpenTools().length === 0) {
      retireAllTrackedTasks();
      stopMonitoring();
      return;
    }
    armReconcileTimer();
  }

  function launchPass(): Promise<void> {
    if (disposed || !conversationId) return Promise.resolve();
    if (activePass) {
      retryScheduled = true;
      return activePass;
    }
    const pass = syncOnce().finally(() => {
      if (activePass === pass) activePass = null;
      if (retryScheduled && !disposed) {
        retryScheduled = false;
        void launchPass();
      }
    });
    activePass = pass;
    return pass;
  }

  function requestBackgroundSync(): void {
    if (disposed || !conversationId) return;
    if (activePass) {
      retryScheduled = true;
      return;
    }
    void launchPass();
  }

  async function syncBounded(): Promise<void> {
    if (disposed || !conversationId) return;
    if (activePass) {
      const inFlight = activePass;
      retryScheduled = false;
      await inFlight;
      if (disposed) return;
    }
    if (activePass) {
      await activePass;
      return;
    }
    await launchPass();
  }

  return {
    sync() {
      return syncBounded();
    },
    notify() {
      if (disposed || !conversationId) return;
      if (observedOpenTools().length === 0) {
        stopMonitoring();
        retireAllTrackedTasks();
        return;
      }
      ensureMonitoring();
      if (!reconciling) {
        requestBackgroundSync();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      retryScheduled = false;
      stopMonitoring();
      resetParsedSourceState();
      retiredTaskIds.clear();
      source = null;
    },
  };
}
