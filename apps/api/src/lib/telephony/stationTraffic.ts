import { logSystemError } from "../systemError.js";
import { dushanbeDateString, dushanbeInputToDate } from "../dushanbeTime.js";
import { recordingFetchConfig } from "./callRecordings.js";

/**
 * ТРАФИК ВНЕШНЕГО АДРЕСА СТАНЦИИ (eth1) — УЧЁТ В CRM (08.10.2026).
 *
 * С 08.10 станция ходит к серверу CRM через платный реальный адрес: оператор берёт
 * около 100 сомони за 10 ГБ. Станция раз в час пишет счётчики интерфейса в CSV
 * (`ops/pbx/station/royalhome-eth1-usage.sh`) и отдаёт файл тем же каналом, что и
 * записи разговоров. Здесь файл читается, считается итог за месяц и директору
 * уходит предупреждение при 70 и 90 % лимита.
 *
 * Алгоритм подсчёта — 1-в-1 режим `report` скрипта станции: счётчик ОБНУЛЯЕТСЯ при
 * перезагрузке станции, поэтому если текущее значение меньше предыдущего, дельта —
 * само текущее значение; дельта относится к месяцу строки, на которой она замерена.
 */

/** Лимит месяца по тарифу оператора. Переопределяется `PBX_TRAFFIC_LIMIT_MB`, если тариф сменится. */
export const DEFAULT_STATION_TRAFFIC_LIMIT_MB = 10_240;
/** Имя файла на станции (рядом с каталогами записей). */
export const STATION_TRAFFIC_CSV = "royalhome-eth1-usage.csv";
/** Пороги предупреждения, процентов от лимита. */
export const STATION_TRAFFIC_WARN_PCT = 70;
export const STATION_TRAFFIC_CRITICAL_PCT = 90;

const FETCH_TIMEOUT_MS = 15_000;
const BYTES_IN_MB = 1_048_576;
/** Ответ экрану не чаще раза в 10 минут: api и worker — разные процессы, поэтому в памяти только кэш, не состояние. */
const CACHE_TTL_MS = 10 * 60_000;
/** Отказ запоминаем коротко, чтобы каждое открытие экрана не ждало таймаут станции. */
const CACHE_FAILURE_TTL_MS = 60_000;
/** Одна и та же поломка доступа к файлу — не чаще раза в 6 часов (тик раз в час). */
const FAILURE_REALERT_MS = 6 * 3_600_000;
const FAILURE_DEDUP_KEY = "pbx-traffic-fetch-failed";

export interface StationTrafficUsage {
  /** Месяц учёта по Душанбе, «ГГГГ-ММ». */
  month: string;
  usedMb: number;
  rxMb: number;
  txMb: number;
  limitMb: number;
  /** Доля лимита, процентов (не округлена — округляет тот, кто показывает). */
  pct: number;
  /** Время последней строки счётчика на станции (настоящий момент, ISO). */
  measuredAt: string;
}

export interface ParsedEth1Usage {
  rxBytes: number;
  txBytes: number;
  /** Метка последней корректной строки файла как есть («ГГГГ-ММ-ДД ЧЧ:ММ:СС», часы станции) или null. */
  lastStamp: string | null;
}

/** Лимит в мегабайтах: из окружения, если там нормальное положительное число. */
export function stationTrafficLimitMb(): number {
  const raw = Number(process.env.PBX_TRAFFIC_LIMIT_MB);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STATION_TRAFFIC_LIMIT_MB;
}

/**
 * Итог за месяц из CSV станции. Строки `ГГГГ-ММ-ДД ЧЧ:ММ:СС,rx_bytes,tx_bytes`.
 * Битые строки (заголовок, обрыв записи, нечисла) пропускаются и «предыдущей»
 * строкой не становятся — иначе один мусор в файле дал бы ложный «сброс счётчика»
 * и раздул итог на всё значение счётчика.
 */
export function parseEth1UsageCsv(text: string, month: string): ParsedEth1Usage {
  let rxBytes = 0;
  let txBytes = 0;
  let lastStamp: string | null = null;
  let prev: { rx: number; tx: number } | null = null;

  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(",");
    if (parts.length < 3) continue;
    const stamp = parts[0].trim();
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp)) continue;
    const rx = Number(parts[1]);
    const tx = Number(parts[2]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx) || rx < 0 || tx < 0) continue;

    if (prev) {
      // Счётчик сбросился (перезагрузка станции) — прирост равен текущему значению.
      const drx = rx >= prev.rx ? rx - prev.rx : rx;
      const dtx = tx >= prev.tx ? tx - prev.tx : tx;
      if (stamp.slice(0, 7) === month) {
        rxBytes += drx;
        txBytes += dtx;
      }
    }
    prev = { rx, tx };
    lastStamp = stamp;
  }
  return { rxBytes, txBytes, lastStamp };
}

