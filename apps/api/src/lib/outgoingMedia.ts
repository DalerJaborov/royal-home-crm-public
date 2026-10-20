import { randomUUID } from "node:crypto";
import { r2Upload, r2UploadFile } from "./r2Client.js";

/**
 * ФОТО/ВИДЕО АГЕНТА, отправляемые клиенту (18.08.2026, R2-версия 18.08.2026 вечер) —
 * хранится в Cloudflare R2, не на диске сервера (тот же бакет/клиент, что и у
 * видео-галереи объекта, см. lib/r2Client.ts) — прямое требование владельца:
 * «не забивать место на сервере».
 *
 * Ключ — `chat-media/<conversationId>/<uuid>.<ext>`: префикс `chat-media/` отделяет
 * эти файлы от `<propertyId>/...` видео-галереи и даёт маршруту раздачи
 * (routes/mediaProxy.ts) сузить presign только на свой префикс, не отдавая по той же
 * дыре чужие ключи бакета. UUID — та же причина, что была у случайного имени на
 * диске: предсказуемое имя позволило бы перебором читать чужие отправленные файлы.
 * Секрета в самом файле нет — это то, что оператор уже решил отправить клиенту.
 */
/** Байты в памяти или файл на диске (загрузка из переписки, до 300 МБ, — только
 *  файлом: читать его целиком в память нельзя, см. r2UploadFile). */
export type OutgoingMediaSource = Buffer | { path: string; size: number };

export async function uploadOutgoingMedia(
  conversationId: string,
  source: OutgoingMediaSource,
  ext: string,
  contentType: string
): Promise<string> {
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  const key = `chat-media/${conversationId}/${randomUUID()}.${safeExt}`;
  if (Buffer.isBuffer(source)) await r2Upload(key, source, contentType);
  else await r2UploadFile(key, source.path, source.size, contentType);
  return key;
}
