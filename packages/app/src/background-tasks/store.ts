import { create } from "zustand";
import type { BackgroundTask } from "./model";
export interface HostTasks {
  tasks: BackgroundTask[];
  online: boolean;
}
export const useBackgroundTasks = create<{
  hosts: Record<string, HostTasks>;
  now: number;
  publish: (id: string, tasks: BackgroundTask[] | null, online: boolean) => void;
  tick: () => void;
}>((set) => ({
  hosts: {},
  now: Date.now() / 1000,
  publish: (id, tasks, online) =>
    set((s) => ({
      hosts: {
        ...s.hosts,
        [id]: { tasks: tasks ?? s.hosts[id]?.tasks ?? [], online },
      },
    })),
  tick: () => set({ now: Date.now() / 1000 }),
}));
