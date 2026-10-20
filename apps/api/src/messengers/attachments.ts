/**
 * Загрузка вложений из мессенджеров и классификация по типу: фото уходят в модель
 * vision-блоками, аудио — в расшифровку речи (см. ai/transcribe.ts), видео и документы —
 * в описание (см. ai/geminiMedia.ts). Что осталось непонятым (чужой формат, слишком
 * большой или слишком длинный файл) помечается hadUnsupported — диалоговый слой
 * добавляет модели пометку, чтобы бот честно сказал, что открыть файл не может.
 *
 * Источники разные: Instagram и Messenger дают прямой адрес файла на CDN,
 * а WhatsApp — только идентификатор медиа, и скачивание требует маркера в заголовке
 * (адрес добывается заранее, см. whatsAppMediaSource в messengers/meta.ts). Поэтому
 * на входе не голые адреса, а источники с необязательными заголовками.
 */

import os from "node:os";
import { traceMeasured } from "../lib/botTurnTrace.js";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { savePrivateFile } from "../lib/privateFiles.js";
import { safeOpen, readCapped, UnsafeUrlError } from "../lib/safeFetch.js";
import { probeDurationSec } from "../lib/propertyClipVideo.js";
import type { StoredAttachment } from "../ai/shared.js";

const MAX_FILES = 3;

/**
 * Потолок размера — свой у каждого вида, и это не придирка.
 *
 * Пять мегабайт хватало, пока мы качали только фотографии и голосовые. Рум-тур
 * продавца почти всегда тяжелее, и с общим потолком в 5 МБ подключение видео к
 * Gemini не дало бы ровно ничего: файл отсекался бы до всякого разбора.
 *
 * Откуда каждое число (пересмотрено 21.08.2026, владелец — про расходы и зависания):
 *
 *  - ФОТО 5 МБ. Не меняли: столько же принимает сам WhatsApp на отправку фото, и
 *    картинка уходит в модель base64-блоком, где вес пересчитывается в токены почти
 *    линейно.
 *  - АУДИО 3 МБ, а не общие 5. Голосовое клиента — это просьба или адрес, а не
 *    лекция: opus из WhatsApp весит ~16 кБ/с, то есть 5 МБ — это до сорока минут
 *    речи, и все они ушли бы в самую дорогую расшифровку целиком. Три мегабайта
 *    покрывают всякое осмысленное голосовое с запасом.
 *  - ВИДЕО И ДОКУМЕНТЫ 16 МБ вместо прежних 25. Шестнадцать — это собственный
 *    потолок WhatsApp на видео, то есть оттуда крупнее не приходит вовсе; сверх
 *    него шлют только Instagram и Messenger, и это ровно те файлы, ради которых
 *    не стоит занимать диск (на сервере занято 78%) и минуту живого разговора.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

/**
 * Второй потолок — по длительности, и он не про память, а про счёт за разбор.
 *
 * Вес и длительность связаны слабо: три мегабайта opus — это и полторы минуты, и
 * полчаса, смотря как сжали. Платим же мы за секунды: расшифровка считает
 * длительность, разбор видео — кадры, и один часовой файл стоит дороже, чем весь
 * дневной поток переписки.
 *
 *  - АУДИО 600 секунд (10 минут). Верхняя граница того, что человек вообще
 *    наговаривает в переписку; всё длиннее — это пересланная запись разговора или
 *    чужой подкаст, отвечать по ним всё равно нечего.
 *  - ВИДЕО 180 секунд (3 минуты). Обход квартиры на телефоне укладывается в
 *    три минуты (тот же порядок, что MAX_CLIP_VIDEO_DURATION_SEC у ролика
 *    объекта), а 5–10 минут сжатого мобильного видео — это ~100–150 тысяч
 *    входных токенов за один присланный файл.
 */
const MAX_AUDIO_DURATION_SEC = 600;
const MAX_VIDEO_DURATION_SEC = 180;

/**
 * Один таймаут на всю загрузку, и он рассчитан на самый тяжёлый случай.
 *
 * Раздельного «быстрого» таймаута для картинок тут быть не может: тип файла становится
 * известен только из заголовков ответа, то есть уже внутри запроса. Пятнадцати секунд,
 * которых хватало фотографиям, на 25 МБ видео не хватит — а срыв по таймауту выглядит
 * для клиента так же, как «мы не умеем читать видео», ради чего всё и затевалось.
 */
