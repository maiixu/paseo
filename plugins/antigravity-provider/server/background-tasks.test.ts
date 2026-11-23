import { appendFile, mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AcpDeferredToolObserver, AcpToolCallSnapshot } from "@getpaseo/plugin/server/acp";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsHookControl = vi.hoisted(() => ({
  onStat: null as ((target: string) => Promise<void>) | null,
  onRead: null as ((target: string, callIndex: number) => Promise<void>) | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async stat(...args: Parameters<typeof actual.stat>) {
      if (fsHookControl.onStat) {
        await fsHookControl.onStat(String(args[0]));
      }
      return actual.stat(...args);
    },
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      if (!fsHookControl.onRead) return handle;
      const target = String(args[0]);
      let readCalls = 0;
      const originalRead = handle.read.bind(handle);
      handle.read = (async (...readArgs: unknown[]) => {
        readCalls += 1;
        await fsHookControl.onRead?.(target, readCalls);
        return (originalRead as (...a: unknown[]) => Promise<unknown>)(...readArgs);
      }) as typeof handle.read;
      return handle;
    },
  };
});

import { createAntigravityBackgroundTaskObserver } from "./background-tasks.js";

const tempDirs: string[] = [];
const activeObservers: AcpDeferredToolObserver[] = [];

afterEach(async () => {
  fsHookControl.onStat = null;
  fsHookControl.onRead = null;
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

const DEFAULT_BASE_TIME_MS = Date.parse("2026-11-23T08:47:32-08:00");

function createHarness(
  nativeSessionId: string,
  brainRoot: string,
  initialTools: AcpToolCallSnapshot[] = [],
  reconcileIntervalMs = 25,
  now: () => number = () => DEFAULT_BASE_TIME_MS,
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
    { brainRoots: [brainRoot], reconcileIntervalMs, now },
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

function bgStartEntry(taskId: string, command: string, createdAt = "2026-11-23T08:47:32-08:00") {
  return JSON.stringify({
    step_index: 2,
    type: "RUN_COMMAND",
    status: "RUNNING",
    content: [
      `Created At: ${createdAt}`,
      `Tool is running as a background task with task id: ${taskId}`,
      `Task Description: ${command}`,
      `Task logs are available at: file:///tmp/${taskId}.log`,
    ].join("\n"),
  });
}

function genericCancelEntry(taskId: string, canceledAt = "2026-11-23T08:49:02-08:00") {
  return JSON.stringify({
    step_index: 4,
    type: "GENERIC",
    status: "DONE",
    content: [
      `Created At: ${canceledAt}`,
      `Completed At: ${canceledAt}`,
      `Task "${taskId}" cancelled.`,
    ].join("\n"),
  });
}

function systemEndedEntry(
  taskId: string,
  outcome: "was canceled" | "finished" | "failed",
  timestamp = "2026-11-23T16:49:02Z",
) {
  return JSON.stringify({
    step_index: 5,
    type: "SYSTEM_MESSAGE",
    status: "DONE",
    content: [
      "The following is a <SYSTEM_MESSAGE>",
      `[Message] timestamp=${timestamp} sender=${taskId} priority=MESSAGE_PRIORITY_LOW content=Task id "${taskId}" ${outcome} with result:`,
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

  it("waits for B's wire completion before canceling A when B was opened first and finished in transcript first", async () => {
    const root = await makeBrainRoot();
    const convId = "44444444-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId);
    const harness = createHarness(convId, root);
    await harness.observer.sync();

    // Open B FIRST, then A, with identical command text.
    harness.addTool(makeToolCall({ id: "call-b", input: { command_line: "sleep 30" } }));
    harness.addTool(makeToolCall({ id: "call-a", input: { command_line: "sleep 30" } }));

    // A is killed AND B's transcript finished row is already written BEFORE B closes on wire.
    await writeFile(
      file,
      [
        bgStartEntry(`${convId}/task-b`, "sleep 30"),
        bgStartEntry(`${convId}/task-a`, "sleep 30"),
        genericCancelEntry(`${convId}/task-a`),
        systemEndedEntry(`${convId}/task-b`, "finished"),
      ].join("\n") + "\n",
    );
    await harness.observer.sync();
    // Ambiguous (2 open calls vs 1 cancellation): must NOT cancel B!
    expect(harness.terminated).toEqual([]);

    // Once B's wire completion removes B from open calls, A is unambiguously canceled.
    harness.closeTool("call-b");
    await harness.observer.sync();
    expect(harness.terminated).toEqual([{ id: "call-a", state: "canceled" }]);

    // Trailing SYSTEM_MESSAGE for task-a must not poison a subsequent new run of sleep 30.
    harness.addTool(makeToolCall({ id: "call-c", input: { command_line: "sleep 30" } }));
    await appendFile(file, `${systemEndedEntry(`${convId}/task-a`, "was canceled")}\n`);
    await harness.observer.sync();
    expect(harness.terminated).toEqual([{ id: "call-a", state: "canceled" }]);
  });

  it("retires both pre-existing canceled and pre-existing running tasks during initial open baseline", async () => {
    const root = await makeBrainRoot();
    const convId = "66666666-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId);

    // Historical transcript has one already-canceled task and one still-running task whose cancel flushes later.
    await writeFile(
      file,
      [
        bgStartEntry(`${convId}/task-1`, "sleep 30"),
        genericCancelEntry(`${convId}/task-1`),
        bgStartEntry(`${convId}/task-old-running`, "sleep 45"),
      ].join("\n") + "\n",
    );

    const harness = createHarness(convId, root);
    await harness.observer.sync();

    // Brand-new runs must NOT claim either the already-canceled task or a late-flushing historical cancel.
    harness.addTool(makeToolCall({ id: "new-30", input: { command_line: "sleep 30" } }));
    harness.addTool(makeToolCall({ id: "new-45", input: { command_line: "sleep 45" } }));
    await appendFile(file, `${genericCancelEntry(`${convId}/task-old-running`)}\n`);
    await harness.observer.sync();
    expect(harness.terminated).toEqual([]);
  });

  it("does not let an in-flight scan discard a kill from the next prompt", async () => {
    const root = await makeBrainRoot();
    const convId = "88888888-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId);
    await writeFile(file, "");

    const harness = createHarness(convId, root);
    await harness.observer.sync();

    let pauseInFlightStat = false;
    let enteredPausedStat: (() => void) | null = null;
    let releasePausedStat: (() => void) | null = null;
    const pausedStatEntered = new Promise<void>((resolve) => {
      enteredPausedStat = resolve;
    });

    fsHookControl.onStat = async (target) => {
      if (!pauseInFlightStat || !target.endsWith("transcript_full.jsonl")) return;
      pauseInFlightStat = false;
      enteredPausedStat?.();
      await new Promise<void>((resolve) => {
        releasePausedStat = resolve;
      });
    };

    // Turn 1 opens and triggers a scan paused inside stat().
    pauseInFlightStat = true;
    harness.addTool(makeToolCall({ id: "turn1-call", input: { command_line: "sleep 10" } }));
    await pausedStatEntered;

    // While the scan is still in flight, Turn 1 closes and Turn 2 opens + kills sleep 30.
    harness.closeTool("turn1-call");
    harness.addTool(makeToolCall({ id: "turn2-call", input: { command_line: "sleep 30" } }));
    await appendFile(
      file,
      [
        bgStartEntry(`${convId}/task-turn2`, "sleep 30"),
        genericCancelEntry(`${convId}/task-turn2`),
      ].join("\n") + "\n",
    );

    releasePausedStat?.();
    await harness.observer.sync();
    expect(harness.terminated).toEqual([{ id: "turn2-call", state: "canceled" }]);
  });

  it("resolves sync() in a bounded pass even when stat() is slower than reconcileIntervalMs", async () => {
    const root = await makeBrainRoot();
    const convId = "99999999-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId);
    await writeFile(file, `${bgStartEntry(`${convId}/task-slow`, "sleep 30")}\n`);

    const harness = createHarness(convId, root, [], 10);
    await harness.observer.sync();

    fsHookControl.onStat = async (target) => {
      if (target.endsWith("transcript_full.jsonl")) {
        await new Promise((resolve) => setTimeout(resolve, 35));
      }
    };

    harness.addTool(makeToolCall({ id: "slow-stat-call", input: { command_line: "sleep 30" } }));
    const startedAt = Date.now();
    await harness.observer.sync();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500);
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

  it("does not let a late-flushing older cancellation cancel a fresh call opened later", async () => {
    const root = await makeBrainRoot();
    const convId = "aaaaaaaa-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId);
    await writeFile(file, "");

    let clockMs = Date.parse("2026-11-23T08:50:00-08:00");
    const harness = createHarness(convId, root, [], 25, () => clockMs);
    await harness.observer.sync();

    // An older run's start + cancellation rows flush AFTER the initial baseline while idle.
    await appendFile(
      file,
      [
        bgStartEntry(`${convId}/task-old`, "sleep 30", "2026-11-23T08:49:50-08:00"),
        genericCancelEntry(`${convId}/task-old`, "2026-11-23T08:49:55-08:00"),
      ].join("\n") + "\n",
    );

    // A brand-new call with the same command opens later before its own start row is written.
    clockMs = Date.parse("2026-11-23T08:50:05-08:00");
    harness.addTool(makeToolCall({ id: "call-fresh", input: { command_line: "sleep 30" } }));
    await harness.observer.sync();
    expect(harness.terminated).toEqual([]);

    // Once the fresh call's own task starts and is canceled, the fresh call is canceled.
    await appendFile(
      file,
      [
        bgStartEntry(`${convId}/task-fresh`, "sleep 30", "2026-11-23T08:50:05-08:00"),
        genericCancelEntry(`${convId}/task-fresh`, "2026-11-23T08:50:06-08:00"),
      ].join("\n") + "\n",
    );
    await harness.observer.sync();
    expect(harness.terminated).toEqual([{ id: "call-fresh", state: "canceled" }]);
  });

  it("does not retire a brand-new task when an in-flight scan reads it just before ACP delivers the wire call", async () => {
    const root = await makeBrainRoot();
    const convId = "bbbbbbbb-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId);
    await writeFile(file, "");

    let clockMs = Date.parse("2026-11-23T08:51:00-08:00");
    const harness = createHarness(convId, root, [], 25, () => clockMs);
    await harness.observer.sync();

    // New task's start + kill land in the transcript and an idle scan reads them BEFORE ACP delivers call-new.
    await appendFile(
      file,
      [
        bgStartEntry(`${convId}/task-early`, "sleep 30", "2026-11-23T08:51:00-08:00"),
        genericCancelEntry(`${convId}/task-early`, "2026-11-23T08:51:00-08:00"),
      ].join("\n") + "\n",
    );
    await harness.observer.sync();
    expect(harness.terminated).toEqual([]);

    // 100ms later (even across a second boundary), ACP delivers call-new on the wire.
    clockMs = Date.parse("2026-11-23T08:51:01.050-08:00");
    harness.addTool(makeToolCall({ id: "call-early", input: { command_line: "sleep 30" } }));
    await harness.observer.sync();
    expect(harness.terminated).toEqual([{ id: "call-early", state: "canceled" }]);
  });

  it("caps each read pass at the stat snapshot size instead of chasing bytes appended mid-read", async () => {
    const root = await makeBrainRoot();
    const convId = "cccccccc-2222-3333-4444-555555555555";
    const file = await transcriptFile(root, convId);
    await writeFile(file, "");

    const harness = createHarness(convId, root);
    await harness.observer.sync();

    harness.addTool(makeToolCall({ id: "call-bounded", input: { command_line: "sleep 30" } }));
    await writeFile(file, `${bgStartEntry(`${convId}/task-bounded`, "sleep 30")}\n`);

    let appendedMidRead = false;
    fsHookControl.onRead = async (target, callIndex) => {
      if (!appendedMidRead && callIndex === 1 && target.endsWith("transcript_full.jsonl")) {
        appendedMidRead = true;
        // Append the cancel line AFTER stat() returned the initial size and while read() is running.
        await appendFile(file, `${genericCancelEntry(`${convId}/task-bounded`)}\n`);
      }
    };

    // First sync must stop at the stat snapshot size and NOT chase the mid-read append.
    await harness.observer.sync();
    expect(appendedMidRead).toBe(true);
    expect(harness.terminated).toEqual([]);

    // Next sync picks up the newly appended cancel line cleanly.
    fsHookControl.onRead = null;
    await harness.observer.sync();
    expect(harness.terminated).toEqual([{ id: "call-bounded", state: "canceled" }]);
  });
});
