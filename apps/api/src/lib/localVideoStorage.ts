import fs from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";

/**
 * Сырое видео объекта (31.08.2026) — ЗАКРЫТОЕ локальное хранилище на диске
 * сервера, не Cloudflare R2 (см. историю в git). Решение владельца: за R2
 * нужно было платить и настраивать отдельно от остального сервера, а видео —
 * тот же смысл, что и у приватных вложений переписки (lib/privateFiles.ts):
 * закрытая папка ВНЕ uploads (та раздаётся статикой без всякой проверки,
 * см. app.ts) — доступ только через аутентифицированные роуты этого файла.
 *
 * Ключ (storageKey) — двухуровневый относительный путь `<propertyId>/<uuid>.<ext>`,
 * тот же формат, что был у ключа R2-бакета: значения в базе НЕ ТРОГАЛИСЬ при
 * миграции (см. migration.sql — переименование колонки, не данных), только
 * теперь это путь на диске, а не ключ бакета.
 */

export const videoStorageDir = path.resolve(process.env.PROPERTY_VIDEO_DIR ?? "./uploads-private-video");
/** Части многочастевой докачки — ВНЕ videoStorageDir: если бы части лежали
 *  внутри, недописанный файл рисковал попасть под те же операции чтения, что
 *  и готовые видео, при малейшей ошибке в фильтрации по расширению ниже. */
const sessionsDir = path.resolve(process.env.PROPERTY_VIDEO_SESSIONS_DIR ?? "./uploads-private-video-sessions");

fs.mkdirSync(videoStorageDir, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });

/** propertyId — uuid Prisma; сам файл — uuid.расширение. Тот же рубеж от обхода
 *  пути, что и в privateFiles.ts (OWN_NAME_RE): ключ может прийти из базы, куда
 *  когда-то в теории попадёт не только то, что сюда же и писали. */
const KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/i;
const SESSION_ID_RE = /^[0-9a-f-]{36}$/i;

function resolveKeyPath(key: string): string | null {
  if (!KEY_RE.test(key)) return null;
  const full = path.resolve(path.join(videoStorageDir, key));
  // Второй рубеж на случай, если регулярное выражение однажды ослабят —
  // итоговый путь обязан остаться на два уровня внутри videoStorageDir.
  if (path.dirname(path.dirname(full)) !== videoStorageDir) return null;
  return full;
}

function resolveSessionDir(sessionId: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const full = path.resolve(path.join(sessionsDir, sessionId));
  if (path.dirname(full) !== sessionsDir) return null;
  return full;
}

export async function localVideoUpload(key: string, body: Buffer): Promise<void> {
  const dest = resolveKeyPath(key);
  if (!dest) throw new Error(`Недопустимый ключ файла: ${key}`);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, body);
}

/** Тот же контракт, что был у r2Delete: не бросает, true — файла больше нет
 *  (в том числе если его и не было), false — отказ, который стоит увидеть в
 *  журнале (права, диск занят). */
