import { expect, it } from "vitest";
import { presentThread, mergeManagedLinks, type ManagedLink } from "./model";

const link: ManagedLink = {
  id: "s",
  serverId: "cloud",
  workspaceId: "w",
  agentId: "a",
  status: "active",
  nextRunAt: "2026-09-20T16:00:00Z",
  lastRunAt: null,
};
const input = {
  status: "attention",
  links: [link],
  connection: "online",
  schedulesKnown: true,
  now: Date.parse("2026-09-19T16:00:00Z"),
};
it("keeps completed checks managed and promotes actual questions", () => {
  expect(presentThread(input)).toMatchObject({ group: "managed", state: "waiting" });
  expect(presentThread({ ...input, status: "needs_input" })).toMatchObject({
    group: "needs-you",
    state: "answer",
  });
  expect(presentThread({ ...input, status: "done" })).toMatchObject({ group: "managed" });
});
it("never calls missing schedules or offline hosts healthy waiting", () => {
  expect(presentThread({ ...input, links: [], override: true })).toMatchObject({
    state: "unscheduled",
    group: "needs-you",
  });
  expect(presentThread({ ...input, connection: "disconnected" })).toMatchObject({
    state: "offline",
    group: "needs-you",
  });
  expect(presentThread({ ...input, schedulesKnown: false })).toMatchObject({ state: "unknown" });
  expect(
    presentThread({ ...input, links: [{ ...link, nextRunAt: "2026-09-18T16:00:00Z" }] }),
  ).toMatchObject({ state: "unknown", group: "needs-you" });
});
it("distinguishes a paused follow-up from an ended follow-up needing review", () => {
  expect(presentThread({ ...input, links: [{ ...link, status: "paused" }] })).toMatchObject({
    group: "managed",
    state: "paused",
  });
  expect(presentThread({ ...input, links: [{ ...link, status: "completed" }] })).toMatchObject({
    group: "needs-you",
    state: "ended",
  });
});
it("preserves ordinary conversations and explicit grouping overrides", () => {
  expect(presentThread({ ...input, status: "done", override: false })).toMatchObject({
    group: "conversations",
    managed: false,
  });
  expect(presentThread({ ...input, links: [] })).toMatchObject({
    group: "needs-you",
    state: "review",
  });
});

it("uses host-scoped identities and retains last-known links for unavailable hosts", () => {
  const schedules: Parameters<typeof mergeManagedLinks>[0]["schedules"] = [
    { ...link, serverId: "other", target: { type: "agent", agentId: "a" } },
  ];
  expect(
    mergeManagedLinks({
      previous: [link],
      schedules,
      successfulHosts: new Set(["other"]),
      agents: [{ serverId: "other", id: "a", workspaceId: "other-w" }],
    }),
  ).toEqual([link, { ...link, serverId: "other", workspaceId: "other-w" }]);
  expect(
    mergeManagedLinks({
      previous: [link],
      schedules: [],
      successfulHosts: new Set(["cloud"]),
      agents: [],
    }),
  ).toEqual([]);
});
it("does not classify new-agent schedules as persistent managed threads", () => {
  expect(
    mergeManagedLinks({
      previous: [],
      schedules: [
        { ...link, target: { type: "new-agent", config: { provider: "codex", cwd: "/tmp" } } },
      ],
      successfulHosts: new Set(["cloud"]),
      agents: [],
    }),
  ).toEqual([]);
});
