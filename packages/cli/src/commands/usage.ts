import type { Command } from "commander";
import { summarizeUsage } from "@getpaseo/protocol/usage-summary";
import { connectToDaemon } from "../utils/client.js";
import type { CommandOptions, SingleResult, OutputSchema } from "../output/index.js";

type Summary = ReturnType<typeof summarizeUsage>;
const schema: OutputSchema<Summary> = {
  idField: "observedAt",
  columns: [{ header: "OBSERVED", field: "observedAt" }],
  renderHuman(result) {
    if (result.type !== "single") return "";
    const { data } = result;
    const lines = [`Observed: ${data.observedAt}`];
    if (data.routing)
      lines.push(
        `Route: ${data.routing.accountId ?? "unknown"} / ${data.routing.phase ?? data.routing.status}`,
      );
    if (data.routing?.configuredSwitchingMode) {
      lines.push(
        `Switching: configured=${data.routing.configuredSwitchingMode}; worker observed=${data.routing.observedSwitchingMode ?? "unknown (reload/observation required)"}`,
      );
    }
    for (const r of data.resources) {
      lines.push(`${r.provider}/${r.account ?? "default"}: ${r.allowance} (${r.reason})`);
      for (const w of r.windows)
        lines.push(
          `  ${w.label}: ${w.remainingPct ?? "?"}% remaining; reset ${w.resetsAt ?? "unknown"}`,
        );
    }
    lines.push("Allowance is not authorization or execution admission; windows are not pooled.");
    return lines.join("\n");
  },
};
export async function runUsageCommand(
  options: CommandOptions & { agent?: string },
  _command: Command,
): Promise<SingleResult<Summary>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const usage = await client.listProviderUsage({ agentId: options.agent });
    return { type: "single", data: summarizeUsage(usage), schema };
  } finally {
    await client.close();
  }
}
