import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { resolvePinnedLaunchProfile } from "./launch-defaults";
import {
  resolveAgentForm,
  INITIAL_USER_MODIFIED,
  INITIAL_AGENT_FORM_RESOLUTION,
  buildProviderDefinitionMap,
  type AgentFormReducerState,
} from "@/provider-selection/resolve-agent-form";
import { buildProviderDefinitions } from "@/utils/provider-definitions";

const profile: AgentProfile = {
  id: "astra-medium",
  name: "Astra Medium",
  provider: "codex",
  model: "astra",
  modeId: "full-access",
  thinkingOptionId: "medium",
  featureValues: { fast_mode: false },
};
const entries: ProviderSnapshotEntry[] = [
  {
    provider: "codex",
    enabled: true,
    status: "ready",
    defaultModeId: "ask",
    modes: [
      { id: "ask", label: "Ask", icon: "ShieldCheck", colorTier: "safe" },
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
    models: [{ id: "opus", provider: "claude", label: "Opus", isDefault: true }],
    modes: [],
  },
];
const input = {
  profileId: "astra-medium",
  profiles: [profile],
  initialValues: {},
  hasUserSelection: false,
  entries,
};
const initialState: AgentFormReducerState = {
  form: {
    provider: null,
    model: "",
    modeId: "",
    thinkingOptionId: "",
  },
  userModified: INITIAL_USER_MODIFIED,
  resolution: INITIAL_AGENT_FORM_RESOLUTION,
};

describe("pinned launch profile", () => {
  it("takes all selection values from the named host profile over remembered Opus", () => {
    const pinned = resolvePinnedLaunchProfile(input);
    expect(pinned).toEqual({
      status: "ready",
      initialValues: {
        provider: "codex",
        model: "astra",
        modeId: "full-access",
        thinkingOptionId: "medium",
      },
      featureValues: { fast_mode: false },
    });
    if (pinned.status !== "ready") throw new Error("Expected ready profile");
    const state = resolveAgentForm(initialState, {
      type: "COMPLETE_RESOLUTION",
      initialValues: pinned.initialValues,
      preferences: {},
      providerModelsByProvider: new Map(
        entries.map((entry) => [entry.provider, entry.models ?? null]),
      ),
      allowedProviderMap: buildProviderDefinitionMap(buildProviderDefinitions(entries)),
    });
    expect(state.form).toEqual({
      provider: "codex",
      model: "astra",
      modeId: "full-access",
      thinkingOptionId: "medium",
    });
  });

  it("leaves a current manual profile choice alone and pins again for a fresh form", () => {
    expect(resolvePinnedLaunchProfile({ ...input, hasUserSelection: true })).toEqual({
      status: "disabled",
    });
    expect(resolvePinnedLaunchProfile(input).status).toBe("ready");
  });

  it("keeps upstream remembered selections when unconfigured", () => {
    expect(resolvePinnedLaunchProfile({ ...input, profileId: null })).toEqual({
      status: "disabled",
    });
  });

  it.each([
    { provider: "claude", model: "opus" },
    { model: "another-model" },
    { modeId: null },
    { thinkingOptionId: "ultra" },
  ])("preserves explicit draft selection %j", (initialValues) => {
    expect(resolvePinnedLaunchProfile({ ...input, initialValues })).toEqual({ status: "disabled" });
  });

  it("uses the profile values supplied for the selected host", () => {
    const selected = resolvePinnedLaunchProfile({
      ...input,
      initialValues: {},
      profiles: [{ ...profile, thinkingOptionId: "high" }],
    });
    expect(selected).toEqual({
      status: "ready",
      initialValues: {
        provider: "codex",
        model: "astra",
        modeId: "full-access",
        thinkingOptionId: "high",
      },
      featureValues: { fast_mode: false },
    });
  });

  it.each([
    { profiles: null },
    { entries: undefined },
    { entries: [{ ...entries[0]!, status: "loading" as const }] },
    { entries: [{ ...entries[0]!, models: undefined }] },
  ])("waits for authoritative profile/catalog inputs %j", (pending) => {
    expect(resolvePinnedLaunchProfile({ ...input, ...pending })).toEqual({ status: "loading" });
  });

  it.each([
    { profiles: [] },
    { entries: [entries[1]!] },
    { entries: [{ ...entries[0]!, enabled: false }] },
    { entries: [{ ...entries[0]!, status: "unavailable" as const }] },
    { profiles: [{ ...profile, model: "missing-model" }] },
    { profiles: [{ ...profile, modeId: "missing-mode" }] },
    { profiles: [{ ...profile, thinkingOptionId: "missing-effort" }] },
  ])("requires an explicit alternate selection when the pin is unavailable %j", (unavailable) => {
    const result = resolvePinnedLaunchProfile({ ...input, ...unavailable });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") throw new Error("Expected unavailable profile");
    expect(result.message).toContain("Choose another profile or model.");
  });
});
