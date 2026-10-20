import fsp from "node:fs/promises";
import { admitOutbound, OutboundBlockedError, type OutboundOrigin } from "../lib/outboundShield.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { requireModerationAccepted, telegramDeleteOutcome, type ModerationOutcome } from "../messengers/commentModerationOutcome.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

/**
 * АДРЕС BOT API. По умолчанию — облако Telegram, как было: без переменной
 * окружения поведение не меняется ни на байт, и откат с локального сервера
 * обратно — это удаление одной переменной, а не правка кода.
 *
 * `TELEGRAM_API_BASE_URL=http://telegram-bot-api:8081` переключает бота на свою
 * копию Bot API (github.com/tdlib/telegram-bot-api, запуск с `--local`). Что это
 * даёт, дословно из core.telegram.org/bots/api: «Download files without a size
 * limit», «Upload files up to 2000 MB», «Receive the absolute local path as a
 * value of the file_path field without the need to download the file».
 *
 * ⚠️ Переключение односторонее на 10 минут: перед первым запуском на своём
 * сервере бота ОБЯЗАНО разлогинить в облаке (метод logOut, «You must log out the
 * bot before running it locally»), и вернуться в облако раньше чем через 10
 * минут Telegram не даст. Порядок — ops/telegram-local-botapi.md.
 */
const CLOUD_API_ROOT = "https://api.telegram.org";
const API_ROOT = (process.env.TELEGRAM_API_BASE_URL || CLOUD_API_ROOT).replace(/\/+$/, "");

/** Свой сервер это или облако. От этого зависят пределы размеров и то, отдаёт ли
 *  getFile путь на диске вместо адреса для скачивания. */
export const IS_LOCAL_BOT_API = API_ROOT !== CLOUD_API_ROOT;

const BASE_URL = TOKEN ? `${API_ROOT}/bot${TOKEN}` : null;

export function isTelegramEnabled(): boolean {
  return !!BASE_URL;
}

/**
 * МАСКИРУЕТ ТОКЕН БОТА ВНУТРИ ПУТИ НА ТОМЕ СВОЕГО BOT API-СЕРВЕРА (24.09.2026).
 *
 * `--local` раскладывает файлы по подкаталогу с именем самого бота, и `getFile`
 * отдаёт АБСОЛЮТНЫЙ путь вида `/var/lib/telegram-bot-api/<TOKEN>/videos/file_1.mp4`
 * — токен лежит в пути буквально, не только в URL скачивания. Без маскировки он
 * утёк бы в `journalctl`/«Здоровье системы» при первой же ошибке копирования или
 * строке ночной уборки тома (lib/telegramBotApiCleanup.ts).
 */
export function maskTelegramFilePath(value: string): string {
  if (!TOKEN) return value;
  return value.split(TOKEN).join("<bot-token>");
}

/** Обычный вызов Telegram API: секунды. Долгий ответ здесь — это уже отказ. */
const CALL_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ОТВЕТ TELEGRAM НА 429 (aудит «монтажёр ↔ CRM», 21.09.2026). Помимо обычного
 * `ok:false`, лимит частоты возвращает `error_code:429` и
 * `parameters.retry_after` — секунды, через которые можно повторить попытку.
 * core.telegram.org/bots/api#making-requests: «In case of an unsuccessful
 * request, […] the field 'parameters' […] can help to automatically handle
 * the error, e.g. […] retry after the specified number of seconds returned
 * in the 'retry_after' parameter». Дословно, а не «на глаз».
 */
export interface TelegramApiResponse<T> {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
  result?: T;
}

/**
 * Сколько раз ждать `retry_after` и повторять один и тот же вызов, прежде чем
 * сдаться. Не бесконечно: у монтажа есть очередь, а не только Telegram, и
 * зависший навсегда вызов держал бы её как зависшая транзакция. Три попытки —
 * это до нескольких МИНУТ ожидания суммарно (retry_after обычно секунды,
 * изредка десятки при перегрузке облака), с запасом на то, что лимит сам
 * снимется, но без риска зависнуть на объекте навсегда.
 */
const MAX_RATE_LIMIT_RETRIES = 3;
/** +1с сверх того, что просит Telegram, — тот же запас, что и у паузы между
 *  отправками (TELEGRAM_SEND_PAUSE_MS в lib/videoHandoff.ts): часы нашего
 *  сервера и Bot API не гарантированно синхронны день в день. */
const RATE_LIMIT_EXTRA_MS = 1_000;
/**
 * ДОЛЬШЕ МИНУТЫ НЕ ЖДЁМ (аудит 23.09.2026, круг 3, №85). При flood-wait
 * Telegram просит паузу и в сотни, и в тысячи секунд, а ожидание стоит
 * посреди цепочки сообщений одного чата (или задачи по расписанию): всё за
 * ней стояло столько же. Больше минуты — честный отказ сразу, повтор решит
 * вызывающий (очередь монтажа, следующий тик).
 */
const MAX_RETRY_AFTER_SEC = 60;

/** Сколько ждать перед повтором после 429 — или null, если повторять не надо. */
export function telegramRetryDelayMs(data: TelegramApiResponse<unknown>, attempt: number): number | null {
  const after = data.parameters?.retry_after;
  if (data.error_code !== 429 || typeof after !== "number" || attempt >= MAX_RATE_LIMIT_RETRIES) return null;
  if (!(after >= 0) || after > MAX_RETRY_AFTER_SEC) return null;
  return after * 1000 + RATE_LIMIT_EXTRA_MS;
}

