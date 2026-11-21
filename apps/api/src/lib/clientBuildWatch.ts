import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { logSystemError } from "./systemError.js";

/**
 * СТОРОЖ ЗАСТРЯВШИХ ВКЛАДОК (21.11.2026).
 *
 * Вкладка, которая не смогла обновиться, ничем себя не выдаёт: сервер отвечает
 * ей как обычно, а человек видит старый интерфейс и «Страница не найдена» на
 * новом разделе. Узнали об этом от владельца — его iPhone сутки сидел на
 * старой сборке. Теперь каждый запрос несёт заголовки сборки вкладки
 * (apps/web/src/lib/appVersion.ts → clientBuildHeaders):
 *   X-Client-Build       — версия фронта (`__APP_VERSION__`, GIT_SHA выката);
 *   X-Client-Build-Time  — момент сборки фронта, мс.
 *
 * «Текущая» сборка — самая свежая по времени сборки из увиденных: сервер не
 * знает о git и не читает файлы фронта, но первая же вкладка, получившая новую
 * версию, приносит её сама. Застрявшая — та, что после появления текущей
 * сборки продолжает ходить со старой дольше STALE_AFTER_MS.
 *
 * Раз в час, и только если такие есть, — одна сводная строка в журнал ошибок,
 * тихо (без пуша директору): это повод посмотреть, а не тревога. Всё в памяти
 * процесса, с жёсткими пределами — заголовки присылает кто угодно.
 */

export const STALE_AFTER_MS = 30 * 60_000;
export const REPORT_EVERY_MS = 60 * 60_000;
const MAX_BUILDS = 50;
const MAX_CLIENTS = 5_000;
/** Сборка «из будущего» дальше этого — враньё часов или заголовка, не верим. */
const FUTURE_SLACK_MS = 10 * 60_000;

const headerSchema = z.object({
  build: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  builtAt: z.coerce.number().int().positive().optional(),
});

interface BuildInfo {
  builtAt: number | null;
  /** Когда сервер впервые увидел эту сборку у кого-то. */
  firstSeen: number;
}

interface ClientInfo {
  build: string;
  lastSeen: number;
}

export interface StaleSummary {
  current: string;
  stale: { build: string; clients: number }[];
  total: number;
}

export class ClientBuildWatch {
  private builds = new Map<string, BuildInfo>();
  private clients = new Map<string, ClientInfo>();
  private lastReportAt: number;

  constructor(now = Date.now()) {
    this.lastReportAt = now;
  }

  note(build: string, builtAt: number | null, clientKey: string, now = Date.now()): void {
    const trustedBuiltAt = builtAt !== null && builtAt <= now + FUTURE_SLACK_MS ? builtAt : null;
    const known = this.builds.get(build);
    if (!known) {
      if (this.builds.size >= MAX_BUILDS) this.evictOldestBuild();
      this.builds.set(build, { builtAt: trustedBuiltAt, firstSeen: now });
    } else if (known.builtAt === null && trustedBuiltAt !== null) {
      known.builtAt = trustedBuiltAt;
    }
    if (!this.clients.has(clientKey) && this.clients.size >= MAX_CLIENTS) this.evictOldestClient();
    this.clients.set(clientKey, { build, lastSeen: now });
  }

  /** Самая свежая сборка по времени сборки (без времени — по первому появлению). */
  currentBuild(): { build: string; info: BuildInfo } | null {
    let best: { build: string; info: BuildInfo } | null = null;
    for (const [build, info] of this.builds) {
      const rank = info.builtAt ?? info.firstSeen;
      const bestRank = best ? best.info.builtAt ?? best.info.firstSeen : -Infinity;
      if (rank > bestRank) best = { build, info };
    }
    return best;
  }

