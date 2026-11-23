import { appendFile, mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AcpDeferredToolObserver, AcpToolCallSnapshot } from "@getpaseo/plugin/server/acp";
import { afterEach, describe, expect, it } from "vitest";
import { createAntigravityBackgroundTaskObserver } from "./background-tasks.js";

const tempDirs: string[] = [];
const activeObservers: AcpDeferredToolObserver[] = [];

afterEach(async () => {
  while (activeObservers.length > 0) {
    activeObservers.pop()?.dispose();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeBrainRoot() {
  const dir = await mkdtemp(path.join(tmpdir(), "paseo-agy-bg-tasks-"));
  tempDirs.push(dir);
  return dir;
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
    id: "26835c4d176642b5b20ecbc535f60e00",
    title: "sleep 30",
    kind: "execute",
    status: "in_progress",
    input: { command_line: "sleep 30", working_dir: "/tmp" },
    output: null,
    locations: [],
    ...overrides,
  };
}

function createHarness(
  nativeSessionId: string,
  brainRoot: string,
  initialTools: AcpToolCallSnapshot[] = [],
  reconcileIntervalMs = 25,
) {
  const open = new Map<string, AcpToolCallSnapshot>(initialTools.map((tool) => [tool.id, tool]));
  const terminated: Array<{ id: string; state: "completed" | "failed" | "canceled" }> = [];
  const observer = createAntigravityBackgroundTaskObserver(
    {
      nativeSessionId,
      openToolCalls: () => [...open.values()],
      terminateToolCall(id, state) {
        if (!open.delete(id)) return;
        terminated.push({ id, state });
        observer.notify();
      },
    },
    { brainRoots: [brainRoot], reconcileIntervalMs },
  );
  activeObservers.push(observer);
  return {
    observer,
    open,
    terminated,
    addTool(tool: AcpToolCallSnapshot) {
      open.set(tool.id, tool);
      observer.notify();
    },
    closeTool(id: string) {
      open.delete(id);
      observer.notify();
    },
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

function systemEndedEntry(taskId: string, outcome: "was canceled" | "finished" | "failed") {
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

describe("createAntigravityBackgroundTaskObserver", () => {
  it("terminates a backgrounded command once canceled via GENERIC and detects late flushes asynchronously", async () => {
    const root = await makeBrainRoot();
    const convId = "410c02f3-7c64-45fb-acf0-52147aae36f9";
    const file = await transcriptFile(root, convId);
    const harness = createHarness(convId, root);
    await harness.observer.sync();

    const toolCall = makeToolCall({ id: "call-1" });
    harness.addTool(toolCall);
    await writeFile(file, `${bgStartEntry(`${convId}/task-2`, "sleep 30")}\n`);
    await harness.observer.sync();
    expect(harness.terminated).toEqual([]);

    // Late cancellation flush without any manual sync() call is detected by watcher/interval.
    await appendFile(file, `${genericCancelEntry(`${convId}/task-2`)}\n`);
    await expect
      .poll(() => harness.terminated, { timeout: 2_000 })
      .toEqual([{ id: "call-1", state: "canceled" }]);
  });

  it("supports CommandLine, title fallback, and CRLF normalization", async () => {
    const root = await makeBrainRoot();
    const convId = "11111111-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId, "transcript.jsonl");
    const harness = createHarness(convId, root);
    await harness.observer.sync();

    harness.addTool(
      makeToolCall({
        id: "call-multiline",
        name: "run_command",
        input: { CommandLine: "echo a\r\necho b\n" },
      }),
    );
    harness.addTool(
      makeToolCall({
        id: "call-title",
        kind: "execute",
        title: "  npm test  ",
        input: null,
      }),
    );

    await writeFile(
      file,
      [
        bgStartEntry(`${convId}/task-1`, "echo a\necho b"),
        genericCancelEntry(`${convId}/task-1`),
        bgStartEntry(`${convId}/task-2`, "npm test"),
        systemEndedEntry(`${convId}/task-2`, "was canceled"),
      ].join("\n") + "\n",
    );
    await harness.observer.sync();

    expect(harness.terminated).toEqual([
      { id: "call-multiline", state: "canceled" },
      { id: "call-title", state: "canceled" },
    ]);
  });

  it("does not cancel normally finished, failed, or non-execute tools, and clears failed tasks from active state", async () => {
    const root = await makeBrainRoot();
    const convId = "22222222-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId);
    const harness = createHarness(convId, root);
    await harness.observer.sync();

    harness.addTool(makeToolCall({ id: "call-finished", input: { command_line: "sleep 2" } }));
    harness.addTool(
      makeToolCall({
        id: "call-schedule",
        name: "schedule",
        kind: "other",
        title: "sleep 2",
        input: { DurationSeconds: 60 },
      }),
    );

    await writeFile(
      file,
      [
        bgStartEntry(`${convId}/task-1`, "sleep 2"),
        systemEndedEntry(`${convId}/task-1`, "finished"),
      ].join("\n") + "\n",
    );
    await harness.observer.sync();
    expect(harness.terminated).toEqual([]);

    // Two identical commands: task-2 is canceled, task-3 fails with result.
    // Once task-3 fails and closes on wire, task-3 must no longer block canceling task-2's call.
    harness.addTool(makeToolCall({ id: "call-a", input: { command_line: "sleep 30" } }));
    harness.addTool(makeToolCall({ id: "call-b", input: { command_line: "sleep 30" } }));
    await appendFile(
      file,
      [
        bgStartEntry(`${convId}/task-2`, "sleep 30"),
        bgStartEntry(`${convId}/task-3`, "sleep 30"),
        genericCancelEntry(`${convId}/task-2`),
      ].join("\n") + "\n",
    );
    await harness.observer.sync();
    expect(harness.terminated).toEqual([]);

    harness.closeTool("call-b");
    await appendFile(file, `${systemEndedEntry(`${convId}/task-3`, "failed")}\n`);
    await harness.observer.sync();
    expect(harness.terminated).toEqual([{ id: "call-a", state: "canceled" }]);
  });

  it("cancels only the killed call when parallel identical commands have one wire-completed and one killed", async () => {
    const root = await makeBrainRoot();
    const convId = "44444444-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId);
    const harness = createHarness(convId, root);
    await harness.observer.sync();

    harness.addTool(makeToolCall({ id: "call-a", input: { command_line: "sleep 30" } }));
    harness.addTool(makeToolCall({ id: "call-b", input: { command_line: "sleep 30" } }));

    await writeFile(
      file,
      [
        bgStartEntry(`${convId}/task-1`, "sleep 30"),
        bgStartEntry(`${convId}/task-2`, "sleep 30"),
        genericCancelEntry(`${convId}/task-1`),
      ].join("\n") + "\n",
    );
    await harness.observer.sync();
    expect(harness.terminated).toEqual([]);

    // call-b completes via wire while call-a remains open.
    harness.closeTool("call-b");
    await appendFile(file, `${systemEndedEntry(`${convId}/task-2`, "finished")}\n`);
    await harness.observer.sync();
    expect(harness.terminated).toEqual([{ id: "call-a", state: "canceled" }]);

    // Trailing SYSTEM_MESSAGE for task-1 must not poison a subsequent new run of sleep 30.
    harness.addTool(makeToolCall({ id: "call-c", input: { command_line: "sleep 30" } }));
    await appendFile(file, `${systemEndedEntry(`${convId}/task-1`, "was canceled")}\n`);
    await harness.observer.sync();
    expect(harness.terminated).toEqual([{ id: "call-a", state: "canceled" }]);
  });

  it("retires pre-existing historical cancellations during initial open baseline", async () => {
    const root = await makeBrainRoot();
    const convId = "66666666-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId);

    // Historical canceled task already on disk before session opens / reloads.
    await writeFile(
      file,
      [bgStartEntry(`${convId}/task-1`, "sleep 30"), genericCancelEntry(`${convId}/task-1`)].join(
        "\n",
      ) + "\n",
    );

    const harness = createHarness(convId, root);
    // Initial sync with no open tools baselines and retires task-1.
    await harness.observer.sync();

    // Brand-new run of the same command must NOT claim the historical cancellation.
    harness.addTool(makeToolCall({ id: "new-call", input: { command_line: "sleep 30" } }));
    await harness.observer.sync();
    expect(harness.terminated).toEqual([]);
  });

  it("upgrades from fallback transcript.jsonl to transcript_full.jsonl and handles equal/larger inode replacement", async () => {
    const root = await makeBrainRoot();
    const convId = "77777777-2222-3333-4444-555555555555";
    const fallbackFile = await transcriptFile(root, convId, "transcript.jsonl");
    const primaryFile = path.join(path.dirname(fallbackFile), "transcript_full.jsonl");

    // Start with only fallback transcript.jsonl containing an already-retired historical task.
    await writeFile(
      fallbackFile,
      [bgStartEntry(`${convId}/task-1`, "sleep 30"), genericCancelEntry(`${convId}/task-1`)].join(
        "\n",
      ) + "\n",
    );

    const harness = createHarness(convId, root);
    await harness.observer.sync();

    // Now transcript_full.jsonl appears with task-1 (already retired) plus a new canceled task-2.
    harness.addTool(makeToolCall({ id: "call-2", input: { command_line: "sleep 30" } }));
    await writeFile(
      primaryFile,
      [
        bgStartEntry(`${convId}/task-1`, "sleep 30"),
        genericCancelEntry(`${convId}/task-1`),
        bgStartEntry(`${convId}/task-2`, "sleep 30"),
        genericCancelEntry(`${convId}/task-2`),
      ].join("\n") + "\n",
    );
    await harness.observer.sync();
    expect(harness.terminated).toEqual([{ id: "call-2", state: "canceled" }]);

    // Atomically replace transcript_full.jsonl with a larger file on a new inode containing task-3.
    harness.addTool(makeToolCall({ id: "call-3", input: { command_line: "sleep 45" } }));
    const replacementTmp = `${primaryFile}.tmp`;
    const padding = JSON.stringify({
      step_index: 0,
      type: "PLANNER_RESPONSE",
      content: "x".repeat(4096),
    });
    await writeFile(
      replacementTmp,
      [
        padding,
        bgStartEntry(`${convId}/task-1`, "sleep 30"),
        genericCancelEntry(`${convId}/task-1`),
        bgStartEntry(`${convId}/task-3`, "sleep 45"),
        genericCancelEntry(`${convId}/task-3`),
      ].join("\n") + "\n",
    );
    await unlink(primaryFile);
    await rename(replacementTmp, primaryFile);
    await harness.observer.sync();

    expect(harness.terminated).toEqual([
      { id: "call-2", state: "canceled" },
      { id: "call-3", state: "canceled" },
    ]);
  });

  it("handles chunked >64KiB lines, partial trailing lines, and DONE RUN_COMMAND stdout echoes", async () => {
    const root = await makeBrainRoot();
    const convId = "55555555-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId);
    const harness = createHarness(convId, root);
    await harness.observer.sync();

    harness.addTool(makeToolCall({ id: "call-big", input: { command_line: "sleep 30" } }));

    // Write a >90 KiB non-lifecycle line, then bg start, then a DONE RUN_COMMAND echoing cancel text,
    // then half of the real GENERIC cancel line without trailing newline.
    const hugeNoiseLine = JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "y".repeat(90_000),
    });
    const echoLine = JSON.stringify({
      step_index: 3,
      type: "RUN_COMMAND",
      status: "DONE",
      content: `Created At: 2026-11-23T08:49:00-08:00\nCompleted At: 2026-11-23T08:49:00-08:00\nOutput:\nTask "${convId}/task-1" cancelled.`,
    });
    const cancelLine = genericCancelEntry(`${convId}/task-1`);
    const splitAt = Math.floor(cancelLine.length / 2);

    await writeFile(
      file,
      `${hugeNoiseLine}\n${bgStartEntry(`${convId}/task-1`, "sleep 30")}\n${echoLine}\n${cancelLine.slice(0, splitAt)}`,
    );
    await harness.observer.sync();
    expect(harness.terminated).toEqual([]);

    await appendFile(file, `${cancelLine.slice(splitAt)}\n`);
    await harness.observer.sync();
    expect(harness.terminated).toEqual([{ id: "call-big", state: "canceled" }]);
  });
});
