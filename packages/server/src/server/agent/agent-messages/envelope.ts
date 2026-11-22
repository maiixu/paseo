import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

const agentIdSchema = z.string().min(1);
const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("change-request-update"),
    url: z.url({ protocol: /^https?$/ }),
  }),
  z.object({
    kind: z.literal("agent-message"),
    agentId: agentIdSchema,
    serverId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("agent-notification"),
    agentId: agentIdSchema,
    serverId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    event: z.enum(["finished", "errored", "permission-required", "closed"]),
  }),
]);
export type AgentPromptSource = z.infer<typeof sourceSchema>;

import type { SenderClientInfo } from "../runtime-context.js";

interface AgentMessage {
  id: string;
  source: AgentPromptSource | null;
  text: string;
  sender?: SenderClientInfo;
}

/**
 * Providers read a command from the raw start of the prompt: a slash and a name with no
 * second slash in it. A path such as `/tmp/build.log` is plain text.
 */
export function isSlashCommandPrompt(prompt: AgentPromptInput): boolean {
  const first = typeof prompt === "string" ? prompt : prompt[0];
  if (typeof first !== "string" && first?.type !== "text") return false;
  const text = typeof first === "string" ? first : first.text;
  return /^\/[^\s/]+(\s|$)/.test(text.trim());
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function unescapeXml(value: string): string | null {
  if (/[<>]|&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) return null;
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      default:
        return "'";
    }
  });
}

export function formatAgentMessage(message: AgentMessage): string {
  const { source } = message;
  if (source?.kind === "change-request-update") {
    return `<paseo-system version="1" kind="change-request-update" source-url="${escapeXml(source.url)}" message-id="${escapeXml(message.id)}">\n${escapeXml(message.text)}\n</paseo-system>`;
  }
  const attributes = source
    ? `kind="${source.kind}" source-agent-id="${escapeXml(source.agentId)}"`
    : 'kind="user-message"';
  const server = source?.serverId ? ` source-server-id="${escapeXml(source.serverId)}"` : "";
  const title = source?.title ? ` source-agent-title="${escapeXml(source.title)}"` : "";
  const event = source?.kind === "agent-notification" ? ` event="${source.event}"` : "";
  const senderDevice =
    !source && message.sender?.device ? ` sender-device="${escapeXml(message.sender.device)}"` : "";
  const senderLocality =
    !source && message.sender?.locality
      ? ` sender-locality="${escapeXml(message.sender.locality)}"`
      : "";
  return `<paseo-system version="1" ${attributes} message-id="${escapeXml(message.id)}"${server}${title}${event}${senderDevice}${senderLocality}>\n${escapeXml(message.text)}\n</paseo-system>`;
}

export function parseAgentMessage(text: string): AgentMessage | null {
  const envelope = /^<paseo-system((?:\s+[a-z-]+="[^"<>]*")+)>\n([\s\S]*)\n<\/paseo-system>$/.exec(
    text,
  );
  if (!envelope) return null;
  const attributes = new Map<string, string>();
  for (const match of envelope[1].matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)) {
    const value = unescapeXml(match[2]);
    if (value === null || attributes.has(match[1])) return null;
    attributes.set(match[1], value);
  }
  if (attributes.get("version") !== "1") return null;
  const id = attributes.get("message-id");
  const body = unescapeXml(envelope[2]);
  if (!id || body === null) return null;
  if (attributes.get("kind") === "user-message") {
    if (attributes.has("source-agent-id") || attributes.has("event")) return null;
    const senderDevice = attributes.get("sender-device");
    const senderLocality = attributes.get("sender-locality");
    const sender: SenderClientInfo | undefined =
      senderDevice && (senderLocality === "local" || senderLocality === "remote")
        ? { device: senderDevice, locality: senderLocality }
        : undefined;
    return { id, source: null, text: body, ...(sender ? { sender } : {}) };
  }
  const source = sourceSchema.safeParse({
    kind: attributes.get("kind"),
    agentId: attributes.get("source-agent-id"),
    serverId: attributes.get("source-server-id"),
    event: attributes.get("event"),
    title: attributes.get("source-agent-title"),
    url: attributes.get("source-url"),
  });
  if (!source.success) return null;
  return { id, source: source.data, text: body };
}

/** Accept only a complete sequence of envelopes; prose around them stays user text. */
export function parseAgentMessages(text: string): AgentMessage[] | null {
  // Bodies are XML escaped, so a literal closing tag unambiguously ends an entry.
  const parts = text.split(/(?<=<\/paseo-system>)\n+(?=<paseo-system )/);
  const messages = parts.map(parseAgentMessage);
  return messages.every((message) => message !== null) ? messages : null;
}

function renderMessageText(block: AgentPromptContentBlock): string[] {
  if (block.type === "image") return [];
  if (block.type === "text") return [block.text];
  return [renderPromptAttachmentAsText(block)];
}

