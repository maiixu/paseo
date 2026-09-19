import type { ManagedLink } from "./model";
import type { AggregatedSchedule } from "@/schedules/aggregated-schedules";
export interface ManagedAgentIdentity {
  serverId: string;
  id: string;
  workspaceId?: string | null;
}
// Workspace directories can be loaded without opening their agents. Resolve only
// scheduled targets, rather than hydrating every conversation or its transcript.
export async function resolveScheduleTargets(input: {
  schedules: readonly Pick<AggregatedSchedule, "serverId" | "target">[];
  agents: readonly ManagedAgentIdentity[];
  previous: readonly ManagedLink[];
  readWorkspace: (serverId: string, agentId: string) => Promise<string | null>;
}): Promise<ManagedAgentIdentity[]> {
  const result = new Map(
    input.agents.filter((a) => a.workspaceId).map((a) => [`${a.serverId}:${a.id}`, a]),
  );
  for (const link of input.previous) {
    const key = `${link.serverId}:${link.agentId}`;
    if (!result.has(key))
      result.set(key, { serverId: link.serverId, id: link.agentId, workspaceId: link.workspaceId });
  }
  const missing = new Map<string, { serverId: string; id: string }>();
  for (const s of input.schedules) {
    if (s.target.type !== "agent") continue;
    const key = `${s.serverId}:${s.target.agentId}`;
    if (!result.has(key)) missing.set(key, { serverId: s.serverId, id: s.target.agentId });
  }
  await Promise.all(
    [...missing].map(async ([key, a]) => {
      const workspaceId = await input.readWorkspace(a.serverId, a.id);
      if (workspaceId) result.set(key, { ...a, workspaceId });
    }),
  );
  return [...result.values()];
}
