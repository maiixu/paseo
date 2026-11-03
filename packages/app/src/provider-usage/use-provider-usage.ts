import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { providerUsageCopy } from "./copy";
import type { ProviderUsageListPayload, ProviderUsageView } from "./types";

export const PROVIDER_USAGE_STALE_TIME_MS = 60 * 1000;

type ProviderUsageClient = Pick<DaemonClient, "listProviderUsage">;

export function providerUsageQueryKey(serverId: string | null | undefined, agentId?: string) {
  return ["providerUsage", serverId ?? "", agentId ?? ""] as const;
}

async function fetchProviderUsage(
  client: ProviderUsageClient,
  options: { agentId?: string; forceRefresh?: boolean },
): Promise<ProviderUsageListPayload> {
  return client.listProviderUsage({
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
  });
}

interface UseProviderUsageOptions {
  enabled?: boolean;
  agentId?: string;
}

export function useProviderUsage(
  serverId: string | null | undefined,
  options: UseProviderUsageOptions = {},
): {
  view: ProviderUsageView;
  refresh: () => Promise<void>;
  canFetch: boolean;
} {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsProviderUsage = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageList === true,
  );
  const queryKey = useMemo(
    () => providerUsageQueryKey(serverId, options.agentId),
    [serverId, options.agentId],
  );
  const canFetch = Boolean(serverId && client && isConnected && supportsProviderUsage);
  const enabled = Boolean((options.enabled ?? true) && canFetch);

  const queryFn = useCallback(async () => {
    if (!client) {
      throw new Error(providerUsageCopy.clientUnavailable);
    }
    return fetchProviderUsage(client, { agentId: options.agentId });
  }, [client, options.agentId]);

  const query = useQuery({
    queryKey,
    queryFn,
    enabled,
    staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    refetchOnMount: true,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    refetchInterval: enabled && options.agentId ? 30_000 : false,
  });

  // An explicit Refresh bypasses the daemon's provider and account caches; the poll does not.
  // Cancel an in-flight poll first so the forced fetch is not deduplicated into it.
  const refresh = useCallback(async () => {
    if (!canFetch || !client) return;
    await queryClient.cancelQueries({ queryKey });
    await queryClient.fetchQuery({
      queryKey,
      queryFn: () => fetchProviderUsage(client, { agentId: options.agentId, forceRefresh: true }),
      staleTime: 0,
    });
  }, [canFetch, client, options.agentId, queryClient, queryKey]);

  const view = useMemo<ProviderUsageView>(() => {
    if (!serverId || !client || !isConnected) {
      return { kind: "error", message: providerUsageCopy.hostUnavailable };
    }
    if (!supportsProviderUsage) {
      return { kind: "error", message: providerUsageCopy.hostUpgradeRequired };
    }
    if (query.data) {
      return {
        kind: "ready",
        payload: query.data,
        isRefreshing: query.isFetching,
        ...(query.isError ? { refreshError: "Refresh failed; showing last fetched usage" } : {}),
      };
    }
    if (query.isError) {
      return {
        kind: "error",
        message: query.error instanceof Error ? query.error.message : String(query.error),
      };
    }
    return { kind: "loading" };
  }, [
    client,
    isConnected,
    query.data,
    query.error,
    query.isError,
    query.isFetching,
    serverId,
    supportsProviderUsage,
  ]);

  return { view, refresh, canFetch };
}
