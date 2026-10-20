/**
 * Чистые функции формата для очереди загрузки — скорость, оставшееся время,
 * сообщение телеметрии отказа. Ничего не знают ни про IndexedDB, ни про XHR,
 * ни про React — поэтому тестируются без браузера (найдено 23.09.2026, разбор
 * жалобы «не грузится»: объект №134, IMG_0065.mov 183 МБ, 12,5 минуты ~250 КБ/с,
 * а строка задания всё это время показывала «0% · в очереди», без единой цифры
 * о том, что вообще происходит).
 */

/** `formatUploadSize` жила в UploadTaskRow.tsx — переехала сюда как более общая
 *  чистая функция формата; UploadTaskRow.tsx реэкспортирует её для прежних
 *  вызывающих (StepMedia.tsx, StepReview.tsx), второй такой функции не заводим. */
export function formatUploadSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} ГБ`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Та же лестница единиц, что и formatUploadSize, но со скоростью — байт/с те
 *  же байты, поэтому используем ровно тот же формат с припиской «/с». */
export function formatSpeedBps(bytesPerSecond: number): string {
  return `${formatUploadSize(Math.max(0, bytesPerSecond))}/с`;
}

/** Единица измерения для пары «отдано / всего»: обе части строки — в единице
 *  ИТОГА (totalBytes), иначе «4,2 МБ из 183» превратилось бы в разнобой
 *  единиц на маленьком файле (КБ) и большом (МБ) в одной строке. */
function pickUnit(bytes: number): "КБ" | "МБ" | "ГБ" {
  if (bytes >= 1024 * 1024 * 1024) return "ГБ";
  if (bytes >= 1024 * 1024) return "МБ";
  return "КБ";
}

function unitDivisor(unit: "КБ" | "МБ" | "ГБ"): number {
  return unit === "ГБ" ? 1024 * 1024 * 1024 : unit === "МБ" ? 1024 * 1024 : 1024;
}

/** «4,2 МБ из 183» — обе части в единице ИТОГА, отданное с одним знаком после
 *  запятой (точнее в моменте, чем целое), итог округлён до целого (он и так
 *  печатается рядом полностью — formatUploadSize(total) выше по строке). */
export function formatProgressFraction(loadedBytes: number, totalBytes: number): string {
  const unit = pickUnit(totalBytes);
  const div = unitDivisor(unit);
  const loadedValue = Math.max(0, loadedBytes) / div;
  const totalValue = Math.max(0, totalBytes) / div;
  const loadedLabel =
    unit === "КБ"
      ? `${Math.max(0, Math.round(loadedValue))} КБ`
      : `${loadedValue.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`;
  const totalLabel = Math.round(totalValue).toLocaleString("ru-RU");
  return `${loadedLabel} из ${totalLabel}`;
}

/** ~45 с / ~12 мин / ~1 ч 05 мин — не точнее секунды, дальше человеку всё
 *  равно нужен порядок величины, а не таймер до секунды. */
export function formatEtaSeconds(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `~${s} с`;
  const totalMinutes = Math.round(s / 60);
  if (totalMinutes < 60) return `~${totalMinutes} мин`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `~${hours} ч` : `~${hours} ч ${String(minutes).padStart(2, "0")} мин`;
}

/** Одна точка прогресса: момент времени (мс, `Date.now()`) и отдано байт
 *  накопительно с начала ЭТОГО задания. */
export interface ProgressSample {
  t: number;
  loaded: number;
}

/** Порог, за пределы которого старые точки в скользящее среднее не берутся. */
export const SPEED_WINDOW_MS = 5_000;

/**
 * Скользящее среднее скорости по последним ~5 с прогресса. Чистая функция —
 * хранение самих точек (t, loaded) живёт в модуле очереди (uploadQueue.ts),
 * здесь только расчёт из готового списка.
 *
 * `null`, когда данных мало: первая точка задания, слишком короткий разброс
 * по времени (не набежали 5 с и хотя бы 2 точки) или на первый взгляд время
 * не движется (часы браузера перевели назад — такое бывает после сна
 * устройства). Строка задания в этом случае честно пишет «начинаем…», а не
 * делит на ноль и не показывает случайную цифру.
 */
export function computeSpeedBps(samples: ProgressSample[], now: number = Date.now()): number | null {
  const windowStart = now - SPEED_WINDOW_MS;
  const inWindow = samples.filter((s) => s.t >= windowStart && s.t <= now);
  if (inWindow.length < 2) return null;
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const dt = (last.t - first.t) / 1000;
  const dLoaded = last.loaded - first.loaded;
  if (dt <= 0.25 || dLoaded <= 0) return null;
  return dLoaded / dt;
}

/**
 * Честная строка активного задания: «183 МБ · 4,2 МБ из 183 · 250 КБ/с ·
 * осталось ~12 мин». Пока скорость ещё не набралась (см. computeSpeedBps) —
 * «183 МБ · начинаем…», а не пустая полоса и не деление на ноль в ETA.
 */
export function formatActiveUploadLine(totalBytes: number, loadedBytes: number, speedBps: number | null): string {
  const totalLabel = formatUploadSize(totalBytes);
  if (speedBps == null || speedBps <= 0) return `${totalLabel} · начинаем…`;
  const progress = formatProgressFraction(loadedBytes, totalBytes);
  const speedLabel = formatSpeedBps(speedBps);
  const remaining = Math.max(0, totalBytes - loadedBytes);
  const etaLabel = formatEtaSeconds(remaining / speedBps);
  return `${totalLabel} · ${progress} · ${speedLabel} · осталось ${etaLabel}`;
}

/** Секунд до следующей попытки, округлённое вверх (та же логика, что и у
 *  баннера UploadIndicator.secondsUntil — «0 с» не должно мелькать за миг до
 *  самого повтора). */
function secondsUntil(ts: number, now: number): number {
  return Math.max(1, Math.ceil((ts - now) / 1000));
}

/**
 * «Связь пропала — попробуем ещё раз · повтор через 40 с» — живой обратный
 * отсчёт вместо голого «в очереди», который агент читает как «застряло»
 * (найдено 23.09.2026). Причина отказа — настоящая (`task.error`), не
 * придуманная заново: баннер сверху и строка задания уже используют один
 * источник правды для текста ошибки, эта функция его не подменяет.
 */
export function formatRetryCountdown(error: string, nextAttemptAt: number, now: number = Date.now()): string {
  return `${error} · повтор через ${secondsUntil(nextAttemptAt, now)} с`;
}

/** Короткая метка устройства для телеметрии — платформа + браузер, без всей
 *  строки User-Agent (та в ErrorLog и так есть у серверных запросов через
 *  заголовок, но у ручного текста сообщения читать её агенту незачем). */
export function formatShortUserAgent(ua: string): string {
  const platform = /iPad/i.test(ua)
    ? "iPad"
    : /iPhone/i.test(ua)
      ? "iPhone"
      : /Android/i.test(ua)
        ? "Android"
        : /Macintosh/i.test(ua)
          ? "Mac"
          : /Windows/i.test(ua)
            ? "Windows"
            : "";
  const browser = /EdgA|Edge|Edg\//i.test(ua)
    ? "Edge"
    : /CriOS|Chrome/i.test(ua)
      ? "Chrome"
      : /FxiOS|Firefox/i.test(ua)
        ? "Firefox"
        : /SamsungBrowser/i.test(ua)
          ? "Samsung Internet"
          : /Safari/i.test(ua)
            ? "Safari"
            : "";
  const label = [platform, browser].filter(Boolean).join(" ");
  return label || "браузер неизвестен";
}

/** То, чем задание закончило попытку — ровно то, что нужно для одной строки
 *  сообщения телеметрии ниже, а не весь StoredTask/DraftMediaItem целиком
 *  (у очереди карточки и очереди мастера разные типы задания). */
export interface UploadIssueInfo {
  kind: "photo" | "video" | "clip";
  name: string;
  sizeBytes: number;
  /** Уже готовая подпись объекта — «объект ОБ-000134» или «черновик объекта»
   *  (мастер ещё не завёл Property, ей взяться неоткуда) — решает вызывающий,
   *  этой функции не нужно знать формат номера объекта. */
  propertyLabel: string;
  attempts: number;
  maxAttempts: number;
  status: number;
  error: string | null;
  online: boolean;
  partsDone?: number;
  partsTotal?: number;
  /** Шаг, на котором оборвался ролик мастера: session | parts | complete. */
  stage?: "session" | "parts" | "complete";
  userAgent: string;
}

const KIND_LABEL: Record<UploadIssueInfo["kind"], string> = {
  photo: "фото",
  video: "видео",
  clip: "ролик",
};

/**
 * «[загрузка] видео IMG_0065.mov 183 МБ, объект ОБ-000134, попытка 3/10,
 * статус 0, «Связь прервалась», online=true, части 0/22, iPhone Safari».
 *
 * Один формат на оба места вызова (uploadQueue.ts и draftUploads.ts) — иначе
 * утренний отчёт директора (читает ErrorLog) получает два разных диалекта
 * одного и того же случая.
 */
export function formatUploadIssueMessage(info: UploadIssueInfo): string {
  const parts =
    info.partsTotal != null ? `, части ${info.partsDone ?? 0}/${info.partsTotal}` : "";
  const stage = info.stage ? `, этап ${info.stage}` : "";
  const errorLabel = info.error ?? "нет ответа";
  return (
    `[загрузка] ${KIND_LABEL[info.kind]} ${info.name} ${formatUploadSize(info.sizeBytes)}, ${info.propertyLabel}, ` +
    `попытка ${info.attempts}/${info.maxAttempts}, статус ${info.status}, «${errorLabel}», ` +
    `online=${info.online}${parts}${stage}, ${formatShortUserAgent(info.userAgent)}`
  );
}

/** Текст отказа D1: файл, который телефон не даёт прочитать (после
 *  перезапуска приложения — известная особенность WebKit с Blob из
 *  IndexedDB). Без пометки — «до первого куска», с пометкой — когда та же
 *  часть дважды подряд ушла со статусом 0 и нулём отданных байт: связь есть
 *  (иначе часть не бралась бы за отправку заново), файл читается через раз.
 */
export function unreadableFileMessage(connectivityConfirmedOk: boolean): string {
  const base = "Телефон не даёт прочитать файл (после перезапуска приложения так бывает) — уберите его и добавьте заново";
  return connectivityConfirmedOk ? `${base} (связь есть, файл не читается)` : base;
}

/** Сколько с каждого края части читаем при проверке «файл вообще читается». */
const READ_PROBE_BYTES = 64 * 1024;

/**
 * Реально ли читается этот кусок файла (WEB-10, аудит 04.10.2026). Нечитаемым
 * Blob из IndexedDB на WebKit объявляем только после попытки прочитать его начало
 * и конец: два обрыва подряд без единого байта сами по себе доказывают лишь
 * отсутствие связи, а не повреждённый файл. Пустой кусок:
 * проверять нечего, считаем читаемым.
 */
export async function isBlobReadable(blob: Blob): Promise<boolean> {
  if (blob.size === 0) return true;
  try {
    await blob.slice(0, Math.min(blob.size, READ_PROBE_BYTES)).arrayBuffer();
    if (blob.size > READ_PROBE_BYTES) await blob.slice(Math.max(0, blob.size - READ_PROBE_BYTES)).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}
