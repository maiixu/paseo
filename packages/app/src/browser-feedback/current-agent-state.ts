import type {
  BrowserAgentIdentity,
  BrowserFeedbackState,
} from "@getpaseo/protocol/browser-feedback";
import type { Agent, SessionState } from "@/stores/session-store";
import {
  parseHostAgentRouteFromPathname,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";

type FeedbackAgent = Pick<
  Agent,
  "id" | "workspaceId" | "status" | "requiresAttention" | "pendingPermissions" | "archivedAt"
>;

export interface BrowserAgentSession extends Pick<SessionState, "focusedAgentId"> {
  agents: ReadonlyMap<string, FeedbackAgent>;
  agentDetails: ReadonlyMap<string, FeedbackAgent>;
}

type BrowserAgentRoute =
  | ({ kind: "agent" } & NonNullable<ReturnType<typeof parseHostAgentRouteFromPathname>>)
  | ({ kind: "workspace" } & NonNullable<ReturnType<typeof parseHostWorkspaceRouteFromPathname>>);

export type CurrentBrowserAgent = BrowserAgentIdentity & Pick<BrowserFeedbackState, "status">;

interface CurrentBrowserAgentInput {
  route: BrowserAgentRoute | null;
  sessions: Readonly<Record<string, BrowserAgentSession>>;
}

export function parseCurrentBrowserAgentRoute(pathname: string): BrowserAgentRoute | null {
  const workspace = parseHostWorkspaceRouteFromPathname(pathname);
  if (workspace) {
    return { kind: "workspace", ...workspace };
  }
  const agent = parseHostAgentRouteFromPathname(pathname);
  return agent ? { kind: "agent", ...agent } : null;
}

function agentFaviconStatus(agent: FeedbackAgent): BrowserFeedbackState["status"] {
  if (agent.status === "running") {
    return "running";
  }
  const needsAttention = agent.requiresAttention || agent.pendingPermissions.length > 0;
  return needsAttention ? "attention" : "none";
}

export function selectCurrentBrowserAgent({
  route,
  sessions,
}: CurrentBrowserAgentInput): CurrentBrowserAgent | null {
  if (!route) {
    return null;
  }
  const session = sessions[route.serverId];
  if (!session) {
    return null;
  }
  const agentId = route.kind === "agent" ? route.agentId : session.focusedAgentId;
  if (!agentId) {
    return null;
  }
  const agent = session.agents.get(agentId) ?? session.agentDetails.get(agentId);
  if (!agent || agent.archivedAt) {
    return null;
  }
  // Workspace focus is published by an effect, so the old workspace's agent
  // can briefly remain selected after the pathname changes.
  const isStaleWorkspaceFocus =
    route.kind === "workspace" && agent.workspaceId !== route.workspaceId;
  if (isStaleWorkspaceFocus) {
    return null;
  }
  const workspaceId = agent.workspaceId ?? null;
  const status = agentFaviconStatus(agent);
  return { serverId: route.serverId, agentId: agent.id, workspaceId, status };
}
