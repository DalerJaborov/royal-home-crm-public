import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadsDir } from "../upload.js";

/**
 * Голосовое АГЕНТА, отправляемое клиенту, — публичная копия рядом с фотографиями
 * объекта (см. lib/messagePhoto.ts, тот же приём).
 *
 * Meta забирает вложение своими серверами по ссылке (см. buildImageRequest в
 * messengers/meta.ts) — значит файл обязан лежать в открытой `uploads`, а не в
 * закрытом хранилище `uploads-private`, куда падают ГОЛОСОВЫЕ КЛИЕНТА (их наружу
 * никто не должен уметь скачать). Разница оправдана: агент сам решает отправить
 * это клиенту, то есть содержимое уже не секрет — client его и так получит.
 *
 * Имя — случайный UUID, как у privateFiles: предсказуемое имя позволило бы
 * перебором читать чужие голосовые, лежащие в той же публичной папке.
 */

const voiceDir = path.join(uploadsDir, "msg-voice");

/** Сохраняет уже перекодированный буфер (ogg для WhatsApp, m4a для
 *  Instagram/Messenger — см. lib/audioTranscode.ts) и отдаёт путь внутри
 *  `/uploads` — превращение в абсолютную ссылку для Meta делает lib/crmPublicUrl.ts. */
export async function saveOutgoingVoice(buffer: Buffer, ext: "ogg" | "m4a" = "ogg"): Promise<string> {
  await fs.mkdir(voiceDir, { recursive: true });
  const name = `${randomUUID()}.${ext}`;
  await fs.writeFile(path.join(voiceDir, name), buffer);
  return `/uploads/msg-voice/${name}`;
}
