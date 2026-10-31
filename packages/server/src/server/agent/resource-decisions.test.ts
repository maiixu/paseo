import { it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
