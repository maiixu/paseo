import { useMemo } from "react";
import { usePathname } from "expo-router";
import { useShallow } from "zustand/shallow";
import type { BrowserFeedbackState } from "@getpaseo/protocol/browser-feedback";
import { getIsElectron, isNative } from "@/constants/platform";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { parseCurrentBrowserAgentRoute, selectCurrentBrowserAgent } from "./current-agent-state";

export function useCurrentBrowserAgent(): Omit<BrowserFeedbackState, "visible"> {
  const pathname = usePathname();
  const isBrowser = !isNative && !getIsElectron();
  const route = useMemo(
    () => (isBrowser ? parseCurrentBrowserAgentRoute(pathname) : null),
    [isBrowser, pathname],
  );
  const current = useSessionStore(
    useShallow((state) => selectCurrentBrowserAgent({ route, sessions: state.sessions })),
  );
  const connected = useHostRuntimeIsConnected(route?.serverId ?? "");

  return useMemo(() => {
    if (!current) {
      return { identity: null, status: "none", connected };
    }
    const { serverId, agentId, workspaceId } = current;
    const status = connected ? current.status : "none";
    return { identity: { serverId, agentId, workspaceId }, status, connected };
  }, [connected, current]);
}
