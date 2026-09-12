import { describe, expect, it } from "vitest";
import {
  DraftLaunchSelectionStore,
  type DraftLaunchSelectionStorage,
} from "./draft-launch-selection";
import { resolvePinnedLaunchProfile } from "./launch-defaults";

function storage(): DraftLaunchSelectionStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}
const opus = {
  serverId: "mac",
  provider: "claude",
  model: "opus",
  modeId: "bypass",
  thinkingOptionId: "high",
  featureValues: { fast: true },
};

describe("draft launch selection", () => {
  it("restores one draft's host and choices without making them another draft's defaults", () => {
    const adapter = storage();
    new DraftLaunchSelectionStore(adapter).write("draft-1", opus);
    const restored = new DraftLaunchSelectionStore(adapter);
    expect(restored.read("draft-1")).toEqual(opus);
    expect(restored.read("draft-2")).toBeNull();
    expect(
      resolvePinnedLaunchProfile({
        profileId: "astra-medium",
        initialValues: restored.read("draft-1") ?? undefined,
        hasUserSelection: false,
        profiles: null,
        entries: undefined,
      }),
    ).toEqual({ status: "disabled" });
  });

  it("does not apply a draft selection to a different explicit host", () => {
    const store = new DraftLaunchSelectionStore(storage());
    store.write("draft-1", opus);
    expect(store.read("draft-1", "cloud")).toBeNull();
    expect(store.read("draft-1", "mac")).toEqual(opus);
  });

  it("removes finalized draft selections", () => {
    const store = new DraftLaunchSelectionStore(storage());
    store.write("draft-1", opus);
    store.clear("draft-1");
    expect(store.read("draft-1")).toBeNull();
  });

  it("ignores malformed browser data", () => {
    const store = new DraftLaunchSelectionStore({ ...storage(), getItem: () => "not json" });
    expect(store.read("draft-1")).toBeNull();
  });

  it("keeps the composer usable when browser storage is unavailable", () => {
    const fail = () => {
      throw new Error("Storage denied");
    };
    const store = new DraftLaunchSelectionStore({ getItem: fail, setItem: fail, removeItem: fail });
    expect(store.read("draft-1")).toBeNull();
    expect(() => store.write("draft-1", opus)).not.toThrow();
    expect(() => store.clear("draft-1")).not.toThrow();
  });
});
