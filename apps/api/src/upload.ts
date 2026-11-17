import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import { looksLikeHeicName } from "./lib/heicInput.js";
import sharp from "sharp";
import type { RequestHandler } from "express";
import {
  PROXY_SINGLE_REQUEST_MAX_BYTES,
  REQUEST_TOO_LARGE_CODE,
  singleRequestTooLargeMessage,
  SOCIAL_VIDEO_COVER_MAX_BYTES,
  SOCIAL_VIDEO_COVER_MIME_TYPES,
  SOCIAL_PHOTO_POST_MAX_BYTES,
  SOCIAL_PHOTO_POST_MAX_IMAGES,
} from "@royal-home/shared";

/**
 * Отказ загрузчика по типу файла (fileFilter). Отдельный класс, чтобы общий
 * обработчик ошибок (app.ts) отвечал 400 с этим текстом, а не 500 «Внутренняя
 * ошибка сервера» со строкой в журнале ошибок (G11, 02.10.2026): виноват
 * присланный файл, а не сервер.
 */
export class UploadRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadRejectedError";
  }
}

/**
 * ПАМЯТЬ SHARP — ГЛОБАЛЬНО НА ПРОЦЕСС (21.09.2026, аудит памяти черновика объекта).
 *
 * Контейнер API — 768 МБ (docker-compose.prod.yml), 506 МБ занято ещё в простое.
 * libvips (движок sharp) по умолчанию (1) держит внутренний кэш операций (до 50 МБ
 * и до 500 файлов/буферов — рассчитан на повторную обработку ОДНОГО и того же
 * входа, чего здесь не бывает: каждое фото проходит через sharp один раз и больше
 * не нужно) и (2) запускает декодирование настолько параллельно, сколько ядер
 * видит контейнер. Пачка из 15-20 фото черновика (routes/properties/drafts.ts) и
 * параллельная загрузка карточки (routes/properties/photos.ts) от НЕСКОЛЬКИХ
 * агентов одновременно превращают это в десятки одновременных декодов снимков в
 * 12+ мегапикселей — ровно то, что кладёт контейнер по памяти молча (без явной
 * ошибки, процессом-контейнером по OOM).
 *
 * `cache(false)` — кэш не нужен (см. выше), `concurrency(1)` — сериализует
 * операции sharp внутри процесса вместо параллельного разбора памяти всеми
 * ядрами сразу. Цена — пачка из нескольких фото обрабатывается чуть дольше
 * (миллисекунды на снимок), это дешевле, чем падение контейнера. Точка ОДНА на
 * весь процесс (не per-вызов): вызывать `sharp.cache`/`sharp.concurrency` из
 * каждого места, где используется sharp, значило бы, что порядок импорта решает,
 * чья настройка победит последней — здесь единственный источник правды, все
 * остальные модули просто используют `sharp(...)` как раньше.
 */
sharp.cache(false);
sharp.concurrency(1);

export const uploadsDir = path.resolve(process.env.UPLOADS_DIR ?? "./uploads");
export const thumbsDir = path.join(uploadsDir, "thumbs");
/** Сжатые ролики карточки объекта (docs/plan-18-08-private-listings-and-video.md §3) —
 *  своя поддиректория рядом с фото, раздаётся тем же express.static("/uploads", uploadsDir). */
export const clipVideoDir = path.join(uploadsDir, "video");
/** Готовые ролики автомонтажа (docs/publishing-hub-plan-22-08-2026.md) — своя
 *  поддиректория рядом с фото, раздаётся тем же express.static("/uploads", uploadsDir). */
export const automontageDir = path.join(uploadsDir, "automontage");
/** Обложки автомонтажа (31.08.2026) — свой подкаталог рядом с самими роликами:
 *  cover_url для Instagram Graph API обязан быть отдельным публичным JPEG, не
 *  кадром внутри mp4. Раздаётся тем же express.static("/uploads", uploadsDir). */
export const automontageCoversDir = path.join(automontageDir, "covers");
/** Готовые ролики от монтажёра — ручная передача через Telegram/CRM (01.09.2026,
 *  lib/videoHandoff.ts), параллельный путь автомонтажу. Своя поддиректория тем же
 *  паттерном, раздаётся тем же express.static("/uploads", uploadsDir): publishApprovedPost
 *  ждёт публичный /uploads/*-путь, закрытое хранилище сырых клипов сюда не годится. */
