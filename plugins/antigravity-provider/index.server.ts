import type { PluginServerContext } from "@getpaseo/plugin/server";
import { buildAntigravitySystemPromptAppend } from "./server/instructions.js";
import { Usage } from "./server/usage.js";
import { createAntigravityProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  const usage = new Usage();
  server.registerUsageSource(usage.registration());
  server.registerProvider(createAntigravityProvider());
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.provider !== "antigravity" || request.purpose !== "interactive") return;
    const append = await buildAntigravitySystemPromptAppend({
      cwd: request.cwd,
      env: request.env,
    });
    if (append)
      return { ...request, appendSystemPrompt: [...(request.appendSystemPrompt ?? []), append] };
  });
  return () => {};
}
