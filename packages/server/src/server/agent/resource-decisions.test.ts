import { it, expect } from "vitest";
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
import { ResourceDecisions } from "./resource-decisions.js";
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
    log.record(agent, null);
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
    log.record(journalAgent("a", "idle"), null);
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
    first.record(journalAgent("a", "idle"), null);
    const file = join(home, "resource-decisions", "decisions.jsonl");
    appendFileSync(file, '{"event":"dispatch","agentId":"b","sta');

    const reopened = new ResourceDecisions(home);
    // State loaded from the intact line still drives transitions.
    reopened.observe(journalAgent("a", "running"));
    reopened.record(journalAgent("c", "idle"), null);

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
