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

/** Статусы «бот не ответил, нужен человек». Остальные (REPLIED, HIDDEN, SKIPPED, DELETED) — решение принято. */
export const COMMENT_NEEDS_HUMAN_STATUSES = ["ESCALATED", "FAILED"] as const;
/** Старый путь шлёт пуш сам сразу — даём ему время, чтобы не продублировать. */
const MIN_AGE_MS = 3 * 60_000;
const LOOKBACK_MS = 24 * 60 * 60_000;
const SWEEP_LIMIT = 50;
const CLAIM_CHANNEL = "comment-needs-human";
const PLACE: Record<string, string> = { INSTAGRAM: "Instagram", FACEBOOK: "Facebook", YOUTUBE: "YouTube", TELEGRAM: "Telegram" };

export function commentTag(commentId: string): string {
  return `ig-comment-${commentId}`;
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
  const recipients = await findAgentsWithPermission("messages.view");
  if (!recipients.length) {
    void logSystemError("meta", `Комментарии ждут человека (${rows.length}), но в CRM нет никого с правом «Сообщения».`,
      { dedupKey: "comment-needs-human-no-recipients" });
    return { checked: rows.length, alerted: 0 };
  }
  let alerted = 0;
  for (const row of rows) {
    try {
      // Атомарная отметка ДО отправки: два тика или два процесса не пройдут оба.
      const claimed = await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt","completedAt")
        VALUES (${randomUUID()},${CLAIM_CHANNEL},${row.commentId},now(),now()) ON CONFLICT ("channel","messageId") DO NOTHING`;
      if (claimed !== 1) continue;
      const author = row.authorName ? `@${row.authorName}` : "Подписчик";
      await sendPushToAgents(recipients, {
        kind: "message",
        title: `💬 ${PLACE[row.channel] ?? row.channel}: ответьте на комментарий вручную`,
        body: `${author}: «${row.text.slice(0, 120)}» — ${plainCommentReason(row.status, row.note)}.`,
        url: "/messages",
        tag: commentTag(row.commentId),
      });
      alerted++;
    } catch (err) {
      // Пуш не ушёл — снимаем отметку, следующий тик попробует снова.
      await prisma.processedMessage.deleteMany({ where: { channel: CLAIM_CHANNEL, messageId: row.commentId } }).catch(() => {});
      void logSystemError("meta", `Пуш по комментарию ${row.commentId} не отправлен: ${err instanceof Error ? err.message : String(err)}`,
        { dedupKey: "comment-needs-human-push-failed" });
    }
  }
  return { checked: rows.length, alerted };
}
