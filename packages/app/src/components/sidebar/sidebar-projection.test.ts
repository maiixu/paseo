import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection } from "./sidebar-projection";

function makeWorkspace(
  id: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"] = "done",
  labels: string[] = [],
  projectViewKey = "project",
) {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
    workspaceId: id,
    projectViewKey,
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
  };
  const entry: SidebarWorkspaceEntry = {
    ...placement,
    workspaceDirectory: "",
    workspaceDirectoryLabel: "",
    title: null,
    currentBranch: null,
    statusBucket,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    labels,
  };
  return { placement, entry };
}

function makeProject(
  workspaces: SidebarWorkspacePlacement[],
  viewKey = "project",
): SidebarProjectEntry {
  return {
    viewKey,
    projectName: "Project",
    projectKind: "git",
    iconWorkingDir: `/repo/${viewKey}`,
    hosts: [
      {
        serverId: "srv",
        projectId: viewKey,
        iconWorkingDir: `/repo/${viewKey}`,
        worktreeSupport: "supported" as const,
      },
    ],
    workspaces,
  };
}

function projectionInput(options?: {
  groupMode?: "project" | "status";
  pinnedCollapsed?: boolean;
}) {
  const pinned = makeWorkspace("pinned", "running");
  const unpinned = makeWorkspace("unpinned", "needs_input");
  return {
    projects: [makeProject([pinned.placement, unpinned.placement])],
    pinnedKeys: {
      pinnedWorkspaceKeys: [pinned.placement.workspaceKey],
      pinnedAtByKey: { [pinned.placement.workspaceKey]: "2026-07-12T12:00:00.000Z" },
    },
    pinnedWorkspaceOrder: [],
    workspaceEntriesByKey: new Map([
      [pinned.entry.workspaceKey, pinned.entry],
      [unpinned.entry.workspaceKey, unpinned.entry],
    ]),
    projectNamesByViewKey: new Map([["project", "Project"]]),
    groupMode: options?.groupMode ?? ("project" as const),
    pinnedCollapsed: options?.pinnedCollapsed ?? false,
    collapsedProjectKeys: new Set<string>(),
    collapsedWorkspaceGroupKeys: new Set<string>(),
  };
}

/**
 * Two projects, one workspace each, both labelled — so every grouping mode puts rows from more
 * than one project on screen, and a mode that asked for fewer icons than it renders would show it.
 */
function twoProjectInput(groupMode: "project" | "status") {
  const first = makeWorkspace("first", "running", ["Urgent"], "project");
  const second = makeWorkspace("second", "needs_input", ["Backend"], "other-project");
  return {
    ...projectionInput({ groupMode }),
    projects: [makeProject([first.placement]), makeProject([second.placement], "other-project")],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map([
      [first.entry.workspaceKey, first.entry],
      [second.entry.workspaceKey, second.entry],
    ]),
    projectNamesByViewKey: new Map([
      ["project", "Project"],
      ["other-project", "Other project"],
    ]),
  };
}

