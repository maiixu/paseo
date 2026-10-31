import type { ProviderUsageService } from "../../../services/quota-fetcher/service.js";
import type { ListUsageReportsOptions } from "../../plugins/usage-sources/index.js";
import type pino from "pino";
import type { ProviderUsage, UsageReportEntry } from "@getpaseo/protocol/messages";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";

export interface UsageSessionOptions {
  emit(message: SessionOutboundMessage): void;
  runtime?: {
    listUsageReports(options: ListUsageReportsOptions): Promise<UsageReportEntry[]>;
    listLegacyUsage(): Promise<{ fetchedAt: string; providers: ProviderUsage[] }>;
  };
  routedUsage?: Pick<ProviderUsageService, "listRoutedUsage">;
  logger: pino.Logger;
}

type RoutedUsage = NonNullable<Awaited<ReturnType<ProviderUsageService["listRoutedUsage"]>>>;
function routedAccountReport(
  account: RoutedUsage["accounts"][number],
  routing: RoutedUsage["routing"],
): UsageReportEntry {
  const id = `codex-router:${account.accountId}`;
  return {
    id,
    account: { label: account.displayName },
    fetchedAt: account.fetchedAt ?? new Date(0).toISOString(),
    sourceId: "codex-router",
    sourceLabel: "Codex accounts",
    icon: "codex",
    report:
      account.status === "available"
        ? {
            status: "available",
            windows: account.windows,
            ...(account.planLabel ? { planLabel: account.planLabel } : {}),
            ...(account.balances ? { balances: account.balances } : {}),
            details: [
              ...(account.details ?? []),
              ...(routing
                ? [
                    {
                      id: "route",
                      label: "Current account",
                      value: `${routing.accountId ?? "Unknown"} · ${routing.phase ?? routing.status}`,
                    },
                  ]
                : []),
            ],
          }
        : { status: "error", error: account.error ?? "Account usage unavailable" },
  };
}

export class UsageSession {
  constructor(private readonly options: UsageSessionOptions) {}

  async handleListReports(
    msg: Extract<SessionInboundMessage, { type: "usage.list_reports.request" }>,
  ): Promise<void> {
    try {
      if (!this.options.runtime) throw new Error("Plugin runtime is unavailable");
      const routed = await this.options.routedUsage?.listRoutedUsage(msg.agentId, msg.forceRefresh);
      const useRouted = Boolean(routed && (!msg.agentId || routed.routing));
      const emitReport = (report: UsageReportEntry) =>
        this.options.emit({
          type: "usage.list_reports.update",
          payload: { requestId: msg.requestId, report },
        });
      if (useRouted && routed) {
        for (const account of routed.accounts) {
          const id = `codex-router:${account.accountId}`;
          if (msg.reportIds && !msg.reportIds.includes(id)) continue;
          emitReport(routedAccountReport(account, routed.routing));
        }
      }
      await this.options.runtime.listUsageReports({
        forceRefresh: msg.forceRefresh,
        reportIds: msg.reportIds?.filter((id) => !useRouted || !id.startsWith("codex-router:")),
        agentId: msg.agentId,
        onReport: (report) => {
          if (!useRouted || report.sourceId !== "codex") emitReport(report);
        },
      });
      this.options.emit({
        type: "usage.list_reports.response",
        payload: { requestId: msg.requestId, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "usage.list_reports.response",
        payload: {
          requestId: msg.requestId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  // COMPAT(providerUsageList): added in v0.9.3, remove after 2027-03-26.
  async handleLegacyList(
    msg: Extract<SessionInboundMessage, { type: "provider.usage.list.request" }>,
  ): Promise<void> {
    try {
      if (!this.options.runtime) throw new Error("Plugin runtime is unavailable");
      const usage = await this.options.runtime.listLegacyUsage();
      const routed = await this.options.routedUsage?.listRoutedUsage(msg.agentId);
      if (routed) {
        const codex = usage.providers.find((p) => p.providerId === "codex");
        if (codex) codex.accounts = routed.accounts;
        else
          usage.providers.push({
            providerId: "codex",
            displayName: "Codex accounts",
            status: "available",
            planLabel: null,
            windows: [],
            accounts: routed.accounts,
          });
      }
      this.options.emit({
        type: "provider.usage.list.response",
        payload: {
          requestId: msg.requestId,
          fetchedAt: usage.fetchedAt,
          providers: usage.providers,
          ...(routed?.routing ? { accountRouting: routed.routing } : {}),
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.options.logger.error({ err }, "Failed to list provider usage");
      this.options.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to list provider usage: ${err.message}`,
          code: "provider_usage_list_failed",
        },
      });
    }
  }
}
