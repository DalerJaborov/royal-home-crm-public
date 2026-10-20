import { prisma } from "../db.js";

/**
 * ГЛУБОКАЯ ПРОВЕРКА ЗДОРОВЬЯ ДЛЯ СТОРОЖА НА СЕРВЕРЕ (аудит 23.09.2026, круг 3,
 * №77; просьба Dan 25.09 — «внешний сторож, который будит сервер, если он завис»).
 *
 * `/api/v1/health` отвечает «жив», даже когда база не отвечает, и ничего не знает
 * о фоновом процессе (worker): зависший worker молчит, а сторож пульса тиков живёт
 * в нём же и молчит вместе с ним. Здесь — два ответа, по которым
 * `ops/health-watch.sh` решает, кого перезапустить:
 *  - db: база отвечает на простой запрос за DB_TIMEOUT_MS;
 *  - worker: хоть один тик расписания отметился в пульсе (`CronHeartbeat`,
 *    запуск или пропуск выключенного модуля) не раньше WORKER_STALE_MS назад.
 *    Частые тики идут раз в 2–5 минут, так что 10 минут тишины — это не пауза,
 *    а вставший процесс.
 * Сам ответ API за таймаут сторожа означает, что жив процесс api.
 */

export const WORKER_STALE_MS = 10 * 60_000;
const DB_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type DeepHealth = {
  ok: boolean;
  db: boolean;
  worker: boolean;
  /** Сколько секунд назад worker последний раз отметился; null — не известно. */
  workerLastBeatSec: number | null;
};

/** Последняя отметка любого тика в пульсе: запуск или пропуск выключенного модуля. */
async function lastWorkerBeat(): Promise<Date | null> {
  const last = await withTimeout(
    prisma.cronHeartbeat.aggregate({ _max: { lastRunAt: true, lastSkippedAt: true } }),
    DB_TIMEOUT_MS
  ).catch(() => null);
  const beats = [last?._max.lastRunAt, last?._max.lastSkippedAt]
    .filter((d): d is Date => d instanceof Date)
    .map((d) => d.getTime());
  return beats.length ? new Date(Math.max(...beats)) : null;
}

export async function deepHealth(
  options: { now?: number; readLastBeat?: () => Promise<Date | null> } = {}
): Promise<DeepHealth> {
  const now = options.now ?? Date.now();
  const db = await withTimeout(prisma.$queryRaw`SELECT 1`, DB_TIMEOUT_MS)
    .then(() => true)
    .catch(() => false);
  if (!db) return { ok: false, db: false, worker: false, workerLastBeatSec: null };

  const lastBeat = await (options.readLastBeat ?? lastWorkerBeat)();
  const workerLastBeatSec =
    lastBeat === null ? null : Math.max(0, Math.round((now - lastBeat.getTime()) / 1000));
  const worker = workerLastBeatSec !== null && workerLastBeatSec * 1000 <= WORKER_STALE_MS;
  return { ok: worker, db, worker, workerLastBeatSec };
}
