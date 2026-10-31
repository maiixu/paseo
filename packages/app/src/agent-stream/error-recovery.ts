interface Activity {
  kind: string;
  timestamp: Date;
  text?: string;
  payload?: { data: { status: string } };
}
export function latestSubstantiveActivity(items: readonly Activity[]): number {
  let latest = 0;
  for (const item of items) {
    const assistantOutput =
      item.kind === "assistant_message" &&
      Boolean(item.text?.trim()) &&
      !item.text?.startsWith("[System Error]") &&
      !item.text?.startsWith("Queued:");
    const completedTool = item.kind === "tool_call" && item.payload?.data.status === "completed";
    if (assistantOutput || completedTool) latest = Math.max(latest, item.timestamp.getTime());
  }
  return latest;
}
export function errorRecoveryState(errorAt: number, latestActivityAt: number, status: string) {
  if (latestActivityAt > errorAt) return "historical";
  if (status === "error") return "blocked";
  return "unconfirmed";
}
