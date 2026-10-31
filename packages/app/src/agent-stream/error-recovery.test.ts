import { describe, it, expect } from "vitest";
import { latestSubstantiveActivity, errorRecoveryState } from "./error-recovery";
describe("error recovery evidence", () => {
  it("does not call a running label or new user prompt recovery", () => {
    const at = latestSubstantiveActivity([{ kind: "user_message", timestamp: new Date(300) }]);
    expect(errorRecoveryState(100, at, "running")).toBe("unconfirmed");
    expect(errorRecoveryState(100, at, "error")).toBe("blocked");
  });
  it("marks old errors historical only after actual newer output", () => {
    const at = latestSubstantiveActivity([
      { kind: "assistant_message", timestamp: new Date(300), text: "Checked the receipt" },
    ]);
    expect(errorRecoveryState(100, at, "running")).toBe("historical");
    expect(errorRecoveryState(400, at, "error")).toBe("blocked");
  });
  it("excludes failed/unfinished tools, queue notices and other errors", () => {
    const at = latestSubstantiveActivity([
      { kind: "tool_call", timestamp: new Date(300), payload: { data: { status: "running" } } },
      { kind: "tool_call", timestamp: new Date(400), payload: { data: { status: "failed" } } },
      { kind: "assistant_message", timestamp: new Date(500), text: "[System Error] second error" },
      { kind: "assistant_message", timestamp: new Date(600), text: "Queued: waiting" },
      { kind: "tool_call", timestamp: new Date(200), payload: { data: { status: "completed" } } },
    ]);
    expect(at).toBe(200);
  });
});
