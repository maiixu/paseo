import { z } from "zod";
import {
  BROWSER_COMPANION_SOURCE,
  BROWSER_FEEDBACK_VERSION,
  BrowserAgentIdentitySchema,
  BrowserFeedbackMessageSchema,
  BrowserFeedbackStateSchema,
  BrowserFeedbackTraceSchema,
  browserAgentKey,
  browserNotificationTarget,
  isBrowserFeedbackUrl,
  type BrowserAgentIdentity,
  type BrowserCompanionDelivery,
  type BrowserCompanionMessage,
  type BrowserFeedbackNotification,
} from "@getpaseo/protocol/browser-feedback";

const BindingSchema = z.object({
  tabId: z.number().int(),
  pageUrl: z.string(),
  documentId: z.string(),
  state: BrowserFeedbackStateSchema,
  live: z.boolean(),
  lastActiveAt: z.number(),
  previousAutoDiscardable: z.boolean().nullable(),
});
const DeliverySchema = z.object({
  id: z.string(),
  chromeId: z.string(),
  origin: z.string(),
  identity: BrowserAgentIdentitySchema,
  acceptedAt: z.number(),
});
export const TraceSchema = BrowserFeedbackTraceSchema.extend({
  at: z.number(),
  tabId: z.number().int().nullable(),
});
const SessionSchema = z.object({
  version: z.literal(1),
  bindings: z.array(BindingSchema),
  deliveries: z.array(DeliverySchema),
  traces: z.array(TraceSchema),
});
export const DiagnosticsSchema = z.object({
  permission: z.enum(["granted", "denied"]),
  bindings: z.array(BindingSchema),
  traces: z.array(TraceSchema),
});
export type Diagnostics = z.infer<typeof DiagnosticsSchema>;
type Binding = z.infer<typeof BindingSchema>;
type Delivery = z.infer<typeof DeliverySchema>;
type Session = z.infer<typeof SessionSchema>;
type Trace = z.infer<typeof TraceSchema>;

export interface PageSender {
  tabId: number;
  frameId: number;
  documentId: string;
  pageUrl: string;
}

// Browser APIs are the only replaceable boundary; the same coordinator runs in the worker and tests.
export interface CompanionBrowser {
  readSession(): Promise<unknown>;
  writeSession(session: Session): Promise<void>;
  getTab(tabId: number): Promise<chrome.tabs.Tab | null>;
  updateTab(tabId: number, update: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | null>;
  createTab(url: string): Promise<chrome.tabs.Tab>;
  getWindow(windowId: number): Promise<chrome.windows.Window>;
  focusWindow(windowId: number): Promise<void>;
  notificationPermission(): Promise<"granted" | "denied">;
  createNotification(
    id: string,
    notification: Pick<BrowserFeedbackNotification, "title" | "body">,
  ): Promise<void>;
  clearNotification(id: string): Promise<void>;
}
interface CompanionOptions {
  browser: CompanionBrowser;
  now: () => number;
}
interface TargetTab {
  binding: Binding;
  tab: chrome.tabs.Tab;
}

export function browserErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 300);
  }
  return "Chrome operation failed";
}

function isTrustedSender(sender: PageSender): boolean {
  return sender.frameId === 0 && isBrowserFeedbackUrl(sender.pageUrl);
}

function sameAgent(left: BrowserAgentIdentity | null, right: BrowserAgentIdentity): boolean {
  return left !== null && browserAgentKey(left) === browserAgentKey(right);
}

function matchesPage(binding: Binding, tab: chrome.tabs.Tab): boolean {
  const hasSameUrl = tab.url === binding.pageUrl && isBrowserFeedbackUrl(tab.url);
  const isNavigatingElsewhere = tab.pendingUrl !== undefined && tab.pendingUrl !== binding.pageUrl;
  return hasSameUrl && !isNavigatingElsewhere;
}

async function notificationId(origin: string, id: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([origin, id]));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `paseo-${hex}`;
}

