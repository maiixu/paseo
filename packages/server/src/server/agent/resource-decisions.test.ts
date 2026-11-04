import { it, expect, vi } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceDecisions, createResourceDecisionRecorder } from "./resource-decisions.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { ManagedAgent } from "./agent-manager.js";
it("records real dispatch evidence and later state without private configuration", () => {
  const home = mkdtempSync(join(tmpdir(), "resource-decisions-"));
  try {
    const agent = {
      id: "task-a",
      lifecycle: "idle",
      provider: "codex",
      config: {
        provider: "codex",
        cwd: "/private/work",
        model: "model-a",
        thinkingOptionId: "medium",
        env: { SECRET: "never-log" },
      },
      labels: { "paseo.resource-reason": "bounded independent audit" },
    } as unknown as ManagedAgent;
    const log = new ResourceDecisions(home);
    log.dispatch(agent);
    log.observe(agent);
    log.observe({ ...agent, lifecycle: "running" } as ManagedAgent);
    const reopened = new ResourceDecisions(home);
    reopened.observe({ ...agent, lifecycle: "error" } as ManagedAgent);
    const file = join(home, "resource-decisions", "decisions.jsonl");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("never-log");
    expect(text).not.toContain("/private/work");
    expect(
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).status),
    ).toEqual(["idle", "running", "error"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function journalAgent(id: string, lifecycle: string): ManagedAgent {
  return {
    id,
    lifecycle,
    provider: "codex",
    config: { provider: "codex", cwd: "/w", model: "m", thinkingOptionId: "low" },
    labels: {},
  } as unknown as ManagedAgent;
}

it("loads an empty journal file and keeps recording", () => {
  const home = mkdtempSync(join(tmpdir(), "resource-decisions-"));
  try {
    const dir = join(home, "resource-decisions");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "decisions.jsonl");
    writeFileSync(file, "");
    const log = new ResourceDecisions(home);
    log.dispatch(journalAgent("a", "idle"));
    log.observe(journalAgent("a", "running"));
    const rows = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => row.status)).toEqual(["idle", "running"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("skips a truncated last line, keeps earlier state, and appends on a fresh line", () => {
  const home = mkdtempSync(join(tmpdir(), "resource-decisions-"));
  try {
    const first = new ResourceDecisions(home);
    first.dispatch(journalAgent("a", "idle"));
    const file = join(home, "resource-decisions", "decisions.jsonl");
    appendFileSync(file, '{"event":"dispatch","agentId":"b","sta');

    const reopened = new ResourceDecisions(home);
    // State loaded from the intact line still drives transitions.
    reopened.observe(journalAgent("a", "running"));
    reopened.dispatch(journalAgent("c", "idle"));

    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(() => JSON.parse(lines[1])).toThrow(SyntaxError);
    const parsed = [lines[0], lines[2], lines[3]].map((line) => JSON.parse(line));
    expect(parsed.map((row) => [row.agentId, row.status])).toEqual([
      ["a", "idle"],
      ["a", "running"],
      ["c", "idle"],
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function journalRows(home: string) {
  return readFileSync(join(home, "resource-decisions", "decisions.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const observedUsage = {
  fetchedAt: new Date().toISOString(),
  providers: [
    {
      providerId: "codex",
      displayName: "Codex",
      status: "available" as const,
      planLabel: null,
      windows: [{ id: "weekly", label: "Weekly", remainingPct: 40 }],
    },
  ],
};

it("journals create -> run -> idle even when usage discovery settles after the run", async () => {
  const home = mkdtempSync(join(tmpdir(), "resource-decisions-"));
  try {
    const decisions = new ResourceDecisions(home);
    const usage = deferred<typeof observedUsage>();
    const record = createResourceDecisionRecorder({
      decisions,
      getUsage: () => usage.promise,
      logger: createTestLogger(),
    });
    // createAgent returns a copy whose lifecycle stays "idle" while the live agent moves on.
    const snapshot = journalAgent("a", "idle");
    record(snapshot);
    decisions.observe(journalAgent("a", "running"));
    decisions.observe(journalAgent("a", "idle"));
    usage.resolve(observedUsage);
    await vi.waitFor(() => expect(journalRows(home)).toHaveLength(4));

    const rows = journalRows(home);
    expect(rows.map((row) => [row.event, row.status ?? row.observationState])).toEqual([
      ["dispatch", "idle"],
      ["state", "running"],
      ["state", "idle"],
      ["observation", "observed"],
    ]);
    expect(rows[0].observationState).toBe("pending");
    expect(rows[3].observation.resources[0].allowance).toBe("remaining");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("records an unavailable observation when discovery fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "resource-decisions-"));
  try {
    const decisions = new ResourceDecisions(home);
    createResourceDecisionRecorder({
      decisions,
      getUsage: async () => {
        throw new Error("discovery down");
      },
      logger: createTestLogger(),
    })(journalAgent("a", "idle"));
    await vi.waitFor(() => expect(journalRows(home)).toHaveLength(2));
    expect(journalRows(home)[1]).toMatchObject({
      event: "observation",
      observationState: "unavailable",
      unavailableReason: "error",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("records an unavailable observation when discovery outlasts the timeout", async () => {
  const home = mkdtempSync(join(tmpdir(), "resource-decisions-"));
  vi.useFakeTimers();
  try {
    const decisions = new ResourceDecisions(home);
    createResourceDecisionRecorder({
      decisions,
      getUsage: () => new Promise(() => {}),
      logger: createTestLogger(),
      timeoutMs: 1_000,
    })(journalAgent("a", "idle"));
    expect(journalRows(home)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(journalRows(home)[1]).toMatchObject({
      event: "observation",
      observationState: "unavailable",
      unavailableReason: "timeout",
    });
  } finally {
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  }
});

it("skips discovery entirely when the journal is unavailable", () => {
  const getUsage = vi.fn(async () => observedUsage);
  createResourceDecisionRecorder({ decisions: null, getUsage, logger: createTestLogger() })(
    journalAgent("a", "idle"),
  );
  expect(getUsage).not.toHaveBeenCalled();
});
