import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { AgentModelDefinition, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { FormInitialValues } from "@/provider-selection/resolve-agent-form";
import { filterSelectableModels, findModelByReference } from "@/provider-selection/model-catalog";

// Opt-in deployment settings. Unconfigured builds keep remembered selections.
export const DEFAULT_LAUNCH_SERVER_ID =
  process.env.EXPO_PUBLIC_PASEO_DEFAULT_SERVER_ID?.trim() || null;
export const DEFAULT_LAUNCH_PROFILE_ID =
  process.env.EXPO_PUBLIC_PASEO_DEFAULT_PROFILE_ID?.trim() || null;

export type PinnedLaunchProfile =
  | { status: "disabled" }
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | {
      status: "ready";
      initialValues: FormInitialValues;
      featureValues: Record<string, unknown>;
    };

export function shouldUsePinnedLaunchProfile(input: {
  profileId: string | null;
  initialValues: FormInitialValues | undefined;
  hasUserSelection: boolean;
}): boolean {
  const initial = input.initialValues;
  return Boolean(
    input.profileId &&
    !input.hasUserSelection &&
    initial?.provider === undefined &&
    initial?.model === undefined &&
    initial?.modeId === undefined &&
    initial?.thinkingOptionId === undefined,
  );
}

/** The named host profile is authoritative; no remembered-provider fallback. */
export function resolvePinnedLaunchProfile(input: {
  profileId: string | null;
  initialValues: FormInitialValues | undefined;
  hasUserSelection: boolean;
  profiles: readonly AgentProfile[] | null;
  entries: readonly ProviderSnapshotEntry[] | undefined;
}): PinnedLaunchProfile {
  if (!shouldUsePinnedLaunchProfile(input)) return { status: "disabled" };
  if (input.profiles === null) return { status: "loading" };
  const profile = input.profiles.find((entry) => entry.id === input.profileId);
  const unavailable = (): PinnedLaunchProfile => ({
    status: "unavailable",
    message: `Default profile “${profile?.name ?? input.profileId}” is unavailable on this host. Choose another profile or model.`,
  });
  if (!profile) return unavailable();
  if (input.entries === undefined) return { status: "loading" };
  const provider = input.entries.find((entry) => entry.provider === profile.provider);
  if (!provider?.enabled || provider.status === "unavailable" || provider.status === "error") {
    return unavailable();
  }
  if (provider.status === "loading" || provider.models == null) return { status: "loading" };
  const values = resolveProfileValues(profile, provider);
  if (!values) return unavailable();
  return {
    status: "ready",
    initialValues: {
      ...input.initialValues,
      provider: provider.provider,
      ...values,
    },
    featureValues: profile.featureValues ?? {},
  };
}

function profileModel(
  profile: AgentProfile,
  provider: ProviderSnapshotEntry,
): AgentModelDefinition | null {
  const models = filterSelectableModels(provider.models ?? []) ?? [];
  const requestedModel = profile.model?.trim() ?? "";
  return requestedModel
    ? findModelByReference(models, requestedModel)
    : (models.find((entry) => entry.isDefault) ?? models[0] ?? null);
}

function resolveProfileValues(
  profile: AgentProfile,
  provider: ProviderSnapshotEntry,
): FormInitialValues | null {
  const model = profileModel(profile, provider);
  if (profile.model?.trim() && !model) return null;
  const modeId = profile.modeId?.trim() || provider.defaultModeId || "";
  if (modeId && !provider.modes?.some((mode) => mode.id === modeId)) return null;
  const thinkingOptionId = profile.thinkingOptionId?.trim() || model?.defaultThinkingOptionId || "";
  if (thinkingOptionId && !model?.thinkingOptions?.some((option) => option.id === thinkingOptionId))
    return null;
  return { model: model?.id ?? "", modeId, thinkingOptionId };
}
