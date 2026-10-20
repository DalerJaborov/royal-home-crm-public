import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import type { MessengerChannel } from "./conversation.js";
import type { PublicResult, PublicSourceRef } from "../lib/publicCommentTypes.js";

/**
 * Общая часть очереди комментариев — вынесена из comments.ts (17.09.2026, добавление
 * канала YouTube) в отдельный файл, НАРОЧНО без единой зависимости от comments.ts или
 * youtubeComments.ts.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ЭКСПОРТ ИЗ comments.ts. comments.ts зовёт действия
 * YouTube (postYouTubeCommentReply/hideYouTubeComment/deleteYouTubeComment/
 * fetchYouTubeVideoInfo/youtubeCommentsConfigured) из youtubeComments.ts — значит
 * comments.ts → youtubeComments.ts. Поллер YouTube, в свою очередь, кладёт строки в
 * очередь и гасит модерацию тем же путём, что Instagram/Facebook, — то есть ему тоже
 * нужны были бы enqueueComments/noteCommentsOff из comments.ts, а это
 * youtubeComments.ts → comments.ts. Вместе это цикл импортов, который в этом
 * репозитории ловит `npm run audit:deps` (правило "no-circular", уже один раз
 * находило точно такой же цикл — см. lib/describeError.ts). Нейтральный файл без
 * обратных зависимостей разрывает цикл: оба канальных модуля читают отсюда, а не
 * друг у друга.
 */

/** Один комментарий, приведённый к виду, понятному очереди — вне зависимости от
 *  канала (Instagram/Facebook разбирает parseIncomingComments в comments.ts,
 *  YouTube строит поллер в youtubeComments.ts). */
export interface IncomingComment {
  /** Где оставлен комментарий: от этого зависит и адрес API, и маркер. */
  channel: MessengerChannel;
  commentId: string;
  mediaId: string;
  /** В какой НАШ аккаунт/канал пришёл комментарий — чьим маркером потом отвечать. */
  accountExternalId?: string;
  /** Заполнен, если комментарий — ответ в ветке (в том числе на нашу реплику). */
  parentId?: string;
  authorId: string;
  authorName?: string;
  text: string;
}

/** Server-only request-local closure, produced from the actual signed raw comment batch.
 * This interface alone is NOT authorization; root P12 store must revalidate original capture. */
export interface MetaPublicCaptureSession {
  readonly items: readonly Readonly<IncomingComment>[];
  commitFiltered(items: readonly IncomingComment[], enabled: boolean): Promise<PublicResult<readonly PublicSourceRef[]>>;
}

/** Тексты режем при записи: в базе они нужны для журнала и промта, а не целиком. */
const MAX_TEXT = 2000;

/**
 * ВЫКЛЮЧЕННАЯ МОДЕРАЦИЯ ОБЯЗАНА БЫТЬ ВИДИМОЙ (30.08.2026).
 *
 * До этого выключенная фича не оставляла никакого следа: комментарии ложились в
 * базу со статусом SKIPPED и пометкой "bot_off", экран «Здоровье системы»
 * показывал зелёное, и понять, что модерация не работает уже неделю, было
 * неоткуда. Это тот же класс дефектов, на котором проект обжигался трижды:
 * молчаливый обход прячет мёртвый основной путь.
 *
 * Раз в сутки на канал: журнал ошибок дедуплицирует записи окном в 10 минут, а
 * выключенная модерация — состояние на дни, и десятиминутные повторы утопили бы
 * настоящие поломки. Счётчик в памяти процесса: после перезапуска запись
 * появится ещё раз — это не мешает, а лишний раз подтверждает, что фича молчит.
 */
const BOT_OFF_LOG_EVERY_MS = 24 * 60 * 60 * 1000;
const lastBotOffLogAt = new Map<string, number>();

export async function noteCommentsOff(channel: MessengerChannel, reason: string): Promise<void> {
  const now = Date.now();
  if (now - (lastBotOffLogAt.get(channel) ?? 0) < BOT_OFF_LOG_EVERY_MS) return;
  lastBotOffLogAt.set(channel, now);
  await logSystemError(
    "meta",
    `Модерация комментариев не работает (${channel}): ${reason}. ` +
      `Комментарии сохраняются в CRM, но бот на них не отвечает, спам не скрывается и реклама конкурентов не удаляется.`
  );
}

/**
 * Кладёт уже отфильтрованные (собственные реплики отсеяны вызывающим — см.
 * ingestInstagramComments в comments.ts и pollYouTubeComments в youtubeComments.ts)
 * комментарии в очередь. skipDuplicates + уникальный commentId — вся защита от
 * повторной доставки; проверка «а нет ли уже такого» здесь была бы гонкой.
 *
 * @param enabled решение «отвечать ли», принятое ВЫЗЫВАЮЩИМ (там своя проверка
 *   рубильников для каждого канала) — этот файл нарочно не знает о каналах ничего,
 *   кроме имени. Бот выключен — комментарий всё равно сохраняем: он должен остаться
 *   в журнале, но отвечать на него потом, «задним числом», уже нельзя.
 */
export async function enqueueComments(items: IncomingComment[], enabled: boolean): Promise<number> {
  if (items.length === 0) return 0;
  try {
    const now = Date.now();
    const rows = items.map((c) => ({
      channel: c.channel,
      commentId: c.commentId,
      mediaId: c.mediaId,
      accountExternalId: c.accountExternalId ?? null,
      parentId: c.parentId ?? null,
      authorId: c.authorId,
      authorName: c.authorName ?? null,
      text: c.text.slice(0, MAX_TEXT),
      replyDueAt: new Date(now),
      ...(enabled ? {} : { status: "SKIPPED", note: "bot_off" }),
    }));
    const { count } = await prisma.instagramComment.createMany({ data: rows, skipDuplicates: true });
    return count;
  } catch (err) {
    void logSystemError("meta", `Комментарии (${items[0]?.channel ?? "?"}) не приняты: ${describeError(err)}`);
    return 0;
  }
}