async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS, validateResult?: (data: unknown, status: number) => T, beforePost?: () => Promise<void>): Promise<T> {
  if (!BASE_URL) throw new Error("TELEGRAM_BOT_TOKEN не настроен");
  for (let attempt = 0; ; attempt++) {
    // Без таймаута зависшее соединение вешает вызов навсегда. Для long polling это
    // означает тихо умерший бот: цикл опроса стоит на одном fetch, ошибки нет,
    // журнал молчит, клиентам никто не отвечает.
    await beforePost?.();
    const res = await fetch(`${BASE_URL}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json()) as TelegramApiResponse<T>;
    if (data.ok) return validateResult ? validateResult(data, res.status) : data.result as T;
    const waitMs = telegramRetryDelayMs(data, attempt);
    if (waitMs !== null) {
      await sleep(waitMs);
      continue;
    }
    throw new Error(`Telegram API ${method}: ${data.description ?? "неизвестная ошибка"}`);
  }
}

/** Предел Telegram на текст одного сообщения. Сверх него API отвергает ЦЕЛИКОМ. */
const MESSAGE_MAX_CHARS = 4096;

/**
 * Режем длинный текст на куски ≤4096 по границе строки/пробела: длинный ответ
 * (сотрудник вставил список объектов, модель разошлась) раньше ронял отправку
 * целиком — клиент не получал НИЧЕГО, а в журнале лежал «message is too long».
 */
export function splitTelegramText(text: string): string[] {
  if (text.length <= MESSAGE_MAX_CHARS) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MESSAGE_MAX_CHARS) {
    const window = rest.slice(0, MESSAGE_MAX_CHARS);
    const cutAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const cut = cutAt > MESSAGE_MAX_CHARS / 2 ? cutAt : MESSAGE_MAX_CHARS;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function sendMessage(
  chatId: string,
  text: string,
  replyToMessageId?: number,
  directMessagesTopicId?: number,
  /**
   * ЩИТ ИСХОДЯЩИХ (17.09.2026, lib/outboundShield.ts) — `origin: "staff"` снимает
   * с сообщения все ограничения: живой сотрудник отвечает клиенту из CRM.
   * Умолчание — бот.
   */
  outbound?: { origin?: OutboundOrigin; beforePost?: () => Promise<void>; requireReply?: boolean }
): Promise<unknown> {
  /**
   * ЩИТ СТОРОЖИТ ТОЛЬКО КЛИЕНТСКИЕ ЧАТЫ (`onlyIfKnown`).
   *
   * Через эту же функцию уходят служебные сообщения сотрудникам: привязка чата,
   * квитанции монтажёру, отчёты. Диалог становится «известным» щиту ровно тогда,
   * когда в него пришло настоящее входящее клиента (telegram/bot.ts →
   * handleClientMessages), поэтому служебные чаты проходят не тронутыми, а
   * клиентские — по всем правилам.
   */
  const verdict = await admitOutbound({
    channel: "TELEGRAM",
    /**
     * DIRECT MESSAGES — КЛЮЧ ПО СОБЕСЕДНИКУ, А НЕ ПО КАНАЛУ (правка 22.09.2026).
     *
     * В инбоксе Direct Messages `chat_id` один на всех написавших, людей
     * разносит только `direct_messages_topic_id`. С ключом по `chatId` щит
     * считал бы реплики РАЗНЫМ людям монологом одному и поставил бы паузу
     * сразу всему каналу. Составной ключ понимает и lib/outboundShield.ts
     * (см. directKey там), когда ставит и снимает паузу.
     */
    subscriberId: directMessagesTopicId ? `${chatId}:${directMessagesTopicId}` : chatId,
    text,
    origin: outbound?.origin,
    onlyIfKnown: true,
  });
  if (!verdict.allowed) {
    console.warn(`[щит] TELEGRAM → ${chatId}: ${verdict.reasonText}`);
    throw new OutboundBlockedError(verdict);
  }

  // Без parse_mode: текст клиентского бота — обычная человеческая речь, разметки
  // в нём нет, а любой знак < или & в режиме HTML ронял отправку целиком.
  // Куски шлём последовательно — порядок частей обязан сохраниться.
  //
  // reply_to_message_id — только у ПЕРВОГО куска: длинный ответ, разрезанный
  // на части, в Telegram не может «отвечать сам себе» вторым куском — тредом
  // остаётся исходный комментарий, остальные части идут ниже без привязки.
  //
  // direct_messages_topic_id (01.09.2026) — ответ в Direct Messages канала:
  // все отправители делят один и тот же chat_id (сам канал), Telegram
  // разносит их только этим полем. Без него ответ ушёл бы «куда-то в канал»,
  // а не конкретному человеку.
  let last: unknown;
  let first = true;
  for (const part of splitTelegramText(text)) {
    last = await call("sendMessage", {
      chat_id: chatId,
      text: part,
      ...(directMessagesTopicId ? { direct_messages_topic_id: directMessagesTopicId } : {}),
      ...(first && replyToMessageId ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: !outbound?.requireReply } : {}),
    }, CALL_TIMEOUT_MS, outbound?.requireReply ? (data, status) => {
      if (status < 200 || status >= 300 || !data || typeof data !== "object" || !("ok" in data) || data.ok !== true || ("success" in data && data.success === false) || "error_code" in data || !("result" in data)) throw new Error("Telegram public reply unconfirmed");
      return (data as TelegramApiResponse<unknown>).result;
    } : undefined, outbound?.beforePost);
    first = false;
  }
  return last;
}

/** Кнопка инлайн-клавиатуры: либо действие внутри бота (callback_data,
 *  обрабатывается в telegram/bot.ts → handleCallbackQuery), либо открытие
 *  сайта Mini App'ом (web_app) — Telegram сам разворачивает его в iframe/
 *  WebView внутри клиента, не выходя в системный браузер. */
export type TelegramInlineButton =
  | { text: string; callback_data: string }
  | { text: string; web_app: { url: string } }
  | { text: string; url: string };

/** Инлайн-кнопки под сообщением (19.08.2026) — в отличие от reply-клавиатуры
 *  (requestContact) не занимают полосу ввода и остаются под конкретным
 *  сообщением, а не «висят» до следующего remove_keyboard. buttons — массив
 *  рядов, в ряду одна-две кнопки: больше не помещается на маленьком экране. */
export function sendMessageWithButtons(
  chatId: string,
  text: string,
  buttons: TelegramInlineButton[][]
): Promise<TelegramSentMessage> {
  return call<TelegramSentMessage>("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: buttons } });
}

/**
 * Обязательный ответ на нажатие инлайн-кнопки. Без него Telegram держит на
 * кнопке крутящийся индикатор загрузки у клиента до таймаута — выглядит как
 * зависший бот, даже если сам сценарий уже отработал.
 */
export function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<unknown> {
  return call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

/** Просит клиента поделиться номером через нативную кнопку Telegram —
 * телефон приходит уже верифицированным самим Telegram, без риска опечаток/фейков. */
export function requestContact(chatId: string, text: string): Promise<unknown> {
  return call("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      keyboard: [[{ text: "📱 Поделиться номером телефона", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

export function removeKeyboard(chatId: string, text: string): Promise<unknown> {
  return call("sendMessage", { chat_id: chatId, text, reply_markup: { remove_keyboard: true } });
}

/**
 * Тап эмодзи на сообщение клиента (Bot API 7.0+, июнь 2024) — не отдельное
 * сообщение, а настоящая реакция под конкретной репликой.
 *
 * Провал не бросает исключение выше: реакция — украшение поверх разговора,
 * которое уже состоялся, её отказ не должен ронять основной ответ (тот же
 * принцип, что у showReadAndTyping в messengers/meta.ts).
 */
export async function setMessageReaction(chatId: string, messageId: number, emoji: string): Promise<void> {
  try {
    await call("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: emoji ? [{ type: "emoji", emoji }] : [],
    });
  } catch (err) {
    console.warn("[telegram] Реакция не поставлена (косметика, на переписку не влияет):", describeError(err));
  }
}

/**
 * «ПЕЧАТАЕТ…» ПЕРЕД ОТВЕТОМ БОТА (03.10.2026, аудит audit-1, находка 6). Каналы
 * Meta показывают индикатор и держат паузу «набора» (routes/webhooks.ts), а
 * Telegram отвечал в ту же секунду, как модель закончила, — так пишет автомат.
 * Индикатор живёт ~5 секунд или до первого сообщения. В Direct Messages канала
 * нужен topicId, иначе индикатор не попадёт в нужный разговор.
 *
 * Провал не бросает: индикатор — украшение, ответ важнее (как setMessageReaction).
 */
export async function sendChatAction(chatId: string, directMessagesTopicId?: number): Promise<void> {
  if (!BASE_URL) return;
  try {
    await call("sendChatAction", {
      chat_id: chatId,
      action: "typing",
      ...(directMessagesTopicId != null ? { direct_messages_topic_id: directMessagesTopicId } : {}),
    });
  } catch (err) {
    console.warn("[telegram] «печатает…» не показан (косметика):", describeError(err));
  }
}

/**
 * ФОТО/ВИДЕО/ФАЙЛ/ГОЛОСОВОЕ КЛИЕНТУ (19.08.2026) — Telegram был единственным
 * каналом, где бот умел только текст: у WhatsApp/Instagram/Messenger отправка
 * медиа из инбокса уже была (см. messengers/meta.ts), а Telegram-клиенты
 * оставались без фото объекта и голосового ответа агента.
 *
 * Как и у Meta-каналов — ссылкой, не файлом в теле запроса: Telegram сам
 * скачивает файл по публичному адресу (тот же приём, что и у Graph API,
 * см. lib/outgoingMedia.ts / lib/outgoingVoice.ts). Не нужен multipart и
 * второй путь загрузки на сервер.
 */
/** Предел Telegram на подпись к медиа. Длиннее — отправка отвергается целиком,
 *  поэтому хвост честно обрезаем: вложение с укороченной подписью лучше, чем ничего. */
const CAPTION_MAX_CHARS = 1024;
const fitCaption = (caption?: string) =>
  caption ? { caption: caption.length > CAPTION_MAX_CHARS ? `${caption.slice(0, CAPTION_MAX_CHARS - 1)}…` : caption } : {};

export function sendPhoto(chatId: string, photoUrl: string, caption?: string): Promise<unknown> {
  return call("sendPhoto", { chat_id: chatId, photo: photoUrl, ...fitCaption(caption) });
}

/**
 * Отправка файла ДОКУМЕНТОМ, не видео (01.09.2026, lib/videoHandoff.ts — сырой
 * ролик для монтажёра). Разница принципиальна: sendVideo (даже отправленный
 * файлом, не ссылкой) ВСЕГДА пережимает видео под свой плеер-превью — монтажёр
 * получил бы уже испорченное качество, с которым и работать дальше. sendDocument
 * передаёт байты как есть, один в один, ценой того, что получатель открывает файл
 * обычным способом, без встроенного плеера, — для рабочего исходника это ровно
 * то, что нужно, плеер тут не важен.
 */
/**
 * Правит подпись уже отправленного сообщения (издание поста в канале) —
 * lib/publishedListingSync.ts зовёт это, когда меняется цена уже опубликованного
 * объекта, чтобы обновить пост в канале, а не слать дубль. В отличие от
 * Instagram Graph API (см. Property.publishedPostIds в schema.prisma), Telegram
 * Bot API editMessageCaption — стандартная, давно стабильная операция.
 */
/**
 * Снять пост из канала. Бот удаляет только СВОИ сообщения, и именно так посты
 * объектов туда и попадают (publishTelegramVideo). Ошибку не глотаем: «убрали
 * из соцсетей» обязано быть правдой, иначе ролик с неверным текстом продолжит
 * висеть, а в CRM будет написано, что его нет.
 */
export async function deleteChannelMessage(chatId: string, messageId: number): Promise<void> {
  await call("deleteMessage", { chat_id: chatId, message_id: messageId });
}

/** Comments need the actual deletion confirmation; other channel consumers keep their contract. */
export async function deleteChannelCommentMessage(chatId: string, messageId: number): Promise<ModerationOutcome> {
  return call("deleteMessage", { chat_id: chatId, message_id: messageId }, CALL_TIMEOUT_MS,
    (data, status) => requireModerationAccepted(telegramDeleteOutcome(data, status)));
}

/** Сообщение, которое вернул Telegram на отправку, — нужен только его номер. */
export interface TelegramSentMessage {
  message_id: number;
}

/** Правит текст и клавиатуру уже отправленного сообщения (модерация: убрать
 *  кнопки и дописать «✅ Одобрено …»). `buttons: null` — кнопки снять. */
export async function editMessageText(
  chatId: string,
  messageId: number,
  text: string,
  buttons?: TelegramInlineButton[][] | null
): Promise<void> {
  await call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, MESSAGE_MAX_CHARS),
    reply_markup: { inline_keyboard: buttons ?? [] },
  });
}

/**
 * Альбом файлами с диска (модерация: фото объекта). До 10 элементов — предел
 * Telegram. `fs.openAsBlob` читает файл лениво, а не целиком в память: на
 * контейнере API 768 МБ десять снимков по 2-3 МБ разом ни к чему.
 */
export async function sendMediaGroupFiles(
  chatId: string,
  items: Array<{ type: "photo" | "video"; path: string; caption?: string }>,
  timeoutMs = 120_000
): Promise<TelegramSentMessage[]> {
  if (!BASE_URL) throw new Error("TELEGRAM_BOT_TOKEN не настроен");
  const { openAsBlob } = await import("node:fs");
  const blobs = await Promise.all(items.slice(0, 10).map((item) => openAsBlob(item.path)));
  const result = await postMultipartWithRetry(
    `${BASE_URL}/sendMediaGroup`,
    () => {
      const form = new FormData();
      form.append("chat_id", chatId);
      const media = items.slice(0, 10).map((item, i) => ({
        type: item.type,
        media: `attach://f${i}`,
        ...fitCaption(item.caption),
      }));
      form.append("media", JSON.stringify(media));
      blobs.forEach((blob, i) => form.append(`f${i}`, blob, `f${i}${items[i]!.type === "photo" ? ".webp" : ".mp4"}`));
      return form;
    },
    timeoutMs,
    "sendMediaGroup (файлами)"
  );
  return result as TelegramSentMessage[];
}

