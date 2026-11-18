import type { Agent } from "@/stores/session-store";

interface ShouldClearAgentAttentionInput {
  agentId: string | null | undefined;
  isConnected: boolean;
  requiresAttention: boolean | null | undefined;
  attentionReason?: "finished" | "error" | "permission" | null | undefined;
  trigger?: AgentAttentionClearTrigger;
  hasDeferredFocusEntryClear?: boolean;
}

export type AgentAttentionClearTrigger =
  | "focus-entry"
  | "completion-viewed"
  | "input-focus"
  | "prompt-send"
  | "agent-blur";

interface ViewedAgentCompletionInput {
  status: Agent["status"] | null;
  attentionReason: Agent["attentionReason"];
  isActivelyViewed: boolean;
}

export function shouldClearViewedAgentCompletion(input: ViewedAgentCompletionInput): boolean {
  const isFinishedTurn = input.status === "idle" && input.attentionReason === "finished";
  return input.isActivelyViewed && isFinishedTurn;
}

const ATTENTION_REASON_PRIORITY = {
  permission: 0,
  error: 1,
  finished: 2,
} as const;

function getAttentionPriority(reason: Agent["attentionReason"]): number | null {
  if (!reason) {
    return null;
  }
  return ATTENTION_REASON_PRIORITY[reason];
}

export function pickAttentionAgent(agents: Agent[]): string | null {
  let selectedAgentId: string | null = null;
  let selectedPriority = Number.POSITIVE_INFINITY;
  let selectedTimestamp = Number.POSITIVE_INFINITY;

  for (const agent of agents) {
    if (agent.requiresAttention !== true) {
      continue;
    }

    if (agent.parentAgentId) {
      continue;
    }

    const priority = getAttentionPriority(agent.attentionReason);
    if (priority === null) {
      continue;
    }

    const timestamp = agent.attentionTimestamp?.getTime() ?? Number.POSITIVE_INFINITY;
    const isHigherPriority = priority < selectedPriority;
    const isOlderAtSamePriority = priority === selectedPriority && timestamp < selectedTimestamp;
    if (isHigherPriority || isOlderAtSamePriority) {
      selectedAgentId = agent.id;
      selectedPriority = priority;
      selectedTimestamp = timestamp;
    }
  }

  return selectedAgentId;
}

export function shouldClearAgentAttention(input: ShouldClearAgentAttentionInput): boolean {
  const agentId = input.agentId?.trim();
  if (!agentId) {
    return false;
  }
  if (!input.isConnected) {
    return false;
  }
  if (!input.requiresAttention) {
    return false;
  }
  if (input.attentionReason === "permission") {
    return false;
  }
  if (input.trigger === "focus-entry" && input.hasDeferredFocusEntryClear === true) {
    return false;
  }
  return true;
}

interface AttentionState {
  focused: boolean;
  ready: boolean;
  requiresAttention: boolean;
  attentionReason: "finished" | "error" | "permission" | null | undefined;
  focusRequest: object | null;
}

export function createAgentAttentionController(deps: {
  clear: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  let state: AttentionState | null = null;
  let inFlight = false;
  let pendingFocus = false;

  function acknowledgeFocus() {
    if (!pendingFocus || !state?.focused || !state.ready) return;
    pendingFocus = false;
    if (!state.requiresAttention || state.attentionReason === "permission" || inFlight) return;
    inFlight = true;
    void deps.clear().then(
      () => {
        inFlight = false;
        return undefined;
      },
      (error: unknown) => {
        inFlight = false;
        deps.onError(error);
      },
    );
  }

  return {
    focus() {
      if (!state?.focused) return;
      pendingFocus = true;
      acknowledgeFocus();
    },
    update(next: AttentionState) {
      const entered = next.focused && !state?.focused;
      const requested = next.focusRequest !== null && next.focusRequest !== state?.focusRequest;
      state = { ...next };
      if (!next.focused) pendingFocus = false;
      else if (entered || requested) pendingFocus = true;
      acknowledgeFocus();
    },
  };
}
