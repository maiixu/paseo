# Scheduled follow-ups and sidebar placement

Use Schedules to configure recurring work, including its target, timing and lifecycle.
Sidebar placement follows projects and explicit pins. Agent activity updates the row's
status indicator without moving it into an attention or management group.

Project is the default grouping. Status remains an explicit display preference.
Existing Responsibility preferences migrate to Project while retaining host, project
and label filters. The new storage key keeps older open clients from overwriting the
adopted preference. Current clients synchronize display preferences across tabs.

Schedules and agent lifecycle remain independent: a finished turn does not prove the
underlying task is complete, and archiving a workspace does not cancel its schedule.

End stops future runs and keeps the schedule or heartbeat and its run history.
An already admitted run may finish and save its result. Ending is idempotent and
terminal; use Pause when you intend to resume the same cadence later. The Web,
CLI and agent tools share this operation, and older hosts must be updated to use it.
