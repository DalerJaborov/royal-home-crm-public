import type { CustomerAgentSayDropReason, CustomerAgentAnswerDropReason } from "@royal-home/shared";
import { prisma } from "../db.js";
import { guardFired } from "../ai/guardMetrics.js";
import type { CustomerCoreSay, CustomerCoreAnswer } from "../ai/customerAgentCore.js";
import { dushanbeDateString } from "./dushanbeTime.js";
import { logSystemError } from "./systemError.js";

/**
 * Counters and the owner-facing daily line for the grounded free-phrase channel (`say`, plan 24.10.2026, section 5).
 *
 * Every verdict is one `GuardHit` increment (`say_used`, `say_dropped_<reason>`), so the numbers appear in Settings → «Бот» → «Проверка бота» (lib/botGuardStats.ts) with
 * no new table. `shadow` is a VALID phrase that the mode did not send: for the drop rate it counts as accepted, since the question the
 * shadow week answers is "how often would the validator have let the phrase through".
 */
const REASON_PREFIX = "say_dropped_";
/** Reasons that mean the model tried to hand the customer something it must never invent; one is enough to tell the owner. */
const SERIOUS: readonly CustomerAgentSayDropReason[] = ["promise", "contact"];
/** The share of dropped phrases that is worth a line to the owner, and the sample below which a share means nothing. */
const DROP_SHARE_ALERT = 0.2;
const MIN_SAMPLE = 5;
const CHECK_EVERY_MS = 10 * 60_000;
let lastCheckAt = 0;

/**
 * Reasons that mean "switched off on purpose" (Tajik in v1, non-private surfaces), not "the model got it wrong". They stay out of the drop share and the
 * alert: on 13.11.2026 the line read «отброшена в 83% ответов» while 38 of the 58 drops were the Tajik phrase that v1 drops by design.
 */
const INTENTIONAL: readonly CustomerAgentSayDropReason[] = ["language_disabled", "surface_disabled"];

export interface CustomerAgentSayDay { total: number; dropped: number; share: number; reasons: Array<{ reason: string; count: number }>; alert: boolean;
  /** Phrases dropped because the language or surface is off by design; shown beside the share, never part of it. */
  intentional: number }
/** Pure: GuardHit rows of one day to the verdict. A phrase that was valid but held back by the shadow mode is not "dropped"; one switched off by design is not counted at all. */
export function summarizeCustomerAgentSayDay(rows: readonly { guard: string; count: number }[]): CustomerAgentSayDay {
  let total = 0, dropped = 0, serious = 0, intentional = 0;
  const reasons: Array<{ reason: string; count: number }> = [];
  for (const row of rows) {
    if (row.count <= 0) continue;
    if (row.guard === "say_used") { total += row.count; continue; }
    if (!row.guard.startsWith(REASON_PREFIX)) continue;
    const reason = row.guard.slice(REASON_PREFIX.length);
    if ((INTENTIONAL as readonly string[]).includes(reason)) { intentional += row.count; continue; }
    total += row.count;
    if (reason === "shadow") continue;
    dropped += row.count; reasons.push({ reason, count: row.count });
    if ((SERIOUS as readonly string[]).includes(reason)) serious += row.count;
  }
  reasons.sort((a, b) => b.count - a.count);
  const share = total ? dropped / total : 0;
  return { total, dropped, share, reasons, intentional, alert: serious > 0 || total >= MIN_SAMPLE && share > DROP_SHARE_ALERT };
}

/**
 * Once a day at most: the log line the owner reads, not a page.
 *
 * The day in the key alone did NOT make it daily (prod log 13–16.11.2026: 47 rows in four days, 19 on 13.11): `logSystemError` only
 * looks back over its default 10-minute window, and `recordCustomerAgentSay` re-checks every 10 minutes, so each check wrote a new row.
 * The window is now the whole day. `silent`: a quality metric is read in the morning report, it must not wake the director with a
 * «new problem» push every day (the key is new each day, so it would).
 */
const SAY_REPORT_WINDOW_MS = 24 * 60 * 60_000;
export async function reportCustomerAgentSayDay(now: Date = new Date()): Promise<CustomerAgentSayDay> {
  const day = dushanbeDateString(now);
  const rows = await prisma.guardHit.findMany({ where: { day, guard: { startsWith: "say_" } }, select: { guard: true, count: true }, take: 50 });
  const summary = summarizeCustomerAgentSayDay(rows);
  if (summary.alert) {
    await logSystemError("ai", `Бот: живая фраза отброшена в ${Math.round(summary.share * 100)}% ответов (${summary.dropped} из ${summary.total}), причины: ${
      summary.reasons.map(item => `${item.reason} ${item.count}`).join(", ") || "нет"}${
      summary.intentional ? `. Не в счёт, выключено намеренно (таджикский и не личные сообщения): ${summary.intentional}` : ""}`, { dedupKey: `customer-agent-say:${day}`, dedupWindowMs: SAY_REPORT_WINDOW_MS, silent: true });
  }
  return summary;
}

