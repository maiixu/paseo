import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { sendAsyncQuestionReply } from "./send";

const { asyncStorage } = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      asyncStorage.set(key, value);
    },
    removeItem: async (key: string) => {
      asyncStorage.delete(key);
    },
  },
}));

vi.mock("@/attachments/service", () => ({
  garbageCollectAttachments: async () => undefined,
}));

const SERVER_ID = "test-server-1";
const AGENT_ID = "agent-123";

const AGENT_DEFAULTS: Agent = {
  serverId: SERVER_ID,
  id: AGENT_ID,
  provider: "codex",
  status: "idle",
  activeTurn: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  lastUserMessageAt: null,
  lastActivityAt: new Date("2026-09-01T00:00:00.000Z"),
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: false,
    supportsMcpServers: false,
    supportsReasoningStream: false,
    supportsToolInvocations: false,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: "Test Agent",
  cwd: "/tmp/project",
  model: null,
  labels: {},
  parentAgentId: null,
};

function makeAgent(overrides?: Partial<Agent>): Agent {
  return { ...AGENT_DEFAULTS, ...overrides };
}

interface StubDaemonClient {
  sendAgentMessage: ReturnType<typeof vi.fn>;
}

function createStubClient(
  sendAgentMessage = vi.fn().mockResolvedValue(undefined),
): StubDaemonClient {
  return { sendAgentMessage };
}

function setupSessionWithAgent(client: StubDaemonClient | null, agent?: Agent): void {
  const store = useSessionStore.getState();
  store.initializeSession(SERVER_ID, client as unknown as DaemonClient);
  store.updateSessionServerInfo(SERVER_ID, {
    serverId: SERVER_ID,
    hostname: null,
    version: "0.2.6",
    features: { canonicalSubmittedPrompts: true },
  });
  if (agent) {
    store.setAgents(SERVER_ID, new Map([[agent.id, agent]]));
  }
}

describe("sendAsyncQuestionReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDraftStore.setState({
      drafts: {},
      createModalDraft: null,
      attachmentFocusRequestByDraftKey: {},
    });
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  afterEach(() => {
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  it("throws when session or client is unavailable", async () => {
    await expect(sendAsyncQuestionReply(SERVER_ID, AGENT_ID, "reply text")).rejects.toThrow(
      "The agent or host is unavailable.",
    );
  });

  it("throws when client is null", async () => {
    setupSessionWithAgent(null, makeAgent());
    await expect(sendAsyncQuestionReply(SERVER_ID, AGENT_ID, "reply text")).rejects.toThrow(
      "The agent or host is unavailable.",
    );
  });

  it("throws when agent does not exist in session", async () => {
    const stubClient = createStubClient();
    setupSessionWithAgent(stubClient);

    await expect(sendAsyncQuestionReply(SERVER_ID, AGENT_ID, "reply text")).rejects.toThrow(
      "The agent or host is unavailable.",
    );
  });

  it("throws when agent is archived", async () => {
    const stubClient = createStubClient();
    setupSessionWithAgent(stubClient, makeAgent({ archivedAt: new Date() }));

    await expect(sendAsyncQuestionReply(SERVER_ID, AGENT_ID, "reply text")).rejects.toThrow(
      "The agent or host is unavailable.",
    );
  });

  it("uses real dispatchComposerAgentMessage to steer agent with active turn and accepts submission", async () => {
    const stubClient = createStubClient();
    const agent = makeAgent({
      activeTurn: { turnId: "turn-abc-123", startedAt: new Date() },
    });
    setupSessionWithAgent(stubClient, agent);

    const draftKey = buildDraftStoreKey({ serverId: SERVER_ID, agentId: AGENT_ID });
    useDraftStore.getState().saveDraftInput({
      draftKey,
      draft: { text: "Unsent user prompt in composer", attachments: [] },
    });

    await sendAsyncQuestionReply(SERVER_ID, AGENT_ID, "Deploy\nProduction");

    expect(stubClient.sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(stubClient.sendAgentMessage).toHaveBeenCalledWith(
      AGENT_ID,
      "Deploy\nProduction",
      expect.objectContaining({
        messageId: expect.any(String),
        activeTurnBehavior: "steer",
        images: [],
        attachments: [],
      }),
    );

    const session = useSessionStore.getState().sessions[SERVER_ID];
    const submissions = session?.messageSubmissions.get(AGENT_ID) ?? [];
    expect(submissions.length).toBe(1);
    expect(submissions[0]?.rpcSettled).toBe(true);

    const stream = [
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ];
    const submitted = stream.find((item) => item.kind === "user_message");
    expect(submitted?.text).toBe("Deploy\nProduction");
    expect(submitted?.turnId).toBe("turn-abc-123");

    const preservedDraft = useDraftStore.getState().getDraftInput(draftKey);
    expect(preservedDraft?.text).toBe("Unsent user prompt in composer");
  });

  it("uses real dispatchComposerAgentMessage without active turn, omitting turnId", async () => {
    const stubClient = createStubClient();
    const agent = makeAgent({ activeTurn: null });
    setupSessionWithAgent(stubClient, agent);

    await sendAsyncQuestionReply(SERVER_ID, AGENT_ID, "Option B");

    expect(stubClient.sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(stubClient.sendAgentMessage).toHaveBeenCalledWith(
      AGENT_ID,
      "Option B",
      expect.objectContaining({
        activeTurnBehavior: "steer",
      }),
    );

    const session = useSessionStore.getState().sessions[SERVER_ID];
    const submissions = session?.messageSubmissions.get(AGENT_ID) ?? [];
    expect(submissions.length).toBe(1);
    expect(submissions[0]?.rpcSettled).toBe(true);

    const stream = [
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ];
    const submitted = stream.find((item) => item.kind === "user_message");
    expect(submitted?.text).toBe("Option B");
    expect(submitted?.turnId).toBeUndefined();
  });

  it("rejects submission on daemon failure while preserving composer draft", async () => {
    const daemonError = new Error("Transport disconnected");
    const stubClient = createStubClient(vi.fn().mockRejectedValue(daemonError));
    setupSessionWithAgent(stubClient, makeAgent());

    const draftKey = buildDraftStoreKey({ serverId: SERVER_ID, agentId: AGENT_ID });
    useDraftStore.getState().saveDraftInput({
      draftKey,
      draft: { text: "Draft to preserve across errors", attachments: [] },
    });

    await expect(sendAsyncQuestionReply(SERVER_ID, AGENT_ID, "Option C")).rejects.toThrow(
      "Transport disconnected",
    );

    const session = useSessionStore.getState().sessions[SERVER_ID];
    const submissions = session?.messageSubmissions.get(AGENT_ID) ?? [];
    // After rejection, the submission is cleaned up
    expect(submissions.length).toBe(0);

    const stream = [
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ];
    // And the uncommitted message is removed from the stream
    expect(stream.some((item) => item.kind === "user_message")).toBe(false);

    const preservedDraft = useDraftStore.getState().getDraftInput(draftKey);
    expect(preservedDraft?.text).toBe("Draft to preserve across errors");
  });
});
