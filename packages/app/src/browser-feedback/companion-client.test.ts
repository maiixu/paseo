// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_COMPANION_SOURCE,
  BROWSER_FEEDBACK_SOURCE,
  BROWSER_FEEDBACK_VERSION,
  type BrowserFeedbackNotification,
  type BrowserFeedbackState,
} from "@getpaseo/protocol/browser-feedback";
import { BrowserCompanionClient } from "./companion-client";

const requestId = "00000000-0000-4000-8000-000000000001";
const notification: BrowserFeedbackNotification = {
  id: "agent-a-turn-1",
  identity: { serverId: "server-1", agentId: "agent-a", workspaceId: "workspace-1" },
  reason: "finished",
  title: "Agent A finished",
  body: "Completed the task",
  createdAt: "2026-09-06T12:00:00.000Z",
};
const ready = {
  source: BROWSER_COMPANION_SOURCE,
  version: BROWSER_FEEDBACK_VERSION,
  type: "ready",
};
const accepted = { ...ready, type: "delivery", requestId, status: "accepted", error: null };

function emit(data: unknown, overrides: MessageEventInit = {}) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      origin: window.location.origin,
      data,
      ...overrides,
    }),
  );
}

describe("browser companion page bridge", () => {
  let client: BrowserCompanionClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, "postMessage").mockImplementation(() => {});
    vi.stubGlobal("crypto", { randomUUID: () => requestId });
    client = new BrowserCompanionClient(window);
  });

  afterEach(() => {
    client.dispose();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("handshakes at the page origin and publishes the latest cached state", () => {
    const state: BrowserFeedbackState = {
      identity: notification.identity,
      status: "running",
      visible: false,
      connected: true,
    };
    client.publishState(state);
    client.publishState({ ...state, status: "attention" });
    client.trace({ identity: notification.identity, stage: "received", detail: "finished" });

    expect(window.postMessage).toHaveBeenCalledExactlyOnceWith(
      {
        source: BROWSER_FEEDBACK_SOURCE,
        version: BROWSER_FEEDBACK_VERSION,
        type: "hello",
      },
      window.location.origin,
    );

    emit(ready);

    expect(vi.mocked(window.postMessage).mock.calls.slice(1)).toEqual([
      [
        {
          source: BROWSER_FEEDBACK_SOURCE,
          version: BROWSER_FEEDBACK_VERSION,
          type: "state",
          state: { ...state, status: "attention" },
        },
        window.location.origin,
      ],
      [
        {
          source: BROWSER_FEEDBACK_SOURCE,
          version: BROWSER_FEEDBACK_VERSION,
          type: "trace",
          trace: { identity: notification.identity, stage: "received", detail: "finished" },
        },
        window.location.origin,
      ],
    ]);
  });

  it("does not send a notification without a companion handshake", async () => {
    const result = client.send(notification);
    await vi.advanceTimersByTimeAsync(300);

    expect(await result).toEqual({ status: "unavailable" });
    expect(vi.mocked(window.postMessage).mock.calls.map(([message]) => message.type)).toEqual([
      "hello",
      "hello",
    ]);
  });

  it.each([
    ["other window", ready, { source: null }],
    ["other origin", ready, { origin: "https://unrelated.invalid" }],
    ["wrong version", { ...ready, version: 2 }, {}],
    ["extra fields", { ...ready, command: "navigate" }, {}],
  ])("ignores a handshake from %s", async (_label, message, overrides) => {
    const result = client.send(notification);
    emit(message, overrides);
    await vi.advanceTimersByTimeAsync(300);

    expect(await result).toEqual({ status: "unavailable" });
    expect(vi.mocked(window.postMessage).mock.calls.map(([sent]) => sent.type)).toEqual([
      "hello",
      "hello",
    ]);
  });

  it("waits for a late handshake and accepts only the matching delivery acknowledgement", async () => {
    const result = client.send(notification);
    await vi.advanceTimersByTimeAsync(100);
    emit(ready);
    await Promise.resolve();
    const settled = vi.fn();
    void result.then(settled);

    expect(window.postMessage).toHaveBeenLastCalledWith(
      {
        source: BROWSER_FEEDBACK_SOURCE,
        version: BROWSER_FEEDBACK_VERSION,
        type: "notify",
        requestId,
        notification,
      },
      window.location.origin,
    );
    emit({ ...accepted, requestId: "another-request" });
    emit(accepted, { origin: "https://unrelated.invalid" });
    emit(accepted, { source: null });
    emit({ ...accepted, status: "unknown" });
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).not.toHaveBeenCalled();

    emit(accepted);
    expect(await result).toEqual(accepted);
  });

  it("returns a delivery failure after lost acknowledgement instead of marking the companion absent", async () => {
    emit(ready);
    const result = client.send(notification);
    await vi.advanceTimersByTimeAsync(5000);

    expect(await result).toEqual({
      ...accepted,
      status: "failed",
      error: "The browser companion did not acknowledge the notification. Reload this tab.",
    });
    emit(accepted);
    expect(vi.mocked(window.postMessage).mock.calls.map(([message]) => message.type)).toEqual([
      "hello",
      "notify",
    ]);
  });
});