const FETCH_TIMEOUT_MS = 60_000;

/**
 * Сколько перенаправлений позволяем на пути к файлу.
 *
 * Меньше нельзя: CDN мессенджеров кладёт файл не там, где выдал ссылку —
 * lookaside.fbsbx.com переводит на scontent.*.fbcdn.net, иногда через
 * промежуточный адрес, и запрет редиректов оставил бы нас вообще без вложений
 * WhatsApp. Больше незачем: цепочка длиннее четырёх — это не переезд файла, а
 * либо петля, либо чужая попытка держать наш ход открытым, пока клиент ждёт ответа.
 */
const MAX_REDIRECTS = 4;

/** Единственные media_type, которые принимает Anthropic для image-блоков. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const AUDIO_TYPES = new Set([
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/wav",
  "audio/webm",
  "application/ogg",
]);

/** Видео, которые Gemini разбирает как есть. Список белый, а не «всё video/*»:
 *  экзотику модель отвергнет уже после того, как мы потратим минуту на загрузку. */
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/3gpp", "video/mpeg"]);

/**
 * Документы. Только PDF и простой текст — то, что Gemini действительно читает.
 *
 * .docx и .xlsx сюда НЕ входят намеренно: это zip-архивы, и модель увидела бы в них
 * двоичный мусор. Обещать разбор того, что не разбирается, хуже честного «не открылся»:
 * бот пересказал бы клиенту выдумку о его собственном документе.
 */
const DOCUMENT_TYPES = new Set(["application/pdf", "text/plain"]);

export interface FetchedImage {
  kind: "image";
  mediaType: string;
  /** base64 без префикса data: */
  data: string;
}

export interface FetchedAudio {
  kind: "audio";
  mediaType: string;
  buffer: Buffer;
  /** Расширение имени: Gemini берёт тип из mime_type, но имя попадает в журнал
   *  при неудачной расшифровке — по нему видно, какой именно файл не разобрался. */
  filename: string;
}

export interface FetchedMedia {
  kind: "media";
  /** Что именно прислали — от этого зависит вопрос к модели (ai/geminiMedia.ts). */
  media: "video" | "document";
  mediaType: string;
  buffer: Buffer;
  /** Имя для журнала: по нему видно, какой файл не разобрался. */
  filename: string;
}

interface Detected {
  kind: "image" | "audio" | "video" | "document" | "unsupported";
  /** Точный media_type из белого списка (для image — гарантированно из IMAGE_TYPES). */
  mediaType: string;
  ext: string;
}

/** Классификация и нормализация типа за один проход: Content-Type в приоритете,
 * фолбэк — расширение в URL (CDN мессенджеров любит application/octet-stream).
 * Итоговый media_type ВСЕГДА из белых списков — Anthropic отвергает экзотику
 * вроде image/jpg или image/heic, а расшифровка речи ждёт точный audio/*.
 *
 * `declaredKind` — то, чем вложение назвала САМА платформа в вебхуке
 * (Meta: attachments[].type = "audio" | "video" | "image" | "file"). Нужен
 * из-за живого случая 17.08.2026: голосовое из Messenger приходит файлом
 * `.mp4` с Content-Type видео, и по одним лишь расширению с типом оно
 * неотличимо от настоящего видео — попадало в описание видео (Gemini) вместо
 * расшифровки речи, то есть речь клиента не читалась ВООБЩЕ. Платформа при
 * этом честно писала "audio", а мы этот ответ выбрасывали. */
