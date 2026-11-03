/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useProviderUsage } from "./use-provider-usage";

const runtime = vi.hoisted(() => ({
  client: {
    listProviderUsage: vi.fn(async (_options?: { agentId?: string; forceRefresh?: boolean }) => ({
      requestId: "r",
      fetchedAt: "2026-11-03T00:00:00.000Z",
      providers: [],
    })),
  },
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ sessions: { host: { serverInfo: { features: { providerUsageList: true } } } } }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

it("reads cached usage on load and forces a host refresh only from explicit Refresh", async () => {
  const { result } = renderHook(() => useProviderUsage("host", { agentId: "agent" }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.view.kind).toBe("ready"));
  expect(runtime.client.listProviderUsage).toHaveBeenLastCalledWith({ agentId: "agent" });

  await act(() => result.current.refresh());

  expect(runtime.client.listProviderUsage).toHaveBeenLastCalledWith({
    agentId: "agent",
    forceRefresh: true,
  });
});