export const videoHandoffDir = path.join(uploadsDir, "handoff");
/** ОТКРЫТАЯ папка квадратных обложек объектов (23.09.2026). Почему не рядом с
 *  роликом в `handoff/`: этот подкаталог закрыт от прямой статики и его ссылки
 *  подписываются маркером на сутки (lib/crmPublicUrl.ts, К11 аудита 11.09).
 *  Обложка же уезжает НА САЙТ первой картинкой объявления и обязана открываться
 *  всегда — как и обычные фото объекта, которые лежат просто в /uploads. */
export const propertyCoversDir = path.join(uploadsDir, "covers");
/** ФОТО-ПОСТЫ (28.09.2026, lib/photoPosts.ts) — карусель Instagram/фото-пост
 *  Facebook/альбом Telegram у объекта без ролика собираются из фото объекта,
 *  перекодированных в JPEG под требования Instagram. ОТКРЫТАЯ папка, тем же
 *  приёмом, что и propertyCoversDir выше: Meta и Telegram забирают файлы по
 *  публичной ссылке/с диска, подписывать нечем и незачем — фото объекта и так
 *  открыты. */
export const photoPostsDir = path.join(uploadsDir, "photo-posts");
// Голосовые заметки агента к формам CRM (01.09.2026) храняться в ЗАКРЫТОМ
// хранилище (lib/privateFiles.ts), не здесь — «запись слушает только сам
// агент/руководитель» из первоначального замысла требует авторизации на
// выдаче, а express.static("/uploads", uploadsDir) её не делает (найдено и
// исправлено 02.09.2026, см. routes/me.ts GET /voice-notes/:name).

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(thumbsDir, { recursive: true });
fs.mkdirSync(clipVideoDir, { recursive: true });
fs.mkdirSync(automontageDir, { recursive: true });
fs.mkdirSync(automontageCoversDir, { recursive: true });
fs.mkdirSync(videoHandoffDir, { recursive: true });

/**
 * ВРЕМЕННЫЙ КАТАЛОГ ДЛЯ ВИДЕО-ЗАГРУЗЧИКОВ (К9, аудит безопасности 11.09.2026).
 *
 * Раньше `mediaMessageUpload`/`clipVideoUpload`/`videoHandoffUpload` были на
 * `memoryStorage`, как и все остальные multer-загрузчики: multer держит ВЕСЬ
 * файл в оперативной памяти процесса, пока идёт приём тела запроса. Для фото
 * это не страшно (лимит 30 МБ), но эти три пропускают видео до 300-700 МБ, и
 * несколько параллельных загрузок кладут контейнер: `mem_limit` API-сервиса в
 * докере — 768 МБ (docker-compose.prod.yml), а два одновременных ролика уже
 * перекрывают его без единой строчки бизнес-логики.
 *
 * `diskStorage` пишет тело запроса на диск по мере приёма — Node не копит его в
 * памяти целиком. Каталог — НЕ `uploadsDir`: тот раздаётся статикой (app.ts), а
 * временный файл до обработки не должен быть виден никому. `os.tmpdir()`, а не
 * поддиректория uploads, — тот же довод, что и у закрытого хранилища вложений
 * переписки (lib/privateFiles.ts): каталог обязан быть в стороне от всего, что
 * express.static когда-либо отдаёт.
 *
 * Файлы отсюда — ответственность обработчика маршрута: он читает результат
 * (или переносит его в постоянное хранилище) и обязан удалить временный файл
 * сам, в finally, независимо от исхода. Ничьей фоновой уборки здесь нет:
 * обработка происходит сразу после приёма, зависших файлов копиться не должно
 * (в отличие от uploads-private, где срок хранения оправдан самим назначением
 * папки — готовым результатом, а не промежуточным шагом).
 */
/**
 * Каталог можно переназначить переменной `VIDEO_TMP_DIR`. Нужно это в первую
 * очередь прогонам тестов: каталог по умолчанию ОДИН на всю машину, а тесты
 * идут в несколько процессов (tests/runParallel.ts) — соседний процесс,
 * загружающий свой ролик в ту же секунду, ронял проверку «временный файл не
 * остаётся», потому что она считает файлы во всём каталоге. В tests/setup.ts
 * каждому процессу выдаётся свой. В проде переменная обычно не задана — тогда
 * всё как было, и заодно появляется возможность увести временные файлы на
 * отдельный диск, не трогая код.
 */