export async function localVideoDelete(key: string): Promise<boolean> {
  const dest = resolveKeyPath(key);
  if (!dest) return false;
  try {
    await fs.promises.unlink(dest);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Абсолютный путь файла на диске — null при недопустимом ключе. Существование
 *  не проверяет: вызывающий код сам решает, как обработать отсутствие (стрим
 *  бросит ENOENT естественным образом). */
export function localVideoFilePath(key: string): string | null {
  return resolveKeyPath(key);
}

export async function localVideoExists(key: string): Promise<boolean> {
  const p = resolveKeyPath(key);
  if (!p) return false;
  try {
    await fs.promises.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * ДОКАЧКА С СЕРЕДИНЫ — локальная замена R2-протокола multipart. Части пишутся
 * в свою папку сессии (по id самой записи VideoUploadSession — отдельный
 * r2UploadId-аналог не нужен), при завершении дописываются по порядку в
 * конечный файл потоком, без буферизации всего файла в памяти.
 */
export async function createLocalUploadSession(sessionId: string): Promise<void> {
  const dir = resolveSessionDir(sessionId);
  if (!dir) throw new Error(`Недопустимый id сессии: ${sessionId}`);
  await fs.promises.mkdir(dir, { recursive: true });
}

export async function writeLocalUploadPart(sessionId: string, partNumber: number, body: Buffer): Promise<void> {
  const dir = resolveSessionDir(sessionId);
  if (!dir) throw new Error(`Недопустимый id сессии: ${sessionId}`);
  await fs.promises.writeFile(path.join(dir, `part-${partNumber}`), body);
}

/** Склеивает части сессии по порядку в файл по АБСОЛЮТНОМУ пути — общий шаг для
 *  completeLocalUploadSession (сырое видео, ключ закрытого хранилища) и докачки
 *  готового ролика от монтажёра (23.09.2026, purpose=HANDOFF на сессии — путь
 *  назначения там не ключ закрытого хранилища, а временный файл, который
 *  дальше переносит receiveEditedVideoFromFile в lib/videoHandoff.ts). Части
 *  пишутся строго по порядку номеров — байты конечного файла обязаны идти в
 *  том же порядке, что и у исходника, иначе видео рассыплется. Папку сессии
 *  убирает вызывающий код (после успешного использования собранного файла),
 *  не эта функция — при purpose=HANDOFF собранный файл ещё предстоит перенести. */
async function assembleSessionParts(sessionId: string, destPath: string, totalParts: number): Promise<void> {
  const dir = resolveSessionDir(sessionId);
  if (!dir) throw new Error(`Недопустимый id сессии: ${sessionId}`);

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const out = createWriteStream(destPath);
  /**
   * ОДИН сторож отказа на весь поток, а не по одному на каждую часть.
   * Раньше `out.on("error", reject)` вешался ВНУТРИ цикла и не снимался. Часть —
   * 8 МБ (VIDEO_PART_SIZE в routes/properties/videos.ts), потолок — 10 000 частей,
   * поэтому на любом ролике тяжелее 88 МБ Node печатал MaxListenersExceededWarning,
   * а на большом файле на одном потоке копились тысячи слушателей. Толк от них был
   * только у текущего витка: обещания прошлых уже разрешены, и их `reject` — пустой
   * вызов.
   */
  const outFailed = new Promise<never>((_, reject) => {
    out.once("error", reject);
  });
  try {
    for (let n = 1; n <= totalParts; n++) {
      const partPath = path.join(dir, `part-${n}`);
      await Promise.race([
        outFailed,
        new Promise<void>((resolve, reject) => {
          const inStream = createReadStream(partPath);
          inStream.once("error", reject);
          inStream.once("end", resolve);
          inStream.pipe(out, { end: false });
        }),
      ]);
    }
    /**
     * Закрытие потока — ПОСЛЕДНИЙ шаг, который умеет отказать: до события `finish`
     * хвост файла ещё лежит в буфере. Раньше `out.end()` стоял в `finally` и не
     * ожидался вовсе — отказ на сбросе буфера уходил в пустоту, части ниже успевали
     * удалиться, и на диске оставался обрезанный ролик, о котором ни в журнале, ни
     * у вызывающего не было ни слова.
     */
    await Promise.race([
      outFailed,
      new Promise<void>((resolve) => {
        out.once("finish", resolve);
        out.end();
      }),
    ]);
  } catch (err) {
    // Недописанный файл не «доводим» до конца: повтор завершения откроет его
    // заново и перепишет с нуля (createWriteStream обрезает файл на открытии),
    // а части на диске остаются целы — их убирает вызывающий код, и только
    // после того, как эта функция вернулась без отказа.
    out.destroy();
    throw err;
  }
}

export async function completeLocalUploadSession(sessionId: string, destKey: string, totalParts: number): Promise<void> {
  const dest = resolveKeyPath(destKey);
  if (!dest) throw new Error(`Недопустимый ключ файла: ${destKey}`);
  await assembleSessionParts(sessionId, dest, totalParts);
  const dir = resolveSessionDir(sessionId);
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
}

/** Та же склейка, но в файл ВНЕ закрытого хранилища сырых видео — для докачки
 *  готового ролика от монтажёра (purpose=HANDOFF), см. докстринг у
 *  assembleSessionParts выше. `destPath` — абсолютный путь, который готовит
 *  вызывающий код (routes/properties/videos.ts), не ключ по формату KEY_RE. */
export async function completeLocalUploadSessionToPath(sessionId: string, destPath: string, totalParts: number): Promise<void> {
  await assembleSessionParts(sessionId, destPath, totalParts);
  const dir = resolveSessionDir(sessionId);
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
}

/** Отмена недописанной сессии: части удаляются вместе с её папкой. Не бросает.
 *  Возвращает true, только если папки сессии больше нет на диске (07.10.2026): раньше
 *  функция отвечала true всегда, и уборка стирала строку VideoUploadSession, даже
 *  когда каталог частей не удалился, — части оставались на диске без единой ссылки
 *  на себя, и повторить отмену было некому. Нет папки вовсе — тоже успех. */
export async function abortLocalUploadSession(sessionId: string): Promise<boolean> {
  const dir = resolveSessionDir(sessionId);
  if (!dir) return true;
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.error(`[localVideoStorage] не удалось удалить части сессии ${sessionId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}
