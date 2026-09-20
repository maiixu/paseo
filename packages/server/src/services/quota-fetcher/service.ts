import type { Logger } from "pino";
import { AccountRouterUsage } from "./account-router.js";
import type { ProviderUsageListResponseMessage } from "../../server/messages.js";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderUsageFetchers } from "./manifest.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import { unavailableUsage } from "./usage.js";

export interface ProviderUsageServiceOptions {
  logger: Logger;
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
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cached: { fetchedAtMs: number; result: ProviderUsageListResult } | null = null;
  private inFlight: Promise<ProviderUsageListResult> | null = null;

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
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async listUsage(options?: {
    forceRefresh?: boolean;
    agentId?: string;
  }): Promise<ProviderUsageListResult> {
    const [usage, routed] = await Promise.all([
      this.listProviderUsage(options),
      this.accountRouter?.read(options?.agentId).catch(() => ({ accounts: [] })) ?? null,
    ]);
    if (!routed) return usage;
    return {
      ...usage,
      providers: usage.providers.map((provider) =>
        provider.providerId === "codex"
          ? Object.assign(
              {},
              provider,
              { accounts: routed.accounts },
              routed.accounts.length === 0 ? { error: "Account router usage is unavailable" } : {},
            )
          : provider,
      ),
      ...("routing" in routed && routed.routing ? { accountRouting: routed.routing } : {}),
    };
  }

  private async listProviderUsage(options?: {
    forceRefresh?: boolean;
  }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    if (
      !options?.forceRefresh &&
      this.cached &&
      nowMs - this.cached.fetchedAtMs < this.cacheTtlMs
    ) {
      return this.cached.result;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    const request = this.fetchFreshUsage(nowMs);
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) {
        this.inFlight = null;
      }
    }
  }

  private async fetchFreshUsage(nowMs: number): Promise<ProviderUsageListResult> {
    const settled = await Promise.allSettled(this.fetchers.map((fetcher) => fetcher.fetchUsage()));
    const providers = settled.map((result, index) => {
      const fetcher = this.fetchers[index];
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
    this.cached = { fetchedAtMs: nowMs, result };
    return result;
  }
}