export function prepareAgentMessage(
  prompt: AgentPromptInput,
  source?: AgentPromptSource,
  id?: string,
  sender?: SenderClientInfo,
): { prompt: AgentPromptInput; messageId?: string } {
  if (!source) {
    const submittedText =
      typeof prompt === "string"
        ? prompt
        : prompt
            .flatMap((block) =>
              block.type === "text" && !("mimeType" in block) ? [block.text] : [],
            )
            .join("\n")
            .trim();
    const needsQuoting = Boolean(
      parseAgentMessages(submittedText) || isSystemInjectedEnvelope(submittedText),
    );
    // Quote reserved envelopes only when they arrived through the human send path.
    // Never wrap provider slash commands — providers detect them from the raw start of the prompt.
    if (!needsQuoting && (!sender || isSlashCommandPrompt(prompt))) {
      return { prompt, messageId: id };
    }
    return envelopeMessage(prompt, null, id, sender);
  }
  return envelopeMessage(prompt, source, id);
}

/**
 * Wrap a prompt in its envelope unconditionally. A person's prompt (`source` null) needs one
 * when it is quoted, carries sender device metadata, or shares a provider prompt with agent messages.
 */
export function envelopeMessage(
  prompt: AgentPromptInput,
  source: AgentPromptSource | null,
  id?: string,
  sender?: SenderClientInfo,
): { prompt: AgentPromptInput; messageId: string } {
  const messageId = id ?? randomUUID();
  const text = typeof prompt === "string" ? prompt : prompt.flatMap(renderMessageText).join("\n\n");
  // Render textual attachments before wrapping, so provider replay still contains one
  // complete envelope instead of an envelope followed by provider-rendered context.
  const envelope = formatAgentMessage({
    id: messageId,
    source,
    text,
    ...(source === null && sender ? { sender } : {}),
  });
  return {
    messageId,
    prompt:
      typeof prompt === "string"
        ? envelope
        : [{ type: "text", text: envelope }, ...prompt.filter((block) => block.type === "image")],
  };
}

/** The same projection owns provider echoes, acceptance, import, and replay. */
export function projectAgentMessages(item: AgentTimelineItem): AgentTimelineItem[] {
  if (item.type === "user_message") {
    const messages = parseAgentMessages(item.text);
    if (messages) {
      return messages.flatMap((message) => {
        const projected = projectAgentMessage({ ...item, text: formatAgentMessage(message) });
        return projected ? [projected] : [];
      });
    }
  }
  const projected = projectAgentMessage(item);
  return projected ? [projected] : [];
}

function projectAgentMessage(item: AgentTimelineItem): AgentTimelineItem | null {
  if (item.type !== "user_message") return item;
  const message = parseAgentMessage(item.text);
  if (!message) {
    if (!isSystemInjectedEnvelope(item.text)) return item;
    // Schedule bodies include the run ID, keeping identity stable across replay.
    const text = item.text.slice("<paseo-system>\n".length, -"\n</paseo-system>".length);
    return {
      type: "tool_call",
      callId: `paseo-system:${createHash("sha256").update(item.text).digest("hex")}`,
      name: "heartbeat",
      status: "completed",
      error: null,
      detail: { type: "plain_text", text, icon: "sparkles" },
    };
  }
  const { source } = message;
  if (!source) {
    return { ...item, text: message.text, clientMessageId: message.id };
  }
  if (source.kind === "change-request-update") {
    return {
      type: "tool_call",
      callId: `paseo-change-request:${message.id}`,
      name: "change_request_update",
      status: "completed",
      error: null,
      detail: { type: "plain_text", text: message.text },
    };
  }
  return {
    type: "tool_call",
    callId: `paseo-agent-message:${message.id}`,
    agentMessage: {
      event: source.kind === "agent-message" ? "message" : source.event,
      sender: {
        id: source.agentId,
        ...(source.serverId ? { serverId: source.serverId } : {}),
        ...(source.title ? { title: source.title } : {}),
      },
      text: message.text,
    },
    // COMPAT(agentMessageToolEnvelope): added in v0.11.1; remove after 2027-04-08
    // once clients can accept a dedicated timeline variant. Older clients still
    // parse this existing shape and can expand the delivered body.
    name: "agent_message",
    status: "completed",
    error: null,
    detail: { type: "plain_text", text: message.text, icon: "bot" },
  };
}

/**
 * Wrap a body in <paseo-system>…</paseo-system> so the receiving agent
 * recognizes the prompt as system-injected context — not a user turn.
 * Used by schedule fires; agent messages use the versioned envelope.
 */
export function formatSystemNotificationPrompt(reason: string): string {
  return `<paseo-system>\n${reason}\n</paseo-system>`;
}

const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

export function isSystemInjectedEnvelope(text: string): boolean {
  return SYSTEM_ENVELOPE_PATTERN.test(text);
}
