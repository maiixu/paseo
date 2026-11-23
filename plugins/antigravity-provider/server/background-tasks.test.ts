import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AcpToolCallSnapshot } from "@getpaseo/plugin/server/acp";
import { afterEach, describe, expect, it } from "vitest";
import { createBackgroundTaskTracker } from "./background-tasks.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeBrainRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-agy-bg-tasks-"));
  directories.push(root);
  return root;
}

async function transcriptFile(
  root: string,
  conversationId: string,
  filename = "transcript_full.jsonl",
) {
  const logsDir = path.join(root, conversationId, ".system_generated", "logs");
  await mkdir(logsDir, { recursive: true });
  return path.join(logsDir, filename);
}

function makeToolCall(overrides: Partial<AcpToolCallSnapshot> = {}): AcpToolCallSnapshot {
  return {
    id: "410c02f3-7c64-45fb-acf0-52147aae36f9:10",
    title: "sleep 30",
    kind: "execute",
    status: "in_progress",
    input: { command_line: "sleep 30", working_dir: "/tmp" },
    output: null,
    locations: [],
    ...overrides,
  };
}

function bgStartEntry(taskId: string, command: string) {
  return JSON.stringify({
    step_index: 2,
    type: "RUN_COMMAND",
    status: "RUNNING",
    content: [
      "Created At: 2026-11-23T08:47:32-08:00",
      `Tool is running as a background task with task id: ${taskId}`,
      `Task Description: ${command}`,
      `Task logs are available at: file:///tmp/${taskId}.log`,
    ].join("\n"),
  });
}

function genericCancelEntry(taskId: string) {
  return JSON.stringify({
    step_index: 4,
    type: "GENERIC",
    status: "DONE",
    content: [
      "Created At: 2026-11-23T08:49:02-08:00",
      "Completed At: 2026-11-23T08:49:02-08:00",
      `Task "${taskId}" cancelled.`,
    ].join("\n"),
  });
}

function systemEndedEntry(taskId: string, outcome: "was canceled" | "finished") {
  return JSON.stringify({
    step_index: 5,
    type: "SYSTEM_MESSAGE",
    status: "DONE",
    content: [
      "The following is a <SYSTEM_MESSAGE>",
      `[Message] timestamp=2026-11-23T16:49:02Z sender=${taskId} priority=MESSAGE_PRIORITY_LOW content=Task id "${taskId}" ${outcome} with result:`,
      "Step ended.",
    ].join("\n"),
  });
}

