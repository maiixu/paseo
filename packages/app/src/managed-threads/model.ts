import type { AggregatedSchedule } from "@/schedules/aggregated-schedules";

export interface ManagedLink {
  id: string;
  serverId: string;
  workspaceId: string;
  agentId: string;
  status: "active" | "paused" | "completed";
  nextRunAt: string | null;
  lastRunAt: string | null;
}
export interface ThreadPresentation {
  managed: boolean;
  running?: boolean;
  group: "needs-you" | "managed" | "conversations";
  state:
    | "answer"
    | "failed"
    | "offline"
    | "unknown"
    | "unscheduled"
    | "ended"
    | "paused"
    | "running"
    | "waiting"
    | "review"
    | "conversation";
  nextRunAt: string | null;
  lastRunAt: string | null;
  schedules: number;
}
export const threadKey = (serverId: string, workspaceId: string) => `${serverId}:${workspaceId}`;

export function mergeManagedLinks(input: {
  previous: ManagedLink[];
  schedules: readonly Pick<
    AggregatedSchedule,
    "id" | "serverId" | "target" | "status" | "nextRunAt" | "lastRunAt"
  >[];
  successfulHosts: ReadonlySet<string>;
  agents: readonly { serverId: string; id: string; workspaceId?: string | null }[];
}): ManagedLink[] {
  const agents = new Map(input.agents.map((a) => [`${a.serverId}:${a.id}`, a.workspaceId]));
  const result = input.previous.filter((l) => !input.successfulHosts.has(l.serverId));
  for (const s of input.schedules) {
    if (s.target.type !== "agent" || !input.successfulHosts.has(s.serverId)) continue;
    const { agentId } = s.target;
    const workspaceId =
      agents.get(`${s.serverId}:${agentId}`) ??
      input.previous.find((l) => l.serverId === s.serverId && l.agentId === agentId)?.workspaceId;
    if (!workspaceId) continue;
    result.push({
      id: s.id,
      serverId: s.serverId,
      workspaceId,
      agentId: s.target.agentId,
      status: s.status,
      nextRunAt: s.nextRunAt,
      lastRunAt: s.lastRunAt,
    });
  }
  return result.sort((a, b) => `${a.serverId}:${a.id}`.localeCompare(`${b.serverId}:${b.id}`));
}

export function presentThread(input: {
  status: string;
  links: readonly ManagedLink[];
  override?: boolean;
  connection: string;
  schedulesKnown: boolean;
  now: number;
}): ThreadPresentation {
  const { links, status } = input;
  const managed = input.override ?? links.length > 0;
  const active = links.filter((l) => l.status === "active");
  const nextRunAt =
    active
      .map((l) => l.nextRunAt)
      .filter((v): v is string => v !== null)
      .sort()[0] ?? null;
  const lastRunAt =
    links
      .map((l) => l.lastRunAt)
      .filter((v): v is string => v !== null)
      .sort()
      .at(-1) ?? null;
  const idleGroup = managed ? "managed" : "conversations";
  const value = (state: ThreadPresentation["state"], needsYou = false): ThreadPresentation => ({
    managed,
    running: status === "running",
    group: needsYou ? "needs-you" : idleGroup,
    state,
    nextRunAt,
    lastRunAt,
    schedules: links.length,
  });
  if (status === "needs_input") return value("answer", true);
  if (status === "failed") return value("failed", true);
  if (!managed)
    return value(status === "attention" ? "review" : "conversation", status === "attention");
  if (input.connection !== "online")
    return value(
      input.connection === "connecting" ? "unknown" : "offline",
      input.connection !== "connecting",
    );
  if (!input.schedulesKnown) return value("unknown");
  if (!links.length) return value("unscheduled", true);
  if (active.length === 0)
    return value(
      links.some((l) => l.status === "paused") ? "paused" : "ended",
      status === "attention" && !links.some((l) => l.status === "paused"),
    );
  if (status === "running") return value("running");
  // A stale next-run timestamp must not be presented as healthy waiting.
  if (
    !nextRunAt ||
    !Number.isFinite(Date.parse(nextRunAt)) ||
    Date.parse(nextRunAt) < input.now - 5 * 60_000
  )
    return value("unknown", true);
  return value("waiting");
}
