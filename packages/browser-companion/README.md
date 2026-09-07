# Paseo Browser Companion

This private Chrome extension accompanies the browser-feedback Web build. It receives explicit agent state and notification events from Paseo pages, shows notifications, and returns you to the correct Chrome tab. It does not connect to a daemon or read agent credentials.

## Build and load

From the repository root:

```bash
npm install
npm run build --workspace=@getpaseo/protocol
npm run build --workspace=@getpaseo/browser-companion
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `packages/browser-companion/dist`. Loading into a personal Chrome profile enables the extension there; use an isolated profile for validation. After rebuilding, reload the extension and refresh the Paseo pages. For continued use, move the build to the stable location below before removing its worktree.

Use the extension action to check its notification permission, registered pages, recent delivery stages, and a test notification. A test accepted by Chrome is not proof that macOS showed a banner. Chrome notification settings, macOS notification settings, and Focus still apply.

The extension only accepts top-frame pages at `http://127.0.0.1:6767` and the isolated validation origin `http://127.0.0.1:6769`. Chrome match patterns cannot restrict ports, so the manifest declares localhost and the scripts enforce those two origins. Tailnet agents are supported through the localhost Paseo client's existing host connections. Pages served directly from other hostnames are outside this build's scope.

## Install and update on mactop

Finish the two-host acceptance journey before switching the live `6767` origin. This procedure keeps both official daemons installed; only mactop serves the custom Web build. Cloudtop needs no installation or restart. It assumes the existing `com.maixu.paseo` LaunchAgent, whose launcher already passes `--web-ui`.

Use Node 22 for this checkout. Build in the worktree, then copy the accepted artifacts into `~/.local/share/paseo/browser-feedback`. Never serve a worktree build directory: rebuilds can delete it, and worktree cleanup would remove the installed UI. The [daemon Web build](../../scripts/build-daemon-web-ui.mjs) also deletes its output directory before copying assets.

### New-agent defaults

The personal Web build pins global new-agent creation to cloudtop and the `codex-astra-medium` profile. Set these public build variables in the shell before building:

```bash
export EXPO_PUBLIC_PASEO_DEFAULT_SERVER_ID="$(ssh cloudtop 'cat ~/.paseo/server-id')"
export EXPO_PUBLIC_PASEO_DEFAULT_PROFILE_ID=codex-astra-medium
```

Keep these variables in later builds. The host ID identifies the saved connection; it is not a credential. Profile values come from that host's existing daemon configuration. Both hosts must carry the named profile. Profile ordering is separate from default selection and lives in each host's `daemon.agentProfiles`.

The homepage and global **New workspace** use the configured host. The homepage restores a remembered workspace only on that host; otherwise it opens a fresh draft there. Explicit host/project URLs and restored draft selections retain their context. A one-off model choice does not replace the next new agent's default. Existing agents retain their configuration. Builds without these variables keep the upstream selection behavior.

### Stage the files

Run these commands from the accepted feature worktree, after the build commands above. Keep the variables in the same shell for the subsequent steps. This creates private snapshots and stable installation directories; it does not change the running daemon.

```bash
set -e
umask 077
env -u PASEO_WEB_PLATFORM npm run build:web --workspace=@getpaseo/app
BF_ROOT="$HOME/.local/share/paseo/browser-feedback"
BF_RELEASE="$BF_ROOT/releases/$(git rev-parse --short=12 HEAD)"
BF_STOCK="/opt/homebrew/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/web-ui"
test -f "$BF_STOCK/index.html"
test ! -e "$BF_RELEASE"
mkdir -p "$BF_RELEASE/web" "$BF_RELEASE/extension" "$BF_ROOT/web"
rsync -a --exclude '*.br' --exclude '*.gz' packages/app/dist/ "$BF_RELEASE/web/"
rsync -a packages/browser-companion/dist/ "$BF_RELEASE/extension/"

# Save the official bundle once, before npm can upgrade or remove it.
if [ ! -d "$BF_ROOT/packaged-web" ]; then
  mkdir "$BF_ROOT/packaged-web"
  rsync -a --exclude '*.br' --exclude '*.gz' "$BF_STOCK/" "$BF_ROOT/packaged-web/"
fi
```

Use raw assets throughout this directory. Mixing new raw files with old `.br` or `.gz` siblings can serve stale compressed content. Preserve old hashed assets for open tabs that have not loaded every chunk yet. The middleware returns HTML for a missing asset path, so removing old chunks can break a page that initially appears healthy.

Define the publication helper in the same shell. `rsync` replaces individual files via temporary files; omit `--inplace` and `--delete`. Publish `index.html` last, after its dependencies exist. Retain release snapshots and old assets until all pages from those releases have closed or reloaded.

