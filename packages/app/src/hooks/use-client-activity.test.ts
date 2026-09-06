// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClientActivity } from "./use-client-activity";

const START = new Date("2026-09-06T12:00:00.000Z");

function mountActivityTracker() {
  // Observe the hook's heartbeat contract without opening a network connection.
  const client = new DaemonClient({ url: "ws://paseo.invalid", clientId: "activity-test" });
  vi.spyOn(client, "isConnected", "get").mockReturnValue(true);
  const sendHeartbeat = vi.spyOn(client, "sendHeartbeat").mockImplementation(() => {});
  vi.spyOn(client, "subscribeConnectionStatus").mockImplementation((listener) => {
    listener({ status: "connected" });
    return () => {};
  });
  const hook = renderHook(() =>
    useClientActivity({ client, focusedAgentId: "agent-1", focusedTerminalId: null }),
  );
  return { sendHeartbeat, ...hook };
}

describe("browser client activity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("initially reports a visible page in an unfocused window as away", () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    const { sendHeartbeat } = mountActivityTracker();

    expect(sendHeartbeat).toHaveBeenCalledExactlyOnceWith({
      deviceType: "web",
      focusedAgentId: "agent-1",
      focusedTerminalId: null,
      lastActivityAt: START.toISOString(),
      appVisible: false,
      appVisibilityChangedAt: START.toISOString(),
    });
  });

  it("reports blur immediately without extending the last user activity", () => {
    const { sendHeartbeat } = mountActivityTracker();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" })));
    sendHeartbeat.mockClear();
    vi.setSystemTime(new Date(START.getTime() + 100));
    vi.mocked(document.hasFocus).mockReturnValue(false);

    act(() => window.dispatchEvent(new Event("blur")));

    expect(sendHeartbeat).toHaveBeenCalledExactlyOnceWith({
      deviceType: "web",
      focusedAgentId: "agent-1",
      focusedTerminalId: null,
      lastActivityAt: START.toISOString(),
      appVisible: false,
      appVisibilityChangedAt: new Date(START.getTime() + 100).toISOString(),
    });
  });

  it("reports returning focus immediately even inside the activity throttle", () => {
    const { sendHeartbeat } = mountActivityTracker();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" })));
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("blur")));
    sendHeartbeat.mockClear();
    vi.setSystemTime(new Date(START.getTime() + 200));
    vi.mocked(document.hasFocus).mockReturnValue(true);

    act(() => window.dispatchEvent(new Event("focus")));

    expect(sendHeartbeat).toHaveBeenCalledExactlyOnceWith({
      deviceType: "web",
      focusedAgentId: "agent-1",
      focusedTerminalId: null,
      lastActivityAt: new Date(START.getTime() + 200).toISOString(),
      appVisible: true,
      appVisibilityChangedAt: new Date(START.getTime() + 200).toISOString(),
    });
  });

  it("keeps a newly visible document away until its window receives focus", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.mocked(document.hasFocus).mockReturnValue(false);
    const { sendHeartbeat } = mountActivityTracker();
    sendHeartbeat.mockClear();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(15_000));

    expect(sendHeartbeat).toHaveBeenLastCalledWith({
      deviceType: "web",
      focusedAgentId: "agent-1",
      focusedTerminalId: null,
      lastActivityAt: START.toISOString(),
      appVisible: false,
      appVisibilityChangedAt: START.toISOString(),
    });
  });

  it("reports a hidden document immediately without refreshing user activity", () => {
    const { sendHeartbeat } = mountActivityTracker();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" })));
    sendHeartbeat.mockClear();
    vi.setSystemTime(new Date(START.getTime() + 100));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(sendHeartbeat).toHaveBeenLastCalledWith({
      deviceType: "web",
      focusedAgentId: "agent-1",
      focusedTerminalId: null,
      lastActivityAt: START.toISOString(),
      appVisible: false,
      appVisibilityChangedAt: new Date(START.getTime() + 100).toISOString(),
    });
  });

  it("removes focus listeners and the heartbeat timer when unmounted", () => {
    const { sendHeartbeat, unmount } = mountActivityTracker();
    unmount();
    sendHeartbeat.mockClear();

    act(() => {
      vi.mocked(document.hasFocus).mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));
      vi.mocked(document.hasFocus).mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(15_000);
    });

    expect(sendHeartbeat).not.toHaveBeenCalled();
  });
});
