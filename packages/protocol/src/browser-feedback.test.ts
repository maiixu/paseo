import { describe, expect, it } from "vitest";
import {
  BrowserFeedbackMessageSchema,
  BrowserFeedbackNotificationSchema,
  browserAgentKey,
  browserNotificationTarget,
  isBrowserFeedbackUrl,
} from "./browser-feedback.js";

describe("browser feedback boundary", () => {
  it("allows only the explicit local page origins, including routes", () => {
    expect(isBrowserFeedbackUrl("http://127.0.0.1:6767/h/local/workspace/a")).toBe(true);
    expect(isBrowserFeedbackUrl("http://127.0.0.1:6769/")).toBe(true);
    for (const url of [
      "blob:http://127.0.0.1:6767/id",
      "http://user@127.0.0.1:6767/",
      "http://127.0.0.1:6768/",
      "https://127.0.0.1:6767/",
      "https://example.com",
      "invalid",
    ]) {
      expect(isBrowserFeedbackUrl(url), url).toBe(false);
    }
  });

  it("keeps host identity distinct and derives navigation without accepting an arbitrary URL", () => {
    const identity = { serverId: "cloud/top", agentId: "agent?one", workspaceId: "space#one" };
    const target = new URL(browserNotificationTarget("http://127.0.0.1:6767", identity));
    expect(target.pathname).toBe("/h/cloud%2Ftop/workspace/space%23one");
    expect(target.searchParams.get("open")).toBe("agent:agent?one");
    expect(
      browserNotificationTarget("http://127.0.0.1:6767", { ...identity, workspaceId: null }),
    ).toBe("http://127.0.0.1:6767/h/cloud%2Ftop/agent/agent%3Fone");
    expect(browserAgentKey(identity)).not.toBe(browserAgentKey({ ...identity, serverId: "local" }));
    expect(() => browserNotificationTarget("https://example.com", identity)).toThrow();
  });

  it("rejects incompatible envelopes and invalid event times", () => {
    expect(
      BrowserFeedbackMessageSchema.safeParse({
        source: "paseo-browser-feedback",
        version: 2,
        type: "hello",
      }).success,
    ).toBe(false);
    expect(
      BrowserFeedbackMessageSchema.safeParse({
        source: "paseo-browser-feedback",
        version: 1,
        type: "hello",
        url: "https://example.com",
      }).success,
    ).toBe(false);
    const notification = {
      id: "event",
      identity: { serverId: "host", agentId: "agent", workspaceId: null },
      reason: "finished",
      title: "Finished",
      body: "Done",
      createdAt: "2026-09-06T00:00:00.000Z",
    };
    expect(BrowserFeedbackNotificationSchema.safeParse(notification).success).toBe(true);
    expect(
      BrowserFeedbackNotificationSchema.safeParse({ ...notification, createdAt: "not a date" })
        .success,
    ).toBe(false);
  });
});
