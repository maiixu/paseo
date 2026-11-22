import { useCallback } from "react";
import { useSessionStore } from "@/stores/session-store";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { ProviderUsageTooltipSection } from "@/provider-usage/tooltip-section";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { UsageCard } from "./card";
import { useUsageDisplay } from "./display";
import { useAgentUsage } from "./queries";
import type { UsageReportEntry } from "./types";

/**
 * The usage of the account an agent runs under, for its context window details: one card per
 * report in the user's card order, without pins. Nothing on hosts that cannot report usage, or for an
 * agent with no account to report.
 */
export function AgentUsage({
  serverId,
  agentId,
  refreshable,
}: {
  serverId: string;
  agentId: string;
  /** Whether each card has a Refresh button; a surface that cannot be pressed hides it. */
  refreshable: boolean;
}) {
  const useLegacyCodexUsage = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return (
      session?.agents.get(agentId)?.provider === "codex" &&
      session.serverInfo?.features?.providerUsageList === true &&
      session.serverInfo.features.usageSources !== true
    );
  });
  if (useLegacyCodexUsage)
    return <RoutedCodexUsage serverId={serverId} agentId={agentId} refreshable={refreshable} />;
  return <PluginAgentUsage serverId={serverId} agentId={agentId} refreshable={refreshable} />;
}

function RoutedCodexUsage({
  serverId,
  agentId,
  refreshable,
}: {
  serverId: string;
  agentId: string;
  refreshable: boolean;
}) {
  const { view, refresh } = useProviderUsage(serverId, { agentId });
  const onRefresh = useCallback(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  return (
    <ProviderUsageTooltipSection
      view={view}
      activeProviderId="codex"
      onRefresh={refreshable ? onRefresh : undefined}
    />
  );
}

function PluginAgentUsage({
  serverId,
  agentId,
  refreshable,
}: {
  serverId: string;
  agentId: string;
  refreshable: boolean;
}) {
  const { t } = useTranslation();
  const view = useAgentUsage(serverId, agentId);
  if (view.kind === "none") return null;
  return (
    <>
      <View style={styles.divider} />
      {view.kind === "ready" ? (
        <AgentUsageCards
          serverId={serverId}
          agentId={agentId}
          reports={view.reports}
          refreshable={refreshable}
        />
      ) : (
        <Text style={styles.message}>
          {view.kind === "loading" ? t("providerUsage.loading") : view.message}
        </Text>
      )}
    </>
  );
}

function AgentUsageCards({
  serverId,
  agentId,
  reports,
  refreshable,
}: {
  serverId: string;
  agentId: string;
  reports: readonly UsageReportEntry[];
  refreshable: boolean;
}) {
  const { display } = useUsageDisplay(reports);
  const arranged = useMemo(() => display.arrange(reports), [display, reports]);
  return arranged.map((entry) => (
    <UsageCard
      key={entry.id}
      serverId={serverId}
      agentId={agentId}
      entry={entry}
      display={display}
      compact
      pinnable={false}
      refreshable={refreshable}
    />
  ));
}

const styles = StyleSheet.create((theme) => ({
  divider: { height: 1, backgroundColor: theme.colors.borderAccent },
  message: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
