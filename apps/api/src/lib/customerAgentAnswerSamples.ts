/**
 * THE MODEL'S WORDS BESIDE THE TEMPLATE, FOR 72 HOURS (one brain, 17.11.2026).
 *
 * The trace keeps only the verdict of the model's words (used / dropped + reason), never the text. Before switching live
 * answers on, the owner reads real pairs «customer → template that went out → what the model would have said». This table
 * holds them, nothing else does:
 *  - phones (lib/clientPhone.ts maskPhonesInFreeText) and links are masked before the row is written;
 *  - a row lives 72 hours; expired rows are removed on write (at most once a minute) — no cron needed;
 *  - every text is cut to SAMPLE_TEXT_MAX chars; at most SAMPLE_DAILY_CAP rows per Dushanbe day;
 *  - no API route: the director reads it with `npx tsx scripts/export-answer-samples.ts` (read only);
 *  - on by default in shadow AND live; `CUSTOMER_AGENT_ANSWER_SAMPLES=off` stops the writes;
 *  - detached from the turn: the caller never awaits it, every failure goes to the error journal and the turn goes on.
 */
import { prisma } from "../db.js";
import { maskPhonesInFreeText } from "./clientPhone.js";
import { logSystemError } from "./systemError.js";
import { dushanbeDateString } from "./dushanbeTime.js";

export const SAMPLE_TTL_MS = 72 * 60 * 60 * 1000;
export const SAMPLE_TEXT_MAX = 1500;
export const SAMPLE_DAILY_CAP = 500;
const PURGE_EVERY_MS = 60_000;
let lastPurgeAt = 0;

export interface CustomerAgentAnswerSampleInput {
  channel: string;
  conversationId?: string | null;
  eventKey?: string | null;
  answerMode: "off" | "shadow" | "live";
  status: "used" | "dropped";
  reason?: string | null;
  customerText: string;
  modelText: string;
  templateText: string;
}

/** Off only when the server says so; the default (empty) writes. */
export function customerAgentAnswerSamplesEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return (env.CUSTOMER_AGENT_ANSWER_SAMPLES ?? "").trim().toLowerCase() !== "off";
}

const LINK_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|ru|tj|me|net|org|io|app|link|ly|gl|be|to)\/\S*/giu;

/** Pure: what may be stored. Phones and links masked, length bounded. */
export function sampleSafeText(text: string): string {
  const masked = maskPhonesInFreeText(text.replace(LINK_RE, "[ссылка]"));
  return masked.length > SAMPLE_TEXT_MAX ? `${masked.slice(0, SAMPLE_TEXT_MAX - 1)}…` : masked;
}

/** Start of the current Dushanbe day (UTC+5) as a Date: the daily cap counts from here. */
function dushanbeDayStart(now: Date): Date {
  return new Date(`${dushanbeDateString(now)}T00:00:00+05:00`);
}

/**
 * Writes one pair. Never throws and never blocks the caller beyond its own promise: call it with `void`.
 * Returns what happened (for tests): `written`, `off`, `capped` or `failed`.
 */
export async function recordCustomerAgentAnswerSample(input: CustomerAgentAnswerSampleInput, now: Date = new Date(),
  env: Readonly<Record<string, string | undefined>> = process.env): Promise<"written" | "off" | "capped" | "failed"> {
  if (!customerAgentAnswerSamplesEnabled(env)) return "off";
  try {
    if (now.getTime() - lastPurgeAt >= PURGE_EVERY_MS) {
      lastPurgeAt = now.getTime();
      await prisma.customerAgentAnswerSample.deleteMany({ where: { expiresAt: { lt: now } } });
    }
    const today = await prisma.customerAgentAnswerSample.count({ where: { createdAt: { gte: dushanbeDayStart(now) } } });
    if (today >= SAMPLE_DAILY_CAP) return "capped";
    await prisma.customerAgentAnswerSample.create({ data: {
      createdAt: now, expiresAt: new Date(now.getTime() + SAMPLE_TTL_MS),
      channel: input.channel.slice(0, 32), conversationId: input.conversationId ?? null, eventKey: input.eventKey ?? null,
      answerMode: input.answerMode, status: input.status, reason: input.reason ? input.reason.slice(0, 64) : null,
      customerText: sampleSafeText(input.customerText), modelText: sampleSafeText(input.modelText), templateText: sampleSafeText(input.templateText),
    } });
    return "written";
  } catch (error) {
    await logSystemError("ai", `Пример слов бота для проверки не записан: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      { dedupKey: "customer-agent-answer-sample-write" }).catch(() => {});
    return "failed";
  }
}

/** Test hook: the purge throttle is per process. */
export function resetCustomerAgentAnswerSamplePurge(): void { lastPurgeAt = 0; }
