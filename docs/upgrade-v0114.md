# Personal Paseo0.11.4 candidate

Merge upstream v0.11.4 into the existing personal Web/daemon branch. Preserve Project grouping, pinned ordering, schedule/heartbeat End, question attention, Companion routing, direct workspace bootstrap, context HUD and explicit host/profile defaults.

Routed Codex accounts keep the host-configured quota reader and native custody lookup. The legacy usage RPC remains available to older clients and the Usage Steward. New usage report requests receive separate Plus/Pro records from the same reader; the default-home Codex report is suppressed when router records are available. Other provider usage sources retain the upstream implementation. Desktop and compact context details share the routed cards. Explicit refresh bypasses the account cache; reconnect/window focus refresh stale UI observations.

This compatibility layer deliberately preserves the known account configuration and tool authority. It does not migrate native histories, change models, enable credits or replay tasks. Host-specific Pro-credit authorization remains in private router configuration.

## Validation

Server and app typechecks passed. Targeted launch/host/icon/sidebar tests83, catalog/account/schedule tests92, usage integration tests12 and account-card browser tests4 passed. Account request order is asynchronous; tests assert both identities and stable output order independently. Production deployment remains pending packaged-runtime, old-session and actual-browser acceptance and the external idle gate.

Build separate Web exports: mactop `srv_u8gICkIrpwaZ` / `codex-astra-medium`; Cloudtop `srv_SEG9hCDOBv2a` / `codex-sol6-high` (the profile resolves to its live definition). Preserve both hosts' existing provider/profile values. Do not replace them from an old accepted manifest.
