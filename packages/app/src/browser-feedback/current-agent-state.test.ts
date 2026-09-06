import { describe, expect, it } from "vitest";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import {
  parseCurrentBrowserAgentRoute,
  selectCurrentBrowserAgent,
  type BrowserAgentSession,
} from "./current-agent-state";

describe("current browser agent", () => {
  it("keeps completed A green while unrelated agents on either host are running", () => {
    const sessions: Record<string, BrowserAgentSession> = {
      mactop: {
        focusedAgentId: "A",
        agentDetails: new Map(),
        agents: new Map([
          [
            "A",
            {
              id: "A",
              workspaceId: "workspace-A",
              status: "idle",
              requiresAttention: true,
              pendingPermissions: [],
            },
          ],
          ["B", { id: "B", workspaceId: "workspace-B", status: "running", pendingPermissions: [] }],
        ]),
      },
      cloudtop: {
        focusedAgentId: "A",
        agentDetails: new Map(),
        agents: new Map([
          ["A", { id: "A", workspaceId: "workspace-C", status: "running", pendingPermissions: [] }],
        ]),
      },
    };
    const route = parseCurrentBrowserAgentRoute(buildHostWorkspaceRoute("mactop", "workspace-A"));

    expect(selectCurrentBrowserAgent({ route, sessions })).toEqual({
      serverId: "mactop",
      agentId: "A",
      workspaceId: "workspace-A",
      status: "attention",
    });
  });

  it("follows the focused pane within a workspace and clears viewed completion", () => {
    const session: BrowserAgentSession = {
      focusedAgentId: "B",
      agentDetails: new Map(),
      agents: new Map([
        [
          "A",
          {
            id: "A",
            workspaceId: "workspace",
            status: "idle",
            requiresAttention: true,
            pendingPermissions: [],
          },
        ],
        ["B", { id: "B", workspaceId: "workspace", status: "running", pendingPermissions: [] }],
      ]),
    };
    const route = parseCurrentBrowserAgentRoute(buildHostWorkspaceRoute("mactop", "workspace"));
    const sessions = { mactop: session };

    expect(selectCurrentBrowserAgent({ route, sessions })?.status).toBe("running");
    session.focusedAgentId = "A";
    expect(selectCurrentBrowserAgent({ route, sessions })?.status).toBe("attention");
    session.agents = new Map([
      [
        "A",
        {
          id: "A",
          workspaceId: "workspace",
          status: "idle",
          requiresAttention: false,
          pendingPermissions: [],
        },
      ],
    ]);
    expect(selectCurrentBrowserAgent({ route, sessions })?.status).toBe("none");
  });

  it("does not carry stale focus across a workspace route change", () => {
    const sessions: Record<string, BrowserAgentSession> = {
      mactop: {
        focusedAgentId: "A",
        agentDetails: new Map(),
        agents: new Map([
          [
            "A",
            { id: "A", workspaceId: "old-workspace", status: "running", pendingPermissions: [] },
          ],
        ]),
      },
    };
    const route = parseCurrentBrowserAgentRoute(buildHostWorkspaceRoute("mactop", "new-workspace"));

    expect(selectCurrentBrowserAgent({ route, sessions })).toBeNull();
  });

  it.each(["/", "/settings", "/h/mactop/settings"])("has no agent on %s", (pathname) => {
    const route = parseCurrentBrowserAgentRoute(pathname);
    expect(selectCurrentBrowserAgent({ route, sessions: {} })).toBeNull();
  });

  it("has no agent when the focused pane is a terminal or the agent is unknown", () => {
    const session: BrowserAgentSession = {
      focusedAgentId: null,
      agents: new Map(),
      agentDetails: new Map(),
    };
    const route = parseCurrentBrowserAgentRoute(buildHostWorkspaceRoute("mactop", "workspace"));
    const sessions = { mactop: session };

    expect(selectCurrentBrowserAgent({ route, sessions })).toBeNull();
    session.focusedAgentId = "unknown";
    expect(selectCurrentBrowserAgent({ route, sessions })).toBeNull();
  });

  it("uses the named agent on a stable deep link before workspace routing completes", () => {
    const sessions: Record<string, BrowserAgentSession> = {
      cloudtop: {
        focusedAgentId: "another-agent",
        agentDetails: new Map(),
        agents: new Map([
          ["A", { id: "A", workspaceId: "workspace", status: "running", pendingPermissions: [] }],
        ]),
      },
    };
    const route = parseCurrentBrowserAgentRoute("/h/cloudtop/agent/A");

    expect(selectCurrentBrowserAgent({ route, sessions })).toEqual({
      serverId: "cloudtop",
      agentId: "A",
      workspaceId: "workspace",
      status: "running",
    });
  });

  it("does not show archived agent activity", () => {
    const sessions: Record<string, BrowserAgentSession> = {
      mactop: {
        focusedAgentId: "A",
        agentDetails: new Map(),
        agents: new Map([
          [
            "A",
            {
              id: "A",
              workspaceId: "workspace",
              status: "idle",
              requiresAttention: true,
              pendingPermissions: [],
              archivedAt: new Date("2026-09-06T00:00:00Z"),
            },
          ],
        ]),
      },
    };
    const route = parseCurrentBrowserAgentRoute("/h/mactop/agent/A");

    expect(selectCurrentBrowserAgent({ route, sessions })).toBeNull();
  });

  it("shows a viewed detail-only agent's pending permission", () => {
    const sessions: Record<string, BrowserAgentSession> = {
      mactop: {
        focusedAgentId: "A",
        agents: new Map(),
        agentDetails: new Map([
          [
            "A",
            {
              id: "A",
              workspaceId: "workspace",
              status: "idle",
              pendingPermissions: [
                { id: "request", provider: "codex", name: "Read", kind: "tool" },
              ],
            },
          ],
        ]),
      },
    };
    const route = parseCurrentBrowserAgentRoute(buildHostWorkspaceRoute("mactop", "workspace"));

    expect(selectCurrentBrowserAgent({ route, sessions })).toEqual({
      serverId: "mactop",
      agentId: "A",
      workspaceId: "workspace",
      status: "attention",
    });
  });
});
