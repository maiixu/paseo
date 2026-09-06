import {
  BROWSER_FEEDBACK_SOURCE,
  BROWSER_FEEDBACK_VERSION,
  BrowserCompanionMessageSchema,
  isBrowserFeedbackUrl,
  type BrowserCompanionDelivery,
  type BrowserFeedbackMessage,
  type BrowserFeedbackNotification,
  type BrowserFeedbackState,
  type BrowserFeedbackTrace,
} from "@getpaseo/protocol/browser-feedback";

type DeliveryResult = BrowserCompanionDelivery | { status: "unavailable" };

// Page-owned bridge only. The companion owns Chrome tab IDs and notification clicks.
export class BrowserCompanionClient {
  private ready = false;
  private state: BrowserFeedbackState | null = null;
  private traces: BrowserFeedbackTrace[] = [];
  private readyListeners = new Set<() => void>();
  private pending = new Map<string, (result: BrowserCompanionDelivery) => void>();

  constructor(private readonly page: Window) {
    page.addEventListener("message", this.receive);
    this.hello();
  }

  private post(message: BrowserFeedbackMessage): void {
    this.page.postMessage(message, this.page.location.origin);
  }

  hello(): void {
    this.post({
      source: BROWSER_FEEDBACK_SOURCE,
      version: BROWSER_FEEDBACK_VERSION,
      type: "hello",
    });
  }

  private receive = (event: MessageEvent<unknown>): void => {
    if (event.source !== this.page || event.origin !== this.page.location.origin) return;
    const parsed = BrowserCompanionMessageSchema.safeParse(event.data);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === "ready") {
      this.ready = true;
      for (const listener of this.readyListeners) listener();
      if (this.state) this.publishState(this.state);
      const traces = this.traces.splice(0);
      for (const trace of traces) this.trace(trace);
      return;
    }
    this.pending.get(message.requestId)?.(message);
  };

  publishState(state: BrowserFeedbackState): void {
    this.state = state;
    if (!this.ready) return;
    this.post({
      source: BROWSER_FEEDBACK_SOURCE,
      version: BROWSER_FEEDBACK_VERSION,
      type: "state",
      state,
    });
  }

  trace(trace: BrowserFeedbackTrace): void {
    if (!this.ready) {
      this.traces.push(trace);
      if (this.traces.length > 100) this.traces.shift();
      return;
    }
    this.post({
      source: BROWSER_FEEDBACK_SOURCE,
      version: BROWSER_FEEDBACK_VERSION,
      type: "trace",
      trace,
    });
  }

  async send(notification: BrowserFeedbackNotification): Promise<DeliveryResult> {
    if (!this.ready) {
      await new Promise<void>((resolve) => {
        const done = () => {
          this.page.clearTimeout(timeout);
          this.readyListeners.delete(done);
          resolve();
        };
        const timeout = this.page.setTimeout(done, 300);
        this.readyListeners.add(done);
        this.hello();
      });
    }
    if (!this.ready) return { status: "unavailable" };

    const requestId = this.page.crypto.randomUUID();
    return await new Promise<BrowserCompanionDelivery>((resolve) => {
      const finish = (result: BrowserCompanionDelivery) => {
        this.page.clearTimeout(timeout);
        this.pending.delete(requestId);
        resolve(result);
      };
      const timeout = this.page.setTimeout(
        () =>
          finish({
            source: "paseo-browser-companion",
            version: BROWSER_FEEDBACK_VERSION,
            type: "delivery",
            requestId,
            status: "failed",
            error: "The browser companion did not acknowledge the notification. Reload this tab.",
          }),
        5000,
      );
      this.pending.set(requestId, finish);
      this.post({
        source: BROWSER_FEEDBACK_SOURCE,
        version: BROWSER_FEEDBACK_VERSION,
        type: "notify",
        requestId,
        notification,
      });
    });
  }

  dispose(): void {
    this.page.removeEventListener("message", this.receive);
  }
}

let client: BrowserCompanionClient | null = null;

export function getBrowserCompanion(): BrowserCompanionClient | null {
  if (
    typeof window === "undefined" ||
    window.top !== window ||
    !isBrowserFeedbackUrl(window.location.href)
  ) {
    return null;
  }
  client ??= new BrowserCompanionClient(window);
  return client;
}

export function traceBrowserFeedback(trace: BrowserFeedbackTrace): void {
  getBrowserCompanion()?.trace(trace);
}
