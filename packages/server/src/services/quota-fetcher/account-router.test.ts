import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountRouterUsage } from "./account-router.js";

let root: string;
let now: number;
let command: unknown;
let calls: string[];
let agent: { provider: string; persistence: { sessionId: string } | null } | null;
let usage: AccountRouterUsage;
const thread = "11111111-2222-3333-4444-555555555555";
async function ledger(owner: string, phase = "idle") {
  await writeFile(join(root, "threads", `${thread}.json`), JSON.stringify({ owner, phase }));
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paseo-account-usage-"));
  now = 1_800_000_000_000;
  calls = [];
  for (const alias of ["plus", "pro"]) {
    await mkdir(join(root, alias));
    await writeFile(
      join(root, alias, "auth.json"),
      JSON.stringify({ tokens: { access_token: alias } }),
    );
  }
  await mkdir(join(root, "threads"));
  await writeFile(
    join(root, "router.json"),
    JSON.stringify({
      stateDirectory: root,
      legacyAccount: "pro",
      accounts: ["plus", "pro"].map((alias) => ({ alias, home: join(root, alias) })),
    }),
  );
  command = [
    "python3",
    "/release/paseo-codex-router.py",
    "--router-config",
    join(root, "router.json"),
  ];
  agent = { provider: "codex", persistence: { sessionId: thread } };
  usage = new AccountRouterUsage({
    logger: pino({ enabled: false }),
    getCommand: () => command,
    getAgent: () => agent,
    now: () => now,
    fetch: async (_url, options) => {
      const token = new Headers(options?.headers).get("Authorization")!;
      calls.push(token);
      if (token === "Bearer invalid") return new Response("{}", { status: 401 });
      const plus = token === "Bearer plus";
      return Response.json({
        plan_type: plus ? "plus" : "pro",
        rate_limit: {
          primary_window: {
            used_percent: plus ? 20 : 50,
            limit_window_seconds: plus ? 18000 : 604800,
            reset_at: 1_800_000_060,
          },
        },
      });
    },
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("reads each account only from its explicit home and labels actual quota windows", async () => {
  vi.stubEnv("CODEX_HOME", join(root, "pro"));
  await ledger("plus");
  const result = await usage.read("agent");
  expect(calls).toEqual(["Bearer plus", "Bearer pro"]);
  expect(
    result?.accounts.map((a) => [a.accountId, a.windows[0].label, a.windows[0].remainingPct]),
  ).toEqual([
    ["plus", "5-hour", 80],
    ["pro", "Weekly", 50],
  ]);
  expect(result?.routing).toEqual({
    providerId: "codex",
    accountId: "plus",
    status: "active",
    phase: "idle",
    checkedAt: new Date(now).toISOString(),
  });
  expect(JSON.stringify(result)).not.toContain("Bearer");
  expect(JSON.stringify(result)).not.toContain(root);
});
it("refreshes routing independently of cached quotas and refreshes quota after one minute", async () => {
  await ledger("plus");
  const first = await usage.read("agent");
  await ledger("pro", "quota_wait");
  now += 10_000;
  const next = await usage.read("agent");
  expect(next?.routing?.accountId).toBe("pro");
  expect(next?.routing?.phase).toBe("quota_wait");
  expect(next?.accounts[0].fetchedAt).toBe(first?.accounts[0].fetchedAt);
  expect(calls).toHaveLength(2);
  now += 60_000;
  expect((await usage.read("agent"))?.accounts[0].fetchedAt).toBe(new Date(now).toISOString());
  expect(calls).toHaveLength(4);
});
it("does not enable account reads merely because a config file exists", async () => {
  command = ["codex"];
  expect(await usage.read("agent")).toBeNull();
  expect(calls).toEqual([]);
});
it("keeps one failed account separate from the other account", async () => {
  await writeFile(
    join(root, "plus", "auth.json"),
    JSON.stringify({ tokens: { access_token: "invalid" } }),
  );
  expect((await usage.read())?.accounts.map((a) => a.status)).toEqual(["unavailable", "available"]);
});
it("does not borrow the other account when an explicit home lacks credentials", async () => {
  vi.stubEnv("CODEX_HOME", join(root, "pro"));
  await rm(join(root, "plus", "auth.json"));
  expect((await usage.read())?.accounts[0].status).toBe("unavailable");
  expect(calls).toEqual(["Bearer pro"]);
});
it("distinguishes an unselected thread, an original-account thread, and unreadable routing", async () => {
  expect((await usage.read("agent"))?.routing?.status).toBe("legacy");
  agent = { provider: "codex", persistence: null };
  expect((await usage.read("agent"))?.routing?.status).toBe("pending");
  agent = { provider: "codex", persistence: { sessionId: thread } };
  await writeFile(join(root, "threads", `${thread}.json`), "not json");
  expect((await usage.read("agent"))?.routing?.accountId).toBeNull();
  expect((await usage.read("agent"))?.routing?.status).toBe("unknown");
});
it("rejects invalid thread paths and never reports an unknown ledger account", async () => {
  agent = { provider: "codex", persistence: { sessionId: "../../router" } };
  expect((await usage.read("agent"))?.routing?.status).toBe("unknown");
  agent = { provider: "codex", persistence: { sessionId: thread } };
  await ledger("other");
  expect((await usage.read("agent"))?.routing?.status).toBe("unknown");
});
