import { z } from "zod";
const taskSchema = z
  .object({
    runId: z.string().min(1).max(100),
    agentId: z.string().min(1).max(100),
    workspaceId: z.string().min(1).max(100),
    label: z.string().min(1).max(140),
    host: z.string().min(1).max(80),
    phase: z.enum(["running", "waiting", "verifying", "complete", "failed"]),
    progress: z.number().min(0).max(100).nullable(),
    observedAt: z.number().finite().nonnegative(),
    staleAfterSeconds: z.number().int().min(30).max(86400),
    continuation: z.enum(["none", "armed", "sent", "failed"]),
  })
  .strict();
export type BackgroundTask = z.infer<typeof taskSchema>;
export function parseManifest(text: string, serverId: string): BackgroundTask[] {
  if (text.length > 65536) throw new Error("Manifest too large");
  const manifest = z
    .object({
      version: z.literal(1),
      serverId: z.literal(serverId),
      tasks: z.array(taskSchema).max(128),
    })
    .strict()
    .parse(JSON.parse(text));
  if (new Set(manifest.tasks.map((t) => t.runId)).size !== manifest.tasks.length)
    throw new Error("Duplicate run identity");
  return manifest.tasks;
}
const phases: Record<BackgroundTask["phase"], string> = {
  running: "Running",
  waiting: "Waiting",
  verifying: "Verifying",
  complete: "Complete",
  failed: "Failed",
};
export function taskSummary(task: BackgroundTask, online: boolean, now: number): string {
  const phase = phases[task.phase];
  if (!online) return `Unavailable · Last known: ${phase}`;
  if (
    task.observedAt > now + 60 ||
    (task.phase !== "complete" && now - task.observedAt > task.staleAfterSeconds)
  )
    return `Stale observation · Last known: ${phase}`;
  return `${phase}${task.progress === null ? "" : ` · ${task.progress}%`}${
    task.continuation === "none" ? "" : ` · Continuation ${task.continuation}`
  }`;
}
