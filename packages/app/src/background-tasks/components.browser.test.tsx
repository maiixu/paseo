import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackgroundTaskPanel, BackgroundTaskMeta } from "./components";
import { useBackgroundTasks } from "./store";
import type { BackgroundTask } from "./model";
let root: Root, container: HTMLDivElement;
const task: BackgroundTask = {
  runId: "test1",
  agentId: "agent1",
  workspaceId: "wks1",
  label: "Restore verification",
  host: "cloudtop",
  phase: "verifying",
  progress: 100,
  observedAt: 1000,
  staleAfterSeconds: 120,
  continuation: "sent",
};
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.style.width = "400px";
  document.body.appendChild(container);
  root = createRoot(container);
  useBackgroundTasks.setState({ hosts: {}, now: 1001 });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function render(agentId = "agent1") {
  act(() =>
    root.render(
      <>
        <BackgroundTaskPanel serverId="srv1" workspaceId="wks1" agentId={agentId} />
        <BackgroundTaskMeta workspaceKey="srv1:wks1" />
      </>,
    ),
  );
}
it("shows verification with honest 100 percent and matching identity only", () => {
  act(() => useBackgroundTasks.getState().publish("srv1", [task], true));
  render();
  expect(container.textContent).toContain("Verifying · 100% · Continuation sent");
  expect(container.textContent).toContain("Background: 1 · Work pending");
  expect(container.textContent).not.toContain("Complete");
  render("another");
  expect(container.querySelector('[data-testid="background-task-panel"]')).toBeNull();
});
it("retains last observation while offline and repairs it after reconnect", () => {
  act(() => useBackgroundTasks.getState().publish("srv1", [task], true));
  render();
  act(() => useBackgroundTasks.getState().publish("srv1", null, false));
  expect(container.textContent).toContain("Unavailable · Last known: Verifying");
  act(() => useBackgroundTasks.getState().publish("srv1", [{ ...task, phase: "complete" }], true));
  expect(container.textContent).toContain("Complete · 100%");
  expect(container.querySelector('[data-testid="background-task-meta"]')).toBeNull();
});
it("expires observation and ignores same agent on another host", () => {
  act(() => useBackgroundTasks.getState().publish("srv2", [task], true));
  render();
  expect(container.textContent).toBe("");
  act(() => {
    useBackgroundTasks.getState().publish("srv1", [task], true);
    useBackgroundTasks.setState({ now: 1201 });
  });
  expect(container.textContent).toContain("Stale observation");
});