describe("buildSidebarProjection", () => {
  // The rule that outlived the bug it was written for: a project icon is fetched per project, so
  // whatever a mode groups by, the rows it produces can only reference projects already covered.
  for (const groupMode of ["project", "status"] as const) {
    it(`covers every row ${groupMode} grouping renders with a project icon target`, () => {
      const projection = buildSidebarProjection(twoProjectInput(groupMode));
      const covered = new Set(projection.projectIconTargets.map((target) => target.projectViewKey));

      // Every leading visual the sidebar can paint from this projection: pinned rows, grouped
      // rows, project headers and the rows under them.
      const renderedProjectViewKeys = new Set<string>();
      for (const entry of projection.pinnedGroups.pinnedChats) {
        renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const group of projection.workspaceGroups) {
        for (const entry of group.rows) renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const project of projection.pinnedGroups.unpinnedProjects) {
        renderedProjectViewKeys.add(project.viewKey);
        for (const entry of project.workspaces) renderedProjectViewKeys.add(entry.projectViewKey);
      }

      expect([...renderedProjectViewKeys].sort()).toEqual(["other-project", "project"]);
      expect([...renderedProjectViewKeys].filter((viewKey) => !covered.has(viewKey))).toEqual([]);
    });
  }

  it("uses one pin-aware projection for project rows and shortcut order", () => {
    const projection = buildSidebarProjection(projectionInput());

    expect(projection.pinnedGroups.pinnedChats.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
    ]);
    const remainingProject = projection.pinnedGroups.unpinnedProjects[0];
    expect(remainingProject?.workspaces.map((entry) => entry.workspaceId)).toEqual(["unpinned"]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("keeps pinned chats above status groups and removes them from those groups", () => {
    const projection = buildSidebarProjection(projectionInput({ groupMode: "status" }));

    expect(projection.workspaceGroups.map((group) => group.key)).toEqual(["needs_input"]);
    expect(projection.workspaceGroups[0]?.rows.map((entry) => entry.workspaceId)).toEqual([
      "unpinned",
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("does not number pinned chats while the pinned section is collapsed", () => {
    const projection = buildSidebarProjection(
      projectionInput({ groupMode: "status", pinnedCollapsed: true }),
    );

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });
});

const presentation = (group: "needs-you" | "managed" | "conversations") => ({
  managed: group !== "conversations",
  group,
  state: group === "needs-you" ? ("answer" as const) : ("waiting" as const),
  nextRunAt: null,
  lastRunAt: null,
  schedules: 1,
});
const rowsOf = (result: ReturnType<typeof buildSidebarProjection>, key: string) =>
  result.workspaceGroups.find((g) => g.key === `responsibility-${key}`)?.rows ?? [];

it("assigns every workspace once with attention before pins before management", () => {
  const base = projectionInput();
  const build = (group: "needs-you" | "managed") =>
    buildSidebarProjection({
      ...base,
      groupMode: "responsibility",
      managedPresentations: {
        "srv:pinned": presentation(group),
        "srv:unpinned": presentation("needs-you"),
      },
    });
  const waiting = build("managed");
  expect(waiting.pinnedGroups.pinnedChats).toEqual([]);
  expect(waiting.workspaceGroups.map((g) => g.key)).toEqual([
    "responsibility-needs-you",
    "responsibility-pinned",
  ]);
  expect(rowsOf(waiting, "pinned").map((r) => r.workspaceId)).toEqual(["pinned"]);
  const asking = build("needs-you");
  expect(rowsOf(asking, "pinned")).toEqual([]);
  expect(
    rowsOf(asking, "needs-you").find((r) => r.workspaceId === "pinned")?.pinnedAt,
  ).toBeTruthy();
  expect(asking.workspaceGroups.flatMap((g) => g.rows)).toHaveLength(2);
  expect(rowsOf(build("managed"), "pinned")).toHaveLength(1);
  expect(waiting.shortcutModel.shortcutTargets.map((r) => r.workspaceId)).toEqual([
    "unpinned",
    "pinned",
  ]);
});

it("collapses each responsibility group without suppressing other groups or shortcuts", () => {
  const base = projectionInput();
  const result = buildSidebarProjection({
    ...base,
    groupMode: "responsibility",
    collapsedWorkspaceGroupKeys: new Set(["responsibility-pinned"]),
  });
  expect(rowsOf(result, "pinned")).toHaveLength(1);
  expect(result.shortcutModel.shortcutTargets.map((r) => r.workspaceId)).toEqual(["unpinned"]);
});

it("keeps routine finished managed rows out of Needs you and preserves source state", () => {
  const row = makeWorkspace("bot", "attention");
  const result = buildSidebarProjection({
    ...projectionInput(),
    groupMode: "responsibility",
    workspaceEntriesByKey: new Map([[row.entry.workspaceKey, row.entry]]),
    managedPresentations: { [row.entry.workspaceKey]: presentation("managed") },
  });
  expect(result.workspaceGroups.map((g) => g.key)).toEqual(["responsibility-managed"]);
  expect(rowsOf(result, "managed")[0]?.statusBucket).toBe("done");
  expect(row.entry.statusBucket).toBe("attention");
});

it("retains stored pin order and separates unpinned conversations", () => {
  const a = makeWorkspace("A"),
    b = makeWorkspace("B"),
    c = makeWorkspace("C");
  a.entry.pinnedAt = b.entry.pinnedAt = "2026-09-20T00:00:00Z";
  const result = buildSidebarProjection({
    ...projectionInput(),
    groupMode: "responsibility",
    workspaceEntriesByKey: new Map([a, b, c].map((x) => [x.entry.workspaceKey, x.entry])),
    pinnedWorkspaceOrder: [b.entry.workspaceKey, a.entry.workspaceKey],
  });
  expect(rowsOf(result, "pinned").map((r) => r.name)).toEqual(["B", "A"]);
  expect(rowsOf(result, "conversations").map((r) => r.name)).toEqual(["C"]);
  expect(result.workspaceGroups.map((g) => g.label)).toEqual(["Pinned · 2", "Conversations · 1"]);
});

it("applies local group order without moving conversations across responsibility boundaries", () => {
  const a = makeWorkspace("A"),
    b = makeWorkspace("B"),
    c = makeWorkspace("C", "needs_input");
  const base = {
    ...projectionInput(),
    groupMode: "responsibility" as const,
    workspaceEntriesByKey: new Map([a, b, c].map((x) => [x.entry.workspaceKey, x.entry])),
    responsibilityOrder: {
      "responsibility-conversations": [
        c.entry.workspaceKey,
        b.entry.workspaceKey,
        a.entry.workspaceKey,
      ],
    },
  };
  const result = buildSidebarProjection(base);
  expect(rowsOf(result, "conversations").map((r) => r.name)).toEqual(["B", "A"]);
  expect(rowsOf(result, "needs-you").map((r) => r.name)).toEqual(["C"]);
  expect(result.shortcutModel.shortcutTargets.map((r) => r.workspaceId)).toEqual(["C", "B", "A"]);
  const filtered = buildSidebarProjection({
    ...base,
    workspaceEntriesByKey: new Map([[a.entry.workspaceKey, a.entry]]),
  });
  expect(rowsOf(filtered, "conversations").map((r) => r.name)).toEqual(["A"]);
  expect(rowsOf(buildSidebarProjection(base), "conversations").map((r) => r.name)).toEqual([
    "B",
    "A",
  ]);
});
