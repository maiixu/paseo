import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageSourceRegistry, type UsageSource } from "../../server/plugins/usage-sources/index.js";
import { ProviderUsageService } from "./service.js";

const logger = pino({ enabled: false });
const NOW = Date.parse("2026-11-03T00:00:00.000Z");

function source(id: string, label: string) {
  const discover = vi.fn(async () => [{ key: "default", input: { id } }]);
  const fetch = vi.fn(async () => ({
    status: "available",
    windows: [{ id: "weekly", label: "Weekly", usedPct: 10, remainingPct: 90 }],
  }));
  const usageSource: UsageSource = { id, label, discover, fetch };
  return { usageSource, discover, fetch };
}

function registry() {
  return new UsageSourceRegistry(() => NOW, 300_000, { warn: () => undefined });
}

describe("ProviderUsageService", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "provider-usage-service-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = home;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("never invokes the fetcher of a usage source the user disabled", async () => {
    const usage = registry();
    const codex = source("codex", "Codex");
    const claude = source("claude", "Claude");
    usage.register(codex.usageSource);
    usage.register(claude.usageSource);
    // Disabling a usage-source plugin unregisters its source (PluginService.removeUsageSources).
    usage.unregister("claude");
    const service = new ProviderUsageService({ logger, pluginUsage: usage, now: () => NOW });

    const result = await service.listUsage();
    await service.listUsage({ forceRefresh: true, agentId: undefined });

    expect(result.providers.map((provider) => provider.providerId)).toEqual(["codex"]);
    expect(codex.fetch).toHaveBeenCalled();
    expect(claude.discover).not.toHaveBeenCalled();
    expect(claude.fetch).not.toHaveBeenCalled();
  });

  it("reads no provider credentials of its own when no usage source is enabled", async () => {
    // Credentials the removed in-process fetchers used to read.
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "at", refreshToken: "rt" } }),
    );
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: "at" } }),
    );
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);

    const withoutPlugins = new ProviderUsageService({ logger, now: () => NOW });
    const withDisabledPlugins = new ProviderUsageService({
      logger,
      pluginUsage: registry(),
      now: () => NOW,
    });

    expect((await withoutPlugins.listUsage()).providers).toEqual([]);
    expect((await withDisabledPlugins.listUsage()).providers).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("isolates a plugin runtime failure as an empty provider list", async () => {
    const service = new ProviderUsageService({
      logger,
      now: () => NOW,
      pluginUsage: { listLegacyUsage: async () => Promise.reject(new Error("runtime down")) },
    });

    expect(await service.listUsage()).toEqual({
      fetchedAt: new Date(NOW).toISOString(),
      providers: [],
    });
  });

  describe("with the Codex account router", () => {
    async function routerCommand() {
      for (const alias of ["plus", "pro"]) {
        await mkdir(join(home, alias));
        await writeFile(
          join(home, alias, "auth.json"),
          JSON.stringify({ tokens: { access_token: alias } }),
        );
      }
      await writeFile(
        join(home, "router.json"),
        JSON.stringify({
          stateDirectory: home,
          legacyAccount: "pro",
          accounts: ["plus", "pro"].map((alias) => ({ alias, home: join(home, alias) })),
        }),
      );
      return ["python3", "/x/paseo-codex-router.py", "--router-config", join(home, "router.json")];
    }

    function routerFetch(calls: string[]): typeof fetch {
      return (async (_url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new Headers(init?.headers).get("Authorization") ?? "");
        return Response.json({
          plan_type: "plus",
          rate_limit: { primary_window: { used_percent: 25, reset_at: NOW / 1000 + 3600 } },
        });
      }) as typeof fetch;
    }

    it("attaches routed accounts to the plugin's Codex provider", async () => {
      const calls: string[] = [];
      const command = await routerCommand();
      const usage = registry();
      usage.register(source("codex", "Codex").usageSource);
      const service = new ProviderUsageService({
        logger,
        now: () => NOW,
        pluginUsage: usage,
        accountRouter: {
          logger,
          getCommand: () => command,
          getAgent: () => null,
          now: () => NOW,
          fetch: routerFetch(calls),
        },
      });

      const result = await service.listUsage();

      expect(calls.sort()).toEqual(["Bearer plus", "Bearer pro"]);
      const codex = result.providers.find((provider) => provider.providerId === "codex");
      expect(codex?.accounts?.map((account) => account.accountId)).toEqual(["plus", "pro"]);
    });

    it("reports routed accounts when the Codex usage source is disabled", async () => {
      const calls: string[] = [];
      const command = await routerCommand();
      const service = new ProviderUsageService({
        logger,
        now: () => NOW,
        pluginUsage: registry(),
        accountRouter: {
          logger,
          getCommand: () => command,
          getAgent: () => null,
          now: () => NOW,
          fetch: routerFetch(calls),
        },
      });

      const result = await service.listUsage();

      expect(result.providers).toHaveLength(1);
      expect(result.providers[0]).toMatchObject({
        providerId: "codex",
        displayName: "Codex accounts",
        status: "available",
      });
      expect(result.providers[0]?.accounts).toHaveLength(2);
    });
  });
});
