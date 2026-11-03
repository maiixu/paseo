import type { Logger } from "pino";
import { AccountRouterUsage } from "./account-router.js";
import type { ProviderUsageListResponseMessage } from "../../server/messages.js";
import type { ProviderUsage } from "../../server/messages.js";

/**
 * Provider usage owned by the plugin runtime. Each usage source is a plugin, so a source the
 * user disabled is never registered and its credentials are never read.
 */
export interface PluginUsageSource {
  listLegacyUsage(): Promise<{ fetchedAt: string; providers: ProviderUsage[] }>;
}

export interface ProviderUsageServiceOptions {
  logger: Logger;
  pluginUsage?: PluginUsageSource | null;
  now?: () => number;
  accountRouter?: ConstructorParameters<typeof AccountRouterUsage>[0];
}

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
  accountRouting?: ProviderUsageListResponseMessage["payload"]["accountRouting"];
}

/**
 * The fork's usage service reads only the Codex account router configured in the live Codex
 * command. Every other provider comes from the plugin runtime, which respects the plugin and
 * usage-source enablement settings and owns the fetch cache.
 */
export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly accountRouter: AccountRouterUsage | null;
  private readonly pluginUsage: PluginUsageSource | null;
  private readonly now: () => number;

  constructor(options: ProviderUsageServiceOptions) {
    this.accountRouter = options.accountRouter
      ? new AccountRouterUsage(options.accountRouter)
      : null;
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.pluginUsage = options.pluginUsage ?? null;
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
      this.listPluginUsage(),
      this.accountRouter
        ?.read(options?.agentId, options?.forceRefresh)
        .catch(() => ({ accounts: [] })) ?? null,
    ]);
    if (!routed) return usage;
    const routedFields = (provider: ProviderUsage): ProviderUsage =>
      Object.assign(
        {},
        provider,
        { accounts: routed.accounts },
        routed.accounts.length === 0 ? { error: "Account router usage is unavailable" } : {},
      );
    const hasCodex = usage.providers.some((provider) => provider.providerId === "codex");
    const providers = hasCodex
      ? usage.providers.map((provider) =>
          provider.providerId === "codex" ? routedFields(provider) : provider,
        )
      : [
          ...usage.providers,
          routedFields({
            providerId: "codex",
            displayName: "Codex accounts",
            status: routed.accounts.length > 0 ? "available" : "unavailable",
            planLabel: null,
            windows: [],
          }),
        ];
    return {
      ...usage,
      providers,
      ...("routing" in routed && routed.routing ? { accountRouting: routed.routing } : {}),
    };
  }

  private async listPluginUsage(): Promise<ProviderUsageListResult> {
    const empty = { fetchedAt: new Date(this.now()).toISOString(), providers: [] };
    if (!this.pluginUsage) return empty;
    try {
      return await this.pluginUsage.listLegacyUsage();
    } catch (err) {
      this.logger.debug({ err }, "Plugin usage sources are unavailable");
      return empty;
    }
  }
}
