import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientIdResolver, type ClientIdStorage } from "./client-id";

interface InMemoryStorage extends ClientIdStorage {
  items: Map<string, string>;
  setCallCount: number;
  getCallCount: number;
}

function inMemoryStorage(initial: Record<string, string> = {}): InMemoryStorage {
  const items = new Map<string, string>(Object.entries(initial));
  const storage: InMemoryStorage = {
    items,
    setCallCount: 0,
    getCallCount: 0,
    async getItem(key) {
      storage.getCallCount += 1;
      return items.get(key) ?? null;
    },
    async setItem(key, value) {
      storage.setCallCount += 1;
      items.set(key, value);
    },
    async removeItem(key) {
      items.delete(key);
    },
  };
  return storage;
}

describe("clientIdResolver", () => {
  it("returns the stored client id when present and does not regenerate", async () => {
    const storage = inMemoryStorage({ "@paseo:client-id-v1": "cid_existing" });
    const resolver = createClientIdResolver({
      storage,
      generateUuid: () => {
        throw new Error("generateUuid should not run when an id is stored");
      },
    });

    expect(await resolver.getOrCreate()).toBe("cid_existing");
    expect(storage.setCallCount).toBe(0);
  });

  it("creates and persists a new client id when storage is empty", async () => {
    const storage = inMemoryStorage();
    const resolver = createClientIdResolver({
      storage,
      generateUuid: () => "123456781234123412341234567890ab",
    });

    expect(await resolver.getOrCreate()).toBe("cid_123456781234123412341234567890ab");
    expect(storage.items.get("@paseo:client-id-v1")).toBe("cid_123456781234123412341234567890ab");
  });

  it("dedupes concurrent callers behind a single storage write", async () => {
    const storage = inMemoryStorage();
    let uuidCalls = 0;
    const resolver = createClientIdResolver({
      storage,
      generateUuid: () => {
        uuidCalls += 1;
        return "abcdef0123456789abcdef0123456789";
      },
    });

    const [first, second] = await Promise.all([resolver.getOrCreate(), resolver.getOrCreate()]);

    expect(first).toBe("cid_abcdef0123456789abcdef0123456789");
    expect(second).toBe(first);
    expect(uuidCalls).toBe(1);
    expect(storage.setCallCount).toBe(1);
  });

  it("ignores stored blank strings and treats them as missing", async () => {
    const storage = inMemoryStorage({ "@paseo:client-id-v1": "   " });
    const resolver = createClientIdResolver({
      storage,
      generateUuid: () => "newuuid",
    });

    expect(await resolver.getOrCreate()).toBe("cid_newuuid");
    expect(storage.items.get("@paseo:client-id-v1")).toBe("cid_newuuid");
  });
});

async function loadClientIdentityRealm(
  storage: InMemoryStorage,
  options: { isWeb: boolean; electron: boolean; uuid: string },
) {
  vi.resetModules();
  vi.doMock("@react-native-async-storage/async-storage", () => ({ default: storage }));
  vi.doMock("@/constants/platform", () => ({
    isWeb: options.isWeb,
    getIsElectron: () => options.electron,
  }));
  vi.stubGlobal("crypto", { randomUUID: () => options.uuid });
  return import("./client-id");
}

describe("connection client identity", () => {
  afterEach(() => {
    vi.doUnmock("@react-native-async-storage/async-storage");
    vi.doUnmock("@/constants/platform");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("isolates browser document realms sharing storage while preserving persistent marker identity", async () => {
    const storage = inMemoryStorage({ "@paseo:client-id-v1": "cid_existing" });
    const first = await loadClientIdentityRealm(storage, {
      isWeb: true,
      electron: false,
      uuid: "11111111-1111-4111-8111-111111111111",
    });
    const firstIds = await Promise.all([
      first.getOrCreateConnectionClientId(),
      first.getOrCreateConnectionClientId(),
    ]);
    const second = await loadClientIdentityRealm(storage, {
      isWeb: true,
      electron: false,
      uuid: "22222222-2222-4222-8222-222222222222",
    });

    expect(firstIds).toEqual([
      "cid_11111111111141118111111111111111",
      "cid_11111111111141118111111111111111",
    ]);
    expect(await second.getOrCreateConnectionClientId()).toBe(
      "cid_22222222222242228222222222222222",
    );
    expect(await first.getOrCreateConnectionClientId()).toBe(firstIds[0]);
    expect(storage.getCallCount).toBe(0);
    expect(storage.setCallCount).toBe(0);
    expect(await first.getOrCreateClientId()).toBe("cid_existing");
    expect(await second.getOrCreateClientId()).toBe("cid_existing");
    expect(storage.items.get("@paseo:client-id-v1")).toBe("cid_existing");
  });

  it.each([
    { name: "native", isWeb: false, electron: false },
    { name: "Electron", isWeb: true, electron: true },
  ])("keeps persistent connection identity in $name", async ({ isWeb, electron }) => {
    const storage = inMemoryStorage({ "@paseo:client-id-v1": "cid_existing" });
    const first = await loadClientIdentityRealm(storage, { isWeb, electron, uuid: "unused-one" });
    expect(await first.getOrCreateConnectionClientId()).toBe("cid_existing");
    const second = await loadClientIdentityRealm(storage, { isWeb, electron, uuid: "unused-two" });
    expect(await second.getOrCreateConnectionClientId()).toBe("cid_existing");
    expect(storage.setCallCount).toBe(0);
  });
});
