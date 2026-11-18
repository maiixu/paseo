# Personal Paseo 0.16.2 upgrade

Upstream v0.16.2 is merged into the maintained personal Web/daemon branch. The
accepted runtime source is 128f055aeb038f5ed9100f2e4c84518bc987247b; the immutable
release is `0.16.2-personal-128f055ae-final`. Intelligence's
`machine/paseo/accepted-deployment.json` owns the per-host hashes and native pins.

Retained patches include current-tab Companion routing, question attention,
host-specific profiles, Project grouping and pins, Context HUD, schedule End and
history, routed account usage, ACP cancellation acknowledgement, and optional
cache read deadlines. Profiles accept both new options and legacy featureValues,
preserving explicit Fast-off. The bare CLI usage summary remains available.
The focused workspace owns directory demand, including reconnect readiness;
compact headers retain Context HUD. Desktop details use hover and compact details
use a click/sheet. No production workspace-recovery defect was established by the
old post-cleanup screenshot of an already deleted test workspace.

## Validation and rollout

Server, CLI and Web builds/typechecks passed. Focused app tests passed 164 cases,
ACP/account/resource tests passed 162, and directory/cache tests passed 44.
Desktop and 390px Context HUD browser acceptance passed. Actual immutable-package
HTTP and native PTY checks passed. Both current directory plugins compiled and
reported running in an isolated packaged daemon. Fixtures disable bundled skill
writes and use private state; management-socket readiness follows HTTP health.

All 399 copied stored records preserved identity, model, effort and Fast across
the options migration. Native Codex 0.170 restored an old copied history with nine
turns; the source hash was unchanged and no inference was sent. AGY 1.5 separately
restored a copied native history with 1,297 notifications and unchanged source.

On November 18, Cloudtop switched first and Mactop second using independent
external launchd jobs. Each recorded exactly one restart and new_runtime_verified.
Cloudtop retained 356 agents and 19 schedules; Mactop retained 72 agents and zero
schedules. Both final deployment checks passed, and both Codex catalogues advertised
GPT-6.2 Astra/Sol. Existing model/effort/Fast, schedule identity/history and account
routing were preserved; new automatic idle-runtime cleanup remains disabled.
The original Cloudtop maintenance conversation resumed through actual Codex 0.170.
Its live Chrome page retained history, Context HUD and its GPT-6 Astra selection.
Mactop live desktop interaction remains unverified because its Computer Use endpoint
rejected sender authentication; serving bytes, runtime ancestry and RPC passed.
No host OS was rebooted. Mactop OS reboot remains explicitly deferred.

Retain compatible runtime/launcher pairs and private metadata/native/SQLite
snapshots. Completed one-shot jobs were unloaded; never replay their inputs.
Inspect the owning host's saved outcome before any retry or rollback. Existing
agent workers, account custody and durable services require the same safe-idle
boundary for future disruptive changes. No additional paid canary is authorized.
