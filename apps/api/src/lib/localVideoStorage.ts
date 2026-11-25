import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UploadError, isDiskFullError, toStorageError } from "./uploadErrors.js";

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
 *
 * ОДИН СЛОЙ НА ВСЕ ТРИ ВИДА ЗАГРУЗКИ ЧАСТЯМИ (25.11.2026, волна B): общее ядро
 * (lib/chunkedUploadSessions.ts), видео объекта (routes/properties/videos.ts) и ролик
 * черновика (lib/propertyDraftMedia.ts) пишут на диск только через функции ниже, и
 * правила надёжности живут здесь, а не в каждом маршруте:
 *   - место на диске проверяется ДО записи (assertUploadDiskSpace) — нехватка места
 *     отвечает 507 DISK_FULL, а не 500 посреди записи и не падением Postgres рядом;
 *   - часть и служебные файлы пишутся во временный файл и переименовываются —
 *     обрыв или ENOSPC не оставляют обрезанную `part-N` со статусом «принята»;
 *   - сборка сверяет размер каждой части с планом и итог с `sizeBytes`, склеивает во
 *     временный `.partial-*` и переименовывает атомарно; две сборки одной сессии
 *     разводит замок с пульсом (lockLocalUploadAssembly);
 *   - сборка НЕ удаляет части: их убирает finishLocalUploadSession ПОСЛЕ того, как
 *     результат закреплён (запись в базе, перенос файла) — иначе упавшая запись в базу
 *     превращала каждый повтор в «не удалось собрать» навсегда.
 * Сторож: tests/upload-storage-one-door.test.ts (часть пишется только через этот модуль).
 */

/** Запас свободного места, ниже которого загрузки не принимаются (по умолчанию 5 ГБ):
 *  на том же диске живёт база, и ENOSPC валит её вместе с загрузкой. */
const DEFAULT_DISK_RESERVE_BYTES = 5 * 1024 * 1024 * 1024;

export function uploadDiskReserveBytes(): number {
  const raw = Number(process.env.UPLOAD_DISK_RESERVE_BYTES);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DISK_RESERVE_BYTES;
}

