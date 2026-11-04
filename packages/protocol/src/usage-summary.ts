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

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Whether a model-scoped window limits the given model. The window's model key comes from
 * its id (`weekly_model_<key>`) or, for older fetchers, its label (`Weekly · <name>`); it
 * matches when every key token appears in the model id, so `weekly_model_sonnet` limits
 * `claude-sonnet-5-5` and `sonnet`, but not `claude-opus-5-5`.
 */
export function windowLimitsModel(
  window: Pick<UsageWindow, "id" | "label">,
  model: string | null | undefined,
): boolean {
  if (!model || windowScope(window) !== "model") return false;
  const key = MODEL_ID.test(window.id)
    ? window.id.replace(MODEL_ID, "")
    : window.label.replace(/^weekly\s*[-·:]\s*/i, "");
  const keyTokens = tokens(key);
  const modelTokens = new Set(tokens(model));
  return keyTokens.length > 0 && keyTokens.every((token) => modelTokens.has(token));
}

export interface SummarizeUsageOptions {
  now?: number;
  /**
   * The model the planned work runs on. Its matching model-scoped windows join the general
   * windows in the account allowance; other scoped windows stay informational.
   */
  model?: string | null;
}

export function summarizeUsage(usage: Usage, options: SummarizeUsageOptions = {}) {
  const now = options.now ?? Date.now();
  const model = options.model ?? null;
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
      // Admission reads general windows, plus the model windows of the requested model. A
      // spent code-review or other-model window does not refuse ordinary work, and a missing
      // value there does not make the account unknown; those are reported in `scoped`.
      const admission = windows.filter((w) => w.scope === "general" || windowLimitsModel(w, model));
      const scoped = windows
        .filter((w) => w.scope !== "general")
        .map((w) => ({
          id: w.id,
          label: w.label,
          scope: w.scope,
          allowance: w.allowance,
          remainingPct: w.remainingPct,
          resetsAt: w.resetsAt,
          appliesToModel: windowLimitsModel(w, model),
        }));
      let allowance: UsageAllowance = "unknown";
      let reason = "missing_or_invalid_windows";
      if (!fresh) reason = "stale_or_invalid_timestamp";
      else if (account.status !== "available") reason = "observation_unavailable";
      else if (
        admission.some((w) => w.scope === "general") &&
        admission.every((w) => w.allowance !== "unknown")
      ) {
        const exhausted = admission.some((w) => w.allowance === "exhausted");
        allowance = exhausted ? "exhausted" : "remaining";
        if (exhausted) reason = "window_exhausted";
        else if (scoped.some((w) => !w.appliesToModel && w.allowance === "exhausted"))
          reason = "general_remaining_scoped_exhausted";
        else reason = "all_reported_windows_positive";
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
    model,
    routing: usage.accountRouting ?? null,
    resources,
  };
}
