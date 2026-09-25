import { useEffect } from "react";
import {
  getHostRuntimeStore,
  useHosts,
  useHostRuntimeConnectionStatuses,
} from "@/runtime/host-runtime";
import { parseManifest } from "./model";
import { useBackgroundTasks } from "./store";
// Personal two-Mac installation; no daemon change or new listener.
export const TASK_ROOT = "/Users/maixu/.local/state/paseo/background-tasks";
function HostObserver({ serverId }: { serverId: string }) {
  const online = useHostRuntimeConnectionStatuses([serverId]).get(serverId) === "online";
  useEffect(() => {
    const store = useBackgroundTasks.getState();
    const client = getHostRuntimeStore().getClient(serverId);
    if (!online || !client) {
      store.publish(serverId, null, false);
      return;
    }
    let cancelled = false,
      pending = false;
    const controller = new AbortController();
    let unsubscribe: (() => Promise<void>) | undefined;
    const read = async () => {
      if (pending || cancelled) return;
      pending = true;
      try {
        const file = await client.readFile(TASK_ROOT, "status.json", undefined, 65536);
        const tasks = parseManifest(new TextDecoder().decode(file.bytes), serverId);
        if (!cancelled) store.publish(serverId, tasks, true);
      } catch {
        if (!cancelled) store.publish(serverId, null, false);
      } finally {
        pending = false;
      }
    };
    void read();
    void client
      .subscribeFile(
        { cwd: TASK_ROOT, path: "status.json", signal: controller.signal },
        () => void read(),
      )
      .then((s) => {
        if (cancelled) void s.unsubscribe().catch(() => {});
        else unsubscribe = s.unsubscribe;
        return undefined;
      })
      .catch(() => {});
    // Bounded recovery for missing manifests, subscription failure and TTL expiry.
    const timer = setInterval(() => {
      store.tick();
      void read();
    }, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      controller.abort();
      void unsubscribe?.().catch(() => {});
    };
  }, [serverId, online]);
  return null;
}
export function BackgroundTasksSync() {
  return (
    <>
      {useHosts().map((h) => (
        <HostObserver key={h.serverId} serverId={h.serverId} />
      ))}
    </>
  );
}
