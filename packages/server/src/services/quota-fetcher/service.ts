import type { Logger } from "pino";
import { AccountRouterUsage } from "./account-router.js";
import type { ProviderUsageListResponseMessage } from "../../server/messages.js";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderUsageFetchers } from "./manifest.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import { unavailableUsage } from "./usage.js";

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
    if (!routed) return usage;
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
    return {
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
    };
  }

  private async listProviderUsage(options?: {
    forceRefresh?: boolean;
  }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    // Read enablement on every request: a disabled source's fetcher is never invoked, so its
    // credentials are never read and its API is never called. The cache is keyed by the
    // enabled set, so a source disabled after a fetch stops appearing immediately.
    const fetchers = this.fetchers.filter((fetcher) =>
      this.usageSources.isEnabled(fetcher.providerId),
    );
    const sourceKey = fetchers.map((fetcher) => fetcher.providerId).join("\n");
    if (
      !options?.forceRefresh &&
      this.cached &&
      this.cached.sourceKey === sourceKey &&
      nowMs - this.cached.fetchedAtMs < this.cacheTtlMs
    ) {
      return this.cached.result;
    }

    if (this.inFlight?.sourceKey === sourceKey) {
      return this.inFlight.request;
    }

    const request = this.fetchFreshUsage(nowMs, fetchers, sourceKey);
    this.inFlight = { sourceKey, request };
    try {
      return await request;
    } finally {
      if (this.inFlight?.request === request) {
        this.inFlight = null;
      }
    }
  }

  private async fetchFreshUsage(
    nowMs: number,
    fetchers: ProviderUsageFetcher[],
    sourceKey: string,
  ): Promise<ProviderUsageListResult> {
    const settled = await Promise.allSettled(fetchers.map((fetcher) => fetcher.fetchUsage()));
    const providers = settled.map((result, index) => {
      const fetcher = fetchers[index];
      if (result.status === "fulfilled") {
        return result.value;
      }
      this.logger.debug(
        { err: result.reason, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      return unavailableUsage({
        providerId: fetcher.providerId,
        displayName: fetcher.displayName,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    const result = { fetchedAt: new Date(nowMs).toISOString(), providers };
    this.cached = { fetchedAtMs: nowMs, sourceKey, result };
    return result;
  }
}
