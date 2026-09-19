import { deriveEffectiveWorkspaceStatus } from "@/hooks/sidebar-workspaces-view-model";
import { resolveScheduleTargets } from "./resolve-targets";
import { useEffect, useMemo, useState, useRef } from "react";
import { useShallow } from "zustand/shallow";
import { useSchedules } from "@/hooks/use-schedules";
import {
  getHostRuntimeStore,
  useHosts,
  useHostRuntimeConnectionStatuses,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useManagedThreadsStore } from "./store";
import { mergeManagedLinks, presentThread, threadKey, type ThreadPresentation } from "./model";

export function ManagedThreadsSync() {
  const hosts = useHosts();
  const pendingReads = useRef(new Map<string, Promise<string | null>>());
  const ids = useMemo(() => hosts.map((h) => h.serverId), [hosts]);
  const connections = useHostRuntimeConnectionStatuses(ids);
  const sources = useSessionStore(
    useShallow((s) =>
      ids.flatMap((id) => [
        s.sessions[id]?.agents,
        s.sessions[id]?.agentDetails,
        s.sessions[id]?.workspaceAgentActivity,
        s.sessions[id]?.workspaces,
      ]),
    ),
  );
  const { loadState, hostErrors, refetch, isAuthoritative } = useSchedules();
  const links = useManagedThreadsStore((s) => s.links);
  const overrides = useManagedThreadsStore((s) => s.overrides);
  const [now, setNow] = useState(Date.now);
  const refresh = useRef(refetch);
  useEffect(() => {
    refresh.current = refetch;
  }, [refetch]);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      refresh.current();
    }, 30_000);
    return () => clearInterval(timer);
  }, []);
  const successfulHosts = useMemo(
    () =>
      new Set(
        loadState.status === "loaded" && isAuthoritative
          ? ids.filter(
              (id) =>
                connections.get(id) === "online" && !hostErrors.some((e) => e.serverId === id),
            )
          : [],
      ),
    [ids, connections, loadState, hostErrors, isAuthoritative],
  );
  useEffect(() => {
    if (loadState.status !== "loaded" || !isAuthoritative) return;
    const sessions = useSessionStore.getState().sessions;
    const agents = ids.flatMap((serverId) =>
      [
        ...(sessions[serverId]?.agents.values() ?? []),
        ...(sessions[serverId]?.agentDetails.values() ?? []),
      ].map((a) => ({
        serverId,
        id: a.id,
        workspaceId: a.workspaceId,
      })),
    );
    let cancelled = false;
    const schedules = loadState.data.filter((s) => successfulHosts.has(s.serverId));
    void resolveScheduleTargets({
      schedules,
      agents,
      previous: links,
      readWorkspace: (serverId, agentId) => {
        const key = `${serverId}:${agentId}`;
        let pending = pendingReads.current.get(key);
        if (!pending) {
          const client = getHostRuntimeStore().getClient(serverId);
          pending = client
            ? client
                .fetchAgent({ agentId })
                .then((r) => r?.agent?.workspaceId ?? null)
                .catch(() => null)
            : Promise.resolve(null);
          pendingReads.current.set(key, pending);
          void pending.finally(() => pendingReads.current.delete(key));
        }
        return pending;
      },
    }).then((resolved) => {
      if (cancelled) return undefined;
      useManagedThreadsStore
        .getState()
        .setLinks(
          mergeManagedLinks({ previous: links, schedules, successfulHosts, agents: resolved }),
        );
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [loadState, successfulHosts, ids, sources, links, isAuthoritative]);
  useEffect(() => {
    const sessions = useSessionStore.getState().sessions;
    const presentations: Record<string, ThreadPresentation> = {};
    for (const serverId of ids) {
      for (const workspace of sessions[serverId]?.workspaces.values() ?? []) {
        const key = threadKey(serverId, workspace.id);
        presentations[key] = presentThread({
          status: deriveEffectiveWorkspaceStatus({
            serverId,
            workspace,
            workspaceAgentActivity: sessions[serverId]?.workspaceAgentActivity,
          }).status,
          links: links.filter((l) => l.serverId === serverId && l.workspaceId === workspace.id),
          override: overrides[key],
          connection: connections.get(serverId) ?? "connecting",
          schedulesKnown: successfulHosts.has(serverId),
          now,
        });
      }
    }
    useManagedThreadsStore.getState().publish(presentations);
  }, [ids, sources, links, overrides, connections, successfulHosts, now]);
  return null;
}
