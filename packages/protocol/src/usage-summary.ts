import type { ProviderUsageListResponseMessage } from "./messages.js";

type Usage = Omit<ProviderUsageListResponseMessage["payload"], "requestId">;
export function summarizeUsage(usage: Usage, now = Date.now()) {
  const resources = usage.providers.flatMap((provider) => {
    // Empty account windows must not inherit the aggregate provider allowance.
    const accounts = provider.accounts?.length ? provider.accounts : [provider];
    return accounts.map((account) => {
      const accountId = "accountId" in account ? account.accountId : null;
      const fetchedAt = account.fetchedAt ?? provider.fetchedAt ?? usage.fetchedAt;
      const timestamp = Date.parse(fetchedAt);
      const age = now - timestamp;
      const fresh = Number.isFinite(age) && age >= 0 && age <= 300_000;
      const windows = account.windows.map((w) => ({
        id: w.id,
        label: w.label,
        remainingPct: w.remainingPct ?? null,
        usedPct: w.usedPct ?? null,
        resetsAt: w.resetsAt ?? null,
      }));
      const valid =
        windows.length > 0 &&
        windows.every((w) => {
          const remaining = w.remainingPct;
          const validPercent =
            typeof remaining === "number" &&
            Number.isFinite(remaining) &&
            remaining >= 0 &&
            remaining <= 100;
          const validReset = w.resetsAt === null || Date.parse(w.resetsAt) > now;
          return validPercent && validReset;
        });
      let allowance = "unknown";
      let reason = "missing_or_invalid_windows";
      if (!fresh) reason = "stale_or_invalid_timestamp";
      else if (account.status !== "available") reason = "observation_unavailable";
      else if (valid) {
        const exhausted = windows.some((w) => w.remainingPct === 0);
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
