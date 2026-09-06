# Paseo Browser Companion

This private Chrome extension accompanies the browser-feedback Web build. It receives explicit agent state and notification events from Paseo pages, shows notifications, and returns you to the correct Chrome tab. It does not connect to a daemon or read agent credentials.

## Build and load

From the repository root:

```bash
npm install
npm run build --workspace=@getpaseo/protocol
npm run build --workspace=@getpaseo/browser-companion
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `packages/browser-companion/dist`. Loading into a personal Chrome profile enables the extension there; use an isolated profile for validation. After rebuilding, reload the extension and refresh the Paseo pages.

Use the extension action to check its notification permission, registered pages, recent delivery stages, and a test notification. A test accepted by Chrome is not proof that macOS showed a banner. Chrome notification settings, macOS notification settings, and Focus still apply.

The extension only accepts top-frame pages at `http://127.0.0.1:6767` and the isolated validation origin `http://127.0.0.1:6769`. Chrome match patterns cannot restrict ports, so the manifest declares localhost and the scripts enforce those two origins. Tailnet agents are supported through the localhost Paseo client's existing host connections. Pages served directly from other hostnames are outside this build's scope.

## Permissions and retained state

- `notifications` creates the system notification. Clicking it selects an existing tab for the same origin and agent, or opens a new tab when there is no valid match.
- `tabs` reads tab URL, activation, and discard state to validate bindings and activate the correct tab and window. Unrelated tabs are never navigated. A discarded matching tab is restored at the canonical agent URL in that same tab.
- `storage` keeps tab bindings, accepted event IDs, notification target metadata, and the last 100 trace entries in `storage.session`. They survive service-worker suspension and are cleared with the browser session. Notification title/body text is not persisted. Nothing is uploaded or synchronized.
- Localhost access runs the bridge content script. The bridge accepts the versioned protocol in `@getpaseo/protocol/browser-feedback`; it does not scrape the UI or intercept WebSockets.

Running and attention tabs are marked `autoDiscardable: false`, retaining their page and agent connection at the cost of browser memory. Idle/unbound tabs regain their previous setting. Disabling or removing an extension cannot run cleanup code: close and reopen retained Paseo tabs after removal to release that tab policy. The extension cannot draw a favicon in a discarded page or receive new agent events after every Paseo page has closed.

The Web build owns per-agent favicon rendering and daemon attention acknowledgement. The companion retains the daemon's `shouldNotify` recipient selection, including its presence threshold. The Web build uses its native notification path only when the companion is unavailable before dispatch; it does not retry through a second outlet after a failed or ambiguous acknowledgement. The companion does not repair events suppressed or never emitted by the daemon. The popup traces distinguish daemon suppression, focused-tab suppression, Chrome acceptance, and errors. “Accepted” means the browser API call succeeded; it is not a delivery receipt from macOS.

## Verification

```bash
npm run test --workspace=@getpaseo/browser-companion
npm run test:browser --workspace=@getpaseo/browser-companion
npm run typecheck --workspace=@getpaseo/browser-companion
npm run lint -- packages/browser-companion
npm run build --workspace=@getpaseo/browser-companion
```

The targeted tests exercise the production coordinator against an in-memory adapter for Chrome-only APIs. They cover concurrent duplicates, worker rehydration, retry after failure, focused-window suppression, live/discarded/closed targets, close and navigation races, origin isolation, resource-policy restoration, and bounded diagnostics. These are logic tests, not browser or OS notification end-to-end tests.

`test:browser` requires the Playwright Chromium executable (`npm exec playwright install chromium`). It binds port 6769, loads the actual built extension in a temporary Chromium profile, and removes the fixture server and profile afterward. It exercises real content-script/worker registration, the notifications API, popup success/error/retry, and page retention. Its error case fills real session storage to its quota and verifies recovery after releasing it. It does not test native OS notification clicks or visible macOS banners.

For full acceptance, verify the target tab and window after an actual notification click and confirm the second tab stays in place. Agent completion and visible macOS banner delivery require the full two-host journey recorded in Discussion #563.
