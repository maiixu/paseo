import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useBackgroundTasks } from "./store";
import { taskSummary } from "./model";
export function BackgroundTaskMeta({ workspaceKey }: { workspaceKey: string }) {
  const hosts = useBackgroundTasks((s) => s.hosts);
  const now = useBackgroundTasks((s) => s.now);
  const entries = Object.entries(hosts).flatMap(([id, h]) =>
    h.tasks
      .filter((t) => `${id}:${t.workspaceId}` === workspaceKey && t.phase !== "complete")
      .map((t) => ({ t, online: h.online })),
  );
  if (!entries.length) return null;
  const unknown = entries.some(
    ({ t, online }) => !online || now - t.observedAt > t.staleAfterSeconds,
  );
  let status = "Work pending";
  if (entries.some(({ t }) => t.phase === "failed")) status = "Needs attention";
  if (unknown) status = "Status unavailable/stale";
  return (
    <Text style={styles.meta} numberOfLines={2} testID="background-task-meta">
      Background: {entries.length} · {status}
    </Text>
  );
}
export function BackgroundTaskPanel({
  serverId,
  workspaceId,
  agentId,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string | null;
}) {
  const host = useBackgroundTasks((s) => s.hosts[serverId]);
  const now = useBackgroundTasks((s) => s.now);
  const tasks =
    host?.tasks.filter((t) => t.workspaceId === workspaceId && t.agentId === agentId) ?? [];
  if (!tasks.length) return null;
  return (
    <View style={styles.panel} testID="background-task-panel">
      {tasks.map((t) => (
        <View key={t.runId} style={styles.row}>
          <Text style={styles.title}>
            {t.label} · {t.host}
          </Text>
          <Text style={styles.meta}>{taskSummary(t, host?.online ?? false, now)}</Text>
          <Text style={styles.meta}>
            Last observed: {new Date(t.observedAt * 1000).toLocaleString()}
          </Text>
        </View>
      ))}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  panel: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  row: { gap: 3 },
  title: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  meta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 16,
  },
}));

export function WorkspaceBackgroundTaskPanel({
  serverId,
  workspaceId,
  tab,
}: {
  serverId: string;
  workspaceId: string;
  tab: WorkspaceTabDescriptor | null;
}) {
  const agentId = tab?.target.kind === "agent" ? tab.target.agentId : null;
  return <BackgroundTaskPanel serverId={serverId} workspaceId={workspaceId} agentId={agentId} />;
}