/** Одно фото файлом с диска, по желанию с кнопками (модерация «по одному»). */
export async function sendPhotoFromDisk(
  chatId: string,
  filePath: string,
  caption?: string,
  buttons?: TelegramInlineButton[][],
  timeoutMs = 60_000
): Promise<TelegramSentMessage> {
  if (!BASE_URL) throw new Error("TELEGRAM_BOT_TOKEN не настроен");
  const { openAsBlob } = await import("node:fs");
  const blob = await openAsBlob(filePath);
  const result = await postMultipartWithRetry(
    `${BASE_URL}/sendPhoto`,
    () => {
      const form = new FormData();
      form.append("chat_id", chatId);
      if (caption) form.append("caption", caption.slice(0, CAPTION_MAX_CHARS));
      if (buttons) form.append("reply_markup", JSON.stringify({ inline_keyboard: buttons }));
      form.append("photo", blob, "photo.webp");
      return form;
    },
    timeoutMs,
    "sendPhoto (с диска)"
  );
  return result as TelegramSentMessage;
}

/** Видео файлом с диска, лениво (см. sendMediaGroupFiles) — ролик агента бывает сотни МБ.
 *  `buttons` — инлайн-кнопки под самим видео (проверка готового ролика модератором,
 *  lib/clipReview.ts, 25.09.2026): видео, а не документ, чтобы смотреть прямо в чате. */
