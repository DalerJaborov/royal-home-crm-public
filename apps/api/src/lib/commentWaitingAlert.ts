// КОММЕНТАРИЙ, НА КОТОРЫЙ БОТ НЕ ОТВЕТИЛ, ДОХОДИТ ДО ЧЕЛОВЕКА (15.11.2026).
//
// ЗАЧЕМ. Старый путь комментариев (messengers/comments.ts::escalate) зовёт
// человека пушем, когда бот «не знает» или сдался после попыток. Новое ядро
// (lib/customerPublicAgentTurn.ts, customerPublicAgentFailure.ts) ставит
// комментарию ESCALATED или FAILED и больше НИЧЕГО: «never a send, retry, staff
// handover». ФАКТ (прод, 7 дней до 15.11): 1 FAILED (`unsupported_decision_evidence`,
// 14.11) и 2 ESCALATED (модерация) — ни одного уведомления по комментариям.
// Значок в меню их считает, но пуша нет, и человек под постом ждёт впустую.
//
// ОДНА ДВЕРЬ на «комментарий ждёт человека»: сторож раз в 10 минут находит
// свежие ESCALATED/FAILED без уведомления и шлёт его тем же тегом, что и старый
// путь (`ig-comment-<commentId>`): если старый путь уже позвал человека, второго
// пуша нет. Будущий путь, который тоже забудет позвать, ловится здесь же.
//
// ВТОРАЯ ВОЛНА (15.11.2026, В2 владельца). Технические финалы (ИИ недоступен после
// повторов, технические отказы ядра) и комментарии, застрявшие в очереди дольше
// 30 минут, тоже уходят человеку — той же сводкой за тик. Удалённые и спам — нет.
// Рубильник Settings.commentFailureWatchEnabled (по умолчанию включён).
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { findAgentsWithPermission } from "./recipients.js";
import { logSystemError } from "./systemError.js";
import { loadBotCapabilities } from "../messengers/botCapabilities.js";

/** Старый путь шлёт пуш сам сразу — даём ему время, чтобы не продублировать. */
const MIN_AGE_MS = 3 * 60_000;
const LOOKBACK_MS = 24 * 60 * 60_000;
/** Застрявшие старше двух суток — дело ленты комментариев, а не пуша (отметка живёт 3 дня). */
const STUCK_LOOKBACK_MS = 48 * 60 * 60_000;
const SWEEP_LIMIT = 50;
const CLAIM_CHANNEL = "comment-needs-human";
const PLACE: Record<string, string> = { INSTAGRAM: "Instagram", FACEBOOK: "Facebook", YOUTUBE: "YouTube", TELEGRAM: "Telegram" };

export function commentTag(commentId: string): string {
  return `ig-comment-${commentId}`;
}

/**
 * Нужен ли человек (15.11.2026, ответ владельца В2: «комментарии, на которые ИИ
 * технически не смог ответить, теперь тоже уходят человеку» — это ОТМЕНЯЕТ решение
 * 30.08.2026 «отключи, что у ИИ типа нет ответа»). Три исхода:
 *  - "no": комментарий удалён (`gone` — отвечать физически некуда), спам, или ответ
 *    уже дал сотрудник (`manual_reply*`);
 *  - "technical": бот не ответил по технической причине — ИИ недоступен после
 *    повторов (`ai_down`), технический отказ ядра (`expired`, `turn_unavailable`,
 *    `turn_deadline`, `public_core_unavailable`…), застрял в очереди. Зовём, если
 *    включён рубильник Settings.commentFailureWatchEnabled;
 *  - "human": бот сам передал вопрос человеку (ESCALATED), сдался после попыток
 *    (`no_answer`), отказ ядра по смыслу ответа и любой НЕЗНАКОМЫЙ код FAILED —
 *    новый способ не ответить по умолчанию зовёт человека, а не молчит.
 */
export type CommentNeed = "no" | "technical" | "human";
const TECHNICAL_CORE_FAILURES = new Set(["public_core_unavailable", "turn_unavailable", "turn_deadline", "expired",
  "invalid_model_turn", "mixed_model_protocol", "missing_model_parts", "duplicate_call_id", "invalid_model_call", "invalid_call_id",
  "call_id_reused", "invalid_model_decision", "duplicate_tool_definition", "round_limit", "tool_limit", "output_limit"]);
/** Застрял в очереди: ни ответа, ни финала дольше этого — бот уже не справился сам. */
export const COMMENT_STUCK_MS = 30 * 60_000;
export function commentNeed(status: string, note: string | null): CommentNeed {
  const n = note ?? "";
  if (/(^|[;\s])gone(?![a-z_])/.test(n)) return "no";
  if (status === "PENDING" || status === "WORKING" || status === "ERROR") return "technical";
  if (status === "ESCALATED") return "human";
  if (status !== "FAILED") return "no";
  if (/^spam\b/.test(n) || n.startsWith("manual_reply")) return "no";
  if (n === "ai_down") return "technical";
  const core = /^managed_core:failed:([a-z_]+)/.exec(n);
  if (core) return TECHNICAL_CORE_FAILURES.has(core[1]!) ? "technical" : "human";
  return "human";
}
/** «Звать ли» при включённом рубильнике технических отказов. */
export function commentNeedsHuman(status: string, note: string | null): boolean {
  return commentNeed(status, note) !== "no";
}

/** Рубильник «Комментарий со сбоем бота — человеку» (Settings.commentFailureWatchEnabled). */
export async function isCommentFailureWatchEnabled(): Promise<boolean> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { commentFailureWatchEnabled: true } });
  return s?.commentFailureWatchEnabled ?? true;
}

