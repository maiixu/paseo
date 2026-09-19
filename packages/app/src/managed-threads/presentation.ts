import type { ThreadPresentation } from "./model";

export function threadSummary(p: ThreadPresentation): string {
  switch (p.state) {
    case "answer":
      return "Needs your answer";
    case "failed":
      return "Needs recovery";
    case "offline":
      return "Host disconnected · status unknown";
    case "unknown":
      return "Check follow-up status";
    case "unscheduled":
      return "No automatic follow-up scheduled";
    case "ended":
      return "Follow-up ended · review outcome";
    case "paused":
      return p.running ? "Checking now · future checks paused" : "Follow-up paused";
    case "running":
      return "Checking now";
    case "waiting":
      return "Waiting for next check";
    case "review":
      return "Ready for your review";
    case "conversation":
      return "Conversation";
  }
}
export function formatCheckTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
