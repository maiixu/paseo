import { describe, expect, it } from "vitest";
import {
  BROWSER_COMPANION_SOURCE,
  BROWSER_FEEDBACK_SOURCE,
  BROWSER_FEEDBACK_VERSION,
  browserNotificationTarget,
  type BrowserAgentIdentity,
  type BrowserFeedbackNotification,
  type BrowserFeedbackState,
} from "@getpaseo/protocol/browser-feedback";
import { createCompanion, type CompanionBrowser, type PageSender } from "./companion";

const ORIGIN = "http://127.0.0.1:6769";
const AGENT_A: BrowserAgentIdentity = {
  serverId: "local",
  agentId: "agent-a",
  workspaceId: "workspace-a",
};
const AGENT_B: BrowserAgentIdentity = {
  serverId: "tailnet",
  agentId: "agent-b",
  workspaceId: "workspace-b",
};
const envelope = { source: BROWSER_FEEDBACK_SOURCE, version: BROWSER_FEEDBACK_VERSION };
const completion: BrowserFeedbackNotification = {
  id: JSON.stringify(["local", "agent-a", "finished", "2026-09-06T12:00:00Z"]),
  identity: AGENT_A,
  reason: "finished",
  title: "Agent A finished",
  body: "Ready for review",
  createdAt: "2026-09-06T12:00:00Z",
};

interface TabUpdate {
  tabId: number;
  update: chrome.tabs.UpdateProperties;
}
interface NotificationCall {
  id: string;
  notification: Pick<BrowserFeedbackNotification, "title" | "body">;
}

function makeTab(id: number, identity: BrowserAgentIdentity): chrome.tabs.Tab {
  return {
    id,
    url: browserNotificationTarget(ORIGIN, identity),
    windowId: 10,
    active: false,
    highlighted: false,
    selected: false,
    pinned: false,
    incognito: false,
    index: id,
    discarded: false,
    frozen: false,
    lastAccessed: 0,
    autoDiscardable: true,
    groupId: -1,
  };
}

function setup() {
  const tabs = new Map<number, chrome.tabs.Tab>([
    [1, makeTab(1, AGENT_A)],
    [2, { ...makeTab(2, AGENT_B), active: true }],
  ]);
  const notifications: NotificationCall[] = [];
  const updates: TabUpdate[] = [];
  const created: string[] = [];
  const focused: number[] = [];
  let stored: unknown = undefined;
  let permission: "granted" | "denied" = "granted";
  let notificationFailure = false;
  let focusedWindow = 10;
  let closeOnActivation: number | null = null;
  let restoreAfterLookup: number | null = null;
  let time = 100;
  const browser: CompanionBrowser = {
    async readSession() {
      return structuredClone(stored);
    },
    async writeSession(session) {
      stored = structuredClone(session);
    },
    async getTab(tabId) {
      const tab = tabs.get(tabId);
      if (tab === undefined) {
        return null;
      }
      const snapshot = { ...tab };
      if (restoreAfterLookup === tabId) {
        tab.discarded = false;
        restoreAfterLookup = null;
      }
      return snapshot;
    },
    async updateTab(tabId, update) {
      if (closeOnActivation === tabId && update.active) {
        tabs.delete(tabId);
      }
      const tab = tabs.get(tabId);
      if (tab === undefined) {
        return null;
      }
      updates.push({ tabId, update });
      if (update.active) {
        for (const candidate of tabs.values()) {
          if (candidate.windowId === tab.windowId) {
            candidate.active = false;
          }
        }
      }
      Object.assign(tab, update);
      if (update.url !== undefined) {
        tab.discarded = false;
      }
      return tab;
    },
    async createTab(url) {
      created.push(url);
      const tab = { ...makeTab(100 + created.length, AGENT_A), url, active: true };
      tabs.set(100 + created.length, tab);
      return tab;
    },
    async getWindow(windowId) {
      return {
        id: windowId,
        focused: windowId === focusedWindow,
        alwaysOnTop: false,
        incognito: false,
      };
    },
    async focusWindow(windowId) {
      focused.push(windowId);
      focusedWindow = windowId;
    },
    async notificationPermission() {
      return permission;
    },
    async createNotification(id, notification) {
      if (notificationFailure) {
        throw new Error("Chrome notification adapter failed");
      }
      notifications.push({
        id,
        notification: { title: notification.title, body: notification.body },
      });
    },
    async clearNotification() {},
  };
  function sender(tabId: number): PageSender {
    const tab = tabs.get(tabId);
    if (tab === undefined || tab.url === undefined) {
      throw new Error("Test tab is missing");
    }
    return { tabId, documentId: `document-${tabId}`, frameId: 0, pageUrl: tab.url };
  }
  const options = { browser, now: () => time++ };
  const companion = createCompanion(options);
  async function register(
    tabId: number,
    identity: BrowserAgentIdentity,
    status: BrowserFeedbackState["status"] = "running",
  ) {
    await companion.receive(sender(tabId), {
      ...envelope,
      type: "state",
      state: { identity, status, visible: tabId === 2, connected: true },
    });
  }
  async function notify(requestId = "request-a") {
    return companion.receive(sender(2), {
      ...envelope,
      type: "notify",
      requestId,
      notification: completion,
    });
  }
  function requireTab(id: number) {
    const tab = tabs.get(id);
    if (tab === undefined) {
      throw new Error("Test tab missing");
    }
    return tab;
  }
  return {
    companion,
    browser,
    options,
    tabs,
    notifications,
    updates,
    created,
    focused,
    sender,
    register,
    notify,
    requireTab,
    setPermission(value: typeof permission) {
      permission = value;
    },
    setNotificationFailure(value: boolean) {
      notificationFailure = value;
    },
    setFocusedWindow(value: number) {
      focusedWindow = value;
    },
    closeWhenActivated(id: number) {
      closeOnActivation = id;
    },
    restoreAfterNextLookup(id: number) {
      restoreAfterLookup = id;
    },
  };
}