function detect(contentType: string, url: string, declaredKind?: string): Detected {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  const path = url.split("?")[0].toLowerCase();

  /**
   * СЛОВО ПЛАТФОРМЫ СИЛЬНЕЕ РАСШИРЕНИЯ — но только там, где расширение врёт.
   *
   * Разбирается ровно двусмысленность audio-в-контейнере-видео (.mp4/.webm/.mpeg
   * бывают и тем, и другим). Общий приоритет остаётся у Content-Type: если он
   * назвал точный audio/*, ниже разберётся и без подсказки, а подменять
   * достоверный тип догадкой платформы смысла нет.
   */
  if (declaredKind === "audio" || declaredKind === "voice") {
    if (ct === "audio/mpeg" || /\.(mp3|mpeg|mpga)$/.test(path))
      return { kind: "audio", mediaType: "audio/mpeg", ext: "mp3" };
    if (ct === "audio/wav" || /\.wav$/.test(path)) return { kind: "audio", mediaType: "audio/wav", ext: "wav" };
    if (/\.(ogg|oga|opus)$/.test(path) || ct === "audio/ogg" || ct === "application/ogg")
      return { kind: "audio", mediaType: "audio/ogg", ext: "ogg" };
    if (ct === "audio/webm" || /\.webm$/.test(path)) return { kind: "audio", mediaType: "audio/webm", ext: "webm" };
    // Остальное (в т.ч. .mp4/.m4a и видео-Content-Type у голосового) — контейнер
    // MPEG-4: Gemini принимает его как audio/mp4 и расшифровывает речь.
    return { kind: "audio", mediaType: "audio/mp4", ext: "m4a" };
  }

  if (IMAGE_TYPES.has(ct)) return { kind: "image", mediaType: ct, ext: ct.split("/")[1] };
  if (AUDIO_TYPES.has(ct)) {
    if (ct === "audio/mpeg") return { kind: "audio", mediaType: ct, ext: "mp3" };
    if (ct === "audio/mp4" || ct === "audio/x-m4a") return { kind: "audio", mediaType: "audio/mp4", ext: "m4a" };
    if (ct === "audio/wav") return { kind: "audio", mediaType: ct, ext: "wav" };
    if (ct === "audio/webm") return { kind: "audio", mediaType: ct, ext: "webm" };
    return { kind: "audio", mediaType: "audio/ogg", ext: "ogg" };
  }
  if (VIDEO_TYPES.has(ct)) return { kind: "video", mediaType: ct, ext: ct.split("/")[1] };
  if (DOCUMENT_TYPES.has(ct)) return { kind: "document", mediaType: ct, ext: ct === "text/plain" ? "txt" : "pdf" };

  const imgExt = path.match(/\.(jpe?g|png|webp|gif)$/)?.[1];
  if (imgExt) {
    const norm = imgExt === "jpg" || imgExt === "jpeg" ? "jpeg" : imgExt;
    return { kind: "image", mediaType: `image/${norm}`, ext: norm };
  }
  const audExt = path.match(/\.(ogg|oga|opus|mp3|mpeg|mpga|m4a|aac|wav|webm)$/)?.[1];
  if (audExt) {
    // Instagram-голосовые приходят файлом .mpeg — это audio/mpeg (mp3-семейство).
    if (audExt === "mp3" || audExt === "mpeg" || audExt === "mpga")
      return { kind: "audio", mediaType: "audio/mpeg", ext: "mp3" };
    if (audExt === "m4a" || audExt === "aac") return { kind: "audio", mediaType: "audio/mp4", ext: "m4a" };
    if (audExt === "wav") return { kind: "audio", mediaType: "audio/wav", ext: "wav" };
    if (audExt === "webm") return { kind: "audio", mediaType: "audio/webm", ext: "webm" };
    return { kind: "audio", mediaType: "audio/ogg", ext: "ogg" };
  }
  // Расширение как запасной путь — тот же случай, что у фото: CDN мессенджеров любит
  // отдавать application/octet-stream, и по одному Content-Type видео не опознать.
  const vidExt = path.match(/\.(mp4|mov|webm|3gp|mpeg|mpg)$/)?.[1];
  if (vidExt) {
    if (vidExt === "mov") return { kind: "video", mediaType: "video/quicktime", ext: "mov" };
    if (vidExt === "webm") return { kind: "video", mediaType: "video/webm", ext: "webm" };
    if (vidExt === "3gp") return { kind: "video", mediaType: "video/3gpp", ext: "3gp" };
    if (vidExt === "mpeg" || vidExt === "mpg") return { kind: "video", mediaType: "video/mpeg", ext: "mpeg" };
    return { kind: "video", mediaType: "video/mp4", ext: "mp4" };
  }
  if (path.endsWith(".pdf")) return { kind: "document", mediaType: "application/pdf", ext: "pdf" };
  return { kind: "unsupported", mediaType: "", ext: "" };
}