export const videoTmpDir = process.env.VIDEO_TMP_DIR ?? path.join(os.tmpdir(), "royal-home-video-uploads");
fs.mkdirSync(videoTmpDir, { recursive: true });

const videoTmpStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, videoTmpDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10) || guessExtFromMime(file.mimetype);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

/**
 * ОДНА ДВЕРЬ ДЛЯ ПРИЁМА ФАЙЛА ОДНИМ ЗАПРОСОМ (17.11.2026, класс «большой файл одним
 * запросом → 413 от прокси»). Каждый загрузчик multer создаётся только здесь, через
 * `guardedUpload`, и обязан назвать `maxRequestBytes` — сколько весит весь запрос. Между
 * браузером и API стоят Cloudflare и прокси, которые режут тело больше ~100 МБ, поэтому
 * потолок — PROXY_SINGLE_REQUEST_MAX_BYTES (90 МБ); всё тяжелее едет частями
 * (lib/chunkedUploadSessions.ts, routes/uploadSessions.ts). Выше потолка — только с
 * `overProxyCeilingReason` (кто зовёт мимо прокси и почему).
 *
 * Сторож — `scripts/audit-limits.mjs` (precheck и CI): `multer(` вне этой функции,
 * `maxRequestBytes` выше потолка без причины и fileSize × files больше maxRequestBytes
 * без `batchFitsReason` не проходят. Сама функция бросает ошибку на том же.
 *
 * Сама дверь тоже держит обещание: запрос с Content-Length больше `maxRequestBytes`
 * получает 413 с понятным текстом ДО разбора тела — тем же текстом, что видит экран.
 */
export interface UploadDoorOptions extends multer.Options {
  /** Имя для сторожа и журнала, совпадает с именем переменной. */
  name: string;
  /** Предел всего запроса. Не больше PROXY_SINGLE_REQUEST_MAX_BYTES без причины. */
  maxRequestBytes: number;
  /** Обоснование, если запрос тяжелее потолка прокси: кто зовёт мимо Cloudflare. */
  overProxyCeilingReason?: string;
  /**
   * Обоснование, если fileSize × files больше maxRequestBytes: почему экран всё равно
   * укладывает весь запрос в предел (режет пачки по весу, сжимает снимки, шлёт по одному).
   * Без него такая дверь обещает больше, чем пропустит, — и человек узнаёт об этом 413-м.
   */
  batchFitsReason?: string;
}

export interface UploadDoor {
  readonly name: string;
  readonly maxRequestBytes: number;
  single(field: string): RequestHandler;
  array(field: string, maxCount?: number): RequestHandler;
  fields(fields: readonly multer.Field[]): RequestHandler;
  none(): RequestHandler;
  any(): RequestHandler;
}

/** Все двери процесса — для проверки в тестах (tests/upload-size-class.test.ts). */
export const uploadDoors: Array<{
  name: string;
  maxRequestBytes: number;
  fileSize: number;
  files: number;
  overProxyCeilingReason: string | null;
  batchFitsReason: string | null;
}> = [];

/** Отказ по заявленному весу запроса — до чтения тела. Отдельно, чтобы проверять без сети. */
export function requestCapGuard(maxRequestBytes: number): RequestHandler {
  return (req, res, next) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxRequestBytes) {
      // Тело не читаем: закрываем соединение, чтобы клиент не досылал сотни мегабайт впустую.
      res.setHeader("Connection", "close");
      res.status(413).json({ error: singleRequestTooLargeMessage(declared), code: REQUEST_TOO_LARGE_CODE });
      return;
    }
    next();
  };
}

