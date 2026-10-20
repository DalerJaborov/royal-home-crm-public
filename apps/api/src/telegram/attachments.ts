/**
 * Вложения из Telegram → общий конвейер вложений мессенджеров.
 *
 * Instagram, WhatsApp и Messenger приходят в CRM через processMessengerTurn, и фото
 * с голосовыми у них скачиваются, сохраняются и видны в переписке. У Telegram своя
 * таблица и свой путь обработки, который мимо этого конвейера и проходил: клиент
 * присылал фото квартиры, а в карточке оставалась пустота. Этот модуль — недостающий
 * переходник, а не второй загрузчик.
 *
 * Разница у Telegram ровно одна: файл берётся в два шага (getFile по file_id, затем
 * скачивание по выданному пути с маркером бота в адресе). Первый шаг делает
 * telegram/api.ts, дальше работает общий загрузчик messengers/attachments.ts — он же
 * держит лимиты, таймауты и определение типа содержимого.
 */

import { fetchAttachments, type AttachmentSource, type FetchedAttachments } from "../messengers/attachments.js";
import { resolveTelegramFile, type TelegramMedia } from "./api.js";

/** Что мы умеем открыть, если файл пришёл документом. Остальное честно помечаем
 * как «не открылось»: врать клиенту, будто мы посмотрели файл, нельзя. Список
 * совпадает с тем, что принимает закрытое хранилище (lib/privateFiles.ts) — сохранить
 * то, чего оно не примет, всё равно не выйдет. */
const OPENABLE_DOCUMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
]);

interface Candidates {
  fileIds: string[];
  /** К сообщению приложено что-то, чего мы заведомо не откроем. */
  unsupported: boolean;
}

/**
 * Что из сообщения имеет смысл качать.
 *
 * Заведомо непригодное отсекаем ЗДЕСЬ, не тратя запрос к Telegram: видеокружок и
 * произвольный документ нам всё равно нечем ни показать в переписке, ни сохранить.
 */
function collect(msg: TelegramMedia): Candidates {
  const fileIds: string[] = [];
  let unsupported = false;

  // Telegram отдаёт лесенку превью; последний элемент — самый крупный. На сжатом
  // превью не разобрать ни планировку, ни надписи, а присылают фото именно ради них.
  const largestPhoto = msg.photo?.[msg.photo.length - 1];
  if (largestPhoto) fileIds.push(largestPhoto.file_id);

  // Голосовое и присланный аудиофайл идут в расшифровку одинаково.
  const voice = msg.voice ?? msg.audio;
  if (voice) fileIds.push(voice.file_id);

  // Видеокружок: звук в нём есть, но хранить его негде и показать в переписке нечем.
  // Честная пометка лучше молчаливого исчезновения сообщения.
  if (msg.video_note) unsupported = true;

  // Обычное видео (рум-тур продавца) раньше не бралось вовсе и не помечалось —
  // без подписи сообщение исчезало из переписки без следа (ночная проверка
  // 24.09.2026). Идёт общим загрузчиком как видео-документ: белый список типов и
  // пределы по весу/длине — в messengers/attachments.ts. Стикер, гифка и геометка
  // не скачиваются, но помечаются, чтобы агент их видел.
  if (msg.video) fileIds.push(msg.video.file_id);
  if (msg.sticker || msg.animation || msg.location) unsupported = true;

  if (msg.document) {
    // Фото с компьютера часто приходит документом («отправить без сжатия») — такое
    // берём. Договор в pdf не возьмём, но клиент об этом узнает, а не будет гадать.
    if (msg.document.mime_type && OPENABLE_DOCUMENT_TYPES.has(msg.document.mime_type)) {
      fileIds.push(msg.document.file_id);
    } else {
      unsupported = true;
    }
  }

  return { fileIds, unsupported };
}

/**
 * Пометка в переписку вместо пустой реплики, когда в сообщении только то, чего мы
 * не открываем (видеокружок, стикер, гифка, геометка). По ней агент видит, что
 * прислал клиент, а модель — что часть сообщения не дошла. Для остального
 * (документ чужого типа, файл не скачался) — прежняя общая пометка.
 */
export function telegramUnsupportedMark(msgs: TelegramMedia[]): string {
  const kinds = new Set<string>();
  for (const msg of msgs) {
    if (msg.video_note) kinds.add("видеокружок");
    if (msg.sticker) kinds.add("стикер");
    if (msg.animation) kinds.add("гифка");
    if (msg.location) kinds.add("геометка");
  }
  return kinds.size > 0 ? `[${[...kinds].join(", ")}]` : "[📎 файл не открылся]";
}

/** Вложений в сообщении не было вовсе. */
const NOTHING: FetchedAttachments = { images: [], audios: [], medias: [], hadUnsupported: false };

/**
 * Скачивает вложения сообщения Telegram. Ошибки наружу не выбрасывает: недоступный
 * файл не должен ронять обработку самого сообщения — слова клиента важнее.
 */
export function fetchTelegramAttachments(msg: TelegramMedia): Promise<FetchedAttachments> {
  return fetchTelegramAlbumAttachments([msg]);
}

/**
 * То же самое для АЛЬБОМА: несколько сообщений, склеенных по media_group_id.
 *
 * Telegram присылает альбом отдельными сообщениями — по одному на снимок, — и
 * склеивает их только общий идентификатор группы. Разбирая их поодиночке, бот
 * скачивал бы по одному фото за раз и отвечал столько раз, сколько снимков прислал
 * клиент. Поэтому кандидаты собираются со ВСЕЙ пачки, а лимит на число скачиваемых
 * файлов остаётся один (MAX_FILES в messengers/attachments.ts): лишнее честно
 * помечается «не открылось», а не тянется в память десятком картинок.
 */
export async function fetchTelegramAlbumAttachments(msgs: TelegramMedia[]): Promise<FetchedAttachments> {
  const collected = msgs.map(collect);
  const fileIds = collected.flatMap((c) => c.fileIds);
  const unsupported = collected.some((c) => c.unsupported);
  if (fileIds.length === 0) return unsupported ? { ...NOTHING, hadUnsupported: true } : NOTHING;

  // resolveTelegramFile, а не fileDownloadUrl: на своём Bot API сервере (--local)
  // файл уже лежит на нашем диске и адреса для скачивания у него нет вовсе.
  // В этом случае в источник уходит путь, а поле url остаётся подписью для
  // журнала и подсказкой расширения — по нему никто никуда не идёт.
  const refs = await Promise.all(fileIds.map((fileId) => resolveTelegramFile(fileId)));
  const sources: AttachmentSource[] = refs
    .filter((ref): ref is NonNullable<typeof ref> => !!ref)
    .map((ref) => (ref.kind === "url" ? { url: ref.url } : { url: ref.path, localPath: ref.path }));
  // getFile не ответил по части файлов — это тоже «вложение не дошло», а не пустое сообщение.
  const lostOnResolve = sources.length < fileIds.length;

  const fetched = await fetchAttachments(sources);
  return { ...fetched, hadUnsupported: fetched.hadUnsupported || unsupported || lostOnResolve };
}
