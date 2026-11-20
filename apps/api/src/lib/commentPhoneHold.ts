/**
 * ПРИДЕРЖКА РАЗДАЧИ КАРТОЧКИ ПО НОМЕРУ ИЗ КОММЕНТАРИЯ (18.11.2026, messengers/commentPhoneLead.ts).
 *
 * Карточка заведена сразу (номер не теряется), бот написал клиенту ОДНО личное с вопросом о цели. В раздачу карточка
 * идёт, когда клиент ответил боту в личных (его ответ — в хронологию карточки) или когда прошли 20 минут без ответа
 * (пометка «номер из комментария, боту не ответил»). Снимает придержку только этот файл; зовётся тиком раздачи
 * (cron.ts, `lead-distribution`, каждые 5 минут в рабочем окне) ПЕРЕД утренней волной — поэтому ночью придержка
 * снимается в начале рабочего окна, и отдельного таймера (setTimeout) нет. Волна (services/leads/reassignment.ts)
 * не берёт карточку, пока срок придержки не вышел.
 */
import { prisma } from "../db.js";
import { logTimeline } from "./timeline.js";
import { COMMENT_HISTORY_PREFIX } from "../messengers/commentPhoneLead.js";
import { COMMENT_PHONE_DM } from "../ai/botSelfAnswerText.js";

const RELEASE_LIMIT = 100;
const DM_TEXTS = [COMMENT_PHONE_DM.ru, COMMENT_PHONE_DM.tg];

type Msg = { role?: unknown; content?: unknown; silentCapture?: unknown };

/**
 * Чистая: что клиент ответил боту в личных ПОСЛЕ личного по номеру из комментария. Свои реплики кода (тихий приём,
 * сам комментарий) — не ответ. null — ответа нет (или личного не было).
 */
export function commentPhoneReplyOf(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  let dmAt = -1;
  messages.forEach((raw, index) => {
    const m = raw as Msg | null;
    if (m?.role === "assistant" && typeof m.content === "string" && DM_TEXTS.includes(m.content.trim())) dmAt = index;
  });
  if (dmAt < 0) return null;
  const replies: string[] = [];
  for (const raw of messages.slice(dmAt + 1)) {
    const m = raw as Msg | null;
    if (!m || m.role !== "user" || m.silentCapture === true || typeof m.content !== "string") continue;
    const text = m.content.trim();
    if (!text || text.startsWith(COMMENT_HISTORY_PREFIX)) continue;
    replies.push(text);
  }
  return replies.length ? replies.join(" ").replace(/\s+/gu, " ").slice(0, 300) : null;
}

/** Снять придержку с пометкой в хронологии. Только если придержка та же (двое не снимут дважды). */
export async function releaseCommentPhoneHold(clientId: string, note: string, expected?: Date | null,
  /** Пометку писать и без придержки (личное не ушло, а карточка и так в раздаче): агенту важна причина. */
  noteEvenIfFree = false): Promise<boolean> {
  const released = await prisma.client.updateMany({
    where: { id: clientId, ...(expected ? { commentPhoneHoldUntil: expected } : { commentPhoneHoldUntil: { not: null } }) },
    data: { commentPhoneHoldUntil: null },
  });
  if (released.count !== 1 && !noteEvenIfFree) return false;
  await logTimeline({ clientId, type: "SYSTEM", notes: note, actor: { kind: "system", source: "comment-phone" } })
    .catch((err) => console.error("[comment-phone] пометка в хронологии не записана:", err instanceof Error ? err.message : err));
  return true;
}

/** Тик: клиент ответил — в раздачу с его словами; срок вышел — в раздачу с пометкой «боту не ответил». */
export async function releaseCommentPhoneHolds(now: Date = new Date()): Promise<{ answered: number; expired: number }> {
  const held = await prisma.client.findMany({
    where: { commentPhoneHoldUntil: { not: null }, deletedAt: null },
    select: { id: true, commentPhoneHoldUntil: true },
    orderBy: { commentPhoneHoldUntil: "asc" },
    take: RELEASE_LIMIT,
  });
  let answered = 0, expired = 0;
  for (const card of held) {
    const conversations = await prisma.botConversation.findMany({ where: { clientId: card.id }, select: { messages: true } });
    const reply = conversations.map((c) => commentPhoneReplyOf(c.messages)).find((r): r is string => !!r) ?? null;
    if (reply) {
      if (await releaseCommentPhoneHold(card.id, `Номер из комментария: клиент ответил боту в личных — «${reply}»`, card.commentPhoneHoldUntil)) answered++;
    } else if (card.commentPhoneHoldUntil && card.commentPhoneHoldUntil.getTime() <= now.getTime()) {
      if (await releaseCommentPhoneHold(card.id, "Номер из комментария, боту не ответил: позвоните и узнайте, что нужно клиенту.", card.commentPhoneHoldUntil)) expired++;
    }
  }
  return { answered, expired };
}
