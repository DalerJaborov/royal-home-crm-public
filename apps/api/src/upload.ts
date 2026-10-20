import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import { looksLikeHeicName } from "./lib/heicInput.js";
import sharp from "sharp";
import { SOCIAL_VIDEO_UPLOAD_MAX_BYTES, SOCIAL_VIDEO_COVER_MAX_BYTES, SOCIAL_VIDEO_COVER_MIME_TYPES } from "@royal-home/shared";

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
export const upload = multer({
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
export const draftPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    // HEIC из Chrome на Windows приходит с пустым типом или octet-stream —
    // пускаем по расширению, содержимое проверит sharpFromUpload (lib/heicInput.ts).
    if (!file.mimetype.startsWith("image/") && !looksLikeHeicName(file.originalname)) {
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
export const coverTemplatesUpload = multer({
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
export const audioUpload = multer({
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
export const voiceMessageUpload = multer({
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
export const dealDocumentUpload = multer({
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
 */
export const mediaMessageUpload = multer({
  storage: videoTmpStorage,
  limits: { fileSize: 300 * 1024 * 1024, files: 1 },
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
 */
export const clipVideoUpload = multer({
  storage: videoTmpStorage,
  limits: { fileSize: 300 * 1024 * 1024, files: 1 },
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
 * по 8 МБ, см. routes/properties/videos.ts). Этот маршрут остаётся для ДРУГИХ
 * вызывающих (Telegram-бот шлёт готовый ролик сюда же одним запросом) — 2 ГБ
 * потому, что ровно таков потолок своего Bot API сервера
 * (TELEGRAM_BOT_SEND_LIMIT_BYTES, telegram/api.ts) — тяжелее оттуда всё равно не
 * прилетит. Не безлимит: одним запросом, как раньше, значит опять весь файл во
 * временном каталоге ДО обработки, и держать это неограниченным ценой
 * памяти/диска ради канала с собственным чётким потолком незачем.
 */
export const videoHandoffUpload = multer({
  storage: videoTmpStorage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) return cb(new UploadRejectedError("Допустимо только видео"));
    cb(null, true);
  },
});

/**
 * СВОБОДНЫЙ РОЛИК В СОЦСЕТИ (12.10.2026, routes/socialVideos.ts): промо-ролик без объекта,
 * который маркетинг загружает сам. Предел приёма — SOCIAL_VIDEO_UPLOAD_MAX_BYTES (2 ГБ,
 * как у ролика объекта): это предохранитель, настоящие пределы у каждой сети свои и
 * проверяются отдельно (shared/socialVideo.ts). Файл пишется на диск по мере приёма
 * (videoTmpStorage), не в память; обработчик маршрута обязан убрать временный файл.
 */
export const socialVideoUpload = multer({
  storage: videoTmpStorage,
  limits: { fileSize: SOCIAL_VIDEO_UPLOAD_MAX_BYTES, files: 1, fields: 10, parts: 12, fieldSize: 64 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) return cb(new UploadRejectedError("Допустимо только видео (MP4 или MOV)"));
    cb(null, true);
  },
});

/** Обложка свободного ролика: картинка до 10 МБ в память — дальше sharp делает из неё два файла. */
export const socialVideoCoverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SOCIAL_VIDEO_COVER_MAX_BYTES, files: 1, fields: 4, parts: 6, fieldSize: 16 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!(SOCIAL_VIDEO_COVER_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      return cb(new UploadRejectedError("Обложка — JPEG, PNG или WebP"));
    }
    cb(null, true);
  },
});
