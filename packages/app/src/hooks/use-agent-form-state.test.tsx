/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { useAgentFormState } from "./use-agent-form-state";

const fixture = vi.hoisted(() => ({
  preferences: {} as FormPreferences,
  entries: [] as ProviderSnapshotEntry[],
  refresh: vi.fn(),
  refetch: vi.fn(),
  profile: {
    id: "astra-medium",
    name: "Astra Medium",
    provider: "codex",
    model: "astra",
    modeId: "full-access",
    thinkingOptionId: "medium",
    featureValues: { fast_mode: false },
  },
}));
vi.mock("@/create-agent-preferences/launch-defaults", async (original) => ({
  ...(await original<typeof import("@/create-agent-preferences/launch-defaults")>()),
  DEFAULT_LAUNCH_PROFILE_ID: "astra-medium",
}));
vi.mock("./use-daemon-config", () => ({
  useDaemonConfig: () => ({ config: { agentProfiles: [fixture.profile] } }),
}));
vi.mock("./use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: fixture.entries,
    isLoading: false,
    isRefreshing: false,
    error: null,
    refresh: fixture.refresh,
    refetchIfStale: fixture.refetch,
  }),
}));
vi.mock("./use-form-preferences", async () => ({
  mergeProviderPreferences: (await import("@/create-agent-preferences/preferences"))
    .mergeProviderPreferences,
  useFormPreferences: () => ({
    preferences: fixture.preferences,
    isLoading: false,
    updatePreferences: async (
      update: Partial<FormPreferences> | ((p: FormPreferences) => FormPreferences),
    ) => {
      fixture.preferences =
        typeof update === "function"
          ? update(fixture.preferences)
          : { ...fixture.preferences, ...update };
      return fixture.preferences;
    },
  }),
}));
beforeEach(() => {
  fixture.preferences = { provider: "claude", providerPreferences: { claude: { model: "opus" } } };
  fixture.entries = [
    {
      provider: "codex",
      enabled: true,
      status: "ready",
      defaultModeId: "full-access",
      modes: [
        { id: "full-access", label: "Full access", icon: "ShieldAlert", colorTier: "dangerous" },
      ],
      models: [
        {
          id: "astra",
          provider: "codex",
          label: "Astra",
          isDefault: true,
          defaultThinkingOptionId: "high",
          thinkingOptions: [
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
      ],
    },
    {
      provider: "claude",
      enabled: true,
      status: "ready",
      defaultModeId: "bypassPermissions",
      modes: [
        { id: "bypassPermissions", label: "Bypass", icon: "ShieldAlert", colorTier: "dangerous" },
      ],
      models: [{ id: "opus", provider: "claude", label: "Opus", isDefault: true }],
    },
    {
      provider: "antigravity",
      enabled: true,
      status: "ready",
      modes: [],
      models: [{ id: "gemini", provider: "antigravity", label: "Gemini", isDefault: true }],
    },
  ];
});
it("keeps an explicit provider choice after releasing the pinned launch default", async () => {
  const { result, rerender } = renderHook(() =>
    useAgentFormState({ serverId: "cloudtop", workingDir: "/project" }),
  );
  expect(result.current.selectedProvider).toBe("codex");
  expect(result.current.selectedThinkingOptionId).toBe("medium");
  await act(async () => result.current.setProviderAndModelFromUser("claude", "opus"));
  rerender();
  expect(result.current.selectedProvider).toBe("claude");
  expect(result.current.selectedModel).toBe("opus");
});

it("keeps an explicit Opus profile including its mode through snapshot refresh", async () => {
  const { result, rerender } = renderHook(() =>
    useAgentFormState({ serverId: "cloudtop", workingDir: "/project" }),
  );
  await act(async () =>
    result.current.applyProfileFromUser({
      provider: "claude",
      modelId: "opus",
      modeId: "bypassPermissions",
      thinkingOptionId: "",
      featureValues: {},
    }),
  );
  fixture.entries = structuredClone(fixture.entries);
  rerender();
  expect(result.current.selectedProvider).toBe("claude");
  expect(result.current.selectedModel).toBe("opus");
  expect(result.current.selectedMode).toBe("bypassPermissions");
});

it("keeps Gemini for this draft but restores Astra Medium when a fresh form opens", async () => {
  const { result, rerender } = renderHook(
    ({ isVisible }) =>
      useAgentFormState({ serverId: "cloudtop", workingDir: "/project", isVisible }),
    { initialProps: { isVisible: true } },
  );
  await act(async () => result.current.setProviderAndModelFromUser("antigravity", "gemini"));
  expect(result.current.selectedProvider).toBe("antigravity");
  expect(result.current.selectedModel).toBe("gemini");
  rerender({ isVisible: false });
  rerender({ isVisible: true });
  expect(result.current.selectedProvider).toBe("codex");
  expect(result.current.selectedModel).toBe("astra");
  expect(result.current.selectedThinkingOptionId).toBe("medium");
  expect(result.current.defaultFeatureValues).toEqual({ fast_mode: false });
});

it("respects an explicit restored draft instead of applying the launch profile", () => {
  const { result } = renderHook(() =>
    useAgentFormState({
      serverId: "cloudtop",
      workingDir: "/project",
      initialValues: { provider: "claude", model: "opus" },
    }),
  );
  expect(result.current.selectedProvider).toBe("claude");
  expect(result.current.selectedModel).toBe("opus");
});
