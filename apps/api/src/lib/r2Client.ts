import fs from "node:fs";
import { AwsClient } from "aws4fetch";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/**
 * Обёртка над Cloudflare R2 (S3-совместимый API) для сырого видео объектов.
 *
 * aws4fetch, а не @aws-sdk/client-s3 — ноль зависимостей, R2 полностью
 * S3-совместим для тех операций, что нужны здесь (put/get/delete/presign).
 * Ключи — только из .env (см. .env.example): бакет отдельный от
 * royalhome-backups и специфичен для одной фичи, заводить его в Настройках
 * рядом с Anthropic/Gemini ключами было бы лишней сущностью ради одной формы.
 */

function endpoint(): string | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  return accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null;
}

function bucketName(): string {
  return process.env.R2_BUCKET_NAME || "royalhome-property-video";
}

let client: AwsClient | null = null;
function resolveClient(): AwsClient | null {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  if (!client) {
    client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
  }
  return client;
}

export function isR2Configured(): boolean {
  return !!endpoint() && !!resolveClient();
}

function objectUrl(key: string): string {
  return `${endpoint()}/${bucketName()}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}

// Файлы до ~1ГБ (см. multer.limits в routes/properties.ts) на связи агента с площадки —
// таймаут на порядок щедрее обычных внешних вызовов, иначе зависшее TCP-соединение
// держит запрос вечно (ни одна из R2-операций раньше не имела таймаута вообще).
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DELETE_TIMEOUT_MS = 30_000;

/**
 * Живость доступа к бакету: HEAD по самому бакету, ничего не читает и не пишет.
 * Ключи R2 обслуживают только старые вложения чата и записи звонков до
 * 07.08.2026 — то есть отзыв ключей обнаружился бы через месяцы, когда кто-то
 * откроет архивный файл. Отсюда суточная проверка (lib/integrationHealth.ts).
 *
 * @returns `null` — R2 не настроен; иначе HTTP-код ответа бакета.
 */
export async function r2HealthCheck(): Promise<number | null> {
  const aws = resolveClient();
  const base = endpoint();
  if (!aws || !base) return null;
  const res = await aws.fetch(`${base}/${bucketName()}`, {
    method: "HEAD",
    signal: AbortSignal.timeout(15_000),
  });
  return res.status;
}

/** Загружает файл в R2. Бросает при отсутствии конфигурации или сетевом отказе — вызывающий решает, что делать. */
export async function r2Upload(key: string, body: Buffer, contentType: string): Promise<void> {
  const aws = resolveClient();
  if (!aws || !endpoint()) throw new Error("R2 не настроен (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY)");
  const res = await aws.fetch(objectUrl(key), {
    method: "PUT",
    body,
    headers: { "Content-Type": contentType },
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Оба живых вызывающих (conversationDelivery.ts, liveVoiceBridge.ts) уже ловят
    // это исключение и пишут в журнал сами — здесь НЕ дублируем: см. разбор
    // 22.09.2026 (п.9 «внешний вызов без записи отказа в журнал»).
    throw new Error(`R2 upload failed: ${res.status} ${text}`);
  }
}

/**
 * МНОГОЧАСТЕВАЯ ЗАГРУЗКА — ради докачки видео с середины.
 *
 * Ролик с площадки идёт минутами, и до этого любой обрыв означал отправку
 * гигабайта заново. S3-совместимый протокол (R2 его поддерживает целиком)
 * позволяет слать файл кусками: сервер помнит, какие куски уже приняты, и
 * клиент досылает только недостающие.
 *
 * Размер куска не меньше 5 МБ — требование протокола ко всем частям, кроме
 * последней. Меньше нельзя: R2 отвечает EntityTooSmall на завершении, когда
 * менять что-либо уже поздно.
 */
export const R2_MIN_PART_SIZE = 5 * 1024 * 1024;

function requireClient(): AwsClient {
  const aws = resolveClient();
  if (!aws || !endpoint()) throw new Error("R2 не настроен (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY)");
  return aws;
}

/** Открывает многочастевую загрузку и возвращает её идентификатор в R2. */
export async function r2CreateMultipart(key: string, contentType: string): Promise<string> {
  const res = await requireClient().fetch(`${objectUrl(key)}?uploads`, {
    method: "POST",
    body: "",
    headers: { "Content-Type": contentType },
    signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    // Живой путь один — r2UploadFile ниже (фото/видео сотрудника клиенту из
    // переписки, аудит 23.09.2026 №74). Пишем в журнал здесь же, а не полагаемся
    // на вызывающего: тот самый пробел, из-за которого этот пункт и попал в
    // разбор 22.09.2026.
    void logSystemError("storage", `R2: многочастевая загрузка не открыта (${key}): HTTP ${res.status} ${text}`);
    throw new Error(`R2 create multipart failed: ${res.status} ${text}`);
  }
  // Разбор регулярным выражением, а не XML-парсером: ответ S3 на эту операцию —
  // документированные три поля, и тянуть зависимость ради одного тега незачем.
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(text)?.[1];
  if (!uploadId) throw new Error("R2 create multipart: в ответе нет UploadId");
  return uploadId;
}

/** Отправляет одну часть. Возвращает её ETag — он нужен при завершении. */
export async function r2UploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string> {
  const url = `${objectUrl(key)}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`;
  const res = await requireClient().fetch(url, {
    method: "PUT",
    body,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    void logSystemError("storage", `R2: часть ${partNumber} загрузки ${key} не отправлена: HTTP ${res.status} ${text}`);
    throw new Error(`R2 upload part ${partNumber} failed: ${res.status} ${text}`);
  }
  const etag = res.headers.get("etag");
  if (!etag) throw new Error(`R2 upload part ${partNumber}: в ответе нет ETag`);
  // Кавычки снимаем при хранении и возвращаем при завершении — так в базе лежит
  // чистое значение, а в XML уходит ровно то, чего ждёт протокол.
  return etag.replace(/^"|"$/g, "");
}

/** Собирает файл из частей. Части обязаны идти по возрастанию номера. */
export async function r2CompleteMultipart(
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[]
): Promise<void> {
  const xml =
    "<CompleteMultipartUpload>" +
    [...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`)
      .join("") +
    "</CompleteMultipartUpload>";

  const res = await requireClient().fetch(`${objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`, {
    method: "POST",
    body: xml,
    headers: { "Content-Type": "application/xml" },
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    void logSystemError("storage", `R2: сборка многочастевой загрузки ${key} не удалась: HTTP ${res.status} ${text.slice(0, 300)}`);
    throw new Error(`R2 complete multipart failed: ${res.status} ${text}`);
  }
  /**
   * S3 умеет ответить 200 и при этом сообщить об ОШИБКЕ в теле — так сделано,
   * чтобы соединение не рвалось во время долгой сборки объекта. Проверять только
   * код ответа здесь недостаточно: мы бы записали в базу видео, которого нет.
   */
  if (/<Error>/.test(text)) {
    void logSystemError("storage", `R2: сборка многочастевой загрузки ${key} вернула ошибку в теле: ${text.slice(0, 300)}`);
    throw new Error(`R2 complete multipart вернул ошибку в теле: ${text.slice(0, 300)}`);
  }
}