/** Свободно байт на диске сессий загрузки; null — измерить нельзя (тогда не блокируем). */
export async function uploadDiskFreeBytes(): Promise<number | null> {
  try {
    const st = await fs.promises.statfs(sessionsDir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/**
 * Хватит ли места под `bytesNeeded` с запасом uploadDiskReserveBytes(). Нет — UploadError
 * DISK_FULL (507, повтор бесполезен). Измерить нельзя — пропускаем: «не смогли проверить»
 * не повод отказывать в загрузке.
 */
export async function assertUploadDiskSpace(bytesNeeded: number): Promise<void> {
  // Выключатель только для тестов (tests/setup.ts): прогон на ноутбуке с почти полным диском
  // не должен краснеть на ролике «2 ГБ», которого в тесте нет. На сервере не задаётся — проверка есть.
  if (process.env.UPLOAD_DISK_CHECK === "off") return;
  const free = await uploadDiskFreeBytes();
  if (free === null) return;
  const need = Math.max(0, bytesNeeded) + uploadDiskReserveBytes();
  if (free < need) {
    throw new UploadError("DISK_FULL", {
      detail: `свободно ${Math.round(free / 1024 / 1024)} МБ, нужно ${Math.round(need / 1024 / 1024)} МБ (с запасом)`,
    });
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Атомарная запись маленького файла: временный файл рядом + переименование. */
async function writeFileAtomic(target: string, data: string | Buffer): Promise<void> {
  const tmp = `${target}.tmp-${randomUUID()}`;
  try {
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, target);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function createLocalUploadSession(sessionId: string): Promise<void> {
  const dir = resolveSessionDir(sessionId);
  if (!dir) throw new Error(`Недопустимый id сессии: ${sessionId}`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    throw toStorageError(err, "папка сессии загрузки");
  }
}

/** Папка сессии на диске (null — id не нашего формата). */
export function localUploadSessionDir(sessionId: string): string | null {
  return resolveSessionDir(sessionId);
}

/** Служебный файл сессии без записи в базе (свободный ролик в соцсети, 17.11.2026):
 *  кто открыл, план частей, имя файла. Имя не совпадает с `part-N`, склейку не задевает. */
const SESSION_META = "meta.json";
/** Итог сборки (state, результат или отказ) — переживает удаление частей на сутки. */
const SESSION_STATE = "state.json";
const LOCK_FILE = "assemble.lock";
const KEEP_AFTER_FINISH = new Set([SESSION_META, SESSION_STATE]);

export async function writeLocalUploadSessionMeta(sessionId: string, meta: unknown): Promise<void> {
  const dir = resolveSessionDir(sessionId);
  if (!dir) throw new Error(`Недопустимый id сессии: ${sessionId}`);
  try {
    await writeFileAtomic(path.join(dir, SESSION_META), JSON.stringify(meta));
  } catch (err) {
    throw toStorageError(err, "план сессии загрузки");
  }
}

async function readJson(sessionId: string, name: string): Promise<unknown> {
  const dir = resolveSessionDir(sessionId);
  if (!dir) return null;
  try {
    return JSON.parse(await fs.promises.readFile(path.join(dir, name), "utf8"));
  } catch {
    return null;
  }
}

/** null — нет такой сессии (или id не нашего формата). */
export async function readLocalUploadSessionMeta(sessionId: string): Promise<unknown> {
  return readJson(sessionId, SESSION_META);
}

/** Состояние сборки сессии (см. lib/uploadCompletion.ts). Папку заводит при нужде:
 *  итог хранится и после того, как части убраны. */
export async function writeLocalUploadSessionState(sessionId: string, state: unknown): Promise<void> {
  const dir = resolveSessionDir(sessionId);
  if (!dir) throw new Error(`Недопустимый id сессии: ${sessionId}`);
  await fs.promises.mkdir(dir, { recursive: true });
  await writeFileAtomic(path.join(dir, SESSION_STATE), JSON.stringify(state));
}

export async function readLocalUploadSessionState(sessionId: string): Promise<unknown> {
  return readJson(sessionId, SESSION_STATE);
}

/** Номера частей, уже лежащих на диске (недописанные `part-N.tmp-*` не в счёт). */
export async function listLocalUploadParts(sessionId: string): Promise<number[]> {
  return [...(await localUploadPartSizes(sessionId)).keys()];
}

/** Части на диске с размером: номер → байты. Правда о принятом — диск, а не список в базе. */
export async function localUploadPartSizes(sessionId: string): Promise<Map<number, number>> {
  const dir = resolveSessionDir(sessionId);
  const out = new Map<number, number>();
  if (!dir) return out;
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return out;
  }
  const numbers = names
    .map((name) => /^part-(\d+)$/.exec(name)?.[1])
    .filter((n): n is string => !!n)
    .map(Number)
    .sort((a, b) => a - b);
  for (const n of numbers) {
    const st = await fs.promises.stat(path.join(dir, `part-${n}`)).catch(() => null);
    if (st?.isFile()) out.set(n, st.size);
  }
  return out;
}

/** Все id сессий на диске — для уборки брошенных сессий без записи в базе. */
export async function listLocalUploadSessionIds(): Promise<string[]> {
  try {
    return (await fs.promises.readdir(sessionsDir)).filter((name) => SESSION_ID_RE.test(name));
  } catch {
    return [];
  }
}

/** Папки сессий с возрастом последнего изменения — для уборки сирот (lib/videoUploadCleanup.ts). */
export async function listLocalUploadSessionDirs(): Promise<Array<{ id: string; mtimeMs: number; hasMeta: boolean }>> {
  const out: Array<{ id: string; mtimeMs: number; hasMeta: boolean }> = [];
  for (const id of await listLocalUploadSessionIds()) {
    const dir = resolveSessionDir(id);
    if (!dir) continue;
    const st = await fs.promises.stat(dir).catch(() => null);
    if (!st?.isDirectory()) continue;
    const hasMeta = await fs.promises
      .access(path.join(dir, SESSION_META))
      .then(() => true)
      .catch(() => false);
    out.push({ id, mtimeMs: st.mtimeMs, hasMeta });
  }
  return out;
}

function isAbortError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | null;
  return (
    e?.code === "ECONNRESET" ||
    e?.code === "ECONNABORTED" ||
    e?.code === "ERR_STREAM_PREMATURE_CLOSE" ||
    /^aborted$/i.test(e?.message ?? "")
  );
}

/**
 * Записывает часть. `body` — готовый Buffer (бот Telegram, старые маршруты) или поток
 * запроса: тогда байты идут на диск по мере прихода, без копии части в памяти, со счётчиком
 * (`maxBytes` — обрыв на лишнем байте). Сначала во временный файл, потом переименование:
 * обрыв, нехватка места или падение процесса не оставляют обрезанную `part-N`.
 * `expectedBytes` — размер по плану: другой размер — отказ, файл части не появляется.
 *
 * Повтор той же части перезаписывает файл — клиент может смело повторять.
 * Возвращает число записанных байт.
 */
export async function writeLocalUploadPart(
  sessionId: string,
  partNumber: number,
  body: Buffer | Readable,
  opts: { expectedBytes?: number; maxBytes?: number } = {}
): Promise<number> {
  const dir = resolveSessionDir(sessionId);
  if (!dir) throw new Error(`Недопустимый id сессии: ${sessionId}`);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1) throw new UploadError("PART_OUT_OF_RANGE");
  if (!(await dirExists(dir))) throw new UploadError("SESSION_NOT_FOUND");
  const limit = opts.maxBytes ?? opts.expectedBytes ?? Number.POSITIVE_INFINITY;
  const finalPath = path.join(dir, `part-${partNumber}`);
  const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
  let written = 0;
  try {
    if (Buffer.isBuffer(body)) {
      if (body.length > limit) throw new UploadError("PART_SIZE_MISMATCH");
      written = body.length;
      if (written > 0) await fs.promises.writeFile(tmpPath, body);
    } else {
      // Лишние байты не пишутся, но тело дочитывается (до разумного предела): оборвать поток
      // запроса значило бы закрыть соединение, и клиент вместо понятного 400 увидел бы обрыв
      // связи и повторял бы ту же неверную часть по кругу.
      const drainCap = Number.isFinite(limit) ? limit * 2 + 1024 * 1024 : Number.POSITIVE_INFINITY;
      let overflow = false;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length;
          if (written > drainCap) return cb(new UploadError("PART_SIZE_MISMATCH"));
          if (written > limit) {
            overflow = true;
            return cb();
          }
          cb(null, chunk);
        },
      });
      await pipeline(body, counter, fs.createWriteStream(tmpPath));
      if (overflow) throw new UploadError("PART_SIZE_MISMATCH");
    }
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    if (err instanceof UploadError) throw err;
    if (isDiskFullError(err)) throw toStorageError(err, `запись части ${partNumber}`);
    if (isAbortError(err)) throw new UploadError("PART_INCOMPLETE");
    throw toStorageError(err, `запись части ${partNumber}`);
  }
  if (written === 0) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw new UploadError("EMPTY_PART");
  }
  if (opts.expectedBytes !== undefined && written !== opts.expectedBytes) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw new UploadError("PART_SIZE_MISMATCH");
  }
  try {
    await fs.promises.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw toStorageError(err, `запись части ${partNumber}`);
  }
  return written;
}

