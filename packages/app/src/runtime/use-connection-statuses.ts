import { useMemo, useSyncExternalStore } from "react";
import type { HostRuntimeConnectionStatus } from "./host-runtime";
export interface ConnectionStatusSource {
  subscribeAll(listener: () => void): () => void;
  getSnapshot(serverId: string): { connectionStatus: HostRuntimeConnectionStatus } | null;
}
export function useConnectionStatuses(
  source: ConnectionStatusSource,
  serverIds: readonly string[],
): ReadonlyMap<string, HostRuntimeConnectionStatus> {
  // Snapshot the values themselves. A version-only subscription followed by an
  // opaque memoized read can retain "connecting" after the clients are online.
  const values = useSyncExternalStore(
    (listener) => source.subscribeAll(listener),
    () => serverIds.map((id) => source.getSnapshot(id)?.connectionStatus ?? "connecting").join(","),
    () => serverIds.map(() => "connecting").join(","),
  );
  return useMemo(() => {
    const statuses = values.split(",") as HostRuntimeConnectionStatus[];
    return new Map(serverIds.map((id, index) => [id, statuses[index] ?? "connecting"]));
  }, [serverIds, values]);
}
