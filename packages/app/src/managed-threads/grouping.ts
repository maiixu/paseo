import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarWorkspaceGroup } from "@/components/sidebar/sidebar-labels";
import type { ThreadPresentation } from "./model";

export function managedWorkspaceGroups(
  rows: readonly SidebarWorkspaceEntry[],
  presentations: Readonly<Record<string, ThreadPresentation>>,
  pinnedOrder: readonly string[] = [],
  orders: Readonly<Record<string, readonly string[]>> = {},
): SidebarWorkspaceGroup[] {
  const needs: SidebarWorkspaceEntry[] = [],
    pinned: SidebarWorkspaceEntry[] = [],
    managed: SidebarWorkspaceEntry[] = [],
    conversations: SidebarWorkspaceEntry[] = [];
  for (const row of rows) {
    const p = presentations[row.workspaceKey];
    const group =
      p?.group ??
      (["needs_input", "failed", "attention"].includes(row.statusBucket)
        ? "needs-you"
        : "conversations");
    let destination = conversations;
    if (group === "needs-you") destination = needs;
    else if (row.pinnedAt) destination = pinned;
    else if (group === "managed") destination = managed;
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
  pinned.sort((a, b) => rank(a) - rank(b));
  conversations.sort((a, b) => rank(a) - rank(b));
  managed.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const groups: SidebarWorkspaceGroup[] = [
    {
      key: "responsibility-needs-you",
      label: `Needs you · ${needs.length}`,
      rows: needs,
      leading: { kind: "status", bucket: "needs_input" },
    },
    {
      key: "responsibility-pinned",
      label: `Pinned · ${pinned.length}`,
      rows: pinned,
      leading: { kind: "pinned" },
    },
    {
      key: "responsibility-managed",
      label: `Bot managed · ${managed.length}`,
      rows: managed,
      leading: { kind: "managed" },
    },
    {
      key: "responsibility-conversations",
      label: `Conversations · ${conversations.length}`,
      rows: conversations,
      leading: { kind: "conversation" },
    },
  ];
  for (const group of groups) {
    const order = orders[group.key];
    if (!order || group.leading.kind === "pinned") continue;
    // Newly visible conversations lead the saved order; existing rows keep their drag positions.
    const groupRank = new Map(order.map((key, index) => [key, index]));
    group.rows.sort(
      (a, b) => (groupRank.get(a.workspaceKey) ?? -1) - (groupRank.get(b.workspaceKey) ?? -1),
    );
  }
  return groups.filter((group) => group.rows.length > 0);
}
