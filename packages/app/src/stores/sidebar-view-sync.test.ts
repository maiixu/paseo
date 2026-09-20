import { expect, it, vi } from "vitest";
import { subscribeSidebarViewChanges } from "./sidebar-view-sync";
import { SIDEBAR_VIEW_STORAGE_KEY } from "./sidebar-view-store";
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn().mockResolvedValue(null), setItem: vi.fn(), removeItem: vi.fn() },
}));
it("syncs current tabs without reacting to stale clients and detaches cleanly", () => {
  const target = new EventTarget(),
    refresh = vi.fn();
  const cleanup = subscribeSidebarViewChanges(target, refresh);
  target.dispatchEvent(Object.assign(new Event("storage"), { key: "sidebar-view" }));
  expect(refresh).not.toHaveBeenCalled();
  target.dispatchEvent(Object.assign(new Event("storage"), { key: SIDEBAR_VIEW_STORAGE_KEY }));
  target.dispatchEvent(new Event("focus"));
  expect(refresh).toHaveBeenCalledTimes(2);
  cleanup();
  target.dispatchEvent(new Event("focus"));
  expect(refresh).toHaveBeenCalledTimes(2);
});
