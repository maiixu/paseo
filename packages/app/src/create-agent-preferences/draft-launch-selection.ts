import { z } from "zod";
import { isWeb } from "@/constants/platform";

const selectionSchema = z.object({
  serverId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string(),
  modeId: z.string(),
  thinkingOptionId: z.string(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
});
export type DraftLaunchSelection = z.infer<typeof selectionSchema>;
export interface DraftLaunchSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Session-only form choices, separate from the defaults for the next New. */
export class DraftLaunchSelectionStore {
  constructor(private readonly storage: DraftLaunchSelectionStorage) {}

  private key(draftId: string) {
    return `paseo:draft-launch-selection:v1:${draftId}`;
  }

  read(draftId: string | undefined, serverId?: string | null): DraftLaunchSelection | null {
    if (!draftId) return null;
    try {
      const stored = this.storage.getItem(this.key(draftId));
      if (!stored) return null;
      const parsed = selectionSchema.safeParse(JSON.parse(stored));
      if (!parsed.success || (serverId && parsed.data.serverId !== serverId)) return null;
      return parsed.data;
    } catch {
      return null;
    }
  }

  write(draftId: string, selection: DraftLaunchSelection): void {
    try {
      this.storage.setItem(this.key(draftId), JSON.stringify(selection));
    } catch {
      // Optional persistence must not stop editing when browser storage is unavailable.
    }
  }

  clear(draftId: string | undefined): void {
    if (!draftId) return;
    try {
      this.storage.removeItem(this.key(draftId));
    } catch {
      // The current form remains usable without session storage.
    }
  }
}

export const draftLaunchSelections = new DraftLaunchSelectionStore({
  getItem: (key) => (isWeb ? window.sessionStorage.getItem(key) : null),
  setItem: (key, value) => {
    if (isWeb) window.sessionStorage.setItem(key, value);
  },
  removeItem: (key) => {
    if (isWeb) window.sessionStorage.removeItem(key);
  },
});