export function guardedUpload(options: UploadDoorOptions): UploadDoor {
  const { name, maxRequestBytes, overProxyCeilingReason, batchFitsReason, ...multerOptions } = options;
  const fileSize = multerOptions.limits?.fileSize ?? Number.POSITIVE_INFINITY;
  const files = multerOptions.limits?.files ?? Number.POSITIVE_INFINITY;
  // Сторож в CI (scripts/audit-limits.mjs) ловит это раньше; здесь — чтобы обещание двери
  // не разошлось с правдой, даже если сторож обошли: процесс не стартует, тест краснеет.
  if (maxRequestBytes > PROXY_SINGLE_REQUEST_MAX_BYTES && !overProxyCeilingReason?.trim()) {
    throw new Error(`[upload] ${name}: предел запроса выше потолка прокси без overProxyCeilingReason`);
  }
  if (fileSize > maxRequestBytes) {
    throw new Error(`[upload] ${name}: limits.fileSize больше maxRequestBytes — такой файл не пройдёт дверь`);
  }
  if (fileSize * files > maxRequestBytes && !batchFitsReason?.trim()) {
    throw new Error(`[upload] ${name}: fileSize × files больше maxRequestBytes без batchFitsReason`);
  }
  uploadDoors.push({
    name,
    maxRequestBytes,
    fileSize,
    files,
    overProxyCeilingReason: overProxyCeilingReason ?? null,
    batchFitsReason: batchFitsReason ?? null,
  });
  const inner = multer(multerOptions);
  const cap = requestCapGuard(maxRequestBytes);
  const capped =
    (handler: RequestHandler): RequestHandler =>
    (req, res, next) =>
      cap(req, res, (err?: unknown) => (err ? next(err) : handler(req, res, next)));
  return {
    name,
    maxRequestBytes,
    single: (field) => capped(inner.single(field)),
    array: (field, maxCount) => capped(inner.array(field, maxCount)),
    fields: (fields) => capped(inner.fields(fields)),
    none: () => capped(inner.none()),
    any: () => capped(inner.any()),
  };
}

function guessExtFromMime(mimetype: string): string {
  if (mimetype.startsWith("video/")) return `.${mimetype.split("/")[1] || "mp4"}`;
  if (mimetype.startsWith("image/")) return `.${mimetype.split("/")[1] || "jpg"}`;
  return "";
}

/**
 * Переносит файл, принятый видео-загрузчиком (diskStorage, `videoTmpDir`), в
 * постоянное место. `rename` дёшево, если оба пути на одном томе; в проде
 * `/tmp` контейнера и volume `uploads` — разные тома, `rename` там падает с
 * EXDEV — запасной путь copy+unlink делает то же самое без чтения содержимого
 * в память процесса. Общая точка для всех обработчиков видео-маршрутов, чтобы
 * решение «как переносить» не разошлось по местам вызова.
 */
export async function moveUploadedFile(srcPath: string, destPath: string): Promise<void> {
  try {
    await fs.promises.rename(srcPath, destPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.promises.copyFile(srcPath, destPath);
    await fs.promises.rm(srcPath, { force: true });
  }
}

// 30 МБ/файл: клиент сжимает фото перед отправкой (compressImage), но запас
// нужен на случай необрабатываемых форматов, уходящих оригиналом.
export const upload = guardedUpload({
  name: "upload",
  maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES,
  batchFitsReason: "экран режет пачки фото по весу (uploadQueue.batchPhotos, до 8 МБ) и проверяет вес до отправки; аватар и логотип — по одному файлу",
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 30 },
  fileFilter: (_req, file, cb) => {
    // HEIC из Chrome на Windows приходит с пустым типом или octet-stream —
    // пускаем по расширению, содержимое проверит sharpFromUpload (lib/heicInput.ts).
    if (!file.mimetype.startsWith("image/") && !looksLikeHeicName(file.originalname)) {
      return cb(new UploadRejectedError("Допустимы только изображения"));
    }
    cb(null, true);
  },
});

/** Снимок черновика объекта: предел и проверка типа — одни для мастера CRM и
 *  мастера в Telegram (фото файлом без сжатия, 10.11.2026). */
export const DRAFT_PHOTO_MAX_BYTES = 30 * 1024 * 1024;
export function isAcceptedDraftPhoto(mimetype: string | undefined, filename: string | undefined): boolean {
  // HEIC из Chrome на Windows приходит с пустым типом или octet-stream —
  // пускаем по расширению, содержимое проверит sharpFromUpload (lib/heicInput.ts).
  return Boolean(mimetype?.startsWith("image/")) || looksLikeHeicName(filename ?? "");
}

