import { expect, it } from "vitest";
import { summarizeUsage } from "./usage-summary.js";
const now = Date.parse("2026-10-31T00:00:00Z");
const source = {
  providerId: "codex",
  displayName: "Codex",
  planLabel: null,
  status: "available" as const,
  windows: [{ id: "weekly", label: "Weekly", remainingPct: 90 }],
};
it("keeps exhausted and missing account windows separate from aggregate capacity", () => {
  const result = summarizeUsage(
    {
      fetchedAt: new Date(now).toISOString(),
      providers: [
        {
          ...source,
          accounts: [
            { ...source, accountId: "plus", windows: [{ id: "5h", label: "5h", remainingPct: 0 }] },
            { ...source, accountId: "pro", windows: [] },
          ],
        },
      ],
    },
    now,
  );
  expect(result.resources.map((r) => r.allowance)).toEqual(["exhausted", "unknown"]);
  expect(result.resources.map((r) => r.executionAdmission)).toEqual([
    "not_assessed",
    "not_assessed",
  ]);
});
it("does not present stale, future, elapsed-reset or unavailable data as capacity", () => {
  const old = summarizeUsage(
    { fetchedAt: new Date(now - 301000).toISOString(), providers: [source] },
    now,
  );
  expect(old.resources[0]?.reason).toBe("stale_or_invalid_timestamp");
  const future = summarizeUsage(
    { fetchedAt: new Date(now + 1).toISOString(), providers: [source] },
    now,
  );
  expect(future.resources[0]?.allowance).toBe("unknown");
  const reset = summarizeUsage(
    {
      fetchedAt: new Date(now).toISOString(),
      providers: [
        {
          ...source,
          windows: [
            { id: "5h", label: "5h", remainingPct: 80, resetsAt: new Date(now - 1).toISOString() },
          ],
        },
      ],
    },
    now,
  );
  expect(reset.resources[0]?.allowance).toBe("unknown");
});
it("strips raw error and detail strings from planning output", () => {
  const r = summarizeUsage(
    {
      fetchedAt: new Date(now).toISOString(),
      providers: [
        {
          ...source,
          status: "error",
          error: "secret",
          details: [{ id: "x", label: "x", value: "secret" }],
        },
      ],
    },
    now,
  );
  expect(JSON.stringify(r)).not.toContain("secret");
  expect(r.resources[0]?.allowance).toBe("unknown");
});

it("does not fall back to aggregate quota when routed account discovery fails", () => {
  const r = summarizeUsage(
    { fetchedAt: new Date(now).toISOString(), providers: [{ ...source, accounts: [] }] },
    now,
  );
  expect(r.resources[0]?.allowance).toBe("unknown");
});