/** План сессии для сборки: число частей обязательно, размеры — для сверки байт-в-байт. */
export interface LocalUploadPlan {
  totalParts: number;
  partSize?: number;
  sizeBytes?: number;
}

function normalizePlan(plan: number | LocalUploadPlan): LocalUploadPlan {
  return typeof plan === "number" ? { totalParts: plan } : plan;
}

function expectedPartSize(plan: LocalUploadPlan, n: number): number | null {
  if (plan.partSize === undefined || plan.sizeBytes === undefined) return null;
  return n === plan.totalParts ? plan.sizeBytes - plan.partSize * (plan.totalParts - 1) : plan.partSize;
}

/**
 * Сверка частей с планом перед склейкой. Нет части или её размер не тот (обрезана сбоем
 * прошлой версии, чужая запись) — битая часть удаляется, а вызывающий получает PARTS_MISSING
 * со списком годных: клиент дошлёт недостающие, вместо того чтобы получить битый ролик.
 */
async function verifyPartsOnDisk(sessionId: string, plan: LocalUploadPlan): Promise<void> {
  const dir = resolveSessionDir(sessionId);
  if (!dir) throw new Error(`Недопустимый id сессии: ${sessionId}`);
  const sizes = await localUploadPartSizes(sessionId);
  const good: number[] = [];
  let missing = false;
  for (let n = 1; n <= plan.totalParts; n++) {
    const have = sizes.get(n);
    const want = expectedPartSize(plan, n);
    if (have === undefined || have === 0 || (want !== null && have !== want)) {
      missing = true;
      if (have !== undefined) await fs.promises.rm(path.join(dir, `part-${n}`), { force: true }).catch(() => {});
      continue;
    }
    good.push(n);
  }
  if (missing) throw new UploadError("PARTS_MISSING", { extra: { uploadedPartNumbers: good, totalParts: plan.totalParts } });
}