function delivery(
  status: "accepted" | "suppressed" | "duplicate" | "failed",
  requestId = "request-a",
  error: string | null = null,
) {
  return {
    source: BROWSER_COMPANION_SOURCE,
    version: BROWSER_FEEDBACK_VERSION,
    type: "delivery",
    requestId,
    status,
    error,
  };
}

describe("Paseo browser companion", () => {
  it("activates A's existing tab and window while preserving B's URL", async () => {
    const env = setup();
    await env.register(1, AGENT_A);
    await env.register(2, AGENT_B);
    expect(await env.notify()).toEqual(delivery("accepted"));
    await env.companion.click(env.notifications[0].id);
    expect(env.requireTab(1).active).toBe(true);
    expect(env.requireTab(2).url).toBe(browserNotificationTarget(ORIGIN, AGENT_B));
    expect(env.created).toEqual([]);
    expect(env.focused).toEqual([10]);
    expect(env.updates.filter(({ update }) => update.url !== undefined)).toEqual([]);
  });

  it("serializes concurrent duplicate events and remembers acceptance after worker restart", async () => {
    const env = setup();
    const replies = await Promise.all([env.notify("one"), env.notify("two")]);
    expect(replies).toEqual([delivery("accepted", "one"), delivery("duplicate", "two")]);
    const resumed = createCompanion(env.options);
    const reply = await resumed.receive(env.sender(2), {
      ...envelope,
      type: "notify",
      requestId: "three",
      notification: completion,
    });
    expect(reply).toEqual(delivery("duplicate", "three"));
    expect(env.notifications).toHaveLength(1);
    expect(env.notifications[0].id).toMatch(/^paseo-[a-f0-9]{64}$/);
  });

  it("allows retry when Chrome rejects creation", async () => {
    const env = setup();
    env.setNotificationFailure(true);
    expect(await env.notify()).toEqual(
      delivery("failed", "request-a", "Chrome notification adapter failed"),
    );
    env.setNotificationFailure(false);
    expect(await env.notify()).toEqual(delivery("accepted"));
    expect(env.notifications).toHaveLength(1);
  });

  it("reports disabled extension permission and does not deduplicate a later permitted retry", async () => {
    const env = setup();
    env.setPermission("denied");
    expect(await env.notify()).toEqual(
      delivery("failed", "request-a", "Notifications are disabled for Paseo Browser Companion"),
    );
    env.setPermission("granted");
    expect(await env.notify()).toEqual(delivery("accepted"));
  });

  it("suppresses delivery when any target tab is active in a focused window", async () => {
    const env = setup();
    env.requireTab(1).active = true;
    await env.register(1, AGENT_A);
    expect(await env.notify()).toEqual(delivery("suppressed"));
    expect(env.notifications).toEqual([]);
    const diagnostics = await env.companion.diagnostics();
    expect(diagnostics.traces.map((entry) => entry.stage)).toEqual(["suppressed-focused"]);
  });

  it("still notifies when the target is active in an unfocused window", async () => {
    const env = setup();
    env.requireTab(1).active = true;
    env.setFocusedWindow(99);
    await env.register(1, AGENT_A);
    expect(await env.notify()).toEqual(delivery("accepted"));
  });

  it("restores the exact agent into its discarded tab after worker restart", async () => {
    const env = setup();
    env.requireTab(1).url = `${ORIGIN}/h/local/workspace/workspace-a`;
    await env.register(1, AGENT_A, "none");
    await env.notify();
    env.requireTab(1).discarded = true;
    await env.companion.disconnect(env.sender(1));
    const resumed = createCompanion(env.options);
    await resumed.click(env.notifications[0].id);
    expect(env.updates).toContainEqual({
      tabId: 1,
      update: { active: true, url: browserNotificationTarget(ORIGIN, AGENT_A) },
    });
    expect(env.created).toEqual([]);
    expect(env.requireTab(2).url).toBe(browserNotificationTarget(ORIGIN, AGENT_B));
  });

  it("retains the target when port disconnection arrives before the discarded flag", async () => {
    const env = setup();
    env.requireTab(1).url = `${ORIGIN}/h/local/workspace/workspace-a`;
    await env.register(1, AGENT_A);
    await env.notify();
    await env.companion.disconnect(env.sender(1));
    expect(env.requireTab(1).autoDiscardable).toBe(true);
    env.requireTab(1).discarded = true;
    await env.companion.tabUpdated(1, { discarded: true }, env.requireTab(1));
    const resumed = createCompanion(env.options);
    await resumed.click(env.notifications[0].id);
    expect(env.updates).toContainEqual({
      tabId: 1,
      update: { active: true, url: browserNotificationTarget(ORIGIN, AGENT_A) },
    });
    expect(env.created).toEqual([]);
    expect(env.requireTab(2).url).toBe(browserNotificationTarget(ORIGIN, AGENT_B));
  });

  it("does not suppress or reuse a disconnected loaded page with an unverified active pane", async () => {
    const env = setup();
    await env.register(1, AGENT_A);
    await env.companion.disconnect(env.sender(1));
    env.requireTab(1).active = true;
    env.requireTab(2).active = false;
    expect(await env.notify()).toEqual(delivery("accepted"));
    await env.companion.click(env.notifications[0].id);
    expect(env.updates.filter(({ tabId, update }) => tabId === 1 && update.active)).toEqual([]);
    expect(env.created).toEqual([browserNotificationTarget(ORIGIN, AGENT_A)]);
  });

  it("rechecks a disconnected target that reloads between selection and activation", async () => {
    const env = setup();
    await env.register(1, AGENT_A);
    await env.notify();
    env.requireTab(1).discarded = true;
    await env.companion.disconnect(env.sender(1));
    env.restoreAfterNextLookup(1);
    await env.companion.click(env.notifications[0].id);
    expect(env.updates.filter(({ tabId, update }) => tabId === 1 && update.active)).toEqual([]);
    expect(env.created).toEqual([browserNotificationTarget(ORIGIN, AGENT_A)]);
  });

  it("invalidates a disconnected mapping when a same-URL reload starts", async () => {
    const env = setup();
    await env.register(1, AGENT_A);
    await env.notify();
    await env.companion.disconnect(env.sender(1));
    await env.companion.tabUpdated(1, { status: "loading" }, env.requireTab(1));
    env.requireTab(1).discarded = true;
    await env.companion.tabUpdated(1, { discarded: true }, env.requireTab(1));
    await env.companion.click(env.notifications[0].id);
    expect(env.created).toEqual([browserNotificationTarget(ORIGIN, AGENT_A)]);
  });

  it("prefers a live matching tab over a more recently active discarded copy", async () => {
    const env = setup();
    env.tabs.set(3, makeTab(3, AGENT_A));
    await env.register(1, AGENT_A);
    await env.register(3, AGENT_A);
    await env.companion.tabActivated(3);
    await env.notify();
    env.requireTab(3).discarded = true;
    await env.companion.disconnect(env.sender(3));
    await env.companion.click(env.notifications[0].id);
    expect(env.requireTab(1).active).toBe(true);
    expect(env.requireTab(3).active).toBe(false);
  });

  it("opens A in a new tab when A closed before the click, leaving B in place", async () => {
    const env = setup();
    await env.register(1, AGENT_A);
    await env.register(2, AGENT_B);
    await env.notify();
    env.tabs.delete(1);
    await env.companion.tabRemoved(1);
    await env.companion.click(env.notifications[0].id);
    expect(env.created).toEqual([browserNotificationTarget(ORIGIN, AGENT_A)]);
    expect(env.requireTab(2).url).toBe(browserNotificationTarget(ORIGIN, AGENT_B));
  });

  it("handles the target closing between lookup and activation", async () => {
    const env = setup();
    await env.register(1, AGENT_A);
    await env.notify();
    env.closeWhenActivated(1);
    await env.companion.click(env.notifications[0].id);
    expect(env.created).toEqual([browserNotificationTarget(ORIGIN, AGENT_A)]);
    expect(env.requireTab(2).url).toBe(browserNotificationTarget(ORIGIN, AGENT_B));
  });

  it("invalidates stale identity after navigation and never activates an unrelated page", async () => {
    const env = setup();
    await env.register(1, AGENT_A);
    await env.notify();
    env.requireTab(1).url = "https://example.org/private";
    await env.companion.tabUpdated(1, { url: env.requireTab(1).url }, env.requireTab(1));
    await env.companion.click(env.notifications[0].id);
    expect(env.requireTab(1).active).toBe(false);
    expect(env.requireTab(1).url).toBe("https://example.org/private");
    expect(env.created).toEqual([browserNotificationTarget(ORIGIN, AGENT_A)]);
  });

  it("retains busy pages and restores their original autoDiscardable setting on idle or unbind", async () => {
    const env = setup();
    env.requireTab(2).autoDiscardable = false;
    await env.register(1, AGENT_A);
    await env.register(2, AGENT_B, "attention");
    expect(env.requireTab(1).autoDiscardable).toBe(false);
    await env.register(1, AGENT_A, "none");
    await env.companion.disconnect(env.sender(2));
    expect(env.requireTab(1).autoDiscardable).toBe(true);
    expect(env.requireTab(2).autoDiscardable).toBe(false);
  });

  it("preserves the original discard policy when a replacement document registers", async () => {
    const env = setup();
    await env.register(1, AGENT_A);
    const sender = { ...env.sender(1), documentId: "replacement-document" };
    const state = { identity: AGENT_A, status: "running", visible: false, connected: true };
    await env.companion.receive(sender, { ...envelope, type: "state", state });
    await env.companion.receive(sender, {
      ...envelope,
      type: "state",
      state: { ...state, status: "none" },
    });
    expect(env.requireTab(1).autoDiscardable).toBe(true);
  });

  it("does not use a matching agent registered at a different allowed origin", async () => {
    const env = setup();
    env.requireTab(1).url = browserNotificationTarget("http://127.0.0.1:6767", AGENT_A);
    await env.register(1, AGENT_A);
    await env.notify();
    await env.companion.click(env.notifications[0].id);
    expect(env.requireTab(1).active).toBe(false);
    expect(env.created).toEqual([browserNotificationTarget(ORIGIN, AGENT_A)]);
  });

  it("rejects iframe, foreign origin, and malformed bridge messages", async () => {
    const env = setup();
    const message = { ...envelope, type: "notify", requestId: "one", notification: completion };
    expect(await env.companion.receive({ ...env.sender(2), frameId: 1 }, message)).toBeNull();
    expect(
      await env.companion.receive({ ...env.sender(2), pageUrl: "https://example.org/" }, message),
    ).toBeNull();
    expect(
      await env.companion.receive(env.sender(2), {
        ...message,
        arbitraryUrl: "https://example.org/",
      }),
    ).toBeNull();
    expect(env.notifications).toEqual([]);
  });

  it("keeps a bounded trace history across restarts without persisting notification text", async () => {
    const env = setup();
    for (let index = 0; index < 105; index++) {
      await env.companion.receive(env.sender(2), {
        ...envelope,
        type: "trace",
        trace: { identity: AGENT_A, stage: "suppressed-by-daemon", detail: `event ${index}` },
      });
    }
    await env.notify();
    const resumed = createCompanion(env.options);
    const diagnostics = await resumed.diagnostics();
    expect(diagnostics.traces).toHaveLength(100);
    expect(diagnostics.traces[0].detail).toBe("event 6");
    const stored = JSON.stringify(await env.browser.readSession());
    expect(stored).not.toContain(completion.title);
    expect(stored).not.toContain(completion.body);
  });

  it("shows a test notification failure in diagnostics and allows another attempt", async () => {
    const env = setup();
    env.setNotificationFailure(true);
    await expect(env.companion.testNotification()).rejects.toThrow(
      "Chrome notification adapter failed",
    );
    let diagnostics = await env.companion.diagnostics();
    expect(diagnostics.traces.at(-1)?.stage).toBe("failed");
    env.setNotificationFailure(false);
    await env.companion.testNotification();
    diagnostics = await env.companion.diagnostics();
    expect(diagnostics.traces.at(-1)?.stage).toBe("accepted");
    expect(env.notifications[0].id).toBe("paseo-companion-test");
  });
});
