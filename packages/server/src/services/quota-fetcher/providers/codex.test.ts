import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexQuotaProvider } from "./codex.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const logger = pino({ enabled: false });

function codexResponse(overrides: object = {}) {
  return {
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 42, reset_at: 1_748_812_800 },
      secondary_window: { used_percent: 8, reset_at: 1_749_072_000 },
    },
    ...overrides,
  };
}

function respondWith(response: () => Response): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => {
    if (url.toString() !== USAGE_URL) throw new Error(`Unmocked fetch: ${url.toString()}`);
    return response();
  }) as unknown as typeof fetch;
}

// The Codex fetcher is used only by the account router, once per configured account home.
describe("CodexQuotaProvider", () => {
  let codexHome: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "codex-quota-"));
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "at_codex", refresh_token: "rt_codex" } }),
    );
  });

  afterEach(() => {
    rmSync(codexHome, { recursive: true, force: true });
  });

  function provider(fetchApi: typeof fetch) {
    return new CodexQuotaProvider({ logger, codexHome, fetch: fetchApi });
  }

  it("fetches Codex windows and coerces string credit balances", async () => {
    const usage = await provider(
      respondWith(() =>
        Response.json(codexResponse({ code_review_rate_limit: null, credits: { balance: "0" } })),
      ),
    ).fetchUsage();

    expect(usage).toMatchObject({
      status: "available",
      planLabel: "plus",
      windows: [
        expect.objectContaining({ id: "session", usedPct: 42 }),
        expect.objectContaining({ id: "weekly", usedPct: 8 }),
      ],
      balances: [expect.objectContaining({ id: "credits", remaining: 0 })],
    });
  });

  it("reports a code review window under its own id", async () => {
    const usage = await provider(
      respondWith(() =>
        Response.json(
          codexResponse({ code_review_rate_limit: { primary_window: { used_percent: null } } }),
        ),
      ),
    ).fetchUsage();

    expect(usage.windows.find((window) => window.id === "code_review")).toMatchObject({
      usedPct: null,
      remainingPct: null,
    });
  });

  it("a Codex window can reach danger, not just warning", async () => {
    const usage = await provider(
      respondWith(() =>
        Response.json(
          codexResponse({
            rate_limit: {
              primary_window: { used_percent: 12, reset_at: 1_748_812_800 },
              secondary_window: { used_percent: 96, reset_at: 1_749_072_000 },
            },
          }),
        ),
      ),
    ).fetchUsage();

    expect(usage.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "session", tone: "ok" }),
        expect.objectContaining({ id: "weekly", tone: "danger" }),
      ]),
    );
  });

  it("treats a Codex HTML usage response as auth failure", async () => {
    const usage = await provider(
      respondWith(() => new Response("<html>Login</html>", { status: 200 })),
    ).fetchUsage();

    expect(usage.status).toBe("unavailable");
  });

  it("returns unavailable on 401 without refreshing or rewriting auth.json", async () => {
    const authPath = join(codexHome, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          id_token: "id_codex",
          access_token: "at_codex_stale",
          refresh_token: "rt_codex_valid",
          account_id: "acct_codex",
        },
        last_refresh: "2026-07-04T20:35:00Z",
      }),
    );
    const before = readFileSync(authPath, "utf8");
    // Any request other than the usage endpoint (such as an OAuth refresh) throws.
    const fetchApi = respondWith(() => new Response(null, { status: 401 }));

    const usage = await provider(fetchApi).fetchUsage();

    expect(usage.status).toBe("unavailable");
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(readFileSync(authPath, "utf8")).toBe(before);
  });
});