/**
 * ФОТО ЧЕРНОВИКА — СВОЙ, МЕНЬШИЙ ЛИМИТ ФАЙЛОВ ЗА ЗАПРОС (21.09.2026, аудит памяти).
 *
 * `upload` выше рассчитан на карточку объекта, где агент иногда догружает всю
 * пачку сразу (routes/properties/photos.ts: до 30 файлов по 30 МБ — 900 МБ в
 * memoryStorage одним запросом, отдельная история для того маршрута). Мастер
 * черновика (web: lib/draftUploads.ts) шлёт файлы ПО ОДНОМУ — 30 в одном запросе
 * там никогда не бывает, а держать тот же потолок значило бы разрешать то, чего
 * клиент не делает, ценой лишних сотен МБ пиковой памяти на один случайный или
 * вредоносный запрос. 5 — тот же порядок, что у MAX_VIDEOS_PER_REQUEST
 * (routes/properties/videos.ts): с запасом над «по одному», но не «как карточка».
 */
export const draftPhotoUpload = guardedUpload({
  name: "draftPhotoUpload",
  maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES,
  batchFitsReason: "мастер черновика шлёт снимки по одному (draftUploads.sendPhoto) и проверяет вес до отправки",
  storage: multer.memoryStorage(),
  limits: { fileSize: DRAFT_PHOTO_MAX_BYTES, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (!isAcceptedDraftPhoto(file.mimetype, file.originalname)) {
      return cb(new UploadRejectedError("Допустимы только изображения"));
    }
    cb(null, true);
  },
});

/**
 * ШАБЛОН ОБЛОЖКИ (владелец, 23.09.2026): пара файлов SVG + spec.json и
 * необязательные листья/знак картинкой. Свой загрузчик, а не общий `upload`:
 * тот пускает только картинки, а здесь обязателен JSON — расширять общий
 * означало бы, что фото объекта можно подменить json-файлом.
 * 4 файла, 8 МБ каждый: слой шаблона — это разметка и, редко, встроенная
 * картинка data:, а не фотобанк.
 */
export const coverTemplatesUpload = guardedUpload({
  name: "coverTemplatesUpload",
  maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES,
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 4 },
  fileFilter: (_req, file, cb) => {
    const isSvg = file.mimetype === "image/svg+xml" || /\.svg$/i.test(file.originalname);
    const isJson = file.mimetype === "application/json" || /\.json$/i.test(file.originalname);
    const isImage = file.mimetype.startsWith("image/") && !isSvg;
    if (file.fieldname === "svg" && !isSvg) return cb(new UploadRejectedError("Слой шаблона — файл .svg"));
    if (file.fieldname === "spec" && !isJson) return cb(new UploadRejectedError("Числа шаблона — файл spec.json"));
    if ((file.fieldname === "leaves" || file.fieldname === "logo") && !isImage) {
      return cb(new UploadRejectedError("Листья и знак — обычная картинка (png)"));
    }
    if (!["svg", "spec", "leaves", "logo"].includes(file.fieldname)) return cb(new UploadRejectedError("Лишний файл в запросе"));
    cb(null, true);
  },
});

/**
 * Загрузка звука для телефонии: музыка ожидания и приветствие автоответчика.
 * Отдельный загрузчик, а не общий: тот пускает только картинки, и это правильно —
 * расширять его «или картинка, или звук» значило бы, что фото объекта можно
 * подменить mp3-файлом. 15 МБ хватает на несколько минут музыки в mp3.
 */
export const audioUpload = guardedUpload({
  name: "audioUpload",
  maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES,
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.originalname);
    if (!ok) return cb(new UploadRejectedError("Допустимы только звуковые файлы (mp3 или wav)"));
    cb(null, true);
  },
});

/**
 * Голосовое СОТРУДНИКА клиенту в переписке (16.08.2026). Отдельный загрузчик от
 * audioUpload выше: тот — для музыки ожидания и приветствия (mp3/wav, до 15 МБ,
 * загружает директор в Настройках), этот — для короткой записи из браузера
 * (webm/opus почти всегда, 2 минуты голоса — не больше пары мегабайт). Разные
 * лимиты разного смысла лучше не делить на одном multer: смена одного случайно
 * подвинула бы другой.
 */
