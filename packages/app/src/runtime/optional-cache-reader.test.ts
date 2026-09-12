import { describe, expect, it } from "vitest";
import { OptionalCacheReader } from "./optional-cache-reader";

describe("optional cache reads", () => {
  it("releases reads started offline once the host becomes online", async () => {
    const cache = new OptionalCacheReader();
    let release!: (value: string) => void;
    const stored = new Promise<string>((resolve) => {
      release = resolve;
    });
    let completed = false;
    const read = cache
      .read(() => stored)
      .then((value) => {
        completed = true;
        return value;
      });
    expect(completed).toBe(false);
    cache.setOnline(true);
    await expect.poll(() => completed, { timeout: 2000 }).toBe(true);
    expect(await read).toBeUndefined();

    release("late cached value");
    await stored;
    expect(await cache.read(async () => "another cached value")).toBeUndefined();
  });

  it("keeps offline reads available beyond the online deadline", async () => {
    const cache = new OptionalCacheReader();
    let release!: (value: string) => void;
    const stored = new Promise<string>((resolve) => {
      release = resolve;
    });
    const read = cache.read(() => stored);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    release("offline cached value");
    expect(await read).toBe("offline cached value");
  });

  it("accepts quick online reads without abandoning subsequent reads", async () => {
    const cache = new OptionalCacheReader();
    cache.setOnline(true);
    expect(await cache.read(async () => "first")).toBe("first");
    expect(await cache.read(async () => "second")).toBe("second");
    cache.setOnline(false);
  });

  it("releases every pending read when storage rejects", async () => {
    const cache = new OptionalCacheReader();
    cache.setOnline(true);
    const pending = cache.read(() => new Promise<string>(() => undefined));
    const rejected = cache.read(async () => {
      throw new Error("Storage failed");
    });
    expect(await Promise.all([pending, rejected])).toEqual([undefined, undefined]);
  });
});
