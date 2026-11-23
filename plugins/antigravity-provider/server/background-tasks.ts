import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AcpToolCallSnapshot } from "@getpaseo/plugin/server/acp";

const MAX_TRACKED_CONVERSATIONS = 64;
const TRANSCRIPT_FILENAMES = ["transcript_full.jsonl", "transcript.jsonl"] as const;
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_CALL_UUID_PREFIX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/i;
const BACKGROUND_TASK_START =
  /^Created At:[^\n]*\nTool is running as a background task with task id: (\S+)\nTask Description: ([\s\S]*)$/;
const TASK_LOGS_MARKER = "\nTask logs are available at: ";
const GENERIC_TASK_CANCELLED =
  /^Created At:[^\n]*\n(?:Completed At:[^\n]*\n)?Task "([^"]+)" cancelled\.\s*$/;
const SYSTEM_TASK_ENDED = /content=Task id "([^"]+)" (was canceled|finished) with result:/g;

interface ConversationTaskState {
  path: string;
  offset: number;
  activeTasks: Map<string, string>;
  knownTasks: Map<string, string>;
  unclaimedCanceledTasks: Map<string, string>;
  claimedTaskIds: Set<string>;
  claimedToolCallIds: Set<string>;
}

export interface BackgroundTaskTracker {
  isToolCallCanceled(toolCall: AcpToolCallSnapshot, nativeSessionId?: string): boolean;
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

function resolveConversationId(
  toolCall: AcpToolCallSnapshot,
  nativeSessionId?: string,
): string | undefined {
  if (nativeSessionId && SAFE_CONVERSATION_ID.test(nativeSessionId)) {
    return nativeSessionId;
  }
  return TOOL_CALL_UUID_PREFIX.exec(toolCall.id)?.[1];
}

function findTranscriptPath(
  conversationId: string,
  brainRoots: readonly string[],
): string | undefined {
  for (const root of brainRoots) {
    const logsDir = path.join(root, conversationId, ".system_generated", "logs");
    for (const filename of TRANSCRIPT_FILENAMES) {
      const candidate = path.join(logsDir, filename);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // File does not exist yet or is unreadable.
      }
    }
  }
  return undefined;
}

function createConversationState(transcriptPath: string): ConversationTaskState {
  return {
    path: transcriptPath,
    offset: 0,
    activeTasks: new Map(),
    knownTasks: new Map(),
    unclaimedCanceledTasks: new Map(),
    claimedTaskIds: new Set(),
    claimedToolCallIds: new Set(),
  };
}

function resetConversationState(state: ConversationTaskState): void {
  state.offset = 0;
  state.activeTasks.clear();
  state.knownTasks.clear();
  state.unclaimedCanceledTasks.clear();
  state.claimedTaskIds.clear();
  state.claimedToolCallIds.clear();
}

function markTaskEnded(state: ConversationTaskState, taskId: string, canceled: boolean): void {
  const command = state.activeTasks.get(taskId) ?? state.knownTasks.get(taskId);
  state.activeTasks.delete(taskId);
  if (canceled && command && !state.claimedTaskIds.has(taskId)) {
    state.unclaimedCanceledTasks.set(taskId, command);
  }
}

function hasTaskLifecycleMarker(line: string): boolean {
  return (
    line.includes("background task with task id:") ||
    line.includes("cancelled.") ||
    line.includes("was canceled with result:") ||
    line.includes("finished with result:")
  );
}

function recordBackgroundTaskStart(state: ConversationTaskState, rawContent: string): void {
  const content = rawContent.replace(/\r\n/g, "\n");
  const match = BACKGROUND_TASK_START.exec(content);
  if (!match) return;
  const [, taskId, rawDescription] = match;
  const logsIndex = rawDescription.lastIndexOf(TASK_LOGS_MARKER);
  const description = logsIndex === -1 ? rawDescription : rawDescription.slice(0, logsIndex);
  const command = normalizeCommand(description);
  if (!command) return;
  state.activeTasks.set(taskId, command);
  state.knownTasks.set(taskId, command);
  state.unclaimedCanceledTasks.delete(taskId);
}