/** Размер куска при загрузке файла с диска: не меньше R2_MIN_PART_SIZE, и ровно
 *  столько памяти держит одна загрузка в каждый момент. */
export const R2_FILE_PART_SIZE = 8 * 1024 * 1024;

/**
 * ФАЙЛ С ДИСКА В R2, НЕ ЧИТАЯ ЕГО В ПАМЯТЬ ЦЕЛИКОМ (аудит 23.09.2026, №74).
 *
 * Видео, которое сотрудник отправляет клиенту из переписки, бывает до 300 МБ
 * (multer кладёт его на диск), а процесс API живёт в 768 МБ: чтение целиком
 * двумя-тремя такими отправками разом роняло всю CRM. Небольшой файл уходит
 * одним запросом, как раньше; крупный — частями по R2_FILE_PART_SIZE, в памяти
 * всегда не больше одной части. Сорвалось посередине — незавершённая загрузка
 * отменяется (части в R2 хранятся платно), ошибка уходит вызывающему.
 */
export async function r2UploadFile(key: string, filePath: string, size: number, contentType: string): Promise<void> {
  if (size <= R2_FILE_PART_SIZE) {
    await r2Upload(key, await fs.promises.readFile(filePath), contentType);
    return;
  }
  const uploadId = await r2CreateMultipart(key, contentType);
  const handle = await fs.promises.open(filePath, "r");
  try {
    const parts: { partNumber: number; etag: string }[] = [];
    for (let offset = 0, partNumber = 1; offset < size; offset += R2_FILE_PART_SIZE, partNumber++) {
      const length = Math.min(R2_FILE_PART_SIZE, size - offset);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (bytesRead !== length) throw new Error(`R2: файл ${filePath} короче заявленного (${offset + bytesRead} из ${size} байт)`);
      parts.push({ partNumber, etag: await r2UploadPart(key, uploadId, partNumber, chunk) });
    }
    await r2CompleteMultipart(key, uploadId, parts);
  } catch (err) {
    await r2AbortMultipart(key, uploadId);
    throw err;
  } finally {
    await handle.close();
  }
}