type FetchedAttachment = FetchedImage | FetchedAudio | FetchedMedia | { kind: "unsupported" };

/** Только хост — в журнал: полный адрес медиа содержит подписанный ключ доступа.
 *  Разбор не должен падать сам: он вызывается из обработчика ошибки. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "адрес неразборчив";
  }
}

/** Откуда качать файл. `headers` нужны WhatsApp: его CDN отдаёт медиа только с маркером. */
export interface AttachmentSource {
  url: string;
  headers?: Record<string, string>;
  /** Чем вложение назвала сама платформа в вебхуке ("audio", "video", "image",
   *  "file"). Разрешает двусмысленность голосового в контейнере .mp4 — см. detect. */
  declaredKind?: string;
  /**
   * Файл уже лежит на нашем диске — качать нечего (свой Bot API сервер в режиме
   * `--local` отдаёт абсолютный путь вместо адреса, см. telegram/api.ts).
   *
   * Сеть в этом случае не трогается вовсе, поэтому проверки safeFetch к такому
   * источнику неприменимы — и именно поэтому путь обязан лежать внутри
   * TELEGRAM_LOCAL_FILES_DIR: единственный способ сюда попасть — файл, который
   * наш же bot-api положил в свой том. Произвольный путь читать нельзя, иначе
   * «прочти файл по имени» стало бы новым способом вынести секреты с диска.
   *
   * `url` при этом остаётся заполненным — он служит только подписью в журнале
   * и подсказкой расширения для detect, по нему никто никуда не ходит.
   */
  localPath?: string;
}

/**
 * Корень тома своего Bot API сервера. Пусто — значит своего сервера нет, и
 * ни один локальный путь не будет принят: проверка ниже отвергнет всё.
 * Экспортирована по той же причине, что и isInsideTelegramFilesDir ниже —
 * ночная уборка тома (lib/telegramBotApiCleanup.ts) обходит именно этот корень.
 */
export const TELEGRAM_LOCAL_FILES_DIR = process.env.TELEGRAM_LOCAL_FILES_DIR ?? "";

/** Экспортирована (24.09.2026) для уборки исходников после приёма ролика
 *  монтажёра (telegram/bot.ts) и ночной уборки тома Bot API
 *  (lib/telegramBotApiCleanup.ts) — та же проверка, что не пускала чтение
 *  произвольного пути, теперь защищает и удаление: снести можно только файл
 *  внутри тома своего Bot API сервера, ничего больше. */
