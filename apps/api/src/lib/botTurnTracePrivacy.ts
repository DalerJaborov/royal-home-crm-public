import { createHmac } from "node:crypto";
import type { BotTurnTracePayload } from "@royal-home/shared";

type Redaction = BotTurnTracePayload["redactedKinds"][number];
export function tracePseudonym(secret: string, domain: "event" | "conversation" | "account" | "mid" | "property" | "operation", channel: string, account: string | null, value: string | null | undefined): string | null {
  if (!value) return null;
  return createHmac("sha256", secret).update(JSON.stringify(["bot-trace-v1", domain, channel, account, value])).digest("hex");
}

/** Opt-in diagnostic text is still residual PII. Default callers omit text entirely. */
export function sanitizeTraceText(raw: string, knownContacts: readonly string[] = [], knownSecrets: readonly string[] = []): { text: string; redactedKinds: Redaction[]; omitted: number } {
  const kinds = new Set<Redaction>();
  const replace = (pattern: RegExp, label: Redaction, replacement: string) => {
    text = text.replace(pattern, () => { kinds.add(label); return replacement; });
  };
  // Bound work before regexes. Never retain the original in a store queue.
  const limited = raw.slice(0, 8000);
  // Preserve units such as m²; compatibility normalization would alter evidence.
  let text = limited.normalize("NFC").replace(/[０-９٠-٩۰-۹]/g, (c) => String(c.charCodeAt(0) - (c >= "０" ? 0xff10 : c <= "٩" ? 0x660 : 0x6f0)));
  for (const secret of knownSecrets.slice(0, 10)) {
    if (secret.length < 8 || secret.length > 1000) continue;
    replace(new RegExp(secret.normalize("NFC").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "credential", "[CREDENTIAL]");
  }
  replace(/\b(?:Bearer|Basic)\s+[^\s,;]+|\b(?:token|password|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+|\b(?:AIza[\w-]{20,}|sk-[\w-]{12,}|EAA[\w-]{30,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/gi, "credential", "[CREDENTIAL]");
  replace(/https?:\/\/[^\s<>]+|\b(?:t\.me|wa\.me)\/[^\s<>]+/gi, "url", "[URL]");
  replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "email", "[EMAIL]");
  replace(/@[\p{L}\p{N}_.-]+/gu, "handle", "[HANDLE]");
  // Nine or more digits are phone-like, including international/separated forms.
  replace(/(?<!\d)\+?\d(?:[\s().\-–—]*\d){8,17}(?!\d)/g, "phone", "[PHONE]");
  for (const name of knownContacts.slice(0, 12)) {
    if (name.length < 2 || name.length > 100) continue;
    replace(new RegExp(name.normalize("NFC").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), "known_contact", "[CONTACT]");
  }
  const omitted = Math.max(0, raw.length - limited.length) + Math.max(0, text.length - 2000);
  if (omitted) kinds.add("truncated");
  return { text: text.slice(0, 2000), redactedKinds: [...kinds], omitted };
}

export function projectTraceModel(raw: unknown, projectText: (text: string) => { present: boolean; chars: number; text?: string }) {
  const node = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const reply = node?.reply;
  const value = typeof reply === "string" ? reply : Array.isArray(reply) ? reply.slice(0, 4).filter((v): v is string => typeof v === "string").join("\n") : "";
  const booleanType = (v: unknown): "boolean" | "missing" | "other" => typeof v === "boolean" ? "boolean" : v === undefined ? "missing" : "other";
  return {
    object: !!node, reply: projectText(value),
    replyType: (typeof reply === "string" ? "string" : Array.isArray(reply) ? "array" : reply === undefined ? "missing" : "other") as "string" | "array" | "missing" | "other",
    readyType: booleanType(node?.ready), confidentType: booleanType(node?.confident),
    leadPresent: node?.lead !== undefined, jobPresent: node?.jobApplication !== undefined,
    showingPresent: node?.showing !== undefined, topicPresent: node?.topic !== undefined,
  };
}

export function boundedTracePayload(payload: BotTurnTracePayload): BotTurnTracePayload {
  // Input is already strictly projected/redacted. Removing bounded collections
  // keeps valid JSON; slicing serialized JSON would leak or corrupt the record.
  const copy: BotTurnTracePayload = structuredClone(payload);
  while (Buffer.byteLength(JSON.stringify(copy), "utf8") > 32 * 1024) {
    const item = copy.filterDeltas.pop();
    if (item) { copy.omittedCounts.filterDeltas++; copy.truncated = true; continue; }
    const attempt = copy.modelAttempts.pop();
    if (attempt) { copy.omittedCounts.modelAttempts++; copy.truncated = true; continue; }
    const outgoing = copy.outgoing.pop();
    if (outgoing) { copy.omittedCounts.outgoing++; copy.truncated = true; continue; }
    throw new Error("trace_projection_limit");
  }
  return copy;
}
