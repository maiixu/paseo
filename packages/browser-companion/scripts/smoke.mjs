import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import {
  BROWSER_FEEDBACK_SOURCE,
  BROWSER_FEEDBACK_VERSION,
  browserNotificationTarget,
} from "@getpaseo/protocol/browser-feedback";

const origin = "http://127.0.0.1:6769";
const identityA = { serverId: "smoke-local", agentId: "agent-a", workspaceId: "workspace-a" };
const identityB = { serverId: "smoke-tailnet", agentId: "agent-b", workspaceId: "workspace-b" };
const envelope = { source: BROWSER_FEEDBACK_SOURCE, version: BROWSER_FEEDBACK_VERSION };
const fixture = `<!doctype html><html><head><title>Companion smoke fixture</title></head><body><p>Isolated browser companion fixture; no daemon connection.</p><script>window.messages = []; window.addEventListener('message', (event) => { if (event.source === window) window.messages.push(event.data); });</script></body></html>`;
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(fixture);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(6769, "127.0.0.1", resolve);
});
const profile = await mkdtemp(path.join(tmpdir(), "paseo-companion-smoke-"));
let context;
try {
  const extension = path.resolve("dist");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let worker = context.serviceWorkers()[0];
  if (worker === undefined) {
    worker = await context.waitForEvent("serviceworker");
  }
  const extensionId = new URL(worker.url()).host;
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  async function send(page, message) {
    await page.evaluate((value) => {
      window.postMessage(value, location.origin);
    }, message);
  }
  async function register(page, identity) {
    await page.goto(browserNotificationTarget(origin, identity));
    await send(page, { ...envelope, type: "hello" });
    await page.waitForFunction(() =>
      window.messages.some(
        (message) => message.source === "paseo-browser-companion" && message.type === "ready",
      ),
    );
    await send(page, {
      ...envelope,
      type: "state",
      state: { identity, status: "running", visible: false, connected: true },
    });
  }
  await register(pageA, identityA);
  await register(pageB, identityB);
  await pageB.bringToFront();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  try {
    await popup
      .locator("#pages")
      .filter({ hasText: "2 connected page(s)" })
      .waitFor({ timeout: 10000 });
  } catch (error) {
    process.stderr.write(`${await popup.locator("body").innerText()}\n`);
    process.stderr.write(
      `${JSON.stringify(await worker.evaluate(async () => chrome.storage.session.get(null)))}\n`,
    );
    throw error;
  }
  assert.equal(
    await popup.locator("#permission").textContent(),
    "Extension notifications: granted",
  );
  const chromeTabs = await worker.evaluate(async () =>
    chrome.tabs.query({ url: "http://127.0.0.1/*" }),
  );
  assert.equal(chromeTabs.length, 2);
  assert.equal(
    chromeTabs.every((tab) => tab.autoDiscardable === false),
    true,
  );
  await send(pageB, {
    ...envelope,
    type: "notify",
    requestId: "smoke-completion",
    notification: {
      id: "smoke-completion-a",
      identity: identityA,
      reason: "finished",
      title: "Paseo isolated smoke test",
      body: "No real agent or daemon is involved.",
      createdAt: new Date().toISOString(),
    },
  });
  await pageB.waitForFunction(() =>
    window.messages.some(
      (message) => message.type === "delivery" && message.requestId === "smoke-completion",
    ),
  );
  const received = await pageB.evaluate(() =>
    window.messages.find(
      (message) => message.type === "delivery" && message.requestId === "smoke-completion",
    ),
  );
  assert.equal(received.status, "accepted", JSON.stringify(received));
  await popup.locator("#refresh").click();
  await popup.locator("#history").filter({ hasText: "Chrome accepted the notification" }).waitFor();
  await popup.locator("#test").click();
  await popup.locator("#outcome").filter({ hasText: "Chrome accepted the test" }).waitFor();
  const notifications = await worker.evaluate(async () => chrome.notifications.getAll());
  assert.equal(Object.keys(notifications).length, 2);

  // Fill real session storage to exercise the popup's visible failure path without mocking Chrome.
  await worker.evaluate(async () => {
    const used = await chrome.storage.session.getBytesInUse(null);
    await chrome.storage.session.set({
      smokeQuota: "x".repeat(chrome.storage.session.QUOTA_BYTES - used - 32),
    });
  });
  await popup.locator("#test").click();
  await popup.locator("#outcome.error").waitFor();
  assert.match(await popup.locator("#outcome").textContent(), /quota|QUOTA|storage/i);
  await worker.evaluate(async () => {
    await chrome.storage.session.remove("smokeQuota");
  });
  await popup.locator("#test").click();
  await popup.locator("#outcome").filter({ hasText: "Chrome accepted the test" }).waitFor();
  assert.equal(await popup.locator("#test").isEnabled(), true);
  await send(pageA, {
    ...envelope,
    type: "state",
    state: { identity: identityA, status: "none", visible: false, connected: true },
  });
  await popup.locator("#refresh").click();
  const idleTab = await worker.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0],
    browserNotificationTarget(origin, identityA),
  );
  assert.equal(idleTab.autoDiscardable, true);
  await worker.evaluate(async () => {
    const remaining = await chrome.notifications.getAll();
    await Promise.all(Object.keys(remaining).map((id) => chrome.notifications.clear(id)));
  });
  process.stdout.write(
    "PASS: packaged MV3 extension, real content/worker handshake, two agent registrations, Chrome notification acceptance, popup success/error/retry, and page retention/restoration.\n",
  );
  process.stdout.write(
    "NOT TESTED: actual macOS banner visibility, OS notification clicks, or real agent/daemon delivery.\n",
  );
} finally {
  if (context !== undefined) {
    await context.close();
  }
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await rm(profile, { recursive: true, force: true });
}
