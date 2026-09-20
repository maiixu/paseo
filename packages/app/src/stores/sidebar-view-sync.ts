import { SIDEBAR_VIEW_STORAGE_KEY } from "./sidebar-view-store";

export function subscribeSidebarViewChanges(target: EventTarget, rehydrate: () => unknown) {
  const refresh = () => {
    void rehydrate();
  };
  const storage = (event: Event) => {
    if ((event as StorageEvent).key === SIDEBAR_VIEW_STORAGE_KEY) refresh();
  };
  target.addEventListener("storage", storage);
  target.addEventListener("focus", refresh);
  return () => {
    target.removeEventListener("storage", storage);
    target.removeEventListener("focus", refresh);
  };
}
