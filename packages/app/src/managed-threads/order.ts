import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { mergeWithRemainder } from "@/utils/sidebar-reorder";

interface GroupOrderState {
  orders: Record<string, string[]>;
  reorder: (group: string, keys: string[]) => void;
}

export const useResponsibilityOrderStore = create<GroupOrderState>()(
  persist(
    (set) => ({
      orders: {},
      reorder: (group, keys) =>
        set((state) => ({
          orders: {
            ...state.orders,
            [group]: mergeWithRemainder({
              currentOrder: state.orders[group] ?? [],
              reorderedVisibleKeys: [...new Set(keys)],
            }),
          },
        })),
    }),
    {
      name: "sidebar-responsibility-order",
      storage: createValidatedPersistStorage(
        AsyncStorage,
        z.object({ orders: z.record(z.string(), z.array(z.string())) }),
      ),
      partialize: (state) => ({ orders: state.orders }),
    },
  ),
);
