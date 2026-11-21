import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { SpawnedACPProcess } from "./acp-agent.js";
import {
  ACPAgentSession,
  DEFAULT_ACP_CAPABILITIES,
  deriveModelDefinitionsFromACP,
} from "./acp-agent.js";
import { AntigravityACPAgentClient } from "./antigravity-acp-agent.js";

function groupedModelOption(currentValue: string): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [
      { value: "gemini-4-neon", name: "Gemini 4 Neon" },
      { value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
      { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    ],
  };
}

function thinkingOption(currentValue: string, includeXHigh: boolean): SessionConfigOption {
  return {
    id: "thinking_level",
    name: "Thinking Level",
    category: "thought_level",
    type: "select",
    currentValue,
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      ...(includeXHigh ? [{ value: "xhigh", name: "Extra" }] : []),
    ],
  };
}

const FLAT_MODELS_STATE = {
  currentModelId: "gemini-3.8-flash-high",
  availableModels: [
    { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
    { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
    { modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
    { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
    { modelId: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)" },
    { modelId: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
    { modelId: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)" },
    { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  ],
};

function createAntigravityClient(
  spawnProcess: () => Promise<SpawnedACPProcess>,
): AntigravityACPAgentClient {
  class TestAntigravityACPAgentClient extends AntigravityACPAgentClient {
    protected override async spawnProcess(): Promise<SpawnedACPProcess> {
      return spawnProcess();
    }

    protected override async closeProbe(): Promise<void> {}
  }

  return new TestAntigravityACPAgentClient({
    logger: createTestLogger(),
    command: ["agy-acp"],
    providerId: "antigravity",
    label: "Antigravity",
  });
}

describe("AntigravityACPAgentClient grouped models and thinking levels", () => {
  test("prefers grouped configOptions models and resolves per-family thinking levels including xhigh", async () => {
    const setSessionConfigOption = vi.fn(async ({ value }: { value: string }) => ({
      configOptions: [groupedModelOption(value), thinkingOption("high", value === "gemini-4-neon")],
    }));

    const client = createAntigravityClient(
      async () =>
        ({
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: vi.fn().mockResolvedValue({
              sessionId: "session-1",
              models: FLAT_MODELS_STATE,
              configOptions: [
                groupedModelOption("gemini-3.8-flash"),
                thinkingOption("high", false),
              ],
            }),
            setSessionConfigOption,
          },
          initialize: { agentCapabilities: {} },
        }) as unknown as SpawnedACPProcess,
    );

    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/acp-agy-grouped",
      force: false,
    });

    expect(catalog.models.map((m) => m.id)).toEqual([
      "gemini-4-neon",
      "gemini-4-carbon",
      "gemini-3.8-flash",
    ]);
    const neon = catalog.models.find((m) => m.id === "gemini-4-neon");
    const carbon = catalog.models.find((m) => m.id === "gemini-4-carbon");
    const flash = catalog.models.find((m) => m.id === "gemini-3.8-flash");

    expect(neon?.thinkingOptions?.map((o) => o.id)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(neon?.defaultThinkingOptionId).toBe("high");
    expect(carbon?.thinkingOptions?.map((o) => o.id)).toEqual(["low", "medium", "high"]);
    expect(flash?.isDefault).toBe(true);
    expect(flash?.thinkingOptions?.map((o) => o.id)).toEqual(["low", "medium", "high"]);
  });

  test("falls back to flat availableModels when configOptions has no model picker (ACP 1.4.x)", () => {
    const models = deriveModelDefinitionsFromACP("antigravity", FLAT_MODELS_STATE, [], {
      preferConfigOptionModels: true,
    });
    expect(models.map((m) => m.id)).toEqual(
      FLAT_MODELS_STATE.availableModels.map((m) => m.modelId),
    );
  });

  test("preserves xhigh and accepts legacy concrete model IDs while syncing thinkingOptionId", async () => {
    let activeFamily = "gemini-3.8-flash";
    let activeThinking = "high";

    const setSessionConfigOption = vi.fn(
      async ({ configId, value }: { configId: string; value: string }) => {
        if (configId === "model") {
          const match = value.match(/^(gemini-[^-]+-[^-]+)-(low|medium|high|xhigh)$/);
          if (match) {
            activeFamily = match[1];
            activeThinking = match[2];
          } else {
            activeFamily = value;
            if (activeFamily !== "gemini-4-neon" && activeThinking === "xhigh") {
              activeThinking = "high";
            }
          }
        } else if (configId === "thinking_level") {
          activeThinking = value;
        }
        return {
          configOptions: [
            groupedModelOption(activeFamily),
            thinkingOption(activeThinking, activeFamily === "gemini-4-neon"),
          ],
        };
      },
    );
    const unstableSetSessionModel = vi.fn();

    class TestAntigravitySession extends ACPAgentSession {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
        return {
          child: { pid: undefined, kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: vi.fn().mockResolvedValue({
              sessionId: "session-2",
              models: FLAT_MODELS_STATE,
              configOptions: [
                groupedModelOption("gemini-3.8-flash"),
                thinkingOption("high", false),
              ],
            }),
            setSessionConfigOption,
            unstable_setSessionModel: unstableSetSessionModel,
          },
          initialize: { agentCapabilities: {} },
        } as unknown as SpawnedACPProcess;
      }
    }

    const session = new TestAntigravitySession(
      {
        provider: "acp",
        cwd: "/tmp/acp-agy-session",
        model: "gemini-4-neon",
        thinkingOptionId: "xhigh",
      },
      {
        provider: "acp",
        logger: createTestLogger(),
        defaultCommand: ["agy-acp"],
        defaultModes: [],
        capabilities: DEFAULT_ACP_CAPABILITIES,
        preferConfigOptionModels: true,
      },
    );
    await session.initializeNewSession();

    // Wait for session initialization via runtimeInfo
    expect(unstableSetSessionModel).not.toHaveBeenCalled();
    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-2",
      configId: "model",
      value: "gemini-4-neon",
    });
    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-2",
      configId: "thinking_level",
      value: "xhigh",
    });
    expect((await session.getRuntimeInfo()).model).toBe("gemini-4-neon");
    expect((await session.getRuntimeInfo()).thinkingOptionId).toBe("xhigh");

    // Switching to carbon clamps xhigh -> high and emits thinking_option_changed
    const events: string[] = [];
    session.subscribe((event) => {
      if (event.type === "thinking_option_changed") {
        events.push(`thinking:${event.thinkingOptionId}`);
      }
    });
    await session.setModel("gemini-4-carbon");
    expect((await session.getRuntimeInfo()).model).toBe("gemini-4-carbon");
    expect((await session.getRuntimeInfo()).thinkingOptionId).toBe("high");
    expect(events).toContain("thinking:high");

    // Legacy concrete model ID (e.g. from saved schedule/conversation) passes through and syncs both
    await session.setModel("gemini-4-neon-medium");
    expect((await session.getRuntimeInfo()).model).toBe("gemini-4-neon");
    expect((await session.getRuntimeInfo()).thinkingOptionId).toBe("medium");
    expect(events).toContain("thinking:medium");

    await session.close();
  });
});