/** Отменяет незавершённую загрузку. Не бросает: незакрытые части лежат в R2 платно,
 *  но падать из-за неудачной уборки вызывающему незачем — отказ уходит в журнал. */
export async function r2AbortMultipart(key: string, uploadId: string): Promise<boolean> {
  const aws = resolveClient();
  if (!aws || !endpoint()) return false;
  try {
    const res = await aws.fetch(`${objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
    });
    if (res.ok || res.status === 404) return true;
    const text = await res.text().catch(() => "");
    void logSystemError("storage", `R2: не удалось отменить загрузку ${key}: HTTP ${res.status} ${text}`);
    return false;
  } catch (err) {
    void logSystemError("storage", `R2: не удалось отменить загрузку ${key}: ${describeError(err)}`);
    return false;
  }
}

/** Скачивает файл из R2 как Buffer — используется для проксирующего стрима download-роута. */
export async function r2Download(key: string): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | null } | null> {
  const aws = resolveClient();
  if (!aws || !endpoint()) return null;
  const res = await aws.fetch(objectUrl(key), { method: "GET", signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) return null;
  return { body: res.body, contentType: res.headers.get("content-type") };
}

/** Удаляет один объект. Не бросает — отказ логируется, вызывающий (синхронная точка удаления
 *  или cron-подстраховка) не должен падать целиком из-за одного файла. */
export async function r2Delete(key: string): Promise<boolean> {
  const aws = resolveClient();
  if (!aws || !endpoint()) return false;
  try {
    const res = await aws.fetch(objectUrl(key), { method: "DELETE", signal: AbortSignal.timeout(DELETE_TIMEOUT_MS) });
    if (res.ok || res.status === 404) return true;
    // Отказ по HTTP (права, чужой бакет, 5xx) раньше уходил молча — вызывающий
    // видел только false и не мог сказать, почему файл остался платно лежать.
    const text = await res.text().catch(() => "");
    void logSystemError("storage", `R2: не удалось удалить ${key}: HTTP ${res.status} ${text}`);
    return false;
  } catch (err) {
    void logSystemError("storage", `R2: не удалось удалить ${key}: ${describeError(err)}`);
    return false;
  }
}

/** Presigned URL на скачивание — 10 минут, достаточно на один клик «Скачать».
 *
 *  X-Amz-Expires ОБЯЗАН быть в URL уже на входе в aws.sign(): aws4fetch подставляет
 *  свой дефолт (86400) в канонический запрос, только если этого параметра ещё нет
 *  (см. aws4fetch/dist/aws4fetch.esm.mjs: `if (!params.has('X-Amz-Expires')) …`).
 *  Правка query-строки ПОСЛЕ подписи (как было раньше) меняет подписанный
 *  канонический запрос без пересчёта подписи — R2 отвечает SignatureDoesNotMatch. */
export async function r2PresignDownloadUrl(key: string): Promise<string | null> {
  const aws = resolveClient();
  if (!aws || !endpoint()) return null;
  const url = new URL(objectUrl(key));
  url.searchParams.set("X-Amz-Expires", "600");
  const signed = await aws.sign(url.toString(), {
    method: "GET",
    aws: { signQuery: true, service: "s3", region: "auto" },
    headers: {},
  });
  return signed.url;
}