/** Считает готовый итог из текста файла. Чистая функция — отдельно от сети, чтобы тест не лез в fetch. */
export function buildStationTrafficUsage(text: string, month: string, limitMb: number = stationTrafficLimitMb()): StationTrafficUsage {
  const { rxBytes, txBytes, lastStamp } = parseEth1UsageCsv(text, month);
  const rxMb = rxBytes / BYTES_IN_MB;
  const txMb = txBytes / BYTES_IN_MB;
  const usedMb = rxMb + txMb;
  let measuredAt = new Date();
  if (lastStamp) {
    const at = dushanbeInputToDate(lastStamp.slice(0, 10), lastStamp.slice(11, 16));
    if (!Number.isNaN(at.getTime())) measuredAt = at;
  }
  return { month, usedMb, rxMb, txMb, limitMb, pct: (usedMb / limitMb) * 100, measuredAt: measuredAt.toISOString() };
}

/**
 * Читает файл со станции и считает использование. null — адрес/токен станции не
 * заданы (тихо: это обычная разработческая среда) или станция не ответила (тогда
 * отказ ещё и в журнале, с долгим окном повтора).
 */
export async function fetchStationTrafficUsage(): Promise<StationTrafficUsage | null> {
  const config = recordingFetchConfig();
  if (!config || !config.token) return null;
  try {
    const res = await fetch(`${config.baseUrl}/${STATION_TRAFFIC_CSV}`, {
      headers: { "X-Recordings-Token": config.token },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await logTrafficFetchFailure(`станция ответила HTTP ${res.status}`);
      return null;
    }
    return buildStationTrafficUsage(await res.text(), dushanbeDateString().slice(0, 7));
  } catch (err) {
    await logTrafficFetchFailure(err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function logTrafficFetchFailure(detail: string): Promise<void> {
  await logSystemError(
    "telephony",
    `Не удалось прочитать учёт трафика станции (${detail}). Пока это так, CRM не предупредит о приближении лимита платного канала. ` +
      "Проверьте, что на станции работает cron учёта трафика и файл отдаётся тем же каналом, что записи разговоров.",
    { dedupKey: FAILURE_DEDUP_KEY, dedupWindowMs: FAILURE_REALERT_MS }
  );
}

let cache: { at: number; ttlMs: number; value: StationTrafficUsage | null } | null = null;

/** Для экрана: тот же результат не чаще раза в 10 минут. */
export async function getStationTrafficUsageCached(now: number = Date.now()): Promise<StationTrafficUsage | null> {
  if (cache && now - cache.at < cache.ttlMs) return cache.value;
  const value = await fetchStationTrafficUsage();
  cache = { at: now, ttlMs: value ? CACHE_TTL_MS : CACHE_FAILURE_TTL_MS, value };
  return value;
}

/** Только для тестов. */
export function resetStationTrafficCache(): void {
  cache = null;
}

const MONTH_NAMES_RU = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

/** «7,2 ГБ», «0,6 МБ», «10 ГБ» — десятичная запятая, лишний «,0» отброшен. */
function formatVolume(mb: number): string {
  const value = mb >= 1024 ? mb / 1024 : mb;
  const text = value.toFixed(1).replace(/\.0$/, "").replace(".", ",");
  return `${text} ${mb >= 1024 ? "ГБ" : "МБ"}`;
}

export function stationTrafficAlert(usage: StationTrafficUsage): { level: 70 | 90; message: string; dedupKey: string } | null {
  const level = usage.pct >= STATION_TRAFFIC_CRITICAL_PCT ? 90 : usage.pct >= STATION_TRAFFIC_WARN_PCT ? 70 : null;
  if (!level) return null;
  const monthName = MONTH_NAMES_RU[Number(usage.month.slice(5, 7)) - 1] ?? usage.month;
  const message =
    `Трафик станции за ${monthName}: ${formatVolume(usage.usedMb)} из ${formatVolume(usage.limitMb)} (${Math.round(usage.pct)} %). ` +
    "Это платный канал оператора (около 100 сомони за 10 ГБ). При исчерпании лимита оператор может начать брать плату сверх тарифа " +
    "или отключить канал — уточните условия тарифа заранее.";
  return { level, message, dedupKey: `pbx-traffic-${level}-${usage.month}` };
}

/**
 * Часовой тик: прочитать использование и поднять предупреждение директору. Ключ
 * включает месяц и порог, поэтому в месяц каждый порог звучит один раз; окно
 * дедупликации — больше месяца, а новый месяц получает новый ключ.
 */
export async function runStationTrafficTick(): Promise<{ usage: StationTrafficUsage | null; alertedLevel: 70 | 90 | null }> {
  const usage = await fetchStationTrafficUsage();
  if (!usage) return { usage: null, alertedLevel: null };
  const alert = stationTrafficAlert(usage);
  if (!alert) return { usage, alertedLevel: null };
  await logSystemError("telephony", alert.message, {
    dedupKey: alert.dedupKey,
    dedupWindowMs: 35 * 24 * 3_600_000,
  });
  return { usage, alertedLevel: alert.level };
}
