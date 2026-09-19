/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useConnectionStatuses, type ConnectionStatusSource } from "./use-connection-statuses";
import type { HostRuntimeConnectionStatus } from "./host-runtime";
it("tracks live connection values through connect, disconnect and reconnect", () => {
  let status: HostRuntimeConnectionStatus = "connecting";
  const listeners = new Set<() => void>();
  const source: ConnectionStatusSource = {
    subscribeAll: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => ({ connectionStatus: status }),
  };
  const { result } = renderHook(() => useConnectionStatuses(source, ["cloud"]));
  expect(result.current.get("cloud")).toBe("connecting");
  for (const next of ["online", "offline", "online"] as const) {
    act(() => {
      status = next;
      listeners.forEach((f) => f());
    });
    expect(result.current.get("cloud")).toBe(next);
  }
});
