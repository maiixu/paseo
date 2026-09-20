import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import type { ProviderUsageListResponseMessage } from "../../server/messages.js";
import { CodexQuotaProvider } from "./providers/codex.js";
import type { ProviderApiFetch } from "./provider.js";

type Payload = ProviderUsageListResponseMessage["payload"];
type Routing = NonNullable<Payload["accountRouting"]>;
type Accounts = NonNullable<Payload["providers"][number]["accounts"]>;
const ConfigSchema = z.object({
  stateDirectory: z.string(),
  legacyAccount: z.string(),
  accounts: z.array(z.object({ alias: z.string().min(1), home: z.string().min(1) })).min(1),
});
const LedgerSchema = z.object({ owner: z.string(), phase: z.string() });
function expand(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Only the configured router command enables account reads; no client-supplied paths. */
export class AccountRouterUsage {
  private cache: { key: string; at: number; accounts: Accounts } | null = null;
  private inFlight: { key: string; promise: Promise<Accounts> } | null = null;
  constructor(
    private readonly options: {
      logger: Logger;
      getCommand: () => unknown;
      getAgent: (
        id: string,
      ) => { provider: string; persistence: { sessionId: string } | null } | null;
      fetch?: ProviderApiFetch;
      now?: () => number;
    },
  ) {}

  async read(agentId?: string): Promise<{ accounts: Accounts; routing?: Routing } | null> {
    const parsedCommand = z.array(z.string()).safeParse(this.options.getCommand());
    const command = parsedCommand.success ? parsedCommand.data : undefined;
    if (!command?.some((part) => basename(part) === "paseo-codex-router.py")) return null;
    const flag = command.indexOf("--router-config");
    const path = command[flag + 1];
    if (flag < 0 || !path || !isAbsolute(path))
      throw new Error("Account router configuration is unavailable");
    const config = ConfigSchema.parse(JSON.parse(await fs.readFile(path, "utf8")));
    const now = (this.options.now ?? Date.now)();
    const accounts = await this.loadAccounts(config, now);
    if (!agentId) return { accounts };
    const agent = this.options.getAgent(agentId);
    if (!agent || agent.provider !== "codex") return { accounts };
    const routing: Routing = {
      providerId: "codex",
      accountId: null,
      status: "unknown",
      phase: null,
      checkedAt: new Date(now).toISOString(),
    };
    const thread = agent.persistence?.sessionId;
    if (!thread) return { accounts, routing: { ...routing, status: "pending" } };
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(thread)) return { accounts, routing };
    try {
      const ledger = LedgerSchema.parse(
        JSON.parse(
          await fs.readFile(
            join(expand(config.stateDirectory), "threads", `${thread}.json`),
            "utf8",
          ),
        ),
      );
      if (config.accounts.some((account) => account.alias === ledger.owner)) {
        routing.accountId = ledger.owner;
        routing.phase = ledger.phase;
        routing.status = "active";
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        config.accounts.some((account) => account.alias === config.legacyAccount)
      ) {
        routing.accountId = config.legacyAccount;
        routing.status = "legacy";
      }
    }
    return { accounts, routing };
  }
  private async loadAccounts(config: z.infer<typeof ConfigSchema>, now: number): Promise<Accounts> {
    const key = JSON.stringify(config);
    let accounts: Accounts;
    if (this.cache?.key === key && now - this.cache.at < 60_000) accounts = this.cache.accounts;
    else {
      if (!this.inFlight || this.inFlight.key !== key) {
        const promise = Promise.all(
          config.accounts.map(async (account) => {
            try {
              const usage = await new CodexQuotaProvider({
                logger: this.options.logger,
                codexHome: expand(account.home),
                strictHome: true,
                fetch: this.options.fetch,
              }).fetchUsage();
              return {
                ...usage,
                accountId: account.alias,
                displayName: account.alias,
                fetchedAt: new Date(now).toISOString(),
                sourceLabel: "Subscription account",
              };
            } catch {
              return {
                providerId: "codex",
                accountId: account.alias,
                displayName: account.alias,
                status: "error" as const,
                planLabel: null,
                windows: [],
                fetchedAt: new Date(now).toISOString(),
                error: "Account usage could not be refreshed",
              };
            }
          }),
        );
        this.inFlight = { key, promise };
      }
      const flight = this.inFlight;
      try {
        accounts = await flight.promise;
        this.cache = { key, at: now, accounts };
      } finally {
        if (this.inFlight === flight) this.inFlight = null;
      }
    }
    return accounts;
  }
}