export function createCompanion({ browser, now }: CompanionOptions) {
  let tail: Promise<unknown> = Promise.resolve();
  let session: Session | null = null;

  async function transact<T>(operation: (current: Session) => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      if (session === null) {
        const stored = await browser.readSession();
        session =
          stored === undefined
            ? { version: 1, bindings: [], deliveries: [], traces: [] }
            : SessionSchema.parse(stored);
      }
      try {
        return await operation(session);
      } finally {
        await browser.writeSession(session);
      }
    });
    tail = result.catch(() => undefined);
    return result;
  }

  function trace(current: Session, entry: Omit<Trace, "at">): void {
    current.traces.push({ ...entry, at: now() });
    current.traces = current.traces.slice(-100);
  }

  async function releasePageRetention(binding: Binding): Promise<void> {
    if (binding.previousAutoDiscardable !== null) {
      await browser.updateTab(binding.tabId, { autoDiscardable: binding.previousAutoDiscardable });
      binding.previousAutoDiscardable = null;
    }
  }

  async function removeBinding(current: Session, binding: Binding): Promise<void> {
    await releasePageRetention(binding);
    current.bindings = current.bindings.filter((candidate) => candidate.tabId !== binding.tabId);
  }

  async function targetTabs(
    current: Session,
    delivery: Pick<Delivery, "identity" | "origin">,
  ): Promise<TargetTab[]> {
    const matches: TargetTab[] = [];
    for (const binding of current.bindings) {
      const originMatches = new URL(binding.pageUrl).origin === delivery.origin;
      if (!originMatches || !sameAgent(binding.state.identity, delivery.identity)) {
        continue;
      }
      const tab = await browser.getTab(binding.tabId);
      if (tab === null || !matchesPage(binding, tab)) {
        await removeBinding(current, binding);
        continue;
      }
      // A loaded page without its bridge may have changed panes without changing its URL.
      if (!binding.live && !tab.discarded) {
        continue;
      }
      matches.push({ binding, tab });
    }
    return matches.sort((a, b) => {
      const aLive = a.binding.live && !a.tab.discarded;
      const bLive = b.binding.live && !b.tab.discarded;
      return Number(bLive) - Number(aLive) || b.binding.lastActiveAt - a.binding.lastActiveAt;
    });
  }

  async function notify(
    current: Session,
    sender: PageSender,
    notification: BrowserFeedbackNotification,
  ): Promise<Omit<BrowserCompanionDelivery, "source" | "version" | "type" | "requestId">> {
    const origin = new URL(sender.pageUrl).origin;
    const existing = current.deliveries.find(
      (delivery) => delivery.id === notification.id && delivery.origin === origin,
    );
    if (existing) {
      return { status: "duplicate", error: null };
    }
    const target = { origin, identity: notification.identity };
    const tabs = await targetTabs(current, target);
    for (const { tab } of tabs) {
      if (!tab.active) {
        continue;
      }
      const window = await browser.getWindow(tab.windowId);
      if (window.focused) {
        trace(current, {
          tabId: sender.tabId,
          identity: notification.identity,
          stage: "suppressed-focused",
          detail: "The target agent is active in a focused Chrome window",
        });
        return { status: "suppressed", error: null };
      }
    }
    try {
      if ((await browser.notificationPermission()) !== "granted") {
        const error = "Notifications are disabled for Paseo Browser Companion";
        trace(current, {
          tabId: sender.tabId,
          identity: notification.identity,
          stage: "failed",
          detail: error,
        });
        return { status: "failed", error };
      }
      const chromeId = await notificationId(origin, notification.id);
      await browser.createNotification(chromeId, notification);
      current.deliveries.push({ id: notification.id, chromeId, ...target, acceptedAt: now() });
      trace(current, {
        tabId: sender.tabId,
        identity: notification.identity,
        stage: "accepted",
        detail: "Chrome accepted the notification; banner visibility depends on system settings",
      });
      return { status: "accepted", error: null };
    } catch (error) {
      const message = browserErrorMessage(error);
      trace(current, {
        tabId: sender.tabId,
        identity: notification.identity,
        stage: "failed",
        detail: message,
      });
      return { status: "failed", error: message };
    }
  }

  async function receive(
    sender: PageSender,
    input: unknown,
  ): Promise<BrowserCompanionMessage | null> {
    if (!isTrustedSender(sender)) {
      return null;
    }
    const parsed = BrowserFeedbackMessageSchema.safeParse(input);
    if (!parsed.success) {
      return null;
    }
    const message = parsed.data;
    return transact(async (current) => {
      const tab = await browser.getTab(sender.tabId);
      const matchesSender = tab !== null && tab.url === sender.pageUrl;
      const isNavigatingAway =
        tab !== null && tab.pendingUrl !== undefined && tab.pendingUrl !== sender.pageUrl;
      if (!matchesSender || isNavigatingAway) {
        return null;
      }
      const envelope = {
        source: BROWSER_COMPANION_SOURCE,
        version: BROWSER_FEEDBACK_VERSION,
      } as const;
      if (message.type === "hello") {
        return { ...envelope, type: "ready" };
      }
      if (message.type === "trace") {
        trace(current, { ...message.trace, tabId: sender.tabId });
        return null;
      }
      if (message.type === "notify") {
        const delivery = await notify(current, sender, message.notification);
        return { ...envelope, type: "delivery", requestId: message.requestId, ...delivery };
      }
      let originalAutoDiscardable = tab.autoDiscardable;
      let binding = current.bindings.find((candidate) => candidate.tabId === sender.tabId);
      if (binding && binding.documentId !== sender.documentId) {
        if (binding.previousAutoDiscardable !== null) {
          originalAutoDiscardable = binding.previousAutoDiscardable;
        }
        await removeBinding(current, binding);
        binding = undefined;
      }
      if (binding === undefined) {
        binding = {
          tabId: sender.tabId,
          documentId: sender.documentId,
          pageUrl: sender.pageUrl,
          state: message.state,
          live: true,
          lastActiveAt: 0,
          previousAutoDiscardable: null,
        };
        current.bindings.push(binding);
      }
      binding.pageUrl = sender.pageUrl;
      binding.state = message.state;
      binding.live = true;
      if (tab.active) {
        binding.lastActiveAt = now();
      }
      const keepPage = message.state.identity !== null && message.state.status !== "none";
      if (keepPage && binding.previousAutoDiscardable === null) {
        binding.previousAutoDiscardable = originalAutoDiscardable;
        await browser.updateTab(sender.tabId, { autoDiscardable: false });
      }
      if (!keepPage) {
        await releasePageRetention(binding);
      }
      return null;
    });
  }

  async function disconnect(sender: PageSender): Promise<void> {
    await transact(async (current) => {
      const binding = current.bindings.find(
        (candidate) =>
          candidate.tabId === sender.tabId && candidate.documentId === sender.documentId,
      );
      if (!binding) {
        return;
      }
      const tab = await browser.getTab(sender.tabId);
      if (tab !== null && matchesPage(binding, tab)) {
        // Port disconnection can precede Chrome's discarded-state update.
        binding.live = false;
        await releasePageRetention(binding);
        return;
      }
      await removeBinding(current, binding);
    });
  }

  async function tabUpdated(
    tabId: number,
    change: chrome.tabs.OnUpdatedInfo,
    tab: chrome.tabs.Tab,
  ): Promise<void> {
    await transact(async (current) => {
      const binding = current.bindings.find((candidate) => candidate.tabId === tabId);
      if (!binding) {
        return;
      }
      if (tab.discarded && matchesPage(binding, tab)) {
        binding.live = false;
        return;
      }
      const startsLoading = change.status === "loading";
      if (!matchesPage(binding, tab) || startsLoading) {
        await removeBinding(current, binding);
      }
    });
  }

  async function tabRemoved(tabId: number): Promise<void> {
    await transact(async (current) => {
      current.bindings = current.bindings.filter((binding) => binding.tabId !== tabId);
    });
  }

  async function tabActivated(tabId: number): Promise<void> {
    await transact(async (current) => {
      const binding = current.bindings.find((candidate) => candidate.tabId === tabId);
      if (binding) {
        binding.lastActiveAt = now();
      }
    });
  }

  async function click(chromeId: string): Promise<void> {
    await transact(async (current) => {
      const delivery = current.deliveries.find((candidate) => candidate.chromeId === chromeId);
      if (!delivery) {
        return;
      }
      const targetUrl = browserNotificationTarget(delivery.origin, delivery.identity);
      const candidates = await targetTabs(current, delivery);
      for (const { binding } of candidates) {
        // Recheck immediately before activation: another user action may have closed or navigated it.
        const tab = await browser.getTab(binding.tabId);
        if (tab === null || !matchesPage(binding, tab)) {
          await removeBinding(current, binding);
          continue;
        }
        if (!binding.live && !tab.discarded) {
          continue;
        }
        const update: chrome.tabs.UpdateProperties = { active: true };
        if (tab.discarded) {
          update.url = targetUrl;
        }
        const activated = await browser.updateTab(binding.tabId, update);
        if (activated === null) {
          await removeBinding(current, binding);
          continue;
        }
        await browser.focusWindow(activated.windowId);
        await browser.clearNotification(chromeId);
        return;
      }
      const opened = await browser.createTab(targetUrl);
      await browser.focusWindow(opened.windowId);
      await browser.clearNotification(chromeId);
    });
  }

  async function diagnostics(): Promise<Diagnostics> {
    return transact(async (current) => {
      for (const binding of current.bindings) {
        const tab = await browser.getTab(binding.tabId);
        if (tab === null || !matchesPage(binding, tab)) {
          await removeBinding(current, binding);
        }
      }
      return {
        permission: await browser.notificationPermission(),
        bindings: current.bindings,
        traces: current.traces,
      };
    });
  }

  async function testNotification(): Promise<void> {
    await transact(async (current) => {
      const identity = null;
      try {
        if ((await browser.notificationPermission()) !== "granted") {
          throw new Error("Notifications are disabled for Paseo Browser Companion");
        }
        await browser.createNotification("paseo-companion-test", {
          title: "Paseo notification test",
          body: "Chrome accepted this test. This does not test agent completion or daemon recipient selection.",
        });
        trace(current, {
          tabId: null,
          identity,
          stage: "accepted",
          detail: "Test notification accepted by Chrome",
        });
      } catch (error) {
        trace(current, {
          tabId: null,
          identity,
          stage: "failed",
          detail: browserErrorMessage(error),
        });
        throw error;
      }
    });
  }

  async function reportError(error: unknown): Promise<void> {
    await transact(async (current) => {
      trace(current, {
        tabId: null,
        identity: null,
        stage: "failed",
        detail: browserErrorMessage(error),
      });
    });
  }

  return {
    receive,
    disconnect,
    tabUpdated,
    tabRemoved,
    tabActivated,
    click,
    diagnostics,
    testNotification,
    reportError,
  };
}
