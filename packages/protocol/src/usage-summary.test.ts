import { expect, it } from "vitest";
import { summarizeUsage, windowScope } from "./usage-summary.js";
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

const fresh = new Date(now).toISOString();
const reset = new Date(now + 3_600_000).toISOString();

it("classifies window scope from the usage sources' window identities", () => {
  expect(windowScope({ id: "session", label: "Session" })).toBe("general");
  expect(windowScope({ id: "weekly", label: "Weekly" })).toBe("general");
  expect(windowScope({ id: "unknown_primary", label: "Primary limit" })).toBe("general");
  expect(windowScope({ id: "code_review", label: "Code review" })).toBe("surface");
  expect(windowScope({ id: "code_review:weekly", label: "Code review · Weekly" })).toBe("surface");
  expect(windowScope({ id: "limit:spark:weekly", label: "Spark · Weekly" })).toBe("surface");
  expect(windowScope({ id: "weekly_model_opus", label: "Weekly · Opus" })).toBe("model");
  expect(windowScope({ id: "weekly_surface_code", label: "Weekly · Code" })).toBe("surface");
  expect(windowScope({ id: "seven_day_opus", label: "Weekly - Opus" })).toBe("model");
});

it("does not let a Codex code review window without a percent make the account unknown", () => {
  const r = summarizeUsage(
    {
      fetchedAt: fresh,
      providers: [
        {
          ...source,
          windows: [
            { id: "session", label: "5-hour", remainingPct: 60, resetsAt: reset },
            { id: "weekly", label: "Weekly", remainingPct: 80, resetsAt: reset },
            { id: "code_review", label: "Code review", usedPct: null, remainingPct: null },
          ],
        },
      ],
    },
    now,
  );
  expect(r.resources[0]?.allowance).toBe("remaining");
  expect(r.resources[0]?.reason).toBe("all_reported_windows_positive");
  expect(r.resources[0]?.scoped).toEqual([
    { id: "code_review", label: "Code review", scope: "surface", allowance: "unknown" },
  ]);
});

it("reports an exhausted per-model window separately from general admission", () => {
  const r = summarizeUsage(
    {
      fetchedAt: fresh,
      providers: [
        {
          ...source,
          providerId: "claude",
          windows: [
            { id: "five_hour", label: "Session", remainingPct: 70, resetsAt: reset },
            { id: "weekly", label: "Weekly", remainingPct: 50, resetsAt: reset },
            { id: "seven_day_opus", label: "Weekly - Opus", remainingPct: 0, resetsAt: reset },
            { id: "weekly_model_fable", label: "Weekly · Fable", remainingPct: 0 },
          ],
        },
      ],
    },
    now,
  );
  const resource = r.resources[0];
  expect(resource?.allowance).toBe("remaining");
  expect(resource?.scoped.map((w) => [w.id, w.scope, w.allowance])).toEqual([
    ["seven_day_opus", "model", "exhausted"],
    ["weekly_model_fable", "model", "exhausted"],
  ]);
  expect(resource?.windows.map((w) => w.scope)).toEqual(["general", "general", "model", "model"]);
});

it("still refuses general admission when a general window is exhausted or missing", () => {
  const exhausted = summarizeUsage(
    {
      fetchedAt: fresh,
      providers: [
        {
          ...source,
          windows: [
            { id: "session", label: "5-hour", remainingPct: 0, resetsAt: reset },
            { id: "code_review", label: "Code review", remainingPct: 100 },
          ],
        },
      ],
    },
    now,
  );
  expect(exhausted.resources[0]?.allowance).toBe("exhausted");
  const missing = summarizeUsage(
    {
      fetchedAt: fresh,
      providers: [
        {
          ...source,
          windows: [
            { id: "session", label: "5-hour", remainingPct: null },
            { id: "weekly", label: "Weekly", remainingPct: 40 },
          ],
        },
      ],
    },
    now,
  );
  expect(missing.resources[0]?.allowance).toBe("unknown");
});

it("keeps allowance unknown when only scoped windows are reported", () => {
  const r = summarizeUsage(
    {
      fetchedAt: fresh,
      providers: [
        { ...source, windows: [{ id: "code_review", label: "Code review", remainingPct: 90 }] },
      ],
    },
    now,
  );
  expect(r.resources[0]?.allowance).toBe("unknown");
  expect(r.resources[0]?.reason).toBe("missing_or_invalid_windows");
  expect(r.resources[0]?.scoped[0]?.allowance).toBe("remaining");
});
