import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarWorkspaceGroup } from "@/components/sidebar/sidebar-labels";
import type { ThreadPresentation } from "./model";

export function managedWorkspaceGroups(
  rows: readonly SidebarWorkspaceEntry[],
  presentations: Readonly<Record<string, ThreadPresentation>>,
  pinnedOrder: readonly string[] = [],
): SidebarWorkspaceGroup[] {
  const needs: SidebarWorkspaceEntry[] = [],
    managed: SidebarWorkspaceEntry[] = [],
    conversations: SidebarWorkspaceEntry[] = [];
  for (const row of rows) {
    const p = presentations[row.workspaceKey];
    const group =
      p?.group ??
      (["needs_input", "failed", "attention"].includes(row.statusBucket)
        ? "needs-you"
        : "conversations");
    const destination = { "needs-you": needs, managed, conversations }[group];
    destination.push(
      p?.managed && p.state !== "ended" && row.statusBucket === "attention"
        ? { ...row, statusBucket: "done" }
        : row,
    );
  }
  const rank = (row: SidebarWorkspaceEntry) => {
    if (!row.pinnedAt) return pinnedOrder.length + 1;
    const index = pinnedOrder.indexOf(row.workspaceKey);
    return index < 0 ? pinnedOrder.length : index;
  };
  needs.sort((a, b) => rank(a) - rank(b));
  conversations.sort((a, b) => rank(a) - rank(b));
  managed.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return [
    {
      key: "responsibility-needs-you",
      label: `Needs you · ${needs.length}`,
      rows: needs,
      leading: { kind: "status", bucket: "needs_input" },
    },
    {
      key: "responsibility-managed",
      label: `Bot managed · ${managed.length}`,
      rows: managed,
      leading: { kind: "managed" },
    },
    {
      key: "responsibility-conversations",
      label: `My conversations · ${conversations.length}`,
      rows: conversations,
      leading: { kind: "conversation" },
    },
  ];
}
