import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ManagedAgent } from "./agent-manager.js";
import type { ProviderUsageListResult } from "../../services/quota-fetcher/service.js";
import { summarizeUsage } from "@getpaseo/protocol/usage-summary";

export type ResourceObservation =
  | { usage: ProviderUsageListResult }
  | { unavailable: "error" | "timeout" };

/** Metadata-only audit trail. Never serializes prompts, config, auth, tool input or errors. */
export class ResourceDecisions {
  private readonly states = new Map<string, string>();
  private writes = Promise.resolve();

  private constructor(private readonly file: string) {}

  static async open(home: string, logger?: Logger): Promise<ResourceDecisions> {
    const dir = join(home, "resource-decisions");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "decisions.jsonl");
    const journal = new ResourceDecisions(file);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return journal;
    }
    await chmod(file, 0o600);
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
        journal.states.set(row.agentId, row.status);
    }
    // Terminate a truncated tail so the next append starts on its own line.
    if (text.length > 0 && !text.endsWith("\n")) await appendFile(file, "\n");
    if (skipped > 0) logger?.warn({ skipped }, "Skipped unreadable resource decision lines");
    return journal;
  }

  flush(): Promise<void> {
    return this.writes;
  }

  private append(row: object): Promise<void> {
    const line = JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n";
    const write = this.writes.then(() => appendFile(this.file, line, { mode: 0o600 }));
    this.writes = write.catch(() => {});
    return write;
  }

  /** Queue the dispatch receipt before the initial prompt can change the agent's state. */
  dispatch(agent: ManagedAgent) {
    this.states.set(agent.id, agent.lifecycle);
    return this.append({
      event: "dispatch",
      agentId: agent.id,
      status: agent.lifecycle,
      provider: agent.provider,
      model: agent.config.model,
      effort: agent.config.thinkingOptionId,
      parentAgentId: agent.labels["paseo.parent-agent-id"] ?? null,
      reason: agent.labels["paseo.resource-reason"] ?? "explicit_requested_configuration",
      observationState: "pending",
    });
  }
  /** The pre-inference usage observation for a dispatch, appended once discovery settles. */
  observation(input: { agentId: string; model: string | null; result: ResourceObservation }) {
    const { result } = input;
    return this.append({
      event: "observation",
      agentId: input.agentId,
      ...("usage" in result
        ? {
            observationState: "observed",
            observation: summarizeUsage(result.usage, { model: input.model }),
          }
        : { observationState: "unavailable", unavailableReason: result.unavailable }),
    });
  }
  observe(agent: ManagedAgent) {
    const previous = this.states.get(agent.id);
    if (previous === undefined || previous === agent.lifecycle) return;
    this.states.set(agent.id, agent.lifecycle);
    return this.append({
      event: "state",
      agentId: agent.id,
      status: agent.lifecycle,
      previousStatus: previous,
    });
  }
}

export const RESOURCE_OBSERVATION_TIMEOUT_MS = 20_000;

/**
 * Build the create-path receipt: the dispatch row is queued first, and the usage
 * observation follows as its own row without blocking creation. Discovery that fails or
 * outlasts the timeout is recorded as unavailable; it is never a prerequisite for the task.
 */
export function createResourceDecisionRecorder(options: {
  decisions: ResourceDecisions | null;
  getUsage: (agentId: string) => Promise<ProviderUsageListResult | null | undefined>;
  logger: Logger;
  timeoutMs?: number;
}): (agent: ManagedAgent) => void {
  const { decisions, logger } = options;
  const timeoutMs = options.timeoutMs ?? RESOURCE_OBSERVATION_TIMEOUT_MS;
  async function observe(agent: ManagedAgent, journal: ResourceDecisions): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ResourceObservation>((resolve) => {
      timer = setTimeout(() => resolve({ unavailable: "timeout" }), timeoutMs);
      timer.unref?.();
    });
    const discovery = (async (): Promise<ResourceObservation> => {
      try {
        const usage = await options.getUsage(agent.id);
        return usage ? { usage } : { unavailable: "error" };
      } catch {
        return { unavailable: "error" };
      }
    })();
    try {
      const result = await Promise.race([discovery, timeout]);
      await journal.observation({ agentId: agent.id, model: agent.config.model ?? null, result });
    } finally {
      clearTimeout(timer);
    }
  }
  return (agent) => {
    if (!decisions) return;
    decisions.dispatch(agent).catch((error: unknown) => {
      logger.warn(
        { err: error, agentId: agent.id },
        "Resource dispatch receipt could not be saved",
      );
    });
    observe(agent, decisions).catch((error: unknown) => {
      logger.warn({ err: error, agentId: agent.id }, "Resource observation could not be saved");
    });
  };
}
