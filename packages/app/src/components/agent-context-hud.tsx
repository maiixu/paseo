import { View } from "react-native";
import { ContextWindowMeter } from "@/components/context-window-meter";
import { useSessionStore } from "@/stores/session-store";

export function AgentContextHud({ serverId, agentId }: { serverId: string; agentId: string }) {
  const agent = useSessionStore((state) => state.sessions[serverId]?.agents.get(agentId));
  return (
    <View testID="agent-context-hud">
      <ContextWindowMeter
        agentId={agentId}
        serverId={serverId}
        provider={agent?.provider}
        maxTokens={agent?.lastUsage?.contextWindowMaxTokens ?? null}
        usedTokens={agent?.lastUsage?.contextWindowUsedTokens ?? null}
        totalCostUsd={agent?.lastUsage?.totalCostUsd}
        showPercentage
        pending
      />
    </View>
  );
}
