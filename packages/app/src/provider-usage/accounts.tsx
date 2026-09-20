import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ProviderUsageCard } from "./card";
import type { ProviderUsage, ProviderUsageListPayload } from "./types";

export function accountRouteLabel(routing: ProviderUsageListPayload["accountRouting"]): string {
  if (!routing || routing.status === "unknown") return "Current account unavailable";
  if (routing.status === "pending") return "Account not selected yet";
  const account = routing.accountId
    ? routing.accountId[0].toUpperCase() + routing.accountId.slice(1)
    : "Unknown";
  const label =
    routing.status === "legacy" ? `Original account: ${account}` : `Current account: ${account}`;
  if (routing.phase === "quota_wait") return `${label} · Waiting for quota`;
  if (routing.phase === "migrating") return `${label} · Switching accounts`;
  if (routing.phase === "needs_review") return `${label} · Recovery needs review`;
  return label;
}

function AccountUsageCard({
  account,
}: {
  account: NonNullable<ProviderUsage["accounts"]>[number];
}) {
  const display = useMemo(
    () => ({
      ...account,
      planLabel:
        account.planLabel?.toLowerCase() === account.accountId.toLowerCase()
          ? null
          : account.planLabel,
      displayName: account.displayName.charAt(0).toUpperCase() + account.displayName.slice(1),
    }),
    [account],
  );
  return <ProviderUsageCard usage={display} compact showRemaining />;
}

export function ProviderAccountUsage({
  usage,
  routing,
}: {
  usage: ProviderUsage;
  routing?: ProviderUsageListPayload["accountRouting"];
}) {
  return (
    <View style={styles.container} testID="provider-account-usage">
      <Text style={styles.title}>Subscription accounts</Text>
      <Text style={styles.detail}>{accountRouteLabel(routing)}</Text>
      {usage.accounts?.length ? (
        usage.accounts.map((account) => (
          <AccountUsageCard key={account.accountId} account={account} />
        ))
      ) : (
        <Text style={styles.detail}>{usage.error ?? "Account usage unavailable"}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[2], maxWidth: 320 },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
