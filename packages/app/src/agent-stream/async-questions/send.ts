import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { useSessionStore } from "@/stores/session-store";

export async function sendAsyncQuestionReply(serverId: string, agentId: string, text: string) {
  const session = useSessionStore.getState().sessions[serverId];
  const agent = session?.agents.get(agentId);
  if (!session?.client || !agent || agent.archivedAt) {
    throw new Error("The agent or host is unavailable.");
  }
  // A reply steers ongoing work. It does not cancel a turn or consume the composer draft.
  await dispatchComposerAgentMessage({
    client: session.client,
    agentId,
    text,
    attachments: [],
    encodeImages: async () => undefined,
    submission: createMessageSubmissionWriter(serverId),
    activeTurnBehavior: "steer",
    activeTurnId: agent.activeTurn?.turnId ?? undefined,
  });
}