  /** Кто на старой сборке, хотя текущая известна дольше STALE_AFTER_MS. */
  staleSummary(now = Date.now()): StaleSummary | null {
    const current = this.currentBuild();
    if (!current || now - current.info.firstSeen < STALE_AFTER_MS) return null;
    const byBuild = new Map<string, number>();
    for (const client of this.clients.values()) {
      if (client.build === current.build) continue;
      // Вкладку, которая не ходила к серверу с момента выхода текущей сборки,
      // в застрявшие не пишем: возможно, её давно закрыли.
      if (client.lastSeen < current.info.firstSeen + STALE_AFTER_MS) continue;
      byBuild.set(client.build, (byBuild.get(client.build) ?? 0) + 1);
    }
    if (!byBuild.size) return null;
    const stale = [...byBuild.entries()]
      .map(([build, clients]) => ({ build, clients }))
      .sort((a, b) => b.clients - a.clients);
    return { current: current.build, stale, total: stale.reduce((sum, s) => sum + s.clients, 0) };
  }

  /** Пора ли докладывать (раз в REPORT_EVERY_MS) — и что. Отметку ставит сама. */
  takeReport(now = Date.now()): StaleSummary | null {
    if (now - this.lastReportAt < REPORT_EVERY_MS) return null;
    this.lastReportAt = now;
    this.dropSilentClients(now);
    return this.staleSummary(now);
  }

  private dropSilentClients(now: number): void {
    for (const [key, client] of this.clients) {
      if (now - client.lastSeen > 2 * REPORT_EVERY_MS) this.clients.delete(key);
    }
  }

  private evictOldestBuild(): void {
    const current = this.currentBuild()?.build;
    let oldest: string | null = null;
    let oldestSeen = Infinity;
    for (const [build, info] of this.builds) {
      if (build !== current && info.firstSeen < oldestSeen) {
        oldest = build;
        oldestSeen = info.firstSeen;
      }
    }
    if (oldest) this.builds.delete(oldest);
  }

  private evictOldestClient(): void {
    let oldest: string | null = null;
    let oldestSeen = Infinity;
    for (const [key, client] of this.clients) {
      if (client.lastSeen < oldestSeen) {
        oldest = key;
        oldestSeen = client.lastSeen;
      }
    }
    if (oldest) this.clients.delete(oldest);
  }
}

export function formatStaleSummary(summary: StaleSummary): string {
  const parts = summary.stale
    .slice(0, 5)
    .map((s) => `${s.build} (${s.clients})`)
    .join(", ");
  return `Вкладки на старой сборке дольше 30 минут: ${summary.total}. Текущая сборка ${summary.current}; старые: ${parts}`;
}

/** Ключ вкладки для подсчёта: сотрудник после входа, иначе устройство. */
function clientKeyOf(req: Request): string | null {
  const agentId = (req as { agent?: { id?: unknown } }).agent?.id;
  if (typeof agentId === "string" && agentId) return `a:${agentId}`;
  const device = req.get("X-Device-Id");
  if (device && /^[A-Za-z0-9._:-]{1,80}$/.test(device)) return `d:${device}`;
  return null;
}

/**
 * Express-прослойка. Ставится до маршрутов; сотрудника читает уже после ответа
 * (`finish`), когда проверка входа его выставила. Никогда не мешает запросу:
 * всё внутри — без throw, запись в журнал — в отрыве.
 */
export function clientBuildWatchMiddleware(
  watch = new ClientBuildWatch(),
  report: (message: string) => void = (message) => {
    void logSystemError("api", message, {
      dedupKey: "stale-client-builds",
      dedupWindowMs: REPORT_EVERY_MS - 5 * 60_000,
      silent: true,
    });
  }
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = headerSchema.safeParse({
      build: req.get("X-Client-Build") ?? undefined,
      builtAt: req.get("X-Client-Build-Time") ?? undefined,
    });
    if (parsed.success) {
      const { build, builtAt } = parsed.data;
      res.once("finish", () => {
        try {
          const key = clientKeyOf(req);
          if (!key) return;
          const now = Date.now();
          watch.note(build, builtAt ?? null, key, now);
          const summary = watch.takeReport(now);
          if (summary) report(formatStaleSummary(summary));
        } catch (err) {
          console.error("[client-build-watch]", err);
        }
      });
    }
    next();
  };
}
