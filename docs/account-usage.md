# Account usage in the context tooltip

The composer ring measures the current conversation's context window. Its tooltip
keeps that information separate from subscription allowance. The selected host's
provider-usage RPC owns the allowance, not the host serving the Web files.

On a host whose live Codex command selects `paseo-codex-router.py`, the daemon reads
that command's explicit configuration and reports each configured subscription
separately. Account aliases, allowance windows, reset times and fetch timestamps
reach the client; credentials, account home paths and native histories do not.
Each account uses only its own auth file. Missing/expired credentials remain
unavailable instead of borrowing the primary account. Reading usage does not
refresh credentials, run inference, or change the route.

The optional request `agentId` resolves through the daemon's agent manager to a
native thread. The router's ownership ledger identifies its assigned account and
whether it is waiting for quota, switching, or needs recovery review. The current
route is read on every request, independently of the one-minute account quota
cache. Existing untracked threads identify the router's original-account policy;
missing thread identity and unreadable ledgers are explicitly distinguished.

The tooltip refreshes every thirty seconds while open. Account windows display
remaining allowance and the duration returned by the provider, with an update
age. A failed refresh identifies retained data rather than presenting it as fresh.
The request and response fields are optional: older clients retain their ordinary
provider card, and hosts without a router keep their existing single-account view.
An account's percentage is never added to another account's percentage.

Use `paseo usage --agent <full-id> --json` or the agent's `get_usage` tool for a
planning snapshot. `available` provider status is not task admission. Empty,
stale and invalid account observations remain unknown; an exhausted window
cannot be offset by another window or account. The output never pools allowance.
Configured switching mode and the worker's observed mode are separate: missing
worker observation does not prove that an old process adopted a live pause.

New agent creation records the selected provider/model and pre-inference usage
snapshot in `resource-decisions/decisions.jsonl` under the owning daemon home.
Supply `paseo.resource-reason` as an agent label to retain the reason; otherwise
it records explicit requested configuration, not an inferred optimization.
State transitions append outcomes to the same private log. Prompts, credentials,
working directories and raw errors are excluded. Failed quota observation does
not block authorized work; it is recorded as unavailable. This evidence does not
authorize another provider, paid overage or history migration.

Account admission, safe switching and custody remain owned by the router. The
usage command and tool only observe them.
