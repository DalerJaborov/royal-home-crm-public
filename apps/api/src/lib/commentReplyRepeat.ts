import { prisma } from "../db.js";

/**
 * ОДИН И ТОТ ЖЕ ПУБЛИЧНЫЙ ОТВЕТ ОДНОМУ ЧЕЛОВЕКУ ПОД ОДНИМ ПОСТОМ — НЕ ДВАЖДЫ (разбор суток 23.11.2026, K11–K18). Клиент под
 * постом Instagram трижды написал «обьект 117» и дважды получил «Какой объект вы имеете в виду? Пришлите номер объекта или
 * ссылку.», а на «- ?» — тот же список из трёх объектов, что и час назад. Повтор под постом видят все, человеку он не
 * помогает: такой ответ не уходит, комментарий идёт человеку (lib/commentWaitingAlert.ts).
 *
 * Одна дверь для обоих путей комментариев: ядра (lib/customerPublicAgentTurn.ts) и прежнего (messengers/comments.ts).
 */
export const PUBLIC_REPLY_REPEAT_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** К сравнимому виду: регистр, ё, пробелы, знаки и смайлики не различают ответы. Чистая. */
export function normalizedPublicReply(text: string): string {
  return text.toLowerCase().replace(/ё/gu, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Повтор по комментарию-реакции («🔥», «👍») — тихо пропускаем, человека не зовём (владелец: «редко беспокоить людей»); по
 * комментарию со словами или с «?» («обьект 117», «@royal.home.tj - ?») — человеку. Чистая.
 */
export function commentWantsAnswer(commentText: string): boolean {
  const own = commentText.replace(/@[\p{L}\p{N}._]+/gu, " ");
  return /[?؟]/u.test(own) || (own.match(/\p{L}/gu)?.length ?? 0) >= 2;
}

export function samePublicReply(a: string, b: string): boolean {
  const left = normalizedPublicReply(a), right = normalizedPublicReply(b);
  return left.length > 0 && left === right;
}

/**
 * Этот текст уже уходил публичным ответом бота этому автору под этой публикацией (за неделю). Ответ сотрудника руками
 * (`manual_reply`) не в счёт. Сбой чтения — «нет»: лишний ответ дешевле, чем потерянный.
 */
export async function publicReplyRepeatsForAuthor(input: { commentId: string; text: string; now?: Date }): Promise<boolean> {
  try {
    const row = await prisma.instagramComment.findUnique({ where: { id: input.commentId }, select: { channel: true, mediaId: true, authorId: true } });
    if (!row?.authorId || !row.mediaId) return false;
    const since = new Date((input.now ?? new Date()).getTime() - PUBLIC_REPLY_REPEAT_WINDOW_MS);
    const earlier = await prisma.instagramComment.findMany({
      where: { id: { not: input.commentId }, channel: row.channel, mediaId: row.mediaId, authorId: row.authorId, replyText: { not: null },
        repliedAt: { gte: since }, OR: [{ note: null }, { note: { not: { startsWith: "manual_reply" } } }] },
      select: { replyText: true }, orderBy: { repliedAt: "desc" }, take: 20,
    });
    return earlier.some(item => !!item.replyText && samePublicReply(item.replyText, input.text));
  } catch {
    return false;
  }
}
