import {
  BROWSER_COMPANION_SOURCE,
  BROWSER_FEEDBACK_SOURCE,
  BROWSER_FEEDBACK_VERSION,
  BrowserCompanionMessageSchema,
  BrowserFeedbackMessageSchema,
  isBrowserFeedbackUrl,
  type BrowserFeedbackMessage,
} from "@getpaseo/protocol/browser-feedback";

function startBridge(): void {
  if (window !== window.top || !isBrowserFeedbackUrl(location.href)) {
    return;
  }
  let port: chrome.runtime.Port | null = null;
  let lastState: Extract<BrowserFeedbackMessage, { type: "state" }> | null = null;
  const pending = new Set<string>();
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function connect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (port !== null || stopped) {
      return;
    }
    try {
      port = chrome.runtime.connect({ name: "paseo-browser-feedback" });
    } catch {
      // Reloading/removing an extension invalidates existing content scripts. Refresh the page.
      stopped = true;
      return;
    }
    port.onMessage.addListener((input: unknown) => {
      const parsed = BrowserCompanionMessageSchema.safeParse(input);
      if (!parsed.success) {
        return;
      }
      if (parsed.data.type === "delivery") {
        pending.delete(parsed.data.requestId);
      }
      window.postMessage(parsed.data, location.origin);
    });
    port.onDisconnect.addListener(() => {
      // Reading lastError consumes Chrome's disconnected-port diagnostic.
      const error =
        chrome.runtime.lastError?.message ??
        "Paseo companion disconnected before acknowledging delivery";
      port = null;
      for (const requestId of pending) {
        window.postMessage(
          {
            source: BROWSER_COMPANION_SOURCE,
            version: BROWSER_FEEDBACK_VERSION,
            type: "delivery",
            requestId,
            status: "failed",
            error: error.slice(0, 300),
          },
          location.origin,
        );
      }
      pending.clear();
      if (reconnectTimer === null) {
        reconnectTimer = setTimeout(connect, 1000);
      }
    });
    port.postMessage({
      source: BROWSER_FEEDBACK_SOURCE,
      version: BROWSER_FEEDBACK_VERSION,
      type: "hello",
    });
    if (lastState !== null) {
      port.postMessage(lastState);
    }
  }

  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== location.origin) {
      return;
    }
    const parsed = BrowserFeedbackMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      return;
    }
    if (parsed.data.type === "state") {
      lastState = parsed.data;
    }
    if (port === null) {
      connect();
    }
    if (parsed.data.type === "notify" && port === null) {
      window.postMessage(
        {
          source: BROWSER_COMPANION_SOURCE,
          version: BROWSER_FEEDBACK_VERSION,
          type: "delivery",
          requestId: parsed.data.requestId,
          status: "failed",
          error: "Paseo companion was reloaded or removed. Refresh this page.",
        },
        location.origin,
      );
      return;
    }
    if (parsed.data.type === "notify") {
      pending.add(parsed.data.requestId);
    }
    port?.postMessage(parsed.data);
  });
  connect();
}

startBridge();
