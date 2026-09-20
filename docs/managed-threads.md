# Managed threads in the sidebar

Responsibility view has four peer collapsible groups: Needs you, Pinned, Bot managed,
and Conversations. Empty groups are hidden. Every workspace appears exactly once:
attention takes priority, then pinning, then management, then ordinary conversation.
A pinned question keeps a pin glyph in Needs you and returns to Pinned when resolved.
Pinned managed threads retain their next-check metadata. Every group supports drag
reordering within the group. Local order persists across refresh and filtering;
state transitions still determine group membership, so dragging cannot hide a question. The static Workspaces title
is omitted; the display-preferences control remains available. All four headings use
the same persistent collapse control and always-visible chevron.

Sidebar provider metadata comes from the latest root agent activity, never from tags.
The historical exact labels review/codex/claude/bedrock are omitted from row chips;
they remain stored and editable in Labels. Other topic labels are unchanged. Live
attention indicators and responsibility groups own status. Missing agent data leaves
provider metadata absent instead of guessing it from an old label.

Same-agent schedules identify managed work automatically. New-agent schedules do
not: a periodic report can create ordinary conversations without making each a
persistent responsibility. Resolve targets by host and agent ID; a visible
workspace does not guarantee its agent detail has been opened.

The workspace menu's Move actions are Hub presentation preferences, stored per
browser origin and keyed by host/workspace identity. They do not create, pause or
cancel schedules. A manually managed workspace without a schedule explicitly asks
for setup. Schedules remains the owner of execution configuration and authorization.

Needs-input and failure states require attention. A normal finished check remains
under Bot managed with its next check time; an ended follow-up with unread results
asks for outcome review. Ending a schedule is not proof that the underlying goal
was achieved. Offline or unverified status must not be presented as healthy waiting;
cached links retain identity and the UI identifies cached next-check information.

The Web reads schedule metadata periodically and preserves failed/offline hosts'
last-known links until an authoritative response arrives. It fetches only missing
scheduled-agent mappings, without fetching their transcripts or sending prompts.
The header and sidebar share the same presentation state. Native daemon attention,
question resolution and OS notification policy remain unchanged by grouping.

Use the existing route helper to open the original workspace. Clicking, grouping
or opening it never approves an external action. Do not infer authorization,
no-change outcomes or overall task completion from assistant prose. Explicit
workflow outcomes would be a separate protocol feature.

Validate cold-load associations, same-ID agents on different hosts, answering and
returning to Managed, local override persistence, pins/filters/shortcuts, and
host loss. Exercise those transitions against an isolated daemon before publishing
Web assets. Keep production schedules, agents and daemon processes untouched.
