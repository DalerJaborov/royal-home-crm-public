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
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { findAgentsWithPermission } from "./recipients.js";
import { logSystemError } from "./systemError.js";

/** Старый путь шлёт пуш сам сразу — даём ему время, чтобы не продублировать. */
const MIN_AGE_MS = 3 * 60_000;
const LOOKBACK_MS = 24 * 60 * 60_000;
const SWEEP_LIMIT = 50;
const CLAIM_CHANNEL = "comment-needs-human";
const PLACE: Record<string, string> = { INSTAGRAM: "Instagram", FACEBOOK: "Facebook", YOUTUBE: "YouTube", TELEGRAM: "Telegram" };

export function commentTag(commentId: string): string {
  return `ig-comment-${commentId}`;
}

/**
 * Нужен ли человек — БЕЛЫЙ список (ревью 192-1, 15.11.2026). Не зовём:
 *  - `gone` — комментарий удалён, отвечать физически некуда (comments.ts::failComment);
 *  - `ai_down` и технические отказы нового ядра (ИИ недоступен, не успел, истёк срок) —
 *    решение владельца 30.08.2026: «отключи, что у ИИ типа нет ответа — думаю не надо
 *    такого»; директор и так видит это в «Здоровье системы»;
 *  - любой незнакомый `note` у FAILED — новый код сначала решают, потом зовут.
 * Зовём: ESCALATED (бот сам передал человеку или спросил про модерацию), FAILED
 * `no_answer` (старый путь сдался после попыток) и FAILED ядра по смыслу ответа.
 */
const TECHNICAL_CORE_FAILURES = new Set(["public_core_unavailable", "turn_unavailable", "turn_deadline", "expired"]);
export function commentNeedsHuman(status: string, note: string | null): boolean {
  const n = note ?? "";
  if (/(^|[;\s])gone(?![a-z_])/.test(n)) return false;
  if (status === "ESCALATED") return true;
  if (status !== "FAILED") return false;
  if (n === "no_answer") return true;
  const core = /^managed_core:failed:([a-z_]+)/.exec(n);
  return !!core && !TECHNICAL_CORE_FAILURES.has(core[1]!);
}

/** Причина простыми словами — без служебных кодов. */
export function plainCommentReason(status: string, note: string | null): string {
  if (note?.includes("moderation")) return "бот не уверен, скрывать ли комментарий — решите сами";
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
  const rows = await prisma.$queryRaw<Array<{ commentId: string; channel: string; status: string; note: string | null; authorName: string | null; text: string }>>`
    SELECT c."commentId", c."channel", c."status", c."note", c."authorName", c."text"
    FROM "InstagramComment" c
    WHERE c."status" IN ('ESCALATED','FAILED')
      AND c."updatedAt" >= ${new Date(now.getTime() - LOOKBACK_MS)}
      AND c."updatedAt" <= ${new Date(now.getTime() - MIN_AGE_MS)}
      AND NOT EXISTS (SELECT 1 FROM "Notification" n WHERE n."tag" = 'ig-comment-' || c."commentId")
      AND NOT EXISTS (SELECT 1 FROM "ProcessedMessage" p WHERE p."channel" = ${CLAIM_CHANNEL} AND p."messageId" = c."commentId")
    ORDER BY c."updatedAt" ASC
    LIMIT ${SWEEP_LIMIT}`;
  if (!rows.length) return { checked: 0, alerted: 0 };
  const claim = (commentId: string) => prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt","completedAt")
    VALUES (${randomUUID()},${CLAIM_CHANNEL},${commentId},now(),now()) ON CONFLICT ("channel","messageId") DO NOTHING`;
  const due: typeof rows = [];
  for (const row of rows) {
    if (!commentNeedsHuman(row.status, row.note)) {
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