```bash
publish_web() {
  test -f "$1/index.html"
  rsync -ac --exclude index.html --exclude '*.br' --exclude '*.gz' "$1/" "$BF_ROOT/web/"
  cp "$1/index.html" "$BF_ROOT/web/.index.html.next"
  mv "$BF_ROOT/web/.index.html.next" "$BF_ROOT/web/index.html"
}

# Seed old chunks before publishing the first custom entry point.
if [ ! -f "$BF_ROOT/web/index.html" ]; then
  publish_web "$BF_ROOT/packaged-web"
fi
publish_web "$BF_RELEASE/web"
mkdir -p "$BF_ROOT/extension"
rsync -a "$BF_RELEASE/extension/" "$BF_ROOT/extension/"
```

In `chrome://extensions`, disable the worktree copy before loading the unpacked extension from `~/.local/share/paseo/browser-feedback/extension`. Loading from a different path can change its extension ID; check permission and registration again. Close and reopen the old Paseo pages to release their retained tab policy and establish fresh bindings. Do not delete the loaded extension's worktree until this migration is confirmed. Do not leave two companion copies enabled.

### First switch at the existing origin

The [Web middleware](../server/src/server/web-ui.ts) captures its directory at startup, and `features.webUi` is outside the [reloadable configuration](../server/src/server/daemon-config-store.ts). The first directory change requires a daemon restart. Later file updates at that same path do not.

Coordinate other configuration edits before this step. Check the LaunchAgent and its launcher for `PASEO_WEB_UI_DIST_DIR`: an environment override takes precedence over the persisted value. Save a private backup, then merge only `features.webUi.distDir`; do not replace the full config with a sample. These commands stage the configuration for the next daemon start:

```bash
BF_CONFIG="$HOME/.paseo/config.json"
test ! -e "$BF_ROOT/config-before-web.json"
cp "$BF_CONFIG" "$BF_ROOT/config-before-web.json"
chmod 600 "$BF_ROOT/config-before-web.json"
BF_CONFIG_TMP="$(mktemp "$HOME/.paseo/config.json.browser-feedback.XXXXXX")"
jq --arg dist "$BF_ROOT/web" '.features.webUi.distDir = $dist' "$BF_CONFIG" > "$BF_CONFIG_TMP"
chmod 600 "$BF_CONFIG_TMP"
mv "$BF_CONFIG_TMP" "$BF_CONFIG"
```

Run the restart only from an external terminal, after the user has agreed that running agents can be interrupted. Do not run it from a Paseo agent session: it ends that session and other daemon-managed work. A reload cannot apply this setting.

```bash
launchctl kickstart -k "gui/$(id -u)/com.maixu.paseo"
curl --fail http://127.0.0.1:6767/api/health
```

After the daemon returns, verify that `6767` serves the new entry point and assets. Refresh a Paseo page, confirm both host connections, profile tags and Gemini icon, then repeat one normal background completion and notification click. Check the companion popup's registration and permission. A healthy daemon alone does not verify the new Web build. Keep the discussion open until live-origin verification is recorded.

For later updates, create a new release snapshot and run `publish_web "$BF_RELEASE/web"` at the same stable path. Refresh pages to adopt it; no daemon restart is needed. If the companion changed, copy its release into the stable extension directory, manually reload it, then refresh the Paseo pages. Keep the Chrome notification settings and Focus exception accepted during testing.

### Roll back

For a restart-free Web rollback, use `publish_web` with the previous release's `web` directory, or with `"$BF_ROOT/packaged-web"` to restore the saved official UI. This leaves newer hashed assets available to still-open pages. Refresh affected pages and verify the restored behavior. To roll back the extension, copy its previous release into the stable extension directory and manually reload it, then refresh pages. If disabling or removing it instead, close and reopen retained Paseo tabs to release their discard policy.

To return to the daemon's configured bundle location, restore only the original `distDir` value from the private backup. Preserve configuration edits made since installation. Run this from the same shell with `BF_ROOT` and `BF_CONFIG` set:

```bash
BF_CONFIG_TMP="$(mktemp "$HOME/.paseo/config.json.browser-feedback.XXXXXX")"
jq --slurpfile before "$BF_ROOT/config-before-web.json" '
  if ($before[0].features.webUi | has("distDir")) then
    .features.webUi.distDir = $before[0].features.webUi.distDir
  else
    del(.features.webUi.distDir)
  end
' "$BF_CONFIG" > "$BF_CONFIG_TMP"
chmod 600 "$BF_CONFIG_TMP"
mv "$BF_CONFIG_TMP" "$BF_CONFIG"
```

Repeat the external restart gate and live-origin checks above. Do not delete snapshots or stable installation directories while the daemon or extension still references them.

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