export const voiceMessageUpload = guardedUpload({
  name: "voiceMessageUpload",
  maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES,
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("audio/")) return cb(new UploadRejectedError("Допустимо только аудио"));
    cb(null, true);
  },
});

/**
 * Документы сделки (Пачка 14, 11.09.2026): свидетельство собственности, договор,
 * паспорт, квитанция. `memoryStorage`, как у обычных фото — файлы небольшие
 * (сканы/фото документа), не видео, поэтому К9 (диск для видео-загрузчиков) сюда
 * не относится. Сохраняются в закрытое хранилище (lib/dealDocumentFiles.ts), не
 * в `uploadsDir`: документы сделки не могут раздаваться статикой.
 */
export const dealDocumentUpload = guardedUpload({
  name: "dealDocumentUpload",
  maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES,
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.startsWith("image/") || file.mimetype === "application/pdf";
    if (!ok) return cb(new UploadRejectedError("Допустимы изображения или PDF"));
    cb(null, true);
  },
});

/**
 * ФОТО/ВИДЕО СОТРУДНИКА клиенту в переписке (18.08.2026, гибридный режим
 * 18.08.2026 вечер). Верхний предел здесь — общий "потолок", ловящий явно
 * неадекватные файлы ещё на приёме; он больше НЕ канальный лимит Meta.
 *
 * С гибридным режимом видео канальный лимит (WhatsApp 16 МБ, Instagram/Facebook
 * 25 МБ) перестал быть причиной отказа — lib/conversationDelivery.ts решает по
 * нему только "отправить файлом или ссылкой на R2", а не "принять или отклонить"
 * (владелец 18.08.2026: ролик объекта 100-300 МБ в исходном качестве не должен
 * упираться в лимит Graph API — сжатие/перекодирование отклонено, теряет качество).
 * Фото у этой логики не меняется — предел канала для фото (5 МБ на WhatsApp) как
 * был причиной отказа в conversationDelivery, так и остался.
 *
 * 300 МБ — предохранитель от случайно огромного файла, не лимит Meta. Число из
 * той же формулировки владельца («ролик объекта 100-300 МБ»), то есть верхняя
 * граница того, что вообще имеет смысл слать клиенту в переписку; оно же стоит у
 * clipVideoUpload ниже. Прежний 1 ГБ был опечаткой порядка величины: здесь
 * memoryStorage, и файл целиком ложится в оперативную память сервера, а не на
 * диск (аудит лимитов 21.08.2026).
 *
 * С 17.11.2026 300 МБ живут в CHUNKED_UPLOAD_PURPOSES["conversation-media"]: экран шлёт
 * файл ЧАСТЯМИ (POST /conversations/:id/reply-media/upload-sessions/:id/complete), а этот
 * одиночный приём — для старых вкладок и не тяжелее потолка прокси (тяжелее его и так
 * отбивал Cloudflare с 413 ещё до API).
 */
export const mediaMessageUpload = guardedUpload({
  name: "mediaMessageUpload",
  maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES,
  storage: videoTmpStorage,
  limits: { fileSize: PROXY_SINGLE_REQUEST_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/") && !file.mimetype.startsWith("video/")) {
      return cb(new UploadRejectedError("Допустимы только изображения или видео"));
    }
    cb(null, true);
  },
});

/**
 * Короткий ролик карточки объекта (POST /properties/:id/clip-video, план §3).
 * 300 МБ — предел ДО сжатия (значение из плана: обход квартиры телефоном, HD
 * покрывается с запасом). Длительность (не более 90с) проверяется отдельно через
 * ffprobe после сохранения во временный файл — multer её не знает.
 *
 * С 17.11.2026 экран шлёт ролик ЧАСТЯМИ (CHUNKED_UPLOAD_PURPOSES["clip-video"], 300 МБ);
 * одиночный приём — для старых вкладок и не тяжелее потолка прокси.
 */
export const clipVideoUpload = guardedUpload({
  name: "clipVideoUpload",
  maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES,
  storage: videoTmpStorage,
  limits: { fileSize: PROXY_SINGLE_REQUEST_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) return cb(new UploadRejectedError("Допустимо только видео"));
    cb(null, true);
  },
});

