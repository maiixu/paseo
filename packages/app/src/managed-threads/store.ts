import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { ManagedLink, ThreadPresentation } from "./model";

const persistedSchema = z.object({
  overrides: z.record(z.string(), z.boolean()),
  links: z.array(
    z.object({
      id: z.string(),
      serverId: z.string(),
      workspaceId: z.string(),
      agentId: z.string(),
      status: z.enum(["active", "paused", "completed"]),
      nextRunAt: z.string().nullable(),
      lastRunAt: z.string().nullable(),
    }),
  ),
});
interface State {
  overrides: Record<string, boolean>;
  links: ManagedLink[];
  presentations: Record<string, ThreadPresentation>;
  setOverride: (key: string, managed: boolean) => void;
  setLinks: (links: ManagedLink[]) => void;
  publish: (presentations: Record<string, ThreadPresentation>) => void;
}
// Presentation preferences belong to this Hub installation, not to the daemon's execution policy.
export const useManagedThreadsStore = create<State>()(
  persist(
    (set, get) => ({
      overrides: {},
      links: [],
      presentations: {},
      setOverride: (key, managed) => set({ overrides: { ...get().overrides, [key]: managed } }),
      setLinks: (links) => {
        if (JSON.stringify(links) !== JSON.stringify(get().links)) set({ links });
      },
      publish: (presentations) => {
        if (JSON.stringify(presentations) !== JSON.stringify(get().presentations))
          set({ presentations });
      },
    }),
    {
      name: "managed-thread-view",
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, persistedSchema),
      partialize: ({ overrides, links }) => ({ overrides, links }),
    },
  ),
);
