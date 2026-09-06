import {
  BROWSER_COMPANION_SOURCE,
  BROWSER_FEEDBACK_VERSION,
  BrowserFeedbackMessageSchema,
  isBrowserFeedbackUrl,
} from "@getpaseo/protocol/browser-feedback";
import { z } from "zod";
import {
  browserErrorMessage,
  createCompanion,
  type CompanionBrowser,
  type PageSender,
} from "./companion";

const SESSION_KEY = "paseo-browser-companion-v1";
const PopupRequestSchema = z.enum(["diagnostics", "test-notification"]);

function tabIsGone(error: unknown): boolean {
  return error instanceof Error && /No tab with id|Invalid tab ID/.test(error.message);
}

const browser: CompanionBrowser = {
  async readSession() {
    const stored = await chrome.storage.session.get(SESSION_KEY);
    return stored[SESSION_KEY];
  },
  async writeSession(session) {
    await chrome.storage.session.set({ [SESSION_KEY]: session });
  },
  async getTab(tabId) {
    try {
      return await chrome.tabs.get(tabId);
    } catch (error) {
      if (tabIsGone(error)) {
        return null;
      }
      throw error;
    }
  },
  async updateTab(tabId, update) {
    try {
      const tab = await chrome.tabs.update(tabId, update);
      return tab ?? null;
    } catch (error) {
      if (tabIsGone(error)) {
        return null;
      }
      throw error;
    }
  },
  createTab(url) {
    return chrome.tabs.create({ url, active: true });
  },
  getWindow(windowId) {
    return chrome.windows.get(windowId);
  },
  async focusWindow(windowId) {
    await chrome.windows.update(windowId, { focused: true });
  },
  notificationPermission() {
    return chrome.notifications.getPermissionLevel();
  },
  async createNotification(id, notification) {
    await chrome.notifications.create(id, {
      type: "basic",
      title: notification.title,
      message: notification.body,
      iconUrl: chrome.runtime.getURL("notification-icon.png"),
    });
  },
  async clearNotification(id) {
    await chrome.notifications.clear(id);
  },
};

const companion = createCompanion({ browser, now: Date.now });

function observe(operation: Promise<unknown>): void {
  void operation.catch(async (error: unknown) => {
    try {
      await companion.reportError(error);
    } catch {
      // Storage itself failed: preserve a visible indicator even when diagnostics cannot be written.
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setTitle({ title: "Paseo Browser Companion: session storage failed" });
    }
  });
}

chrome.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  if (port.name !== "paseo-browser-feedback" || sender === undefined) {
    port.disconnect();
    return;
  }
  const tabId = sender.tab?.id;
  const senderUrl = sender.url;
  const documentId = sender.documentId;
  const validSender =
    sender.id === chrome.runtime.id &&
    sender.frameId === 0 &&
    tabId !== undefined &&
    documentId !== undefined &&
    senderUrl !== undefined &&
    isBrowserFeedbackUrl(senderUrl);
  if (!validSender) {
    port.disconnect();
    return;
  }
  const origin = new URL(senderUrl).origin;
  let disconnected = false;
  let messages: Promise<unknown> = Promise.resolve();
  let latestSender: PageSender = { tabId, frameId: 0, documentId, pageUrl: senderUrl };
  port.onMessage.addListener((input: unknown) => {
    const parsed = BrowserFeedbackMessageSchema.safeParse(input);
    if (!parsed.success) {
      return;
    }
    const operation = messages.then(async () => {
      const tab = await browser.getTab(tabId);
      const pageUrl = tab?.url;
      if (
        pageUrl === undefined ||
        new URL(pageUrl).origin !== origin ||
        !isBrowserFeedbackUrl(pageUrl)
      ) {
        return;
      }
      latestSender = { tabId, frameId: 0, documentId, pageUrl };
      try {
        const response = await companion.receive(latestSender, parsed.data);
        if (response !== null && !disconnected) {
          port.postMessage(response);
        }
      } catch (error) {
        if (parsed.data.type === "notify" && !disconnected) {
          port.postMessage({
            source: BROWSER_COMPANION_SOURCE,
            version: BROWSER_FEEDBACK_VERSION,
            type: "delivery",
            requestId: parsed.data.requestId,
            status: "failed",
            error: browserErrorMessage(error),
          });
        }
        throw error;
      }
      return null;
    });
    messages = operation.catch(() => undefined);
    observe(operation);
  });
  port.onDisconnect.addListener(() => {
    disconnected = true;
    observe(messages.then(() => companion.disconnect(latestSender)));
  });
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  observe(companion.tabUpdated(tabId, change, tab));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  observe(companion.tabRemoved(tabId));
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  observe(companion.tabActivated(tabId));
});
chrome.notifications.onClicked.addListener((id) => {
  observe(companion.click(id));
});
chrome.runtime.onMessage.addListener((input: unknown, sender, sendResponse) => {
  const fromPopup =
    sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html");
  const parsed = PopupRequestSchema.safeParse(input);
  if (!fromPopup || !parsed.success) {
    return false;
  }
  void (async () => {
    try {
      if (parsed.data === "test-notification") {
        await companion.testNotification();
      }
      sendResponse({ status: "ok", diagnostics: await companion.diagnostics() });
    } catch (error) {
      sendResponse({ status: "error", error: browserErrorMessage(error) });
    }
  })();
  return true;
});