/** Склеивает части сессии по порядку в файл по АБСОЛЮТНОМУ пути — общий шаг для
 *  completeLocalUploadSession (сырое видео, ключ закрытого хранилища) и докачки
 *  готового ролика от монтажёра (23.09.2026, purpose=HANDOFF на сессии — путь
 *  назначения там не ключ закрытого хранилища, а временный файл, который
 *  дальше переносит receiveEditedVideoFromFile в lib/videoHandoff.ts). Части
 *  пишутся строго по порядку номеров — байты конечного файла обязаны идти в
 *  том же порядке, что и у исходника, иначе видео рассыплется.
 *
 *  Пишется в `<dest>.partial-<uuid>` и переименовывается в `dest` только целиком
 *  (25.11.2026): существующий `dest` нужного размера — значит, прошлая сборка дошла
 *  до конца, и повтор её не повторяет (`reused: true`). Две одновременные сборки
 *  больше не пишут в один файл с обрезкой (дыра нулей при ответе 201). */
async function assembleSessionParts(sessionId: string, destPath: string, planIn: number | LocalUploadPlan): Promise<{ reused: boolean }> {
  const plan = normalizePlan(planIn);
  const dir = resolveSessionDir(sessionId);
  if (!dir) throw new Error(`Недопустимый id сессии: ${sessionId}`);

  if (plan.sizeBytes !== undefined) {
    const existing = await fs.promises.stat(destPath).catch(() => null);
    if (existing?.isFile() && existing.size === plan.sizeBytes) return { reused: true };
  }
  await verifyPartsOnDisk(sessionId, plan);
  await assertUploadDiskSpace(plan.sizeBytes ?? 0);

  const partialPath = `${destPath}.partial-${randomUUID()}`;
  try {
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  } catch (err) {
    throw toStorageError(err, "папка назначения сборки");
  }
  const out = createWriteStream(partialPath);
  /**
   * ОДИН сторож отказа на весь поток, а не по одному на каждую часть.
   * Раньше `out.on("error", reject)` вешался ВНУТРИ цикла и не снимался: на
   * ролике тяжелее 88 МБ Node печатал MaxListenersExceededWarning, а на большом
   * файле на одном потоке копились тысячи слушателей.
   */
  const outFailed = new Promise<never>((_, reject) => {
    out.once("error", reject);
  });
  outFailed.catch(() => {});
  try {
    for (let n = 1; n <= plan.totalParts; n++) {
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
     * хвост файла ещё лежит в буфере.
     */
    await Promise.race([
      outFailed,
      new Promise<void>((resolve) => {
        out.once("finish", resolve);
        out.end();
      }),
    ]);
    if (plan.sizeBytes !== undefined) {
      const st = await fs.promises.stat(partialPath);
      if (st.size !== plan.sizeBytes) {
        throw new Error(`собрано ${st.size} байт вместо ${plan.sizeBytes}`);
      }
    }
    await fs.promises.rename(partialPath, destPath);
  } catch (err) {
    // Недописанный файл не «доводим» до конца: части на диске остаются целы, повтор
    // сборки начнёт заново с них.
    out.destroy();
    await fs.promises.rm(partialPath, { force: true }).catch(() => {});
    throw toStorageError(err, "сборка файла из частей");
  }
  return { reused: false };
}

/** Склейка в ключ закрытого хранилища сырых видео. Части НЕ удаляет — это делает
 *  finishLocalUploadSession, когда результат закреплён. `plan` — число частей (старый
 *  вызов) или план с размерами (сверка байт-в-байт и повтор без склейки). */
export async function completeLocalUploadSession(
  sessionId: string,
  destKey: string,
  plan: number | LocalUploadPlan
): Promise<{ reused: boolean }> {
  const dest = resolveKeyPath(destKey);
  if (!dest) throw new Error(`Недопустимый ключ файла: ${destKey}`);
  return assembleSessionParts(sessionId, dest, plan);
}

/** Та же склейка, но в файл ВНЕ закрытого хранилища сырых видео — для докачки
 *  готового ролика от монтажёра (purpose=HANDOFF) и общего ядра сессий.
 *  `destPath` — абсолютный путь, который готовит вызывающий код. Части НЕ удаляет. */
export async function completeLocalUploadSessionToPath(
  sessionId: string,
  destPath: string,
  plan: number | LocalUploadPlan
): Promise<{ reused: boolean }> {
  return assembleSessionParts(sessionId, destPath, plan);
}

/** Замок старше этого без пульса — след упавшего процесса, его можно перехватить. */
export const ASSEMBLY_LOCK_STALE_MS = 2 * 60 * 1000;
const ASSEMBLY_LOCK_HEARTBEAT_MS = 30 * 1000;

export interface AssemblyLock {
  release(): Promise<void>;
}

/**
 * Замок сборки сессии — один на все три вида загрузки. Файл создаётся атомарно (`wx`);
 * пока сборка идёт, пульс раз в 30 с обновляет его время. Замок без пульса дольше
 * ASSEMBLY_LOCK_STALE_MS — след убитого процесса: снимаем и берём заново (раньше такой
 * замок держал сессию 15 минут). null — сборка уже идёт в другом запросе.
 */
export async function lockLocalUploadAssembly(sessionId: string): Promise<AssemblyLock | null> {
  const dir = resolveSessionDir(sessionId);
  if (!dir) throw new UploadError("SESSION_NOT_FOUND");
  if (!(await dirExists(dir))) throw new UploadError("SESSION_NOT_FOUND");
  const lockPath = path.join(dir, LOCK_FILE);
  const take = async (): Promise<boolean> => {
    try {
      await (await fs.promises.open(lockPath, "wx")).close();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw toStorageError(err, "замок сборки");
    }
  };
  let taken = await take();
  if (!taken) {
    const st = await fs.promises.stat(lockPath).catch(() => null);
    if (st && Date.now() - st.mtimeMs <= ASSEMBLY_LOCK_STALE_MS) return null;
    await fs.promises.rm(lockPath, { force: true }).catch(() => {});
    taken = await take();
    if (!taken) return null;
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void fs.promises.utimes(lockPath, now, now).catch(() => {});
  }, ASSEMBLY_LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      await fs.promises.rm(lockPath, { force: true }).catch(() => {});
    },
  };
}

/**
 * Сессия своё отыграла: части, замок и недописки удаляются. С `state` — папка остаётся
 * с meta.json и state.json (итог сборки помнится сутки: повтор «собрать» отдаёт его
 * же, а не «загрузка не найдена»). Без `state` — папка удаляется целиком.
 * Не бросает; true — частей на диске больше нет.
 */
export async function finishLocalUploadSession(sessionId: string, state?: unknown): Promise<boolean> {
  const dir = resolveSessionDir(sessionId);
  if (!dir) return true;
  if (state === undefined) return abortLocalUploadSession(sessionId);
  try {
    await writeLocalUploadSessionState(sessionId, state);
    for (const name of await fs.promises.readdir(dir)) {
      if (KEEP_AFTER_FINISH.has(name)) continue;
      await fs.promises.rm(path.join(dir, name), { recursive: true, force: true });
    }
    return true;
  } catch (err) {
    console.error(`[localVideoStorage] не удалось убрать части сессии ${sessionId}:`, err instanceof Error ? err.message : err);
    return false;
  }
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
