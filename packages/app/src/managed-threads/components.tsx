import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { router } from "expo-router";
import { Button } from "@/components/ui/button";
import { useManagedThreadsStore } from "./store";
import { threadKey } from "./model";
import { threadSummary, formatCheckTime } from "./presentation";

export function ManagedThreadMeta({ workspaceKey }: { workspaceKey: string }) {
  const p = useManagedThreadsStore((s) => s.presentations[workspaceKey]);
  if (!p?.managed) return null;
  const next = formatCheckTime(p.nextRunAt);
  return (
    <Text style={styles.meta} numberOfLines={2} testID={`managed-thread-meta-${workspaceKey}`}>
      Bot managed · {threadSummary(p)}
      {next
        ? ` · ${p.state === "offline" || p.state === "unknown" ? "Last known next" : "Next"} ${next}`
        : ""}
    </Text>
  );
}
const openSchedules = () => router.push("/schedules");
export function ManagedThreadPanel({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const p = useManagedThreadsStore((s) => s.presentations[threadKey(serverId, workspaceId)]);
  if (!p?.managed) return null;
  const next = formatCheckTime(p.nextRunAt);
  let detail = "Open schedules to check this follow-up.";
  if (p.state === "unscheduled")
    detail = "Grouping does not create a schedule. Set up a follow-up to automate checks.";
  if (next) {
    const prefix =
      p.state === "offline" || p.state === "unknown" ? "Last known next check" : "Next check";
    detail = `${prefix}: ${next}`;
  }
  return (
    <View style={styles.panel} testID="managed-thread-panel">
      <View style={styles.copy}>
        <Text style={styles.title}>Bot managed · {threadSummary(p)}</Text>
        <Text style={styles.meta}>{detail}</Text>
      </View>
      <Button variant="ghost" size="sm" onPress={openSchedules}>
        Schedules
      </Button>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  meta: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted, lineHeight: 16 },
  title: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  panel: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  copy: { flex: 1, gap: 4 },
}));