/** Причина простыми словами — без служебных кодов. */
export function plainCommentReason(status: string, note: string | null): string {
  if (note?.includes("moderation")) return "бот не уверен, скрывать ли комментарий — решите сами";
  if (status === "PENDING" || status === "WORKING" || status === "ERROR") return "бот не ответил за полчаса (сбой ИИ или очереди)";
  if (note === "ai_down") return "ИИ был недоступен, бот так и не ответил";
  if (status === "FAILED" && commentNeed(status, note) === "technical") return "у бота сорвался ответ по технической причине";
  if (status === "FAILED") return "бот не смог подготовить ответ";
  return "бот передал вопрос человеку";
}

export interface CommentSweepResult {
  checked: number;
  alerted: number;
}

/**
 * Тик крона. ОДНА сводка за тик, а не пуш на каждый комментарий (ревью 192-6:
 * волна спама на модерацию дала бы сотни пушей; правило владельца «редко
 * беспокоить»). Отметка ставится на каждый комментарий атомарно ДО отправки;
 * сводка не ушла — отметки снимаются, следующий тик попробует снова.
 */
export async function runCommentNeedsHumanSweep(now: Date = new Date()): Promise<CommentSweepResult> {
  const technicalOn = await isCommentFailureWatchEnabled();
  // Общий ползунок «Отвечать на комментарии» выключен — очередь стоит намеренно, это не сбой бота.
  const queueRuns = technicalOn && (await loadBotCapabilities()).comments;
  // Финалы (ESCALATED/FAILED) — по времени финала; застрявшие в очереди (PENDING/WORKING/ERROR) —
  // по времени появления комментария: дольше COMMENT_STUCK_MS без ответа — бот уже не справился.
  const rows = await prisma.$queryRaw<Array<{ commentId: string; channel: string; status: string; note: string | null; authorName: string | null; text: string }>>`
    SELECT c."commentId", c."channel", c."status", c."note", c."authorName", c."text"
    FROM "InstagramComment" c
    WHERE (
        (c."status" IN ('ESCALATED','FAILED')
          AND c."updatedAt" >= ${new Date(now.getTime() - LOOKBACK_MS)}
          AND c."updatedAt" <= ${new Date(now.getTime() - MIN_AGE_MS)})
        OR (${queueRuns}::boolean AND c."status" IN ('PENDING','WORKING','ERROR')
          AND c."createdAt" >= ${new Date(now.getTime() - STUCK_LOOKBACK_MS)}
          AND c."createdAt" <= ${new Date(now.getTime() - COMMENT_STUCK_MS)})
      )
      AND NOT EXISTS (SELECT 1 FROM "Notification" n WHERE n."tag" = 'ig-comment-' || c."commentId")
      AND NOT EXISTS (SELECT 1 FROM "ProcessedMessage" p WHERE p."channel" = ${CLAIM_CHANNEL} AND p."messageId" = c."commentId")
    ORDER BY c."updatedAt" ASC
    LIMIT ${SWEEP_LIMIT}`;
  if (!rows.length) return { checked: 0, alerted: 0 };
  const claim = (commentId: string) => prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt","completedAt")
    VALUES (${randomUUID()},${CLAIM_CHANNEL},${commentId},now(),now()) ON CONFLICT ("channel","messageId") DO NOTHING`;
  const due: typeof rows = [];
  for (const row of rows) {
    const need = commentNeed(row.status, row.note);
    // Рубильник выключен: технический отказ не отмечаем — включат, и сводка уйдёт (в пределах суток).
    if (need === "technical" && !technicalOn) continue;
    if (need === "no") {
      // Решено «человека не звать» — отмечаем, чтобы такие строки не занимали предел выборки каждый тик.
      await claim(row.commentId);
      continue;
    }
    due.push(row);
  }
  if (!due.length) return { checked: rows.length, alerted: 0 };
  const recipients = await findAgentsWithPermission("messages.view");
  if (!recipients.length) {
    // Отметки не ставим: появится получатель — сводка уйдёт.
    void logSystemError("meta", `Комментарии ждут человека (${due.length}), но в CRM нет никого с правом «Сообщения».`,
      { dedupKey: "comment-needs-human-no-recipients" });
    return { checked: rows.length, alerted: 0 };
  }
  const claimed: typeof due = [];
  for (const row of due) if ((await claim(row.commentId)) === 1) claimed.push(row);
  if (!claimed.length) return { checked: rows.length, alerted: 0 };
  try {
    const first = claimed[0]!;
    const author = first.authorName ? `@${first.authorName}` : "Подписчик";
    const places = [...new Set(claimed.map((r) => PLACE[r.channel] ?? r.channel))].join(", ");
    await sendPushToAgents(recipients, {
      kind: "message",
      title: claimed.length === 1
        ? `💬 ${places}: ответьте на комментарий вручную`
        : `💬 ${places}: ${claimed.length} комментариев ждут ответа`,
      body: `${author}: «${first.text.slice(0, 120)}» — ${plainCommentReason(first.status, first.note)}.` +
        (claimed.length > 1 ? ` И ещё ${claimed.length - 1} — в разделе комментариев.` : ""),
      url: "/messages",
      // Один тег на сводку: новая заменяет прежнюю в колокольчике, а не копится.
      tag: claimed.length === 1 ? commentTag(first.commentId) : "comments-need-human",
    });
    return { checked: rows.length, alerted: claimed.length };
  } catch (err) {
    await prisma.processedMessage.deleteMany({ where: { channel: CLAIM_CHANNEL, messageId: { in: claimed.map((r) => r.commentId) } } }).catch(() => {});
    void logSystemError("meta", `Сводка «комментарии ждут человека» не отправлена: ${err instanceof Error ? err.message : String(err)}`,
      { dedupKey: "comment-needs-human-push-failed" });
    return { checked: rows.length, alerted: 0 };
  }
}
