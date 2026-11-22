import { hostname } from "node:os";
import type { PluginMessageSender } from "@getpaseo/plugin/server";
import { getHostName } from "../host-name.js";

export type SenderClientInfo = PluginMessageSender;

export interface SenderClientConnectionInput {
  transport: "direct" | "relay" | "hub";
  peer: "loopback" | "local_ipc" | "external";
  clientType?: string;
  host?: string;
  origin?: string;
  userAgent?: string;
  appVersion?: string;
  hasBrowserHost?: boolean;
}

export function resolveRuntimeHostName(): string {
  try {
    const hostName = getHostName().trim();
    if (hostName) return hostName;
  } catch {
    // Fall back to os.hostname() if scutil is unavailable.
  }
  const raw = hostname().trim();
  const short = raw.split(".")[0]?.trim();
  return short || raw;
}

export function buildRuntimeHostSystemPrompt(hostName: string): string {
  const trimmed = hostName.trim();
  if (!trimmed) return "";
  return [
    `Paseo runtime host: ${trimmed}.`,
    "You are executing on this host inside a Paseo daemon; the user may be messaging and viewing your replies from a different device.",
    'When a human prompt is wrapped in <paseo-system version="1" kind="user-message" sender-device="..." sender-locality="...">, treat sender-device and sender-locality as the client device that sent that message.',
  ].join(" ");
}

function stripHostPort(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const closeBracket = trimmed.indexOf("]");
    return closeBracket > 0 ? trimmed.slice(1, closeBracket) : trimmed;
  }
  const colonIndex = trimmed.indexOf(":");
  return colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed;
}

function isLoopbackHostName(hostName: string): boolean {
  const normalized = stripHostPort(hostName);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("127.")
  );
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return isLoopbackHostName(parsed.hostname);
  } catch {
    return false;
  }
}

function resolveSenderLocality(input: SenderClientConnectionInput): "local" | "remote" {
  if (input.transport !== "direct") return "remote";
  if (input.peer === "local_ipc") return "local";
  if (input.peer !== "loopback") return "remote";
  if (input.host && !isLoopbackHostName(input.host)) return "remote";
  if (input.origin && !isLoopbackOrigin(input.origin)) return "remote";
  return "local";
}

function detectPlatform(ua: string): string | null {
  if (/\biPhone\b/i.test(ua)) return "iPhone";
  if (/\biPad\b/i.test(ua)) return "iPad";
  if (/\bAndroid\b/i.test(ua)) return "Android";
  if (/\bMacintosh\b|\bMac OS X\b/i.test(ua)) return "macOS";
  if (/\bWindows\b/i.test(ua)) return "Windows";
  if (/\bCrOS\b/i.test(ua)) return "ChromeOS";
  if (/\bLinux\b/i.test(ua)) return "Linux";
  return null;
}

function detectBrowser(ua: string): string | null {
  if (/\bEdg(?:A|iOS)?\//i.test(ua)) return "Edge";
  if (/\b(?:Firefox|FxiOS)\//i.test(ua)) return "Firefox";
  if (/\b(?:Chrome|CriOS)\//i.test(ua)) return "Chrome";
  if (/\bSafari\//i.test(ua)) return "Safari";
  return null;
}

function resolveSenderDevice(input: SenderClientConnectionInput): string {
  if (input.clientType === "cli") return "CLI";
  if (input.clientType === "mcp") return "MCP";
  if (input.clientType === "hub") return "Hub";

  const ua = input.userAgent?.trim() ?? "";
  if (input.hasBrowserHost || /\bElectron\//i.test(ua)) {
    const platform = ua ? detectPlatform(ua) : null;
    return platform ? `${platform} Desktop` : "Desktop app";
  }

  if (ua) {
    if (/^okhttp\//i.test(ua)) return "Android app";
    if (/\b(?:CFNetwork|Darwin)\b/i.test(ua)) return "iOS app";
    const platform = detectPlatform(ua);
    const browser = detectBrowser(ua);
    if (platform && browser) return `${platform} ${browser}`;
    if (platform) return `${platform} browser`;
    if (browser) return browser;
  }

  if (input.clientType === "mobile") return "iOS app";
  if (input.clientType === "browser") return "Browser";
  return input.clientType ?? "Unknown client";
}

export function describeSenderClient(input: SenderClientConnectionInput): SenderClientInfo {
  return {
    device: resolveSenderDevice(input),
    locality: resolveSenderLocality(input),
    ...(input.clientType ? { clientType: input.clientType } : {}),
    transport: input.transport,
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.host ? { host: input.host } : {}),
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
  };
}