/**
 * Готовый ролик от монтажёра через CRM-панель (01.09.2026, lib/videoHandoff.ts,
 * см. videoHandoffDir выше) — второй путь к receiveEditedVideo рядом с Telegram,
 * для случаев, когда файл больше 20 МБ (потолок Telegram Bot API) или монтажёр
 * просто не привязал бота.
 *
 * 2 ГБ, а не 700 МБ (23.09.2026, докачка с середины): панель «Загрузить готовый
 * ролик» (PropertyVideoFixCard.tsx) теперь шлёт файл через докачку с середины
 * (upload-sessions, purpose=HANDOFF) — у той предела по факту нет (10 000 частей
 * по 8 МБ, см. routes/properties/videos.ts).
 *
 * 17.11.2026: предел опущен с 2 ГБ до потолка прокси. Прежнее обоснование «Telegram-бот
 * шлёт готовый ролик сюда же одним запросом» не подтвердилось: бот принимает ролик
 * функцией (lib/videoHandoff.ts), а не HTTP-запросом, и других вызывающих в репозитории
 * нет. Снаружи же тело больше ~100 МБ сюда не доходило вовсе — его режет Cloudflare.
 */
export const videoHandoffUpload = guardedUpload({
  name: "videoHandoffUpload",
  maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES,
  storage: videoTmpStorage,
  limits: { fileSize: PROXY_SINGLE_REQUEST_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) return cb(new UploadRejectedError("Допустимо только видео"));
    cb(null, true);
  },
});

/**
 * СВОБОДНЫЙ РОЛИК В СОЦСЕТИ (12.10.2026, routes/socialVideos.ts): промо-ролик без объекта,
 * который маркетинг загружает сам. С 17.11.2026 экран шлёт его ЧАСТЯМИ
 * (/social-videos/upload-sessions, до SOCIAL_VIDEO_UPLOAD_MAX_BYTES), а этот одиночный
 * приём — для старых вкладок и не тяжелее потолка прокси. Файл пишется на диск по мере приёма
 * (videoTmpStorage), не в память; обработчик маршрута обязан убрать временный файл.
 */
export const socialVideoUpload = guardedUpload({
  name: "socialVideoUpload",
  maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES,
  storage: videoTmpStorage,
  limits: { fileSize: PROXY_SINGLE_REQUEST_MAX_BYTES, files: 1, fields: 10, parts: 12, fieldSize: 64 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) return cb(new UploadRejectedError("Допустимо только видео (MP4 или MOV)"));
    cb(null, true);
  },
});

/** Фото-пост в разделе публикаций (16.11.2026): до 10 снимков по 20 МБ в память — sharp перекладывает их в JPEG. */
export const socialPhotoPostUpload = guardedUpload({
  name: "socialPhotoPostUpload",
  maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES,
  batchFitsReason: "экран сжимает снимки до 2560 px (compressImage, обычно 1-3 МБ) и проверяет общий вес до отправки (socialVideoUpload.sendOnce)",
  storage: multer.memoryStorage(),
  limits: { fileSize: SOCIAL_PHOTO_POST_MAX_BYTES, files: SOCIAL_PHOTO_POST_MAX_IMAGES, fields: 10, parts: SOCIAL_PHOTO_POST_MAX_IMAGES + 10, fieldSize: 64 * 1024 },
  fileFilter: (_req, file, cb) => {
    // HEIC с айфона браузер часто отдаёт как application/octet-stream — пускаем по имени, sharpFromUpload разберёт.
    if (!file.mimetype.startsWith("image/") && !/\.(heic|heif)$/i.test(file.originalname)) {
      return cb(new UploadRejectedError("Допустимы только фото (JPEG, PNG, WebP, HEIC)"));
    }
    cb(null, true);
  },
});

/** Обложка свободного ролика: картинка до 10 МБ в память — дальше sharp делает из неё два файла. */
export const socialVideoCoverUpload = guardedUpload({
  name: "socialVideoCoverUpload",
  maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES,
  storage: multer.memoryStorage(),
  limits: { fileSize: SOCIAL_VIDEO_COVER_MAX_BYTES, files: 1, fields: 4, parts: 6, fieldSize: 16 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!(SOCIAL_VIDEO_COVER_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      return cb(new UploadRejectedError("Обложка — JPEG, PNG или WebP"));
    }
    cb(null, true);
  },
});