export async function sendVideoFromDisk(
  chatId: string,
  filePath: string,
  caption?: string,
  timeoutMs = 300_000,
  buttons?: TelegramInlineButton[][]
): Promise<TelegramSentMessage> {
  if (!BASE_URL) throw new Error("TELEGRAM_BOT_TOKEN не настроен");
  const { openAsBlob } = await import("node:fs");
  const blob = await openAsBlob(filePath);
  const result = await postMultipartWithRetry(
    `${BASE_URL}/sendVideo`,
    () => {
      const form = new FormData();
      form.append("chat_id", chatId);
      if (caption) form.append("caption", caption.slice(0, CAPTION_MAX_CHARS));
      form.append("supports_streaming", "true");
      if (buttons) form.append("reply_markup", JSON.stringify({ inline_keyboard: buttons }));
      form.append("video", blob, "video.mp4");
      return form;
    },
    timeoutMs,
    "sendVideo (с диска)"
  );
  return result as TelegramSentMessage;
}

/**
 * Подпись уже отправленного медиа. `buttons` не передан — клавиатуру не трогаем
 * (посты канала); `null` — снять кнопки (решение по ролику на проверке).
 *
 * «message is not modified» — НЕ отказ (25.09.2026): подпись под постом уже
 * ровно такая, какую мы шлём, то есть цель достигнута. Раньше это летело
 * исключением, и «Обновить подписи» / обновление концовок писали в журнал
 * ошибку на каждый объект, где текст не поменялся (тот же приём, что уже
 * стоит в lib/telegramModeration.ts для editMessageText).
 */
export async function editMessageCaption(
  chatId: string,
  messageId: number,
  caption: string,
  buttons?: TelegramInlineButton[][] | null
): Promise<void> {
  try {
    await call("editMessageCaption", {
      chat_id: chatId,
      message_id: messageId,
      caption: caption.slice(0, 1024),
      ...(buttons !== undefined ? { reply_markup: { inline_keyboard: buttons ?? [] } } : {}),
    });
  } catch (err) {
    if (err instanceof Error && /message is not modified/i.test(err.message)) return;
    throw err;
  }
}

/**
 * Общий POST multipart с тем же ожиданием retry_after, что и у call() выше —
 * sendDocument/sendVideo файлом идут своим fetch (FormData, не JSON-тело) и
 * раньше вообще не знали про 429, хотя объект с 15-30 роликами (потолок
 * Settings.propertyVideoMaxCount — 30) на отправке подряд как раз в него
 * упирается первым.
 */
async function postMultipartWithRetry(
  url: string,
  buildForm: () => FormData,
  timeoutMs: number,
  label: string
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      body: buildForm(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json()) as TelegramApiResponse<unknown>;
    if (data.ok) return data.result;
    const waitMs = telegramRetryDelayMs(data, attempt);
    if (waitMs !== null) {
      await sleep(waitMs);
      continue;
    }
    throw new Error(`Telegram API ${label}: ${data.description ?? "неизвестная ошибка"}`);
  }
}

/** Что Bot API реально прислал в ответ на sendDocument — нужен `document.file_id`
 *  (24.09.2026, досылка по file_id): один раз загруженный файл дальше пересылается
 *  этой строкой (`sendDocument` ниже принимает file_id вместо URL), без повторного
 *  чтения с диска. `document` может отсутствовать в теории (Bot API его не гарантирует
 *  документированно) — вызывающий код обязан пережить `undefined` молча. */
export interface TelegramSentDocument extends TelegramSentMessage {
  document?: TelegramDocument;
}

export async function sendDocumentFile(
  chatId: string,
  /** Blob из `fs.openAsBlob` читается с диска потоком — сотни мегабайт видео
   *  не ложатся в память процесса (22.09.2026: Buffer 480-МБ .mov + его копия
   *  в `new Blob` убили api по OOM, объект №121 так и не ушёл монтажёру). */
  file: Buffer | Blob,
  filename: string,
  caption?: string,
  timeoutMs = 60_000
): Promise<TelegramSentDocument> {
  if (!BASE_URL) throw new Error("TELEGRAM_BOT_TOKEN не настроен");
  const result = await postMultipartWithRetry(
    `${BASE_URL}/sendDocument`,
    () => {
      const form = new FormData();
      form.append("chat_id", chatId);
      if (caption) form.append("caption", caption.length > CAPTION_MAX_CHARS ? `${caption.slice(0, CAPTION_MAX_CHARS - 1)}…` : caption);
      form.append("document", file instanceof Blob ? file : new Blob([file]), filename);
      return form;
    },
    timeoutMs,
    "sendDocument (файлом)"
  );
  return result as TelegramSentDocument;
}

/** Имя бота (без @) — нужно для прямой ссылки-приглашения t.me/<имя>?start=<код>
 *  (01.09.2026, привязка личного Telegram агента). Кэшируется в памяти процесса:
 *  имя бота не меняется на лету, спрашивать Telegram на каждой ссылке незачем. */
let cachedBotUsername: string | null = null;
/**
 * Проверка доступа бота к чату/каналу — дешёвый вызов без побочных эффектов.
 * Нужна суточной самопроверке (lib/integrationHealth.ts): бота могли исключить
 * из канала или лишить прав админа, и раньше это выяснялось только в момент
 * публикации ролика — объект в CRM «опубликован», а в канале пусто.
 */
export async function getChatTitle(chatId: string): Promise<string | null> {
  const chat = await call<{ title?: string; username?: string }>("getChat", { chat_id: chatId });
  return chat.title ?? chat.username ?? null;
}