/** Fire-and-forget by contract: a counter must never slow or fail the customer's reply. */
export function recordCustomerAgentSay(say: CustomerCoreSay | undefined, now: number = Date.now()): void {
  if (!say || say.status === "absent") return;
  guardFired(say.status === "used" ? "say_used" : `say_dropped_${say.reason}`);
  if (now - lastCheckAt < CHECK_EVERY_MS) return;
  lastCheckAt = now;
  void reportCustomerAgentSayDay(new Date(now)).catch(error => console.error("[say] daily check failed:", error instanceof Error ? error.message : error));
}
/** Test hook: the throttle is process state. */
export function resetCustomerAgentSayThrottle(): void { lastCheckAt = 0; }

// ── the model's words around the facts (`answer`, one-brain step 1; review #211, п.7) ─────────────────────────────────────
const ANSWER_PREFIX = "answer_dropped_";
/** Switched off or not applicable by design: never part of the share (owner rule after the «83%» line of 13.11.2026). */
const ANSWER_INTENTIONAL: readonly CustomerAgentAnswerDropReason[] = ["language_disabled", "surface_disabled", "not_eligible", "template_payload"];
/**
 * The model tried to write a fact, a promise, a contact or «ты», or the verifier broke. These are exactly the replies that must never
 * count as «годный» before the owner's «да» on live: they are dropped (never `shadow`), and one of them is enough for the day line.
 */
const ANSWER_FACT_ATTEMPTS: readonly CustomerAgentAnswerDropReason[] = ["claim", "number", "currency", "place", "promise", "phone_ask", "missing_fact"];
const ANSWER_SERIOUS: readonly CustomerAgentAnswerDropReason[] = [...ANSWER_FACT_ATTEMPTS, "rude", "error"];
let answerLastCheckAt = 0;

export interface CustomerAgentAnswerDay {
  /** Verdicts that count: everything but the intentional ones. */ total: number;
  /** Would have gone out (`answer_used` + `answer_dropped_shadow`). */ good: number;
  dropped: number; share: number;
  /** The model wrote a fact itself (inverted commission, «да, в Худжанде», «свободен», a price): dropped, never counted as good. */
  factAttempts: number;
  reasons: Array<{ reason: string; count: number }>; intentional: number; alert: boolean;
}
/** Pure: GuardHit rows of one day to the verdict the owner reads before switching live on. */
export function summarizeCustomerAgentAnswerDay(rows: readonly { guard: string; count: number }[]): CustomerAgentAnswerDay {
  let total = 0, good = 0, dropped = 0, serious = 0, intentional = 0, factAttempts = 0;
  const reasons: Array<{ reason: string; count: number }> = [];
  for (const row of rows) {
    if (row.count <= 0) continue;
    if (row.guard === "answer_used") { total += row.count; good += row.count; continue; }
    if (!row.guard.startsWith(ANSWER_PREFIX)) continue;
    const reason = row.guard.slice(ANSWER_PREFIX.length) as CustomerAgentAnswerDropReason;
    if (ANSWER_INTENTIONAL.includes(reason)) { intentional += row.count; continue; }
    total += row.count;
    if (reason === "shadow") { good += row.count; continue; }
    dropped += row.count; reasons.push({ reason, count: row.count });
    if (ANSWER_FACT_ATTEMPTS.includes(reason)) factAttempts += row.count;
    if (ANSWER_SERIOUS.includes(reason)) serious += row.count;
  }
  reasons.sort((a, b) => b.count - a.count);
  const share = total ? dropped / total : 0;
  return { total, good, dropped, share, factAttempts, reasons, intentional, alert: serious > 0 || total >= MIN_SAMPLE && share > DROP_SHARE_ALERT };
}

/** Once a day at most (the dedup key is the day): one log line for the owner, never a page. */
export async function reportCustomerAgentAnswerDay(now: Date = new Date()): Promise<CustomerAgentAnswerDay> {
  const day = dushanbeDateString(now);
  const rows = await prisma.guardHit.findMany({ where: { day, guard: { startsWith: "answer_" } }, select: { guard: true, count: true }, take: 50 });
  const summary = summarizeCustomerAgentAnswerDay(rows);
  if (summary.alert) {
    await logSystemError("ai", `Бот: слова модели вокруг фактов годны в ${summary.good} из ${summary.total} ответов, отброшены ${summary.dropped} (${
      Math.round(summary.share * 100)}%); модель сама писала факт: ${summary.factAttempts}. Причины: ${
      summary.reasons.map(item => `${item.reason} ${item.count}`).join(", ") || "нет"}${
      summary.intentional ? `. Не в счёт (особые случаи и выключенное): ${summary.intentional}` : ""}`, { dedupKey: `customer-agent-answer:${day}` });
  }
  return summary;
}

/**
 * Counters of the model's words (`answer_used`, `answer_dropped_<reason>`) in Settings → «Бот» → «Проверка бота», plus the day line above.
 * Fire-and-forget by contract: a counter must never slow or fail the customer's reply.
 */
export function recordCustomerAgentAnswer(answer: CustomerCoreAnswer | undefined, now: number = Date.now()): void {
  if (!answer || answer.status === "absent") return;
  guardFired(answer.status === "used" ? "answer_used" : `answer_dropped_${answer.reason}`);
  if (now - answerLastCheckAt < CHECK_EVERY_MS) return;
  answerLastCheckAt = now;
  void reportCustomerAgentAnswerDay(new Date(now)).catch(error => console.error("[answer] daily check failed:", error instanceof Error ? error.message : error));
}
/** Test hook: the throttle is process state. */
export function resetCustomerAgentAnswerThrottle(): void { answerLastCheckAt = 0; }
