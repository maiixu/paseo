import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ManagedAgent } from "./agent-manager.js";
import type { ProviderUsageListResult } from "../../services/quota-fetcher/service.js";
import { summarizeUsage } from "@getpaseo/protocol/usage-summary";

/** Metadata-only audit trail. Never serializes prompts, config, auth, tool input or errors. */
export class ResourceDecisions {
  private readonly states = new Map<string, string>();
  private readonly file: string;
  constructor(home: string, logger?: Logger) {
    const dir = join(home, "resource-decisions");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "decisions.jsonl");
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    // A crash mid-append can leave a truncated last line; skip bad lines instead of
    // disabling the journal.
    let skipped = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: { agentId?: unknown; status?: unknown };
      try {
        row = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
      if (typeof row?.agentId === "string" && typeof row.status === "string")
        this.states.set(row.agentId, row.status);
    }
    // Terminate a truncated tail so the next append starts on its own line.
    if (text.length > 0 && !text.endsWith("\n")) appendFileSync(this.file, "\n");
    if (skipped > 0) logger?.warn({ skipped }, "Skipped unreadable resource decision lines");
  }
  private append(row: object) {
    appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n", {
      mode: 0o600,
    });
    chmodSync(this.file, 0o600);
  }
  record(agent: ManagedAgent, usage: ProviderUsageListResult | null) {
    this.append({
      event: "dispatch",
      agentId: agent.id,
      status: agent.lifecycle,
      provider: agent.provider,
      model: agent.config.model,
      effort: agent.config.thinkingOptionId,
      parentAgentId: agent.labels["paseo.parent-agent-id"] ?? null,
      reason: agent.labels["paseo.resource-reason"] ?? "explicit_requested_configuration",
      observation: usage ? summarizeUsage(usage) : null,
      observationState: usage ? "observed" : "unavailable",
    });
    this.states.set(agent.id, agent.lifecycle);
  }
  observe(agent: ManagedAgent) {
    const previous = this.states.get(agent.id);
    if (previous === undefined || previous === agent.lifecycle) return;
    this.append({
      event: "state",
      agentId: agent.id,
      status: agent.lifecycle,
      previousStatus: previous,
    });
    this.states.set(agent.id, agent.lifecycle);
  }
}
