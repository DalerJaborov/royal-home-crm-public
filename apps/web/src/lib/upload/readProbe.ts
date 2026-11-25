/**
 * «ЧИТАЕТСЯ ЛИ ФАЙЛ» — ОДНА ПРОВЕРКА НА ВСЕ ЗАГРУЗКИ (25.11.2026).
 *
 * Живой случай: Android, ролики 219–271 МБ из галереи, в журнале «Телефон не даёт
 * прочитать файл… попытка 1/10, статус 0». Проверка была в трёх местах своей копией
 * (lib/uploadQueue.ts::filesReadable, lib/draftUploads.ts::fileReadable,
 * lib/uploadFormat.ts::isBlobReadable), и у всех трёх один и тот же изъян:
 *  - ОДНА неудачная попытка `slice(0, 64К).arrayBuffer()` сразу ставила задание в
 *    «не ушло» — хотя чтение с карты памяти/из облака галереи на Android часто
 *    отказывает один раз и проходит через секунду;
 *  - `catch {}` глотал `e.name`: в журнале не видно, файл пропал (NotFoundError),
 *    телефон не отдал его (NotReadableError) или кончилось место (QuotaExceededError);
 *  - очередь карточки читала копию из IndexedDB, а исходный файл, который человек
 *    только что выбрал и который у вкладки ещё на руках, не пробовала вовсе.
 *
 * Здесь: до трёх попыток с паузой 0,5 и 1,5 с, вторая и третья — по запасному файлу
 * (исходник в памяти), если он есть; причина отказа — словами для человека и
 * именем ошибки для журнала.
 */

export type ReadFailReason = "not-found" | "not-readable" | "quota" | "security" | "other";

/** Откуда брали байты: копия в IndexedDB, исходный файл в памяти вкладки или файл как есть. */
export type ReadSource = "idb" | "original" | "file";

export interface ReadCandidate {
  blob: Blob;
  source: ReadSource;
}

export type ReadProbeResult =
  | { ok: true; blob: Blob; source: ReadSource; attempts: number }
  | {
      ok: false;
      reason: ReadFailReason;
      /** `e.name` и `e.message` последней неудачи — в журнал, не человеку. */
      errorName: string;
      errorMessage: string;
      source: ReadSource;
      attempts: number;
    };

/** Паузы между попытками: 0,5 с перед второй, 1,5 с перед третьей. */
export const READ_PROBE_DELAYS_MS = [500, 1_500] as const;

/** Сколько с каждого края файла читаем — дёшево, но бросает ровно на том же отказе, что и отправка. */
const PROBE_BYTES = 64 * 1024;

/** Прочитать начало и конец. Бросает ошибку браузера как есть. */
export async function readBlobEnds(blob: Blob): Promise<void> {
  if (blob.size === 0) return;
  await blob.slice(0, Math.min(blob.size, PROBE_BYTES)).arrayBuffer();
  if (blob.size > PROBE_BYTES) await blob.slice(Math.max(0, blob.size - PROBE_BYTES)).arrayBuffer();
}

/** Имя ошибки браузера → причина. Чистая функция. */
export function classifyReadError(err: unknown): { reason: ReadFailReason; name: string; message: string } {
  const name = (err as { name?: unknown } | null)?.name;
  const message = (err as { message?: unknown } | null)?.message;
  const n = typeof name === "string" ? name : "Error";
  const m = typeof message === "string" ? message : String(err ?? "");
  let reason: ReadFailReason = "other";
  if (n === "NotFoundError") reason = "not-found";
  else if (n === "NotReadableError" || /Blob|could not be read/i.test(m)) reason = "not-readable";
  else if (n === "QuotaExceededError") reason = "quota";
  else if (n === "SecurityError" || n === "NotAllowedError") reason = "security";
  return { reason, name: n, message: m.slice(0, 200) };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * До трёх попыток прочитать файл. `candidates[0]` — основной источник (что уйдёт на
 * сервер), дальше — запасной (исходник в памяти): попытка N берёт `candidates[min(N-1, last)]`.
 * Успех возвращает тот blob, который прочитался, — его и надо слать.
 */
export async function probeReadable(
  candidates: ReadCandidate[],
  opts: { delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {}
): Promise<ReadProbeResult> {
  const delays = opts.delaysMs ?? READ_PROBE_DELAYS_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const attemptsTotal = delays.length + 1;
  let last: { reason: ReadFailReason; name: string; message: string; source: ReadSource } = {
    reason: "other",
    name: "Error",
    message: "нет файла",
    source: candidates[0]?.source ?? "file",
  };
  if (candidates.length === 0) return { ok: false, errorName: last.name, errorMessage: last.message, reason: last.reason, source: last.source, attempts: 0 };
  for (let i = 0; i < attemptsTotal; i++) {
    if (i > 0) await sleep(delays[i - 1]);
    const c = candidates[Math.min(i, candidates.length - 1)];
    try {
      await readBlobEnds(c.blob);
      return { ok: true, blob: c.blob, source: c.source, attempts: i + 1 };
    } catch (err) {
      last = { ...classifyReadError(err), source: c.source };
    }
  }
  return { ok: false, reason: last.reason, errorName: last.name, errorMessage: last.message, source: last.source, attempts: attemptsTotal };
}

export type DevicePlatform = "android" | "ios" | "other";

export function detectPlatform(ua: string = typeof navigator !== "undefined" ? navigator.userAgent ?? "" : ""): DevicePlatform {
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  return "other";
}

/**
 * Текст для человека: что случилось и что сделать. Без кодов и английских слов.
 * Разные причины — разные слова: «файл удалили» и «кончилась память» лечатся по-разному.
 */
export function readFailureMessage(reason: ReadFailReason, platform: DevicePlatform = detectPlatform()): string {
  if (reason === "not-found") {
    return "Файла больше нет на телефоне — его удалили, перенесли или он лежал только в облаке. Выберите его заново.";
  }
  if (reason === "quota") {
    return "На телефоне закончилось место для временной копии файла. Освободите память и добавьте файл снова.";
  }
  if (reason === "security") {
    return "Браузер запретил читать этот файл. Выберите его заново кнопкой «Добавить».";
  }
  if (platform === "android") {
    return "Телефон не отдаёт файл. Сохраните ролик в память телефона или выберите его через «Файлы» и добавьте снова.";
  }
  if (platform === "ios") {
    return "Телефон не даёт прочитать файл (так бывает после перезапуска приложения). Уберите его и добавьте заново.";
  }
  return "Файл не читается. Уберите его и добавьте заново.";
}
