import type { CustomerAgentSayDropReason } from "@royal-home/shared";
import { prisma } from "../db.js";
import { guardFired } from "../ai/guardMetrics.js";
import type { CustomerCoreSay } from "../ai/customerAgentCore.js";
import { dushanbeDateString } from "./dushanbeTime.js";
import { logSystemError } from "./systemError.js";

/**
 * Counters and the owner-facing daily line for the grounded free-phrase channel (`say`, plan 24.10.2026, section 5).
 *
 * Every verdict is one `GuardHit` increment (`say_used`, `say_dropped_<reason>`), so the numbers appear on the «Обучение бота» screen with
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

export interface CustomerAgentSayDay { total: number; dropped: number; share: number; reasons: Array<{ reason: string; count: number }>; alert: boolean }
/** Pure: GuardHit rows of one day to the verdict. A phrase that was valid but held back by the shadow mode is not "dropped". */
export function summarizeCustomerAgentSayDay(rows: readonly { guard: string; count: number }[]): CustomerAgentSayDay {
  let total = 0, dropped = 0, serious = 0;
  const reasons: Array<{ reason: string; count: number }> = [];
  for (const row of rows) {
    if (row.count <= 0) continue;
    if (row.guard === "say_used") { total += row.count; continue; }
    if (!row.guard.startsWith(REASON_PREFIX)) continue;
    const reason = row.guard.slice(REASON_PREFIX.length);
    total += row.count;
    if (reason === "shadow") continue;
    dropped += row.count; reasons.push({ reason, count: row.count });
    if ((SERIOUS as readonly string[]).includes(reason)) serious += row.count;
  }
  reasons.sort((a, b) => b.count - a.count);
  const share = total ? dropped / total : 0;
  return { total, dropped, share, reasons, alert: serious > 0 || total >= MIN_SAMPLE && share > DROP_SHARE_ALERT };
}

/** Once a day at most (the dedup key is the day): the log line the owner reads, not a page. */
export async function reportCustomerAgentSayDay(now: Date = new Date()): Promise<CustomerAgentSayDay> {
  const day = dushanbeDateString(now);
  const rows = await prisma.guardHit.findMany({ where: { day, guard: { startsWith: "say_" } }, select: { guard: true, count: true }, take: 50 });
  const summary = summarizeCustomerAgentSayDay(rows);
  if (summary.alert) {
    await logSystemError("ai", `Бот: живая фраза отброшена в ${Math.round(summary.share * 100)}% ответов (${summary.dropped} из ${summary.total}), причины: ${
      summary.reasons.map(item => `${item.reason} ${item.count}`).join(", ") || "нет"}`, { dedupKey: `customer-agent-say:${day}` });
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
