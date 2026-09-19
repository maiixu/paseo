import { expect, it, vi } from "vitest";
import { resolveScheduleTargets } from "./resolve-targets";
it("resolves cold scheduled agents without depending on open conversation tabs", async () => {
  const readWorkspace = vi.fn(async (host: string, id: string) => `${host}-${id}`);
  const result = await resolveScheduleTargets({
    schedules: [
      { serverId: "a", target: { type: "agent", agentId: "same" } },
      { serverId: "b", target: { type: "agent", agentId: "same" } },
      { serverId: "a", target: { type: "agent", agentId: "same" } },
    ],
    agents: [],
    previous: [],
    readWorkspace,
  });
  expect(readWorkspace).toHaveBeenCalledTimes(2);
  expect(result).toContainEqual({ serverId: "a", id: "same", workspaceId: "a-same" });
  expect(result).toContainEqual({ serverId: "b", id: "same", workspaceId: "b-same" });
});
it("does not repeatedly fetch known targets or fetch ordinary new-agent schedules", async () => {
  const readWorkspace = vi.fn(async () => null);
  await resolveScheduleTargets({
    schedules: [
      { serverId: "a", target: { type: "agent", agentId: "one" } },
      { serverId: "b", target: { type: "new-agent", config: { provider: "codex", cwd: "/tmp" } } },
    ],
    agents: [{ serverId: "a", id: "one", workspaceId: "w" }],
    previous: [],
    readWorkspace,
  });
  expect(readWorkspace).not.toHaveBeenCalled();
});
