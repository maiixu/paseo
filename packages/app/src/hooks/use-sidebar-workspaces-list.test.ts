// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarWorkspacesList } from "./use-sidebar-workspaces-list";

const runtime = vi.hoisted(() => ({
  ready: false,
  hosts: [{ serverId: "host-1" }],
  acquireDirectoryDemand: vi.fn<(serverId: string) => () => void>(),
  refreshDirectories: vi.fn(async () => {}),
}));

// Model the host registry's public readiness boundary without starting a daemon.
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => runtime,
  useHosts: () => runtime.hosts,
  useHostRegistryLoaded: () => runtime.ready,
}));

describe("sidebar directory demand", () => {
  beforeEach(() => {
    runtime.ready = false;
    runtime.acquireDirectoryDemand.mockReset();
    runtime.acquireDirectoryDemand.mockReturnValue(() => {});
  });

  afterEach(() => cleanup());

  it("waits for registry readiness then acquires demand even when the host list is unchanged", () => {
    const release = vi.fn();
    runtime.acquireDirectoryDemand.mockReturnValue(release);
    const { rerender, unmount } = renderHook(() => useSidebarWorkspacesList());

    expect(runtime.acquireDirectoryDemand).not.toHaveBeenCalled();

    runtime.ready = true;
    rerender();

    expect(runtime.acquireDirectoryDemand).toHaveBeenCalledExactlyOnceWith("host-1");
    rerender();
    expect(runtime.acquireDirectoryDemand).toHaveBeenCalledTimes(1);
    unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps an inactive sidebar undemanded after the registry becomes ready", () => {
    const { rerender } = renderHook(({ enabled }) => useSidebarWorkspacesList({ enabled }), {
      initialProps: { enabled: false },
    });
    runtime.ready = true;
    rerender({ enabled: false });

    expect(runtime.acquireDirectoryDemand).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(runtime.acquireDirectoryDemand).toHaveBeenCalledExactlyOnceWith("host-1");
  });
});
