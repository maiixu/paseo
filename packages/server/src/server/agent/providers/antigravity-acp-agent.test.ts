import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { SpawnedACPProcess } from "./acp-agent.js";
import {
  ACPAgentSession,
  DEFAULT_ACP_CAPABILITIES,
  deriveModelDefinitionsFromACP,
} from "./acp-agent.js";
import {
  AntigravityACPAgentClient,
  buildAntigravitySystemPromptAppend,
  resolveAntigravityInstructionSources,
  resolveAntigravitySessionMeta,
} from "./antigravity-acp-agent.js";

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

describe("AntigravityACPAgentClient system prompt rule injection", () => {
  test("collects global GEMINI.md/rules and workspace AGENTS.md deduplicated by realpath", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-agy-rules-"));
    try {
      const homeDir = path.join(root, "home");
      const geminiConfigDir = path.join(homeDir, ".gemini", "config");
      const geminiRulesDir = path.join(geminiConfigDir, "rules");
      const repoDir = path.join(root, "repo");
      const subDir = path.join(repoDir, "packages", "sub");

      mkdirSync(geminiRulesDir, { recursive: true });
      mkdirSync(path.join(repoDir, ".git"), { recursive: true });
      mkdirSync(subDir, { recursive: true });

      const sharedGlobal = path.join(repoDir, "AGENTS.global.md");
      writeFileSync(sharedGlobal, "GLOBAL_RULE_LINE");
      symlinkSync(sharedGlobal, path.join(geminiConfigDir, "GEMINI.md"));
      symlinkSync(sharedGlobal, path.join(geminiRulesDir, "AGENTS.md"));
      writeFileSync(path.join(geminiRulesDir, "extra.md"), "EXTRA_RULE_LINE");

      const repoAgents = path.join(repoDir, "AGENTS.md");
      writeFileSync(repoAgents, "REPO_ROOT_RULE");
      symlinkSync(repoAgents, path.join(repoDir, "GEMINI.md"));
      writeFileSync(path.join(subDir, "AGENTS.md"), "SUBDIR_RULE");

      const sources = await resolveAntigravityInstructionSources({
        cwd: subDir,
        homeDir,
      });

      expect(sources.map((s) => s.content)).toEqual([
        "GLOBAL_RULE_LINE",
        "EXTRA_RULE_LINE",
        "REPO_ROOT_RULE",
        "SUBDIR_RULE",
      ]);

      const meta = await resolveAntigravitySessionMeta({
        cwd: subDir,
        env: { GEMINI_HOME: path.join(homeDir, ".gemini") },
      });
      expect(meta).toEqual({
        antigravity: {
          systemPrompt: {
            append: expect.stringContaining("GLOBAL_RULE_LINE"),
          },
        },
      });
      const append = (meta as { antigravity: { systemPrompt: { append: string } } }).antigravity
        .systemPrompt.append;
      expect(append.indexOf("GLOBAL_RULE_LINE")).toBeLessThan(append.indexOf("REPO_ROOT_RULE"));
      expect(append.indexOf("REPO_ROOT_RULE")).toBeLessThan(append.indexOf("SUBDIR_RULE"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not walk outside non-git directories and returns undefined when no rules exist", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-agy-nogit-"));
    try {
      const homeDir = path.join(root, "home");
      const parentDir = path.join(root, "parent");
      const childDir = path.join(parentDir, "child");
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(childDir, { recursive: true });
      writeFileSync(path.join(parentDir, "AGENTS.md"), "SHOULD_NOT_LEAK");

      expect(await buildAntigravitySystemPromptAppend({ cwd: childDir, homeDir })).toBeUndefined();

      writeFileSync(path.join(childDir, "AGENTS.md"), "LOCAL_ONLY_RULE");
      expect(await buildAntigravitySystemPromptAppend({ cwd: childDir, homeDir })).toContain(
        "LOCAL_ONLY_RULE",
      );
      expect(await buildAntigravitySystemPromptAppend({ cwd: childDir, homeDir })).not.toContain(
        "SHOULD_NOT_LEAK",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("passes _meta on interactive newSession and loadSession, but omits it on catalog probe and history load", async () => {
    const newSessionSpy = vi.fn().mockResolvedValue({
      sessionId: "session-meta-1",
      models: FLAT_MODELS_STATE,
      configOptions: [groupedModelOption("gemini-3.8-flash"), thinkingOption("high", false)],
    });
    const loadSessionSpy = vi.fn().mockResolvedValue({
      models: FLAT_MODELS_STATE,
      configOptions: [groupedModelOption("gemini-3.8-flash"), thinkingOption("high", false)],
    });

    const sessionMetaResolver = vi.fn().mockReturnValue({
      antigravity: { systemPrompt: { append: "INJECTED_RULES" } },
    });

    class TestMetaSession extends ACPAgentSession {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
        return {
          child: { pid: undefined, kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: newSessionSpy,
            loadSession: loadSessionSpy,
            setSessionConfigOption: vi.fn(),
          },
          initialize: { agentCapabilities: { loadSession: true } },
        } as unknown as SpawnedACPProcess;
      }
    }

    const newSession = new TestMetaSession(
      { provider: "acp", cwd: "/tmp/agy-meta-new" },
      {
        provider: "acp",
        logger: createTestLogger(),
        defaultCommand: ["agy-acp"],
        defaultModes: [],
        capabilities: DEFAULT_ACP_CAPABILITIES,
        sessionMetaResolver,
      },
    );
    await newSession.initializeNewSession();
    expect(newSessionSpy).toHaveBeenCalledWith({
      cwd: "/tmp/agy-meta-new",
      mcpServers: [],
      _meta: { antigravity: { systemPrompt: { append: "INJECTED_RULES" } } },
    });
    await newSession.close();

    const resumedInteractive = new TestMetaSession(
      { provider: "acp", cwd: "/tmp/agy-meta-resume" },
      {
        provider: "acp",
        logger: createTestLogger(),
        defaultCommand: ["agy-acp"],
        defaultModes: [],
        capabilities: DEFAULT_ACP_CAPABILITIES,
        handle: { provider: "acp", sessionId: "session-meta-1" },
        resumePurpose: "interactive",
        sessionMetaResolver,
      },
    );
    await resumedInteractive.initializeResumedSession();
    expect(loadSessionSpy).toHaveBeenCalledWith({
      sessionId: "session-meta-1",
      cwd: "/tmp/agy-meta-resume",
      mcpServers: [],
      _meta: { antigravity: { systemPrompt: { append: "INJECTED_RULES" } } },
    });
    await resumedInteractive.close();

    loadSessionSpy.mockClear();
    const resumedHistory = new TestMetaSession(
      { provider: "acp", cwd: "/tmp/agy-meta-history" },
      {
        provider: "acp",
        logger: createTestLogger(),
        defaultCommand: ["agy-acp"],
        defaultModes: [],
        capabilities: DEFAULT_ACP_CAPABILITIES,
        handle: { provider: "acp", sessionId: "session-meta-1" },
        resumePurpose: "history",
        sessionMetaResolver,
      },
    );
    await resumedHistory.initializeResumedSession();
    expect(loadSessionSpy).toHaveBeenCalledWith({
      sessionId: "session-meta-1",
      cwd: "/tmp/agy-meta-history",
      mcpServers: [],
    });
    await resumedHistory.close();

    // Catalog probe must NOT send _meta
    const probeNewSession = vi.fn().mockResolvedValue({
      sessionId: "probe-1",
      models: FLAT_MODELS_STATE,
      configOptions: [groupedModelOption("gemini-3.8-flash"), thinkingOption("high", false)],
    });
    const probeSetConfigOption = vi.fn(async ({ value }: { value: string }) => ({
      configOptions: [groupedModelOption(value), thinkingOption("high", false)],
    }));
    const probeClient = createAntigravityClient(
      async () =>
        ({
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: probeNewSession,
            setSessionConfigOption: probeSetConfigOption,
          },
          initialize: { agentCapabilities: {} },
        }) as unknown as SpawnedACPProcess,
    );
    await probeClient.fetchCatalog({ scope: "workspace", cwd: "/tmp/agy-meta-probe", force: true });
    expect(probeNewSession).toHaveBeenCalledWith({
      cwd: "/tmp/agy-meta-probe",
      mcpServers: [],
    });
  });

  test("continues without _meta if sessionMetaResolver throws", async () => {
    const newSessionSpy = vi.fn().mockResolvedValue({
      sessionId: "session-err-1",
      models: FLAT_MODELS_STATE,
      configOptions: [groupedModelOption("gemini-3.8-flash"), thinkingOption("high", false)],
    });

    class TestThrowingMetaSession extends ACPAgentSession {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
        return {
          child: { pid: undefined, kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: { newSession: newSessionSpy, setSessionConfigOption: vi.fn() },
          initialize: { agentCapabilities: {} },
        } as unknown as SpawnedACPProcess;
      }
    }

    const session = new TestThrowingMetaSession(
      { provider: "acp", cwd: "/tmp/agy-meta-err" },
      {
        provider: "acp",
        logger: createTestLogger(),
        defaultCommand: ["agy-acp"],
        defaultModes: [],
        capabilities: DEFAULT_ACP_CAPABILITIES,
        sessionMetaResolver: () => {
          throw new Error("boom");
        },
      },
    );
    await session.initializeNewSession();
    expect(newSessionSpy).toHaveBeenCalledWith({
      cwd: "/tmp/agy-meta-err",
      mcpServers: [],
    });
    await session.close();
  });
});
