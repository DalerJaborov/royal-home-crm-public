// Вызовы Graph API / YouTube для публичных комментариев: ответ, скрытие, признак
// «комментария больше нет». Вынесено из messengers/comments.ts (31.10.2026) без смены
// поведения: экран «Комментарии» и ядро зовут их, не завися от старого обработчика.
import { callGraph, GRAPH_VERSION, instagramApiUrl, loadCredentials } from "./meta.js";
import { PublicReplyHeldError, publicReplyReceipt } from "./publicCommentReply.js";
import { graphModerationOutcome, requireModerationAccepted } from "./commentModerationOutcome.js";
import { postYouTubeCommentReplyResponse, setYouTubeCommentHidden } from "./youtubeComments.js";
import type { MessengerChannel } from "./turnTypes.js";

/** Минимум полей строки очереди, нужный для ответа (полная форма — QueuedComment). */
type ReplyTarget = { channel: string; commentId: string; parentId: string | null };

/**
 * АДРЕС И МАРКЕР ЗАВИСЯТ ОТ КАНАЛА (16.08.2026, комментарии Facebook).
 *
 * Instagram ходит на graph.instagram.com (а с нашего VPS — через прокси, см.
 * instagramApiUrl) и своим маркером. Страница Facebook — на graph.facebook.com и
 * маркером страницы. Один и тот же путь `/{id}/replies` у них устроен одинаково,
 * а вот домен и токен разные, и перепутать их значит получить «объект не найден».
 */
export async function commentApi(
  channel: MessengerChannel,
  path: string,
  tokenOverride?: string
): Promise<{ url: string; token: string }> {
  const c = await loadCredentials();
  if (channel === "FACEBOOK") {
    const token = tokenOverride || c.pageToken;
    if (!token) throw new Error("Маркер страницы Facebook не задан в Настройках");
    return { url: `https://graph.facebook.com/${GRAPH_VERSION}${path}`, token };
  }
  const token = tokenOverride || c.igToken;
  if (!token) throw new Error("Маркер Instagram не задан в Настройках");
  return { url: instagramApiUrl(`/${GRAPH_VERSION}${path}`), token };
}

/**
 * Экспортирован для routes/instagramComments.ts (POST /:id/reply — ручной ответ
 * сотрудника): тот же путь Graph API, что использует бот, а не второй, слегка
 * другой вызов.
 *
 * @param row нужен целиком (или как минимум channel/commentId/parentId), а не
 *   только commentId: YouTube принимает ответ ТОЛЬКО на верхний комментарий
 *   ветки — если row.parentId заполнен (это ответ, а не корневой комментарий),
 *   в теле уходит parentId, а не commentId самой реплики (см.
 *   youtubeComments.ts::postYouTubeCommentReply). У Instagram/Facebook такого
 *   ограничения нет, им по-прежнему нужен только сам commentId.
 */
export async function postCommentReplyResponse(
  row: ReplyTarget,
  message: string,
  tokenOverride?: string,
  beforePost?: () => Promise<void>
): Promise<unknown> {
  if (row.channel === "YOUTUBE") return postYouTubeCommentReplyResponse(row.parentId || row.commentId, message, beforePost);
  // Ответ на комментарий у Facebook — POST /{id}/comments, «/replies» есть только
  // у Instagram (02.10.2026): Facebook отвечал «Unsupported post request», а это
  // ещё и принималось за «комментарий удалён».
  const edge = row.channel === "FACEBOOK" ? "comments" : "replies";
  const { url, token } = await commentApi(row.channel, `/${encodeURIComponent(row.commentId)}/${edge}`, tokenOverride);
  const created = await callGraph<{ id?: string }>(url, token, { message }, "POST", beforePost);
  return created;
}

export async function postCommentReply(row: ReplyTarget, message: string, tokenOverride?: string, beforePost?: () => Promise<void>): Promise<string | null> {
  if (row.channel !== "INSTAGRAM" && row.channel !== "FACEBOOK" && row.channel !== "YOUTUBE") throw new PublicReplyHeldError("unsupported_channel");
  const receipt = publicReplyReceipt(row.channel, await postCommentReplyResponse(row, message, tokenOverride, beforePost));
  return receipt.outcome === "accepted" ? receipt.providerId : null;
}

/**
 * Скрыть комментарий от подписчиков или вернуть его обратно. Именно скрыть, а не
 * удалить: удаление необратимо и лишает руководство возможности посмотреть, за что
 * человека наказали.
 *
 * ОДНА ФУНКЦИЯ НА ОБА НАПРАВЛЕНИЯ И НА ВСЕ ТРИ ПЛОЩАДКИ (23.09.2026). Раньше здесь
 * жило только скрытие, а возврат подписчикам был вторым, слегка другим вызовом в
 * routes/instagramComments.ts — и этот второй ходил В INSTAGRAM ВСЕГДА, каким бы ни
 * был канал строки. Комментарий со страницы Facebook или из-под ролика YouTube
 * кнопка «Скрыть» в CRM не скрывала вовсе: маркер Instagram чужого комментария не
 * видит, Meta отвечала отказом, а сотрудник читал «Instagram не принял скрытие» под
 * комментарием, никакого отношения к Instagram не имеющим. Тот же класс, что уже
 * чинили 16.08.2026 у ответа и личного сообщения (см. commentApi): адрес Graph и
 * маркер зависят от канала, и второй копии этого выбора быть не должно.
 *
 * @param tokenOverride маркер аккаунта, под чьим постом комментарий (accounts.ts) —
 *   для YOUTUBE не нужен, там свой Bearer-токен (youtubeComments.ts).
 */
export async function setCommentHidden(
  channel: MessengerChannel,
  commentId: string,
  hide: boolean,
  tokenOverride?: string
): Promise<void> {
  if (channel === "YOUTUBE") return setYouTubeCommentHidden(commentId, hide);
  if (channel !== "INSTAGRAM" && channel !== "FACEBOOK") throw new Error("Unsupported comment moderation channel");
  const { url, token } = await commentApi(channel, `/${encodeURIComponent(commentId)}`, tokenOverride);
  // Поле у двух Graph разное (24.09.2026): Instagram понимает `hide`, а комментарий
  // страницы Facebook — только `is_hidden`. С `hide` страница отвечала отказом, и
  // скрытие спама под постами Facebook не работало ни у бота, ни у кнопки в CRM.
  const response = await callGraph(url, token, channel === "FACEBOOK" ? { is_hidden: hide } : { hide });
  requireModerationAccepted(graphModerationOutcome(channel, hide ? "hide" : "unhide", response));
}

/**
 * «Комментария больше нет» — Graph отвечает 400 с кодом 100 и текстом «Object with
 * ID … does not exist, cannot be loaded due to missing permissions, or does not
 * support this operation». Так выглядит удалённый автором комментарий (и наш же
 * скрытый), а не сбой.
 *
 * Отличать обязательно: этот отказ не лечится ни повтором, ни человеком. До
 * 20.08.2026 он шёл общим путём — три попытки, эскалация «бот несколько раз не
 * смог ответить» и три строки в журнале ошибок на каждый такой комментарий. Агент,
 * открыв эскалацию, не находил ни комментария, ни куда отвечать.
 */
export function isCommentGone(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? "");
  return /does not exist|cannot be loaded due to missing permissions|commentNotFound|comment not found/i.test(text);
}