describe("createBackgroundTaskTracker", () => {
  it("returns false while a background command is active and true once canceled via GENERIC", async () => {
    const root = await makeBrainRoot();
    const convId = "410c02f3-7c64-45fb-acf0-52147aae36f9";
    const file = await transcriptFile(root, convId);
    const tracker = createBackgroundTaskTracker([root]);
    const toolCall = makeToolCall();

    expect(tracker.isToolCallCanceled(toolCall, convId)).toBe(false);

    await writeFile(file, `${bgStartEntry(`${convId}/task-2`, "sleep 30")}\n`);
    expect(tracker.isToolCallCanceled(toolCall, convId)).toBe(false);

    await appendFile(file, `${genericCancelEntry(`${convId}/task-2`)}\n`);
    expect(tracker.isToolCallCanceled(toolCall, convId)).toBe(true);
    // Subsequent checks stay true once claimed.
    expect(tracker.isToolCallCanceled(toolCall, convId)).toBe(true);
  });

  it("supports CommandLine, title fallback, CRLF normalization, and UUID fallback from toolCall.id", async () => {
    const root = await makeBrainRoot();
    const convId = "11111111-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId, "transcript.jsonl");
    const tracker = createBackgroundTaskTracker([root]);

    await writeFile(
      file,
      [
        bgStartEntry(`${convId}/task-1`, "echo a\necho b"),
        genericCancelEntry(`${convId}/task-1`),
        bgStartEntry(`${convId}/task-2`, "npm test"),
        systemEndedEntry(`${convId}/task-2`, "was canceled"),
      ].join("\n") + "\n",
    );

    expect(
      tracker.isToolCallCanceled(
        makeToolCall({
          id: `${convId}:1`,
          name: "run_command",
          input: { CommandLine: "echo a\r\necho b\n" },
        }),
      ),
    ).toBe(true);

    expect(
      tracker.isToolCallCanceled(
        makeToolCall({
          id: `${convId}:2`,
          kind: "execute",
          title: "  npm test  ",
          input: null,
        }),
      ),
    ).toBe(true);
  });

  it("does not mark normally finished tasks or non-execute tools as canceled", async () => {
    const root = await makeBrainRoot();
    const convId = "22222222-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId);
    const tracker = createBackgroundTaskTracker([root]);

    await writeFile(
      file,
      [
        bgStartEntry(`${convId}/task-1`, "sleep 2"),
        systemEndedEntry(`${convId}/task-1`, "finished"),
      ].join("\n") + "\n",
    );

    expect(
      tracker.isToolCallCanceled(
        makeToolCall({ id: `${convId}:1`, input: { command_line: "sleep 2" } }),
        convId,
      ),
    ).toBe(false);

    expect(
      tracker.isToolCallCanceled(
        makeToolCall({
          id: `${convId}:2`,
          name: "schedule",
          kind: "other",
          title: "sleep 2",
          input: { DurationSeconds: 60 },
        }),
        convId,
      ),
    ).toBe(false);
  });

  it("ignores transcript-like text echoed in a DONE RUN_COMMAND output", async () => {
    const root = await makeBrainRoot();
    const convId = "33333333-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId);
    const tracker = createBackgroundTaskTracker([root]);

    await writeFile(
      file,
      [
        bgStartEntry(`${convId}/task-1`, "sleep 30"),
        JSON.stringify({
          step_index: 3,
          type: "RUN_COMMAND",
          status: "DONE",
          content: `Created At: 2026-11-23T08:49:00-08:00\nCompleted At: 2026-11-23T08:49:00-08:00\nOutput:\nTask "${convId}/task-1" cancelled.`,
        }),
      ].join("\n") + "\n",
    );

    expect(tracker.isToolCallCanceled(makeToolCall({ id: `${convId}:1` }), convId)).toBe(false);
  });

  it("keeps identical parallel commands open while one instance is still active and avoids double-claiming on rerun", async () => {
    const root = await makeBrainRoot();
    const convId = "44444444-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId);
    const tracker = createBackgroundTaskTracker([root]);

    // Two parallel runs of the same command: task-1 canceled, task-2 still active.
    await writeFile(
      file,
      [
        bgStartEntry(`${convId}/task-1`, "sleep 30"),
        bgStartEntry(`${convId}/task-2`, "sleep 30"),
        genericCancelEntry(`${convId}/task-1`),
      ].join("\n") + "\n",
    );
    const call1 = makeToolCall({ id: `${convId}:1` });
    const call2 = makeToolCall({ id: `${convId}:2` });
    expect(tracker.isToolCallCanceled(call1, convId)).toBe(false);

    // Once task-2 finishes normally, no active "sleep 30" remains, so call1 claims task-1.
    await appendFile(file, `${systemEndedEntry(`${convId}/task-2`, "finished")}\n`);
    expect(tracker.isToolCallCanceled(call1, convId)).toBe(true);
    // Trailing SYSTEM_MESSAGE for already-claimed task-1 must not allow a later rerun to claim it.
    await appendFile(file, `${systemEndedEntry(`${convId}/task-1`, "was canceled")}\n`);
    expect(tracker.isToolCallCanceled(call2, convId)).toBe(false);
  });

  it("handles partial trailing lines and file truncation cleanly", async () => {
    const root = await makeBrainRoot();
    const convId = "55555555-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId);
    const tracker = createBackgroundTaskTracker([root]);
    const call = makeToolCall({ id: `${convId}:1` });

    const cancelLine = genericCancelEntry(`${convId}/task-1`);
    const splitAt = Math.floor(cancelLine.length / 2);
    await writeFile(
      file,
      `${bgStartEntry(`${convId}/task-1`, "sleep 30")}\n${cancelLine.slice(0, splitAt)}`,
    );
    expect(tracker.isToolCallCanceled(call, convId)).toBe(false);

    await appendFile(file, `${cancelLine.slice(splitAt)}\n`);
    expect(tracker.isToolCallCanceled(call, convId)).toBe(true);

    // Truncated transcript resets state cleanly without throwing.
    await writeFile(file, `${bgStartEntry(`${convId}/task-9`, "sleep 60")}\n`);
    expect(
      tracker.isToolCallCanceled(
        makeToolCall({ id: `${convId}:9`, input: { command_line: "sleep 60" } }),
        convId,
      ),
    ).toBe(false);
  });
});