function parseTranscriptLine(line: string, state: ConversationTaskState): void {
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
    recordBackgroundTaskStart(state, rawContent);
    return;
  }

  if (type === "GENERIC" && status === "DONE") {
    const match = GENERIC_TASK_CANCELLED.exec(rawContent.replace(/\r\n/g, "\n"));
    if (match) markTaskEnded(state, match[1], true);
    return;
  }

  if (type === "SYSTEM_MESSAGE") {
    for (const match of rawContent.matchAll(SYSTEM_TASK_ENDED)) {
      markTaskEnded(state, match[1], match[2] === "was canceled");
    }
  }
}

function syncTranscript(state: ConversationTaskState): boolean {
  let size: number;
  try {
    size = statSync(state.path).size;
  } catch {
    return false;
  }
  if (size < state.offset) {
    resetConversationState(state);
  }
  if (size === state.offset) return true;

  const toRead = size - state.offset;
  const buffer = Buffer.allocUnsafe(toRead);
  let totalRead = 0;
  let fd: number | undefined;
  try {
    fd = openSync(state.path, "r");
    while (totalRead < toRead) {
      const bytesRead = readSync(
        fd,
        buffer,
        totalRead,
        toRead - totalRead,
        state.offset + totalRead,
      );
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }

  if (totalRead === 0) return true;
  const lastNewline = buffer.lastIndexOf(0x0a, totalRead - 1);
  if (lastNewline === -1) return true;

  state.offset += lastNewline + 1;
  const text = buffer.subarray(0, lastNewline).toString("utf8");
  for (const line of text.split("\n")) {
    if (line.length > 0) parseTranscriptLine(line, state);
  }
  return true;
}

/**
 * Tracks Antigravity backgrounded `run_command` tasks canceled via `manage_task(Action="kill")`.
 *
 * Antigravity ACP 1.5.0 emits no `tool_call_update` when `manage_task` cancels a backgrounded
 * command, leaving the tool call open forever in Paseo's deferred-turn state. Reading the
 * conversation transcript incrementally lets the provider recognize canceled commands safely.
 */
export function createBackgroundTaskTracker(
  brainRoots: readonly string[] = defaultBrainRoots(),
): BackgroundTaskTracker {
  const states = new Map<string, ConversationTaskState>();

  function getState(conversationId: string): ConversationTaskState | undefined {
    const existing = states.get(conversationId);
    if (existing) {
      states.delete(conversationId);
      states.set(conversationId, existing);
      if (syncTranscript(existing)) return existing;
      states.delete(conversationId);
    }

    const transcriptPath = findTranscriptPath(conversationId, brainRoots);
    if (!transcriptPath) return undefined;
    const created = createConversationState(transcriptPath);
    if (!syncTranscript(created)) return undefined;
    if (states.size >= MAX_TRACKED_CONVERSATIONS) {
      const oldestKey = states.keys().next().value;
      if (oldestKey !== undefined) states.delete(oldestKey);
    }
    states.set(conversationId, created);
    return created;
  }

  return {
    isToolCallCanceled(toolCall, nativeSessionId) {
      const command = extractCommand(toolCall);
      if (!command) return false;
      const conversationId = resolveConversationId(toolCall, nativeSessionId);
      if (!conversationId) return false;
      const state = getState(conversationId);
      if (!state) return false;
      if (state.claimedToolCallIds.has(toolCall.id)) return true;

      for (const activeCommand of state.activeTasks.values()) {
        if (activeCommand === command) return false;
      }

      for (const [taskId, canceledCommand] of state.unclaimedCanceledTasks) {
        if (canceledCommand !== command) continue;
        state.unclaimedCanceledTasks.delete(taskId);
        state.claimedTaskIds.add(taskId);
        state.claimedToolCallIds.add(toolCall.id);
        return true;
      }
      return false;
    },
  };
}
