# Personal Paseo 0.16.2 candidate

Merge upstream v0.16.2 into the maintained personal Web/daemon branch. Preserve current-tab Companion notifications, question attention, host-specific launch profiles, Project grouping and pins, Context HUD, schedule End/history, routed account usage and ACP cancellation acknowledgement.

The upstream provider-options migration now reads both profile `options` and legacy `featureValues`; it must preserve explicit Fast-off. The CLI retains the existing bare `usage` summary contract while exposing upstream usage subcommands. Existing conversation settings and native identities remain unchanged.

Server and CLI builds and Web typecheck passed. Focused app tests passed except an initially exposed profile-options migration gap, now fixed and covered; 31 default/draft tests passed. Usage/catalog/schedule tests passed, and the ACP/account/resource suite passed 162 tests after fixing a merged test import. Browser and packaged-runtime acceptance are pending. Neither production host is switched.

Retain runtime/launcher and state snapshots. Upstream now has idle-runtime cleanup, terminal workers, provider options and restart recovery; verify custody, background tasks, retained questions and schedule history before any rollout. Do not enable automatic recovery, new providers, model defaults or paid fallback as a migration side effect.

The 0.16 compact header replaces the previous screen header, so the Context HUD
is explicitly retained in its action slot. The focused workspace also owns its
directory demand, including reconnect readiness; it must not depend on the desktop
sidebar mounting. Optional cache read deadlines remain. A route refresh promoted
to full demand now attaches label metadata without a duplicate directory fetch.
All 44 directory/cache tests pass; fresh desktop/mobile browser verification is
running against these final changes.

Desktop and 390px browser acceptance passed. The compact details UI uses a click/sheet, while desktop uses hover; the test now checks the actual interaction. An earlier post-cleanup screenshot misleadingly showed a deleted fixture workspace and is not evidence of a workspace recovery defect.