export function isInsideTelegramFilesDir(candidate: string): boolean {
  if (!TELEGRAM_LOCAL_FILES_DIR) return false;
  const root = path.resolve(TELEGRAM_LOCAL_FILES_DIR);
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Сколько раз пробовать скачать вложение и с какой паузой между попытками.
 *
 * Не панацея: истёкшую подписанную ссылку CDN повтор не оживит — это
 * постоянная, а не временная беда. Но часть отказов (сеть моргнула, CDN
 * ответил 5xx под нагрузкой) как раз временные, и вторая попытка их снимает.
 * Пауза короткая нарочно: клиент ждёт ответа бота внутри этого же хода —
 * несколько долгих попыток подряд превратили бы «не открылось» в «бот завис».
 */
const DOWNLOAD_ATTEMPTS = 2;
const DOWNLOAD_RETRY_DELAY_MS = 700;

/**
 * Одна попытка скачивания: успех — Response с непрочитанным телом, неуспех (сеть,
 * не-2xx, запрещённый адрес) — исключение.
 *
 * Идём через safeOpen, а не через голый fetch, ровно из-за перенаправлений: голый
 * fetch следует за ними САМ и молча, и проверка одного лишь исходного адреса не
 * защищает ни от чего. Подробности — в lib/safeFetch.ts.
 */
export interface ManagedAttachmentDownload { readonly signal: AbortSignal; readonly deadlineAt: number }
async function fetchOnce(url: string, headers: Record<string, string> | undefined, managed?: ManagedAttachmentDownload): Promise<Response> {
  managed?.signal.throwIfAborted();
  const timeoutMs = managed ? Math.min(30_000, managed.deadlineAt - Date.now()) : FETCH_TIMEOUT_MS;
  if (timeoutMs <= 0) throw new Error("Original media deadline expired");
  const { res } = await safeOpen(url, { headers, timeoutMs, maxRedirects: MAX_REDIRECTS, signal: managed?.signal });
  return res;
}

/**
 * Длительность скачанного вложения в секундах, либо null — «измерить не удалось».
 *
 * ffprobe читает файл, а не поток, поэтому буфер сначала ложится во временный файл
 * — тот же приём, что у голосовых агента (lib/audioTranscode.ts) и у ролика объекта
 * (routes/properties.ts). Расширение в имени не украшение: по одному содержимому
 * контейнер угадывается не всегда.
 *
 * Свой ffprobe тут не запускается: probeDurationSec из lib/propertyClipVideo.ts уже
 * умеет и таймаут, и отсутствующий бинарник — второй копии этого кода быть не должно.
 */
async function probeAttachmentDurationSec(buf: Buffer, ext: string): Promise<number | null> {
  const tmpPath = path.join(os.tmpdir(), `attachment-probe-${randomUUID()}.${ext}`);
  try {
    await fs.writeFile(tmpPath, buf);
    return await probeDurationSec(tmpPath);
  } catch {
    // Не смогли даже записать файл (диск полон, каталог недоступен) — это «не
    // проверили», а не «файл длинный»: решение принимает вызывающий.
    return null;
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

/**
 * Не слишком ли длинный файл, чтобы отдавать его в платный разбор.
 *
 * Отказ измерения (ffprobe не установлен, контейнер не распознан) НЕ повод выбросить
 * вложение: клиент не виноват в том, что у нас не встал бинарник, и молча терять из-за
 * этого его голосовое хуже, чем изредка заплатить за длинный файл. Поэтому непроверенное
 * пропускаем дальше, но обязательно оставляем строку в журнале — иначе пропавший ffprobe
 * останется незамеченным ровно до счёта за расшифровку.
 */
async function isTooLong(buf: Buffer, detected: Detected, host: string): Promise<boolean> {
  if (detected.kind !== "audio" && detected.kind !== "video") return false;
  // Пустое тело мерить нечем — ffprobe на нём только зря потратит таймаут.
  if (buf.byteLength === 0) return false;

  const maxSec = detected.kind === "audio" ? MAX_AUDIO_DURATION_SEC : MAX_VIDEO_DURATION_SEC;
  const durationSec = await probeAttachmentDurationSec(buf, detected.ext);
  if (durationSec === null) {
    void logSystemError(
      "meta",
      `Длительность вложения не измерена (${host}, ${detected.mediaType}): ffprobe недоступен или файл не распознан — файл пропущен в разбор без проверки`
    );
    return false;
  }
  return durationSec > maxSec;
}

/**
 * Общий хвост обоих путей (скачали по сети / прочли с диска): распознали тип,
 * проверили длительность, слепили результат. Вынесен, чтобы локальный файл
 * проходил ТЕ ЖЕ проверки, а не свои собственные — иначе две ветки разойдутся,
 * и на одной из них однажды не окажется предела длительности.
 */
function shapeAttachment(buf: Buffer, detected: Detected): FetchedAttachment {
  if (detected.kind === "image") {
    return { kind: "image", mediaType: detected.mediaType, data: buf.toString("base64") };
  }
  if (detected.kind === "video" || detected.kind === "document") {
    return {
      kind: "media",
      media: detected.kind === "video" ? "video" : "document",
      mediaType: detected.mediaType,
      buffer: buf,
      filename: `${detected.kind}.${detected.ext}`,
    };
  }
  return { kind: "audio", mediaType: detected.mediaType, buffer: buf, filename: `voice.${detected.ext}` };
}

/**
 * ГОЛОСОВОЕ ОТБРОШЕНО — СТРОКА В ЖУРНАЛ (25.09.2026).
 *
 * Живой случай в WhatsApp: бот дважды ответил «паёми овозиро кушода
 * наметавонам», а в журнале не было ничего — голосовое, не прошедшее по типу,
 * размеру или длительности, превращалось в `{ kind: "unsupported" }` молча, и
 * владелец не мог узнать, почему речь клиента не разобрана. Фото и видео сюда не
 * пишутся: там отказ виден в переписке самим файлом, а голосовое — это реплика.
 *
 * Начало текста постоянное на каждую причину и совпадает с dedupKey
 * (logSystemError сравнивает начало): одна строка за десять минут на причину.
 */
export const VOICE_REJECTED_LOG_PREFIX = "Голосовое клиента не разобрано";

function rejectAttachment(
  detected: Detected,
  declaredKind: string | undefined,
  contentType: string,
  reason: string,
  host: string
): FetchedAttachment {
  const isVoice =
    detected.kind === "audio" ||
    declaredKind === "audio" ||
    declaredKind === "voice" ||
    contentType.toLowerCase().startsWith("audio/");
  if (isVoice) {
    const head = `${VOICE_REJECTED_LOG_PREFIX}: ${reason}`;
    void logSystemError("meta", `${head} (${host}, ${contentType || detected.mediaType || "тип не указан"})`, {
      dedupKey: head,
    });
  }
  return { kind: "unsupported" };
}

/** Файл своего Bot API сервера: он уже на диске, сеть не нужна. */
async function readLocalOne(source: AttachmentSource): Promise<FetchedAttachment | null> {
  const localPath = source.localPath as string;
  if (!isInsideTelegramFilesDir(localPath)) {
    void logSystemError(
      "telegram",
      `Вложение не прочитано: путь ${localPath} вне тома Bot API (TELEGRAM_LOCAL_FILES_DIR)`
    );
    return null;
  }
  try {
    const detected = detect("", source.url, source.declaredKind);
    if (detected.kind === "unsupported")
      return rejectAttachment(detected, source.declaredKind, "", "тип файла не распознан", "bot-api");
    const isMedia = detected.kind === "video" || detected.kind === "document";
    const limit = isMedia ? MAX_MEDIA_BYTES : detected.kind === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
    // Размер по stat, а не после чтения: смысл тот же, что у readCapped в сетевой
    // ветке — не втягивать в память то, что заведомо не по размеру.
    const stat = await fs.stat(localPath);
    if (stat.size > limit)
      return rejectAttachment(detected, source.declaredKind, "", "файл больше предела по размеру", "bot-api");
    const buf = await fs.readFile(localPath);
    if (await isTooLong(buf, detected, "bot-api"))
      return rejectAttachment(detected, source.declaredKind, "", "запись длиннее предела по времени", "bot-api");
    return shapeAttachment(buf, detected);
  } catch (err) {
    void logSystemError("telegram", `Вложение не прочитано с диска (${localPath}): ${describeError(err)}`);
    return null;
  }
}

async function fetchOne(source: AttachmentSource, managed?: ManagedAttachmentDownload): Promise<FetchedAttachment | null> {
  if (managed && source.localPath) return { kind: "unsupported" };
  if (source.localPath) return readLocalOne(source);
  const { url, headers, declaredKind } = source;
  try {
    /**
     * КУДА ИМЕННО МЫ СОБРАЛИСЬ — ПРОВЕРЯЕТСЯ НА КАЖДОМ ШАГЕ, А НЕ ОДИН РАЗ.
     *
     * Сюда приходят адреса из вебхука Meta (подпись сходится, источник доверенный),
     * но список источников растёт: с 16.08.2026 качаются истории и файлы своей
     * ленты, а следом сюда придут ссылки из сообщений клиентов. Проверять надо не
     * там, где адрес взяли, а здесь, где по нему идут: одно место вместо трёх, и
     * новый источник не забудут прикрыть. Что именно запрещено и почему — в
     * lib/safeFetch.ts (петля, частные сети, метаданные облака с ключами доступа).
     *
     * До 21.08.2026 здесь проверялся ТОЛЬКО исходный адрес, а качал файл обычный
     * fetch — который следует за перенаправлениями сам и молча. То есть защита
     * снималась одним заголовком: публичная ссылка отвечала «302 →
     * http://169.254.169.254/latest/meta-data/» (ключи облака) или «302 →
     * http://postgres:5432/», и CRM послушно приносила содержимое собственной сети
     * тому, кто эту ссылку прислал. Теперь каждый переход проверяется заново
     * (safeOpen), а число переходов ограничено — см. MAX_REDIRECTS.
     */
    // Не удалось — пробуем ещё раз (17.08.2026: голосовые Instagram однажды не
    // скачались с первой попытки). До этой правки первая же неудача сразу
    // сдавалась и терялась без следа (см. DOWNLOAD_ATTEMPTS выше).
    let res: Response | undefined;
    let lastErr: unknown;
    const attempts = managed ? 1 : DOWNLOAD_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        res = await fetchOnce(url, headers, managed);
        break;
      } catch (err) {
        lastErr = err;
        // Запрещённый адрес — беда постоянная, а не «сеть моргнула»: повтор даст
        // ровно тот же отказ и только задержит ответ клиенту ещё на паузу.
        if (err instanceof UnsafeUrlError) break;
        if (attempt < attempts) await new Promise((r) => setTimeout(r, DOWNLOAD_RETRY_DELAY_MS * attempt));
      }
    }
    if (!res) throw lastErr;
    const contentType = res.headers.get("content-type") ?? "";
    const detected = detect(contentType, url, declaredKind);
    const isMedia = detected.kind === "video" || detected.kind === "document";
    const limit = isMedia ? managed ? 12 * 1024 * 1024 : MAX_MEDIA_BYTES : detected.kind === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
    const declaredLength = Number(res.headers.get("content-length") ?? "0");
    // Отсекаем ДО скачивания тела: неизвестные типы и заведомо огромные файлы не
    // должны буферизоваться в память только ради проверки размера.
    if (detected.kind === "unsupported" || declaredLength > limit) {
      await res.body?.cancel();
      return rejectAttachment(
        detected,
        declaredKind,
        contentType,
        detected.kind === "unsupported" ? "тип файла не распознан" : "файл больше предела по размеру",
        hostOf(url)
      );
    }

    /**
     * ТЕЛО ЧИТАЕТСЯ КУСКАМИ И ОБРЫВАЕТСЯ НА ПОТОЛКЕ, а не через arrayBuffer().
     *
     * Проверка Content-Length выше — не защита, а оптимизация: заголовка может не быть
     * вовсе (chunked-ответ), и он ничем не подтверждён. arrayBuffer() в этом случае
     * честно тянул в память столько, сколько отдаёт CDN, — часовое видео уронило бы
     * весь API, а он делит хост с базой. readCapped (lib/safeFetch.ts) обрывает чтение
     * и рвёт соединение на первом же куске за пределом.
     */
    const { body: buf, truncated } = await readCapped(res, limit);
    managed?.signal.throwIfAborted();
    if (managed && Date.now() >= managed.deadlineAt) throw new Error("Original media deadline expired");
    // Оборвались о потолок — файл нам не по размеру. Ровно то же, что говорил
    // соврамший Content-Length: клиент получит честное «файл не открылся».
    if (truncated)
      return rejectAttachment(detected, declaredKind, contentType, "файл больше предела по размеру", hostOf(url));

    if (await isTooLong(buf, detected, hostOf(url)))
      return rejectAttachment(detected, declaredKind, contentType, "запись длиннее предела по времени", hostOf(url));

    if (detected.kind === "image") {
      return { kind: "image", mediaType: detected.mediaType, data: buf.toString("base64") };
    }
    if (isMedia) {
      return {
        kind: "media",
        media: detected.kind === "video" ? "video" : "document",
        mediaType: detected.mediaType,
        buffer: buf,
        filename: `${detected.kind}.${detected.ext}`,
      };
    }
    return { kind: "audio", mediaType: detected.mediaType, buffer: buf, filename: `voice.${detected.ext}` };
  } catch (err) {
    // В журнал, а не только в консоль: у Instagram сетевой доступ с VPS уже однажды
    // оказался закрыт (graph.instagram.com), и «фото не читаются» без расшифрованной
    // причины отладить невозможно. describeError достаёт настоящую причину из cause.
    //
    // Сработавшая защита от SSRF пишется отдельной строкой и без счётчика попыток:
    // это не отказ CDN, а наш собственный отказ идти по адресу — и владелец должен
    // видеть в журнале именно попытку увести бота внутрь сети, а не «файл не скачался».
    void logSystemError(
      "meta",
      err instanceof UnsafeUrlError
        ? `Вложение не скачано (${hostOf(url)}): ссылка ведёт внутрь нашей сети — ${err.message}`
        : `Вложение не скачано (${hostOf(url)}) за ${DOWNLOAD_ATTEMPTS} попытки: ${describeError(err)}`
    );
    return null;
  }
}

export interface FetchedAttachments {
  images: FetchedImage[];
  audios: FetchedAudio[];
  /** Видео и документы — их описывает Gemini (см. ai/geminiMedia.ts). */
  medias: FetchedMedia[];
  /** Были вложения, которые мы не смогли обработать (неизвестный тип, слишком
   *  большое по весу или слишком длинное по времени). */
  hadUnsupported: boolean;
}

export function fetchAttachments(sources: AttachmentSource[], managed?: ManagedAttachmentDownload): Promise<FetchedAttachments> {
  return traceMeasured("media_download", () => fetchAttachmentsImpl(sources, managed));
}
async function fetchAttachmentsImpl(sources: AttachmentSource[], managed?: ManagedAttachmentDownload): Promise<FetchedAttachments> {
  const results = await Promise.all(sources.slice(0, MAX_FILES).map(source => fetchOne(source, managed)));
  const images = results.filter((r): r is FetchedImage => r?.kind === "image");
  const audios = results.filter((r): r is FetchedAudio => r?.kind === "audio");
  const medias = results.filter((r): r is FetchedMedia => r?.kind === "media");
  const hadUnsupported = results.some((r) => r === null || r.kind === "unsupported") || sources.length > MAX_FILES;
  return { images, audios, medias, hadUnsupported };
}

/**
 * Кладёт скачанное в ЗАКРЫТОЕ хранилище и возвращает ссылки для реплики переписки.
 *
 * Живёт рядом с загрузчиком, потому что это его вторая половина: у всех каналов
 * шаг один и тот же — скачали, сохранили, прицепили к реплике, — и расходиться он
 * не должен. Именно расхождение и стоило нам вложений из Telegram: там своя ветка
 * обработки, и до сохранения файлов дело просто не доходило.
 *
 * Файл, который не удалось записать, молча пропускаем: реплика клиента важнее
 * вложения, и терять весь ход из-за одного неудачного файла нельзя.
 */
export async function storeFetchedAttachments(fetched: {
  images: FetchedImage[];
  audios: FetchedAudio[];
  /** Видео и документы. Необязательное поле: у части вызывающих его нет вовсе. */
  medias?: FetchedMedia[];
}): Promise<StoredAttachment[]> {
  const saved: StoredAttachment[] = [];
  for (const img of fetched.images) {
    const file = await savePrivateFile(Buffer.from(img.data, "base64"), img.mediaType);
    if (file) saved.push({ kind: "image", file, mime: img.mediaType });
  }
  for (const audio of fetched.audios) {
    const file = await savePrivateFile(audio.buffer, audio.mediaType);
    if (file) saved.push({ kind: "audio", file, mime: audio.mediaType });
  }
  /**
   * ВИДЕО И ДОКУМЕНТЫ СОХРАНЯЕМ ТОЖЕ (16.08.2026).
   *
   * Раньше они уходили Gemini на описание и выбрасывались: в переписке от
   * присланного рум-тура оставалась одна пометка, и посмотреть его не мог ни
   * агент, ни руководитель. Между тем видео квартиры — самое ценное, что вообще
   * присылает продавец, и человек, приславший его, — самый горячий из всех.
   *
   * Хранилище то же закрытое, что у фото и голосовых: файл отдаётся маршрутом с
   * проверкой права messages.viewAttachments, а не лежит в открытой папке.
   */
  for (const media of fetched.medias ?? []) {
    const file = await savePrivateFile(media.buffer, media.mediaType);
    if (file) saved.push({ kind: media.media === "video" ? "video" : "file", file, mime: media.mediaType });
  }
  return saved;
}
