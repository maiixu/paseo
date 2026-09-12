import { Bot, PackagePlus } from "lucide-react-native";
import { createElement, type ComponentType } from "react";
import { SvgXml } from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import { AwsIcon } from "@/components/icons/aws-icon";
import { ClaudeIcon } from "@/components/icons/claude-icon";
import { CodexIcon } from "@/components/icons/codex-icon";
import { CopilotIcon } from "@/components/icons/copilot-icon";
import { GeminiIcon } from "@/components/icons/gemini-icon";
import { MiniMaxIcon } from "@/components/icons/minimax-icon";
import { OpenCodeIcon } from "@/components/icons/opencode-icon";
import { OmpIcon } from "@/components/icons/omp-icon";
import { PiIcon } from "@/components/icons/pi-icon";
import { ACP_PROVIDER_CATALOG } from "@/data/acp-provider-catalog";
import { resolveProviderIconName } from "@/components/provider-icon-name";

export interface ProviderIconProps {
  size: number;
  color: string;
}

export type ProviderIconComponent = ComponentType<ProviderIconProps>;

const BUILTIN_PROVIDER_ICONS: Record<string, ProviderIconComponent> = {
  aws: AwsIcon,
  claude: ClaudeIcon as unknown as ProviderIconComponent,
  codex: CodexIcon as unknown as ProviderIconComponent,
  copilot: CopilotIcon as unknown as ProviderIconComponent,
  gemini: GeminiIcon,
  kiro: PackagePlus,
  minimax: MiniMaxIcon as unknown as ProviderIconComponent,
  omp: OmpIcon as unknown as ProviderIconComponent,
  opencode: OpenCodeIcon as unknown as ProviderIconComponent,
  pi: PiIcon as unknown as ProviderIconComponent,
};

const CATALOG_ICON_SVGS = new Map(
  ACP_PROVIDER_CATALOG.flatMap((entry) => (entry.iconSvg ? [[entry.id, entry.iconSvg]] : [])),
);

const catalogIconComponents = new Map<string, ProviderIconComponent>();
const snapshotIconComponents = new Map<string, { svg: string; component: ProviderIconComponent }>();

function createSvgIcon(provider: string, iconSvg: string): ProviderIconComponent {
  const SvgProviderIcon: ProviderIconComponent = ({ size, color }) =>
    createElement(SvgXml, {
      xml: iconSvg,
      width: size,
      height: size,
      color,
    });
  SvgProviderIcon.displayName = `SvgProviderIcon(${provider})`;
  return SvgProviderIcon;
}

function getCatalogProviderIcon(provider: string): ProviderIconComponent {
  const cached = catalogIconComponents.get(provider);
  if (cached) {
    return cached;
  }
  const iconSvg = CATALOG_ICON_SVGS.get(provider);
  if (!iconSvg) {
    return Bot;
  }
  const icon = createSvgIcon(provider, iconSvg);
  catalogIconComponents.set(provider, icon);
  return icon;
}

function getSnapshotProviderIcon(provider: string, svg: string): ProviderIconComponent {
  const cached = snapshotIconComponents.get(provider);
  if (cached?.svg === svg) return cached.component;
  const component = createSvgIcon(provider, svg);
  snapshotIconComponents.set(provider, { svg, component });
  return component;
}

export function getProviderIcon(provider: string, serverId?: string | null): ProviderIconComponent {
  const name = resolveProviderIconName(provider, serverId);
  if (name.kind === "builtin") {
    return BUILTIN_PROVIDER_ICONS[name.id];
  }
  if (name.kind === "catalog") {
    return getCatalogProviderIcon(name.id);
  }
  if (name.kind === "svg") {
    return getSnapshotProviderIcon(`${serverId}:${provider}`, name.svg);
  }
  return Bot;
}

function createThemedProviderIcon(Icon: ProviderIconComponent) {
  return withUnistyles(Icon);
}

const themedProviderIcons = new Map<
  ProviderIconComponent,
  ReturnType<typeof createThemedProviderIcon>
>();

/** Theme subscriptions belong to the SVG leaf, including for catalog/custom providers. */
export function getThemedProviderIcon(provider: string, serverId?: string | null) {
  const Icon = getProviderIcon(provider, serverId);
  const cached = themedProviderIcons.get(Icon);
  if (cached) {
    return cached;
  }
  const themed = createThemedProviderIcon(Icon);
  themedProviderIcons.set(Icon, themed);
  return themed;
}
