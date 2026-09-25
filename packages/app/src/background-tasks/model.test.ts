import { describe, expect, it } from "vitest";
import { parseManifest, taskSummary, type BackgroundTask } from "./model";
const task: BackgroundTask = {
  runId: "run1",
  agentId: "agent1",
  workspaceId: "wks1",
  label: "Photo backup",
  host: "cloudtop",
  phase: "verifying",
  progress: 100,
  observedAt: 1000,
  staleAfterSeconds: 120,
  continuation: "sent",
};
describe("background task observations", () => {
  it("binds manifest to the authenticated host and rejects duplicates", () => {
    expect(
      parseManifest(JSON.stringify({ version: 1, serverId: "srv1", tasks: [task] }), "srv1"),
    ).toEqual([task]);
    expect(() =>
      parseManifest(JSON.stringify({ version: 1, serverId: "srv2", tasks: [task] }), "srv1"),
    ).toThrow();
    expect(() =>
      parseManifest(JSON.stringify({ version: 1, serverId: "srv1", tasks: [task, task] }), "srv1"),
    ).toThrow();
  });
  it("keeps verification distinct from completion and expires observations", () => {
    expect(taskSummary(task, true, 1001)).toBe("Verifying · 100% · Continuation sent");
    expect(taskSummary(task, true, 1201)).toBe("Stale observation · Last known: Verifying");
    expect(taskSummary(task, false, 1001)).toBe("Unavailable · Last known: Verifying");
  });
  it("rejects invalid progress and preserves an explicit failure", () => {
    expect(() =>
      parseManifest(
        JSON.stringify({
          version: 1,
          serverId: "srv1",
          tasks: [{ ...task, progress: 101 }],
        }),
        "srv1",
      ),
    ).toThrow();
    expect(
      taskSummary({ ...task, phase: "failed", progress: null, continuation: "failed" }, true, 1001),
    ).toBe("Failed · Continuation failed");
  });
});