export async function getBotUsername(): Promise<string | null> {
  if (cachedBotUsername) return cachedBotUsername;
  if (!BASE_URL) return null;
  try {
    const me = await call<{ username?: string }>("getMe", {});
    cachedBotUsername = me.username ?? null;
    return cachedBotUsername;
  } catch (err) {
    console.error("[telegram] getMe:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** id бота — не меняется на лету, тот же кэш-приём, что у getBotUsername выше.
 *  Нужен getChatMemberStatus ниже: Bot API просит числовой user_id, не username. */
let cachedBotId: number | null = null;
async function getBotId(): Promise<number | null> {
  if (cachedBotId) return cachedBotId;
  if (!BASE_URL) return null;
  try {
    const me = await call<{ id?: number }>("getMe", {});
    cachedBotId = me.id ?? null;
    return cachedBotId;
  } catch (err) {
    console.error("[telegram] getMe:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Статус бота в чате/канале и права писать — те же поля, что Bot API отдаёт
 *  на getChatMember: can_post_messages у канала, can_send_messages у
 *  ограниченного участника группы. Нужна суточной самопроверке дополнительных
 *  чатов Telegram (26.09.2026, lib/integrationHealth.ts). */
export interface TelegramChatMemberStatus {
  status: string;
  can_post_messages?: boolean;
  can_send_messages?: boolean;
}

export async function getChatMemberStatus(chatId: string): Promise<TelegramChatMemberStatus> {
  const botId = await getBotId();
  if (!botId) throw new Error("не удалось определить id бота (getMe)");
  return call<TelegramChatMemberStatus>("getChatMember", { chat_id: chatId, user_id: botId });
}

/** Может ли бот писать в чат — can_post_messages у канала (администратор без
 *  этого права не может постить), can_send_messages у ограниченного участника
 *  группы; kicked/left — бота в чате вообще нет. Остальные статусы (member,
 *  administrator без явного false, creator) считаются «может». Общая для
 *  суточной самопроверки (lib/integrationHealth.ts) и кнопки «Проверить» в
 *  Настройках (routes/marketing.ts) — одно правило, а не два разных. */
export function canBotWriteToChat(member: TelegramChatMemberStatus): boolean {
  if (member.status === "left" || member.status === "kicked") return false;
  if (member.can_post_messages === false) return false;
  if (member.can_send_messages === false) return false;
  return true;
}

/**
 * ВИДЕО В КАНАЛ ТЕЛОМ ЗАПРОСА, НЕ ССЫЛКОЙ (20.09.2026). Найдено на проде: из 8
 * объектов с публикациями TELEGRAM дошёл только у одного, `ErrorLog` копил
 * `Bad Request: failed to get HTTP URL content` (9 записей, последняя в тот же
 * день) — ссылка рабочая (изнутри контейнера `telegram-bot-api` скачивается
 * `HTTP/1.1 200`, правильный `Content-Length`), User-Agent ни при чём, подпись
 * ссылки живёт сутки (истечение исключено), а `uploads` в контейнер Bot API не
 * смонтирован (значит и путь на диске ему не передать) — то есть загрузчик
 * ссылок внутри самого Bot API падает по причине, которую дальше копать не
 * дешевле, чем перестать от неё зависеть. Свой Bot API (`--local`) принимает
 * тело до 2 ГБ (см. TELEGRAM_BOT_SEND_LIMIT_BYTES) — этого с запасом хватает на
 * ролики в десятки мегабайт, поэтому дальше идём тем же способом, что и
 * sendDocumentFile ниже: multipart, без похода за файлом по сети.
 *
 * sendVideo (пережимает под плеер) — ровно то, что нужно для канала, в отличие
 * от sendDocumentFile у монтажёра (см. докстринг там). thumbnail — тем же
 * multipart-полем: Bot API распознаёт обложку по имени поля "thumbnail", когда
 * это настоящая часть формы, а не строка attach://.
 */
/**
 * Реальные width/height/duration ролика (lib/ffmpeg.ts::probeVideoDimensions,
 * вызывается в socialPublish.ts до отправки). Раньше, когда видео уходило
 * ССЫЛКОЙ, Telegram определял их сам при скачивании; при отправке телом
 * запроса он их не знает и без этих полей рисует вертикальный Reels квадратом
 * (регрессия PR #586, найдено 21.09.2026 на объекте ОБ-000113). Необязательны:
 * ffprobe мог не определить размеры (недоступен, битый файл) — тогда просто не
 * передаём поля, как было, и вызывающий обязан записать причину в журнал.
 */
export interface TelegramVideoDimensions {
  width: number;
  height: number;
  /** Секунды, целое — Bot API ожидает Integer. */
  duration: number;
}

export async function sendVideoFile(
  chatId: string,
  /** Blob с диска (socialPublish: ролик до 2 ГБ не читается в память целиком, №80) или буфер. */
  buffer: Buffer | Blob,
  filename: string,
  caption?: string,
  thumbnail?: { buffer: Buffer; filename: string } | null,
  /**
   * 120с — то же, что раньше было отведено на скачивание ролика ПО ССЫЛКЕ
   * Telegram'ом (TELEGRAM_VIDEO_TIMEOUT_MS в socialPublish.ts). Теперь это
   * время уходит на отправку тела запроса нашим сервером в контейнер Bot API
   * (локальная сеть, быстро) и его собственную передачу байтов в инфраструктуру
   * Telegram (внешняя сеть, самое узкое место) — тот же порядок величины, что и
   * раньше, менять не за что: ролики те же десятки мегабайт, путь тот же провод.
   */
  timeoutMs = 120_000,
  dimensions?: TelegramVideoDimensions | null
): Promise<unknown> {
  if (!BASE_URL) throw new Error("TELEGRAM_BOT_TOKEN не настроен");
  return postMultipartWithRetry(
    `${BASE_URL}/sendVideo`,
    () => {
      const form = new FormData();
      form.append("chat_id", chatId);
      if (caption) form.append("caption", caption.length > CAPTION_MAX_CHARS ? `${caption.slice(0, CAPTION_MAX_CHARS - 1)}…` : caption);
      form.append("video", buffer instanceof Blob ? buffer : new Blob([buffer]), filename);
      if (thumbnail) form.append("thumbnail", new Blob([thumbnail.buffer]), thumbnail.filename);
      if (dimensions) {
        form.append("width", String(Math.round(dimensions.width)));
        form.append("height", String(Math.round(dimensions.height)));
        form.append("duration", String(Math.round(dimensions.duration)));
        // Вертикальные Reels 1080x1920 — должны проигрываться во всю высоту, не
        // требуя полной закачки перед стартом (см. докстринг регрессии выше).
        form.append("supports_streaming", "true");
      }
      return form;
    },
    timeoutMs,
    "sendVideo (файлом)"
  );
}

export function sendVideo(chatId: string, videoUrl: string, caption?: string, timeoutMs?: number, thumbnailUrl?: string | null): Promise<unknown> {
  // timeoutMs — для публикации в канал (socialPublish): Telegram качает видео по
  // ссылке синхронно внутри запроса, и стандартных 15 секунд большому ролику мало.
  // thumbnail (31.08.2026) — та же обложка, что уходит в Instagram (lib/video/
  // coverStill.ts); Bot API принимает её тем же способом, что video/photo выше —
  // прямой HTTP(S)-ссылкой, без multipart-загрузки.
  return call(
    "sendVideo",
    { chat_id: chatId, video: videoUrl, ...(thumbnailUrl ? { thumbnail: thumbnailUrl } : {}), ...fitCaption(caption) },
    timeoutMs
  );
}

export function sendDocument(chatId: string, fileUrl: string, caption?: string): Promise<unknown> {
  return call("sendDocument", { chat_id: chatId, document: fileUrl, ...fitCaption(caption) });
}

/** Голосовое — строго audio/ogg с кодеком Opus, как и у WhatsApp: тот же файл,
 *  что transcodeToOggOpus уже готовит для Meta-каналов, подходит без изменений.
 *  direct_messages_topic_id — тот же смысл, что у sendMessage выше: без него
 *  голосовое в Direct Messages канала ушло бы «куда-то в канал», а не в топик
 *  конкретного человека (13.09.2026, голосовые ответы бота). */
export function sendVoice(chatId: string, voiceUrl: string, directMessagesTopicId?: number): Promise<unknown> {
  return call("sendVoice", {
    chat_id: chatId,
    voice: voiceUrl,
    ...(directMessagesTopicId ? { direct_messages_topic_id: directMessagesTopicId } : {}),
  });
}

/** Голосовое/аудио во входящем сообщении — берём только метаданные, файл качаем по file_id. */
export interface TelegramVoice {
  file_id: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

/** Один из размеров присланного фото. Telegram отдаёт лесенку превью — нам нужен
 * последний элемент массива (самый крупный): на сжатом превью текст интерфейса
 * в скриншоте нечитаем, а именно ради него скриншот и присылают. */
export interface TelegramPhotoSize {
  file_id: string;
  width?: number;
  height?: number;
  file_size?: number;
}

/** Файл, присланный документом. Скриншот с компьютера часто приходит именно так
 * («отправить без сжатия»), а не фотографией. */
export interface TelegramDocument {
  file_id: string;
  /** Второй идентификатор Bot API — тот же файл может иметь разный file_id у
   *  разных ботов/сессий, а file_unique_id — нет (24.09.2026, досылка по file_id). */
  file_unique_id?: string;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
}

/** Медиа-часть входящего сообщения. Вынесена отдельно, чтобы разбор вложений
 * жил одним куском кода (telegram/attachments.ts): клиент присылает и фото
 * квартиры, и голосовое, и документ. */
/** Обычное видео (не кружок video_note) — сейчас нужно только для приёма готового
 *  ролика от монтажёра (01.09.2026, см. lib/videoHandoff.ts); в клиентском боте
 *  видео от клиента не встречалось раньше и не разбиралось вовсе. */
export interface TelegramVideoFile {
  file_id: string;
  file_size?: number;
  mime_type?: string;
  duration?: number;
}

export interface TelegramMedia {
  voice?: TelegramVoice;
  audio?: TelegramVoice;
  video_note?: TelegramVoice;
  video?: TelegramVideoFile;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  /** Стикер/гиф-анимация — нужны только затем, чтобы отличить их от готового
   *  ролика в чате монтажёра и ответить по существу (23.09.2026, находка B1),
   *  содержимое файла не используется нигде. */
  sticker?: { file_id: string };
  animation?: { file_id: string };
  /** Геометка. Содержимое не используется — нужна, чтобы сообщение с одной
   *  геометкой не исчезало из переписки без следа (ночная проверка 24.09.2026). */
  location?: { latitude: number; longitude: number };
}

/** Обычное сообщение клиентскому боту. */
export interface TelegramIncomingMessage extends TelegramMedia {
  /** Не заполнен у синтетических сообщений старых тестов — только новый код
   *  (комментарии группы-обсуждения) полагается на это поле. */
  message_id?: number;
  chat: {
    id: number;
    /** "private" — личка с ботом (клиент/сотрудник); "group"/"supergroup" —
     *  группа, в частности группа-обсуждение канала; "channel" сюда не
     *  приходит — посты канала боту доставляются от лица группы-зеркала.
     *  Direct Messages канала (01.09.2026) — тоже "supergroup", отличить
     *  можно только по `is_direct_messages` ниже, не по type. */
    type?: string;
    /** true — это инбокс Direct Messages канала (проверено вживую 01.09.2026):
     *  один и тот же chat.id общий для ВСЕХ, кто написал каналу напрямую,
     *  Telegram различает их через direct_messages_topic.topic_id. */
    is_direct_messages?: boolean;
  };
  /** id нужен сверке «визитка — своя»: нативная кнопка request_contact несёт
   *  contact.user_id отправителя, чужая визитка из телефонной книги — нет. */
  from?: { id?: number; username?: string; first_name?: string; is_bot?: boolean };
  /** Сообщение от имени канала или группы (анонимный админ, «от лица канала»). */
  sender_chat?: { id: number; type?: string };
  text?: string;
  /** Подпись к фото/файлу — это тоже слова клиента, а не служебное поле. */
  caption?: string;
  /** Альбом: клиент отправил несколько фото одной пачкой. Telegram шлёт их
   * ОТДЕЛЬНЫМИ сообщениями с общим идентификатором, а подпись кладёт лишь в одно
   * из них — по этому полю мы склеиваем их обратно в одно обращение (telegram/bot.ts). */
  media_group_id?: string;
  contact?: { phone_number: string; first_name?: string; user_id?: number };
  /** true — Telegram сам переслал пост канала в группу-обсуждение (зеркало).
   *  Комментарий приходит ОТДЕЛЬНЫМ сообщением с reply_to_message на это зеркало,
   *  а не на сам пост в канале — у поста и у зеркала разные message_id. */
  is_automatic_forward?: boolean;
  /** У зеркала поста — откуда оно переслано: для поста канала `message_id` исходного
   *  поста в канале (по нему комментарий привязывается к объекту, «голос рынка»). */
  forward_origin?: { type?: string; message_id?: number };
  /** Устаревшее поле Bot API с тем же смыслом, что forward_origin.message_id. */
  forward_from_message_id?: number;
  /** Заполнено, если это ответ на другое сообщение группы — так отличаем
   *  комментарий «под постом» от случайной реплики в общем чате. */
  reply_to_message?: TelegramIncomingMessage;
  /** Ветка обсуждения. В группе-обсуждении канала Telegram ставит его КАЖДОМУ
   *  комментарию под постом и равным message_id зеркала поста — в том числе
   *  ответу на чужой комментарий и ответу на реплику бота, у которых
   *  reply_to_message указывает уже не на зеркало (см. isCommentUnderPost).
   *  У самого зеркала совпадает с его message_id. */
  message_thread_id?: number;
  /** Direct Messages канала (01.09.2026, реальный вид апдейта проверен через
   *  getUpdates). topic_id — ключ конкретного отправителя внутри общего
   *  chat.id; user — его данные, готовые, без отдельного резолва. */
  direct_messages_topic?: {
    topic_id: number;
    user?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
  };
}

/** Нажатие инлайн-кнопки. from.id нужен, чтобы отличить чат клиента от группы
 *  (в личке с ботом chat.id и from.id совпадают, но полагаться на это нельзя). */
export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  /** message_id — чтобы модерация (lib/telegramModeration) правила именно то
   *  сообщение, под которым нажали кнопку. */
  message?: { chat: { id: number }; message_id?: number };
  from?: { id: number; username?: string; first_name?: string };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramIncomingMessage;
  callback_query?: TelegramCallbackQuery;
}

/** Long polling держит соединение открытым до 25 секунд штатно, поэтому общий
 * таймаут ему не подходит — рвать надо с запасом, иначе каждый тихий опрос
 * (клиенты молчат — обычное дело ночью) выглядел бы отказом связи. */
const POLL_TIMEOUT_SEC = 25;
const POLL_ABORT_MS = (POLL_TIMEOUT_SEC + 10) * 1000;

export function getUpdates(offset: number): Promise<TelegramUpdate[]> {
  return call<TelegramUpdate[]>("getUpdates", {
    offset,
    timeout: POLL_TIMEOUT_SEC,
    // Сообщения и нажатия инлайн-кнопок клиентскому боту: личная переписка
    // директора (Telegram Business) по-прежнему не разбирается.
    allowed_updates: ["message", "callback_query"],
  }, POLL_ABORT_MS);
}

/**
 * Переключение на вебхук (19.08.2026). secretToken уходит Telegram и потом
 * возвращается в каждом запросе заголовком X-Telegram-Bot-Api-Secret-Token —
 * это единственный способ убедиться, что POST /webhooks/telegram зовёт
 * реально Telegram, а не кто угодно, кто угадал публичный адрес.
 */
export function setWebhook(url: string, secretToken: string): Promise<unknown> {
  return call("setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message", "callback_query"],
    // Сбрасываем недоставленные апдейты старого long polling — иначе первый
    // вебхук-запрос принёс бы вперемешку хвост из очереди getUpdates.
    drop_pending_updates: true,
  });
}

/** Возврат на long polling — снимает вебхук, чтобы Telegram не пытался
 *  стучаться на адрес, который сервер больше не слушает. */
export function deleteWebhook(): Promise<unknown> {
  return call("deleteWebhook", { drop_pending_updates: false });
}

/** Лимит на скачиваемое вложение: голосовое в Telegram — десятки КБ, всё крупнее
 * почти наверняка не голосовое, и буферизовать его в память незачем. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * Адрес файла на файловом CDN Telegram.
 *
 * Файл забирается в два шага: getFile по file_id отдаёт относительный путь, и уже
 * по нему идёт скачивание — с маркером бота ПРЯМО В АДРЕСЕ. Поэтому такой адрес
 * нельзя писать в журнал и отдавать наружу: он равнозначен маркеру.
 *
 * Возвращаем адрес, а не байты, нарочно: скачиванием, определением типа и лимитом
 * размера занимается общий загрузчик вложений (messengers/attachments.ts) — тот же,
 * что обслуживает Instagram, WhatsApp и Messenger. Второй такой же здесь не нужен.
 *
 * null — файла нет, он слишком большой или Telegram недоступен.
 */
/**
 * Где именно лежит файл Telegram: адресом для скачивания (облако) или путём на
 * нашем диске (свой сервер с `--local`, который «receive the absolute local path
 * as a value of the file_path field»).
 *
 * Разделение нужно потому, что дальше пути расходятся принципиально: адрес надо
 * качать через safeFetch со всеми проверками переходов, а путь — просто прочесть.
 * Склеивать их в одну строку нельзя: `file://` в общем загрузчике вложений
 * означал бы дыру ровно того класса, от которой этот загрузчик и защищается.
 */
export type TelegramFileRef = { kind: "path"; path: string } | { kind: "url"; url: string };

/** Абсолютный путь: `/var/lib/telegram-bot-api/...` или `C:\...`. */
function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * СВОЙ ТАЙМАУТ ДЛЯ getFile НА СВОЁМ BOT API-СЕРВЕРЕ (24.09.2026).
 *
 * На облаке Telegram getFile — мгновенный ответ, 15с общего `CALL_TIMEOUT_MS`
 * с запасом хватает всегда. На своём сервере (`TELEGRAM_API_BASE_URL`,
 * `IS_LOCAL_BOT_API`) getFile — это не просто чтение метаданных: сервер сам
 * СКАЧИВАЕТ файл у Telegram, если ещё не скачал, и отвечает только когда
 * докачал целиком. На 200+ МБ ролике монтажёра или при медленном канале это
 * секунды-десятки секунд, иногда больше — общий 15-секундный лимит отказывал
 * там, где сервер просто ещё качал, а не был недоступен (разбор 24.09.2026).
 * 180с — тот же потолок, что у самых дорогих внешних шагов конвейера
 * сообщения (см. STALE_AFTER_MS в lib/webhookDedupe.ts: разбор Gemini File
 * API/расшифровки).
 */
const GET_FILE_TIMEOUT_MS = 180_000;

export async function resolveTelegramFile(
  fileId: string,
  maxBytes: number = MAX_FILE_BYTES
): Promise<TelegramFileRef | null> {
  if (!TOKEN) return null;
  try {
    const file = await call<{ file_path?: string; file_size?: number }>(
      "getFile",
      { file_id: fileId },
      GET_FILE_TIMEOUT_MS
    );
    if (!file.file_path) return null;
    // Размер Telegram сообщает сам — отсекаем ДО скачивания, а не после.
    if (file.file_size && file.file_size > maxBytes) {
      console.warn(`[telegram] файл ${fileId} слишком большой (${file.file_size} байт) — пропускаем`);
      return null;
    }
    if (isAbsoluteFilePath(file.file_path)) return { kind: "path", path: file.file_path };
    return { kind: "url", url: `${API_ROOT}/file/bot${TOKEN}/${file.file_path}` };
  } catch (err) {
    console.error("[telegram] getFile:", err instanceof Error ? err.message : err);
    void logSystemError("telegram", `getFile ${fileId}: ${describeError(err)}`);
    return null;
  }
}

/**
 * Адрес для скачивания. Остаётся ради вызывающих, которым нужен именно адрес;
 * на своём сервере в режиме `--local` адреса не существует — там файл уже лежит
 * на диске, и такой вызывающий обязан перейти на resolveTelegramFile.
 */
export async function fileDownloadUrl(fileId: string, maxBytes: number = MAX_FILE_BYTES): Promise<string | null> {
  const ref = await resolveTelegramFile(fileId, maxBytes);
  if (!ref) return null;
  if (ref.kind === "url") return ref.url;
  void logSystemError(
    "telegram",
    `Файл ${fileId} отдан локальным Bot API путём (${ref.path}), а вызывающему нужен адрес — используйте resolveTelegramFile`
  );
  return null;
}

/**
 * Адрес самой свежей фотографии профиля пользователя Telegram (getUserProfilePhotos → getFile).
 *
 * null — фото нет, профиль закрыт, или Telegram недоступен: аватар клиента — приятное
 * дополнение к карточке, а не условие обработки сообщения, поэтому здесь всегда
 * возвращается либо адрес, либо null, и ничего не бросается наружу.
 *
 * Как и fileDownloadUrl, адрес несёт маркер бота ПРЯМО В СЕБЕ — его нельзя сохранять
 * в базу как есть, только скачать и сохранить локальную копию (см. lib/clientAvatar.ts).
 */
export async function getUserProfilePhotoUrl(userId: string): Promise<string | null> {
  if (!BASE_URL) return null;
  // Отрицательный id — это группа/канал, а не человек: getUserProfilePhotos на такой
  // id либо ответит ошибкой, либо (страшнее) фотографией чужой группы. chatId ==
  // userId верно только для личных чатов, ровно на них и рассчитан этот вызов.
  if (!/^\d+$/.test(userId)) return null;
  try {
    const res = await call<{ total_count: number; photos: Array<Array<{ file_id: string }>> }>(
      "getUserProfilePhotos",
      { user_id: Number(userId), limit: 1 }
    );
    const fileId = res.photos?.[0]?.[0]?.file_id;
    if (!fileId) return null;
    return await fileDownloadUrl(fileId);
  } catch (err) {
    console.error("[telegram] getUserProfilePhotos:", err instanceof Error ? err.message : err);
    void logSystemError("telegram", `getUserProfilePhotos ${userId}: ${describeError(err)}`);
    return null;
  }
}

/**
 * ПОТОЛКИ TELEGRAM — ИХ ДВА, И ОНИ РАЗНЫЕ. Путать их дорого: до 12.09.2026
 * отправка монтажёру была зажата потолком СКАЧИВАНИЯ, и ролики 20–50 МБ не
 * доходили файлом, хотя облако их пропускает.
 *
 * Дословно из core.telegram.org/bots/api:
 *  — отправка: «Bots can currently send files of any type of up to 50 MB in size»;
 *  — скачивание: «For the moment, bots can download files of up to 20MB in size»;
 *  — свой сервер: «Download files without a size limit. Upload files up to 2000 MB».
 *
 * На своём сервере скачивание не ограничено вовсе, но бесконечности в коде нет —
 * ставим тот же 2 ГБ, что и на отправку: это предохранитель от того, чтобы
 * прочитать в память файл произвольного размера, а не лимит Telegram.
 */
const LOCAL_API_LIMIT_BYTES = 2000 * 1024 * 1024;

/** Сколько бот может СКАЧАТЬ (getFile). Облако — 20 МБ, свой сервер — без предела. */
export const TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES = IS_LOCAL_BOT_API ? LOCAL_API_LIMIT_BYTES : 20 * 1024 * 1024;

/** Сколько бот может ОТПРАВИТЬ (sendDocument). Облако — 50 МБ, свой сервер — 2 ГБ. */
export const TELEGRAM_BOT_SEND_LIMIT_BYTES = IS_LOCAL_BOT_API ? LOCAL_API_LIMIT_BYTES : 50 * 1024 * 1024;

/** Итог «дай путь или буфер» (23.09.2026, приём ролика от монтажёра — см.
 *  lib/videoHandoff.ts::receiveEditedVideoFromFile). Файл своего Bot API
 *  (kind "path") отдаётся путём и НЕ читается в память здесь: он лежит на общем
 *  томе и принадлежит процессу bot-api, а не нам — читать гигабайтный ролик в
 *  буфер только ради того, чтобы тут же записать его копию на диск, лишняя
 *  память процесса (лимит контейнера — 768 МБ, см. dispatchToEditor). Облачный
 *  файл (kind "buffer") скачивать иначе, кроме как в память, нечем. */
export type TelegramFileMaterialization = { kind: "path"; path: string } | { kind: "buffer"; buffer: Buffer };

/**
 * Резолвит file_id в путь ИЛИ буфер, без лишнего чтения с диска. Ровно то же
 * определение размера и таймауты, что у downloadFile (он теперь построен поверх
 * этой функции — второй копии одной и той же сетевой логики в файле нет).
 */
export async function resolveTelegramFileMaterialization(
  fileId: string,
  maxBytes: number = MAX_FILE_BYTES
): Promise<TelegramFileMaterialization | null> {
  const ref = await resolveTelegramFile(fileId, maxBytes);
  if (!ref) return null;
  if (ref.kind === "path") return { kind: "path", path: ref.path };
  try {
    const res = await fetch(ref.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel();
      console.error(`[telegram] скачивание файла ${fileId}: HTTP ${res.status}`);
      void logSystemError("telegram", `Скачивание файла ${fileId}: HTTP ${res.status}`);
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.byteLength > maxBytes ? null : { kind: "buffer", buffer };
  } catch (err) {
    console.error("[telegram] downloadFile:", err instanceof Error ? err.message : err);
    void logSystemError("telegram", `Скачивание файла ${fileId}: ${describeError(err)}`);
    return null;
  }
}

/** Скачивает файл Telegram по file_id (getFile → CDN). null, если файл слишком
 * большой, недоступен или сеть подвела — вызывающий код должен пережить это без падения.
 * maxBytes по умолчанию рассчитан на голосовые (крохотные). Для приёма ролика от
 * монтажёра (lib/videoHandoff.ts) эта функция больше не годится напрямую — там
 * нужен resolveTelegramFileMaterialization, чтобы не читать файл Bot API в память
 * зря; здесь оставлена ради остальных вызывающих, которым нужен именно буфер. */
export async function downloadFile(fileId: string, maxBytes: number = MAX_FILE_BYTES): Promise<Buffer | null> {
  const material = await resolveTelegramFileMaterialization(fileId, maxBytes);
  if (!material) return null;
  if (material.kind === "buffer") return material.buffer;
  // Свой сервер уже положил файл на общий том — читаем с диска, ничего не качая.
  // Размер проверяем по stat ДО чтения: иначе двухгигабайтный файл окажется
  // в памяти процесса раньше, чем мы поймём, что он слишком большой.
  try {
    const stat = await fsp.stat(material.path);
    if (stat.size > maxBytes) {
      console.warn(`[telegram] файл ${fileId} слишком большой (${stat.size} байт) — пропускаем`);
      return null;
    }
    return await fsp.readFile(material.path);
  } catch (err) {
    console.error("[telegram] чтение локального файла:", err instanceof Error ? err.message : err);
    void logSystemError("telegram", `Чтение файла ${fileId} с диска (${material.path}): ${describeError(err)}`);
    return null;
  }
}
