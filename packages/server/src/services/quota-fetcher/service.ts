import type { Logger } from "pino";
import { AccountRouterUsage } from "./account-router.js";
import type { ProviderUsageListResponseMessage } from "../../server/messages.js";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderUsageFetchers } from "./manifest.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import { MIN_FORCED_REFRESH_INTERVAL_MS, unavailableUsage } from "./usage.js";

/**
 * The upstream plugin usage-source enablement. Each fetcher's `providerId` is the ID of the
 * plugin usage source for the same provider; a fetcher runs only while that source is enabled.
 */
export interface UsageSourceEnablement {
  isEnabled(sourceId: string): boolean;
}

export interface ProviderUsageServiceOptions {
  logger: Logger;
  usageSources: UsageSourceEnablement;
  fetchers?: ProviderUsageFetcher[];
  fetch?: ProviderApiFetch;
  cacheTtlMs?: number;
  now?: () => number;
  accountRouter?: ConstructorParameters<typeof AccountRouterUsage>[0];
}

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
  accountRouting?: ProviderUsageListResponseMessage["payload"]["accountRouting"];
}

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
export const USAGE_SOURCE_DISABLED_ERROR = "Usage source disabled";

export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly accountRouter: AccountRouterUsage | null;
  private readonly fetchers: ProviderUsageFetcher[];
  private readonly usageSources: UsageSourceEnablement;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cached: {
    fetchedAtMs: number;
    sourceKey: string;
    result: ProviderUsageListResult;
  } | null = null;
  private inFlight: { sourceKey: string; request: Promise<ProviderUsageListResult> } | null = null;
  private readonly lastSuccessful = new Map<
    string,
    { fetchedAtMs: number; usage: ProviderUsage }
  >();

  constructor(options: ProviderUsageServiceOptions) {
    this.accountRouter = options.accountRouter
      ? new AccountRouterUsage(options.accountRouter)
      : null;
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.fetchers =
      options.fetchers ??
      createProviderUsageFetchers({
        logger: this.logger,
        fetch: options.fetch,
      });
    this.usageSources = options.usageSources;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async listRoutedUsage(agentId?: string, forceRefresh = false) {
    return this.accountRouter?.read(agentId, forceRefresh) ?? null;
  }

  async listUsage(options?: {
    forceRefresh?: boolean;
    agentId?: string;
  }): Promise<ProviderUsageListResult> {
    const [usage, routed] = await Promise.all([
      this.listProviderUsage(options),
      this.accountRouter
        ?.read(options?.agentId, options?.forceRefresh)
        .catch(() => ({ accounts: [] })) ?? null,
    ]);
    if (!routed) return this.withDisabledSources(usage);
    const withAccounts = (provider: ProviderUsage): ProviderUsage =>
      Object.assign(
        {},
        provider,
        { accounts: routed.accounts },
        routed.accounts.length === 0 ? { error: "Account router usage is unavailable" } : {},
      );
    // The router reads each configured account's own auth file; it does not depend on the
    // codex usage source, so its accounts are reported even when that source is disabled.
    const hasCodex = usage.providers.some((provider) => provider.providerId === "codex");
    return this.withDisabledSources({
      ...usage,
      providers: hasCodex
        ? usage.providers.map((provider) =>
            provider.providerId === "codex" ? withAccounts(provider) : provider,
          )
        : [
            ...usage.providers,
            withAccounts({
              providerId: "codex",
              displayName: "Codex accounts",
              status: routed.accounts.length > 0 ? "available" : "unavailable",
              planLabel: null,
              windows: [],
            }),
          ],
      ...("routing" in routed && routed.routing ? { accountRouting: routed.routing } : {}),
    });
  }

  private async listProviderUsage(options?: {
    forceRefresh?: boolean;
  }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    // Read enablement on every request: a disabled source's fetcher is never invoked, so its
    // credentials are never read and its API is never called. The cache is keyed by the
    // enabled set, so a source disabled after a fetch stops reporting usage immediately.
    const fetchers = this.fetchers.filter((fetcher) =>
      this.usageSources.isEnabled(fetcher.providerId),
    );
    const sourceKey = fetchers.map((fetcher) => fetcher.providerId).join("\n");
    const cached = this.cached?.sourceKey === sourceKey ? this.cached : null;
    const cacheAgeMs = cached ? nowMs - cached.fetchedAtMs : null;
    // A forced refresh within the floor is served from the cache: repeated Refresh presses
    // must not turn into repeated upstream calls (and their rate limits).
    const forced =
      options?.forceRefresh === true &&
      (cacheAgeMs === null || cacheAgeMs >= MIN_FORCED_REFRESH_INTERVAL_MS);
    let result: ProviderUsageListResult;
    if (cached && cacheAgeMs !== null && !forced && cacheAgeMs < this.cacheTtlMs) {
      result = cached.result;
    } else if (this.inFlight?.sourceKey === sourceKey) {
      result = await this.inFlight.request;
    } else {
      const request = this.fetchFreshUsage(nowMs, fetchers);
      this.inFlight = { sourceKey, request };
      try {
        result = await request;
        // A request that another enabled set has superseded must not replace its cache.
        if (this.inFlight?.request === request) {
          this.cached = { fetchedAtMs: nowMs, sourceKey, result };
        }
      } finally {
        if (this.inFlight?.request === request) {
          this.inFlight = null;
        }
      }
    }
    return result;
  }

  /**
   * Every known provider stays in the response. A source that is not registered reports
   * unavailable without reading credentials or calling its API, so consumers that look a
   * provider up by ID always find it. Applied after the router merge, so routed Codex
   * accounts replace the placeholder rather than attaching to it.
   */
  private withDisabledSources(result: ProviderUsageListResult): ProviderUsageListResult {
    const fetched = new Map(result.providers.map((provider) => [provider.providerId, provider]));
    const providers = this.fetchers.map(
      (fetcher) =>
        fetched.get(fetcher.providerId) ?? {
          // A disabled source is not a failure: unavailable, with the reason as its error.
          ...unavailableUsage(fetcher),
          error: USAGE_SOURCE_DISABLED_ERROR,
        },
    );
    return { ...result, providers };
  }

  private async fetchFreshUsage(
    nowMs: number,
    fetchers: ProviderUsageFetcher[],
  ): Promise<ProviderUsageListResult> {
    const settled = await Promise.allSettled(fetchers.map((fetcher) => fetcher.fetchUsage()));
    const providers = settled.map((result, index) => {
      const fetcher = fetchers[index];
      if (result.status === "fulfilled") {
        const previous = this.lastSuccessful.get(fetcher.providerId);
        if (!previous || previous.fetchedAtMs <= nowMs) {
          this.lastSuccessful.set(fetcher.providerId, { fetchedAtMs: nowMs, usage: result.value });
        }
        return result.value;
      }
      this.logger.debug(
        { err: result.reason, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      const message =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      // A failed refresh (network error, rate limit, timeout) keeps the last good answer,
      // stamped with its own fetch time so freshness checks treat it as stale.
      const previous = this.lastSuccessful.get(fetcher.providerId);
      if (previous) return staleUsage({ previous, failure: message });
      return unavailableUsage({
        providerId: fetcher.providerId,
        displayName: fetcher.displayName,
        error: message,
      });
    });

    return { fetchedAt: new Date(nowMs).toISOString(), providers };
  }
}

function staleUsage(input: {
  previous: { fetchedAtMs: number; usage: ProviderUsage };
  failure: string;
}): ProviderUsage {
  const { previous, failure } = input;
  const fetchedAt = new Date(previous.fetchedAtMs).toISOString();
  return Object.assign({}, previous.usage, {
    fetchedAt,
    error: `Refresh failed (${failure}); showing usage from ${fetchedAt}`,
  });
}
