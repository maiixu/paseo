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
// Antigravity stamps RUN_COMMAND Created At when execution starts (1-second resolution);
// a symmetric 3s window absorbs truncation and wire delivery skew while preventing a
// cancellation from an earlier or later invocation from matching the wrong call.
const START_TIME_MATCH_TOLERANCE_MS = 3_000;
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BACKGROUND_TASK_START =
  /^Created At:\s*([^\n]*)\nTool is running as a background task with task id: (\S+)\nTask Description: ([\s\S]*)$/;
const TASK_LOGS_MARKER = "\nTask logs are available at: ";
const GENERIC_TASK_CANCELLED =
  /^Created At:\s*([^\n]*)\n(?:Completed At:\s*([^\n]*)\n)?Task "([^"]+)" cancelled\.\s*$/;
const SYSTEM_TASK_ENDED =
  /(?:timestamp=(\S+)[^\n]*?)?content=Task id "([^"]+)" (was canceled|finished|failed) with result:/g;

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

interface TrackedTask {
  command: string;
  startedAtMs?: number;
}

interface CanceledTask extends TrackedTask {
  canceledAtMs?: number;
}

interface CanceledCandidate {
  taskId: string;
  startedAtMs: number;
  canceledAtMs: number;
}

export interface AntigravityBackgroundTaskObserverOptions {
  brainRoots?: readonly string[];
  reconcileIntervalMs?: number;
  now?: () => number;
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

function parseIsoTimestampMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Date.parse(raw.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function canceledTaskTimestampMs(task: CanceledTask): number | undefined {
  if (task.startedAtMs !== undefined && task.canceledAtMs !== undefined) {
    return Math.min(task.startedAtMs, task.canceledAtMs);
  }
  return task.startedAtMs ?? task.canceledAtMs;
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
  const now = options?.now ?? Date.now;
  const conversationId = SAFE_CONVERSATION_ID.test(context.nativeSessionId)
    ? context.nativeSessionId
    : undefined;

  let disposed = false;
  let reconciling = false;
  let hasCompletedInitialBaseline = false;
  let source: TranscriptSource | null = null;
  let watcher: FSWatcher | null = null;
  let watchedLogsDir: string | null = null;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let activePass: Promise<void> | null = null;
  let retryScheduled = false;

  const activeTasks = new Map<string, TrackedTask>();
  const knownTasks = new Map<string, TrackedTask>();
  const unclaimedCanceledTasks = new Map<string, CanceledTask>();
  const openToolStartedAt = new Map<string, number>();
  const retiredTaskIds = new Set<string>();

  function observedOpenTools(): AcpToolCallSnapshot[] {
    return context
      .openToolCalls()
      .filter((toolCall) => toolCall.status === "in_progress" && isObservedExecuteTool(toolCall));
  }

  function observedPendingExecuteState(): {
    commands: Set<string>;
    hasUnknownCommand: boolean;
  } {
    const commands = new Set<string>();
    let hasUnknownCommand = false;
    for (const toolCall of context.openToolCalls()) {
      if (toolCall.status !== "pending" || !isObservedExecuteTool(toolCall)) continue;
      const command = extractCommand(toolCall);
      if (command) commands.add(command);
      else hasUnknownCommand = true;
    }
    return { commands, hasUnknownCommand };
  }

  function syncOpenToolTimestamps(openTools: readonly AcpToolCallSnapshot[]): void {
    const currentIds = new Set<string>();
    const currentTime = now();
    for (const tool of openTools) {
      currentIds.add(tool.id);
      if (!openToolStartedAt.has(tool.id)) {
        openToolStartedAt.set(tool.id, currentTime);
      }
    }
    for (const id of openToolStartedAt.keys()) {
      if (!currentIds.has(id)) {
        openToolStartedAt.delete(id);
      }
    }
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

  // Only called when no execute tool calls are currently open. Any task whose timestamp is
  // strictly older than (now - tolerance) cannot match a future call that has not opened yet.
  function pruneStaleTrackedTasks(): void {
    const cutoff = now() - START_TIME_MATCH_TOLERANCE_MS;
    for (const [taskId, task] of activeTasks) {
      if (task.startedAtMs === undefined || task.startedAtMs < cutoff) {
        activeTasks.delete(taskId);
        knownTasks.delete(taskId);
        retireTaskId(taskId);
      }
    }
    for (const [taskId, task] of knownTasks) {
      if (task.startedAtMs === undefined || task.startedAtMs < cutoff) {
        knownTasks.delete(taskId);
        retireTaskId(taskId);
      }
    }
    for (const [taskId, task] of unclaimedCanceledTasks) {
      const taskTime = canceledTaskTimestampMs(task);
      if (taskTime === undefined || taskTime < cutoff) {
        unclaimedCanceledTasks.delete(taskId);
        retireTaskId(taskId);
      }
    }
  }

  function recordBackgroundTaskStart(rawContent: string, recordCreatedAt?: string): void {
    const content = rawContent.replace(/\r\n/g, "\n");
    const match = BACKGROUND_TASK_START.exec(content);
    if (!match) return;
    const [, createdAtRaw, taskId, rawDescription] = match;
    if (retiredTaskIds.has(taskId)) return;
    const logsIndex = rawDescription.lastIndexOf(TASK_LOGS_MARKER);
    const description = logsIndex === -1 ? rawDescription : rawDescription.slice(0, logsIndex);
    const command = normalizeCommand(description);
    if (!command) return;
    const startedAtMs = parseIsoTimestampMs(createdAtRaw) ?? parseIsoTimestampMs(recordCreatedAt);
    const tracked: TrackedTask = { command, startedAtMs };
    activeTasks.set(taskId, tracked);
    knownTasks.set(taskId, tracked);
    unclaimedCanceledTasks.delete(taskId);
  }

  function markTaskEnded(taskId: string, canceled: boolean, endedAtMs?: number): void {
    const tracked = activeTasks.get(taskId) ?? knownTasks.get(taskId);
    activeTasks.delete(taskId);
    knownTasks.delete(taskId);
    if (!canceled) {
      unclaimedCanceledTasks.delete(taskId);
      retireTaskId(taskId);
      return;
    }
    if (tracked && !retiredTaskIds.has(taskId)) {
      unclaimedCanceledTasks.set(taskId, {
        command: tracked.command,
        startedAtMs: tracked.startedAtMs,
        canceledAtMs: endedAtMs,
      });
    }
  }

  function recordGenericTaskCancellation(rawContent: string, recordCreatedAt?: string): void {
    const match = GENERIC_TASK_CANCELLED.exec(rawContent.replace(/\r\n/g, "\n"));
    if (!match) return;
    const [, createdAtRaw, completedAtRaw, taskId] = match;
    const canceledAtMs =
      parseIsoTimestampMs(completedAtRaw) ??
      parseIsoTimestampMs(createdAtRaw) ??
      parseIsoTimestampMs(recordCreatedAt);
    markTaskEnded(taskId, true, canceledAtMs);
  }

  function recordSystemTaskEnded(rawContent: string, recordCreatedAt?: string): void {
    const fallbackEndedAt = parseIsoTimestampMs(recordCreatedAt);
    for (const match of rawContent.matchAll(SYSTEM_TASK_ENDED)) {
      const endedAtMs = parseIsoTimestampMs(match[1]) ?? fallbackEndedAt;
      markTaskEnded(match[2], match[3] === "was canceled", endedAtMs);
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
    const recordCreatedAt = typeof record.created_at === "string" ? record.created_at : undefined;
    if (!type || !rawContent) return;

    if (type === "RUN_COMMAND" && status === "RUNNING") {
      recordBackgroundTaskStart(rawContent, recordCreatedAt);
    } else if (type === "GENERIC" && status === "DONE") {
      recordGenericTaskCancellation(rawContent, recordCreatedAt);
    } else if (type === "SYSTEM_MESSAGE") {
      recordSystemTaskEnded(rawContent, recordCreatedAt);
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

  async function readNewTranscriptLines(
    current: TranscriptSource,
    maxOffset: number,
  ): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(current.path, "r");
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let readPos = current.offset;
      let pendingParts: Buffer[] = [];
      let pendingLength = 0;

      while (readPos < maxOffset) {
        if (disposed) break;
        const toRead = Math.min(READ_CHUNK_BYTES, maxOffset - readPos);
        const { bytesRead } = await handle.read(chunk, 0, toRead, readPos);
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

  function matchEligibleCancellationsForCommand(
    calls: readonly AcpToolCallSnapshot[],
    activeForCommand: readonly TrackedTask[] | undefined,
    canceledForCommand: readonly CanceledCandidate[] | undefined,
    currentTime: number,
  ): Array<{ toolCallId: string; taskId: string }> {
    const callEntries = calls
      .map((call) => ({
        id: call.id,
        startedAt: openToolStartedAt.get(call.id) ?? currentTime,
      }))
      .sort((a, b) => a.startedAt - b.startedAt);

    const hasEligibleActiveTask =
      activeForCommand?.some((task) => {
        const taskStart = task.startedAtMs;
        if (taskStart === undefined) return true;
        return callEntries.some(
          (call) => Math.abs(taskStart - call.startedAt) <= START_TIME_MATCH_TOLERANCE_MS,
        );
      }) ?? false;
    if (hasEligibleActiveTask) return [];

    // Random ACP toolCallIds prevent tying one cancellation to a specific call when multiple
    // identical calls remain open; wait until wire completions leave only canceled calls open
    // and every open call has a causally eligible canceled task within its start window.
    if (!canceledForCommand || canceledForCommand.length < callEntries.length) return [];

    const canceledOldestFirst = [...canceledForCommand].sort(
      (a, b) => a.startedAtMs - b.startedAtMs || a.canceledAtMs - b.canceledAtMs,
    );
    const matched: Array<{ toolCallId: string; taskId: string }> = [];
    let taskIndex = 0;
    for (const call of callEntries) {
      const minStart = call.startedAt - START_TIME_MATCH_TOLERANCE_MS;
      const maxStart = call.startedAt + START_TIME_MATCH_TOLERANCE_MS;
      while (
        taskIndex < canceledOldestFirst.length &&
        (canceledOldestFirst[taskIndex].startedAtMs < minStart ||
          canceledOldestFirst[taskIndex].canceledAtMs < minStart)
      ) {
        taskIndex += 1;
      }
      const candidate = canceledOldestFirst[taskIndex];
      if (!candidate || candidate.startedAtMs > maxStart) {
        return [];
      }
      matched.push({ toolCallId: call.id, taskId: candidate.taskId });
      taskIndex += 1;
    }
    return matched;
  }

  function reconcileOpenTools(): void {
    if (disposed || unclaimedCanceledTasks.size === 0) return;
    const openTools = observedOpenTools();
    syncOpenToolTimestamps(openTools);
    if (openTools.length === 0) {
      pruneStaleTrackedTasks();
      return;
    }

    const currentTime = now();
    const openByCommand = new Map<string, AcpToolCallSnapshot[]>();
    for (const toolCall of openTools) {
      const command = extractCommand(toolCall);
      if (!command) continue;
      const list = openByCommand.get(command);
      if (list) list.push(toolCall);
      else openByCommand.set(command, [toolCall]);
    }

    const activeByCommand = new Map<string, TrackedTask[]>();
    for (const task of activeTasks.values()) {
      const list = activeByCommand.get(task.command);
      if (list) list.push(task);
      else activeByCommand.set(task.command, [task]);
    }

    const canceledByCommand = new Map<string, CanceledCandidate[]>();
    for (const [taskId, task] of unclaimedCanceledTasks) {
      if (task.startedAtMs === undefined || task.canceledAtMs === undefined) continue;
      const candidate: CanceledCandidate = {
        taskId,
        startedAtMs: task.startedAtMs,
        canceledAtMs: task.canceledAtMs,
      };
      const list = canceledByCommand.get(task.command);
      if (list) list.push(candidate);
      else canceledByCommand.set(task.command, [candidate]);
    }

    const pendingState = observedPendingExecuteState();
    const toTerminate: string[] = [];
    for (const [command, calls] of openByCommand) {
      if (pendingState.hasUnknownCommand || pendingState.commands.has(command)) continue;
      const matched = matchEligibleCancellationsForCommand(
        calls,
        activeByCommand.get(command),
        canceledByCommand.get(command),
        currentTime,
      );
      for (const { toolCallId, taskId } of matched) {
        unclaimedCanceledTasks.delete(taskId);
        retireTaskId(taskId);
        toTerminate.push(toolCallId);
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
      await readNewTranscriptLines(resolved.source, resolved.size);
      if (disposed) return;
    }

    const openTools = observedOpenTools();
    syncOpenToolTimestamps(openTools);
    if (openTools.length === 0) {
      if (!hasCompletedInitialBaseline) {
        hasCompletedInitialBaseline = true;
        retireAllTrackedTasks();
      } else {
        pruneStaleTrackedTasks();
      }
      stopMonitoring();
      return;
    }

    hasCompletedInitialBaseline = true;

    const logsDir = resolved?.source.logsDir ?? (await findExistingLogsDir());
    if (disposed) return;
    const currentOpenTools = observedOpenTools();
    syncOpenToolTimestamps(currentOpenTools);
    if (currentOpenTools.length === 0) {
      pruneStaleTrackedTasks();
      stopMonitoring();
      return;
    }
    if (logsDir) {
      attachWatcher(logsDir);
    }

    reconcileOpenTools();
    if (disposed) return;
    const remainingOpenTools = observedOpenTools();
    syncOpenToolTimestamps(remainingOpenTools);
    if (remainingOpenTools.length === 0) {
      pruneStaleTrackedTasks();
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
      const openTools = observedOpenTools();
      syncOpenToolTimestamps(openTools);
      if (openTools.length === 0) {
        stopMonitoring();
        if (hasCompletedInitialBaseline) {
          pruneStaleTrackedTasks();
        }
        return;
      }
      hasCompletedInitialBaseline = true;
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
      openToolStartedAt.clear();
      retiredTaskIds.clear();
      source = null;
    },
  };
}
