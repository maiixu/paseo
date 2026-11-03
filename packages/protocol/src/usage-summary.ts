import type { ProviderUsageListResponseMessage } from "./messages.js";

type Usage = Omit<ProviderUsageListResponseMessage["payload"], "requestId">;
type UsageWindow = Usage["providers"][number]["windows"][number];

/**
 * What a quota window limits. Only `general` windows gate every request on the account;
 * `model` and `surface` windows limit one model or one feature (such as Codex code review)
 * and cannot admit or refuse ordinary work.
 */
export type UsageWindowScope = "general" | "model" | "surface";
export type UsageAllowance = "remaining" | "exhausted" | "unknown";

// Window identities emitted by the usage sources. `code_review` and `limit:` come from
// Codex (`code_review_rate_limit`, `additional_rate_limits`; the API does not say whether a
// named additional limit is a model or a feature, so it counts as a surface); `weekly_model_` and
// `weekly_surface_` come from Claude's scoped `limits[]`. Labels of the form
// "Weekly · Opus" / "Weekly - Opus" are Claude per-model windows from older fetchers.
const SURFACE_ID = /^(code_review|limit:)/;
const MODEL_ID = /^weekly_model_/;
const SURFACE_SCOPED_ID = /^weekly_surface_/;
const MODEL_LABEL = /^weekly\s*[-·:]\s*\S/i;

export function windowScope(window: Pick<UsageWindow, "id" | "label">): UsageWindowScope {
  if (SURFACE_ID.test(window.id) || SURFACE_SCOPED_ID.test(window.id)) return "surface";
  if (MODEL_ID.test(window.id) || MODEL_LABEL.test(window.label)) return "model";
  return "general";
}

interface SummaryWindow {
  id: string;
  label: string;
  scope: UsageWindowScope;
  allowance: UsageAllowance;
  remainingPct: number | null;
  usedPct: number | null;
  resetsAt: string | null;
}

function windowAllowance(
  window: Pick<SummaryWindow, "remainingPct" | "resetsAt">,
  now: number,
): UsageAllowance {
  const remaining = window.remainingPct;
  const validPercent =
    typeof remaining === "number" &&
    Number.isFinite(remaining) &&
    remaining >= 0 &&
    remaining <= 100;
  const validReset = window.resetsAt === null || Date.parse(window.resetsAt) > now;
  if (!validPercent || !validReset) return "unknown";
  return remaining === 0 ? "exhausted" : "remaining";
}

export function summarizeUsage(usage: Usage, now = Date.now()) {
  const resources = usage.providers.flatMap((provider) => {
    // Empty account windows must not inherit the aggregate provider allowance.
    const accounts = [...(provider.accounts ?? [provider])];
    if (accounts.length === 0)
      accounts.push({ ...provider, accountId: "unknown", windows: [], status: "unavailable" });
    return accounts.map((account) => {
      const accountId = "accountId" in account ? account.accountId : null;
      const fetchedAt = account.fetchedAt ?? provider.fetchedAt ?? usage.fetchedAt;
      const timestamp = Date.parse(fetchedAt);
      const age = now - timestamp;
      const fresh = Number.isFinite(age) && age >= 0 && age <= 300_000;
      const windows: SummaryWindow[] = account.windows.map((w) => {
        const base = {
          remainingPct: w.remainingPct ?? null,
          usedPct: w.usedPct ?? null,
          resetsAt: w.resetsAt ?? null,
        };
        return {
          id: w.id,
          label: w.label,
          scope: windowScope(w),
          allowance: fresh ? windowAllowance(base, now) : "unknown",
          ...base,
        };
      });
      // General admission reads general windows only. A spent code-review or per-model
      // window does not refuse ordinary work, and a missing value there does not make the
      // account unknown; those windows are reported in `scoped` instead.
      const general = windows.filter((w) => w.scope === "general");
      const scoped = windows
        .filter((w) => w.scope !== "general")
        .map((w) => ({ id: w.id, label: w.label, scope: w.scope, allowance: w.allowance }));
      let allowance: UsageAllowance = "unknown";
      let reason = "missing_or_invalid_windows";
      if (!fresh) reason = "stale_or_invalid_timestamp";
      else if (account.status !== "available") reason = "observation_unavailable";
      else if (general.length > 0 && general.every((w) => w.allowance !== "unknown")) {
        const exhausted = general.some((w) => w.allowance === "exhausted");
        allowance = exhausted ? "exhausted" : "remaining";
        reason = exhausted ? "window_exhausted" : "all_reported_windows_positive";
      }
      return {
        provider: provider.providerId,
        account: accountId,
        fetchedAt,
        ageSeconds: fresh ? Math.floor(age / 1000) : null,
        allowance,
        reason,
        windows,
        scoped,
        executionAdmission: "not_assessed" as const,
      };
    });
  });
  return {
    observedAt: new Date(now).toISOString(),
    routing: usage.accountRouting ?? null,
    resources,
  };
}
