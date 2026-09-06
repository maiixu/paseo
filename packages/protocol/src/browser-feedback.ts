import { z } from "zod";

export const BROWSER_FEEDBACK_SOURCE = "paseo-browser-feedback";
export const BROWSER_COMPANION_SOURCE = "paseo-browser-companion";
export const BROWSER_FEEDBACK_VERSION = 1;

export const BrowserAgentIdentitySchema = z.object({
  serverId: z.string().min(1).max(200),
  agentId: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200).nullable(),
});

export type BrowserAgentIdentity = z.infer<typeof BrowserAgentIdentitySchema>;

export const BrowserFeedbackStateSchema = z.object({
  identity: BrowserAgentIdentitySchema.nullable(),
  status: z.enum(["none", "running", "attention"]),
  visible: z.boolean(),
  connected: z.boolean(),
});

export type BrowserFeedbackState = z.infer<typeof BrowserFeedbackStateSchema>;

export const BrowserFeedbackNotificationSchema = z.object({
  id: z.string().min(1).max(2048),
  identity: BrowserAgentIdentitySchema,
  reason: z.enum(["finished", "permission"]),
  title: z.string().min(1).max(300),
  body: z.string().max(4000),
  createdAt: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => Number.isFinite(Date.parse(value)), {
      message: "Expected a valid event timestamp",
    }),
});

export type BrowserFeedbackNotification = z.infer<typeof BrowserFeedbackNotificationSchema>;

export const BrowserFeedbackTraceSchema = z.object({
  identity: BrowserAgentIdentitySchema.nullable(),
  stage: z.enum([
    "received",
    "suppressed-by-daemon",
    "suppressed-focused",
    "payload-unavailable",
    "accepted",
    "failed",
  ]),
  detail: z.string().max(300),
});

export type BrowserFeedbackTrace = z.infer<typeof BrowserFeedbackTraceSchema>;

const pageEnvelope = {
  source: z.literal(BROWSER_FEEDBACK_SOURCE),
  version: z.literal(BROWSER_FEEDBACK_VERSION),
};

export const BrowserFeedbackMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...pageEnvelope, type: z.literal("hello") }).strict(),
  z
    .object({ ...pageEnvelope, type: z.literal("state"), state: BrowserFeedbackStateSchema })
    .strict(),
  z
    .object({
      ...pageEnvelope,
      type: z.literal("notify"),
      requestId: z.string().min(1).max(100),
      notification: BrowserFeedbackNotificationSchema,
    })
    .strict(),
  z
    .object({ ...pageEnvelope, type: z.literal("trace"), trace: BrowserFeedbackTraceSchema })
    .strict(),
]);

export type BrowserFeedbackMessage = z.infer<typeof BrowserFeedbackMessageSchema>;

const companionEnvelope = {
  source: z.literal(BROWSER_COMPANION_SOURCE),
  version: z.literal(BROWSER_FEEDBACK_VERSION),
};

export const BrowserCompanionMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...companionEnvelope, type: z.literal("ready") }).strict(),
  z
    .object({
      ...companionEnvelope,
      type: z.literal("delivery"),
      requestId: z.string().min(1).max(100),
      status: z.enum(["accepted", "suppressed", "duplicate", "failed"]),
      error: z.string().max(300).nullable(),
    })
    .strict(),
]);

export type BrowserCompanionMessage = z.infer<typeof BrowserCompanionMessageSchema>;
export type BrowserCompanionDelivery = Extract<BrowserCompanionMessage, { type: "delivery" }>;

// The companion is confined to the installed app and the isolated validation origin.
export const BROWSER_FEEDBACK_ORIGINS = ["http://127.0.0.1:6767", "http://127.0.0.1:6769"] as const;

export function isBrowserFeedbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    url.username === "" &&
    url.password === "" &&
    BROWSER_FEEDBACK_ORIGINS.some((origin) => origin === url.origin)
  );
}

export function browserAgentKey(identity: BrowserAgentIdentity): string {
  return JSON.stringify([identity.serverId, identity.agentId]);
}

export function browserNotificationTarget(origin: string, identity: BrowserAgentIdentity): string {
  if (!BROWSER_FEEDBACK_ORIGINS.some((allowed) => origin === allowed)) {
    throw new TypeError("Unsupported Paseo origin");
  }
  const host = encodeURIComponent(identity.serverId);
  if (identity.workspaceId === null) {
    return `${origin}/h/${host}/agent/${encodeURIComponent(identity.agentId)}`;
  }
  const url = new URL(`/h/${host}/workspace/${encodeURIComponent(identity.workspaceId)}`, origin);
  url.searchParams.set("open", `agent:${identity.agentId}`);
  return url.href;
}
