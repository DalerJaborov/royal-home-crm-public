import { Prisma } from "../generated/prisma/client.js";
import { classifyErrorLog, groupErrorLogEntries, type ErrorLogGroup } from "./errorLogClassify.js";
import { visibleSystemErrorWhere } from "./investigationOperations.js";
import { visibleErrorLogs } from "./systemErrorVisibility.js";

/**
 * ЖУРНАЛ ОШИБОК — ОДНА ДВЕРЬ ДЛЯ ЭКРАНА «ЗДОРОВЬЕ СИСТЕМЫ» И ШАБНАМ (17.11.2026,
 * «режим директора»).
 *
 * Кто что видит — ровно как маршрут routes/errorLog.ts:
 *  - граница видимости SQL — `visibleErrorLogs(securityRole)`, где securityRole есть
 *    только у директора/админа С правом clients.securityReview (расследования);
 *  - плюс `visibleSystemErrorWhere(role)` по роли.
 * Право на сам журнал (auditLog.view) проверяет вызывающий.
 */
export interface ErrorLogViewer {
  agentId: string;
  role: string | null | undefined;
  /** Роль для закрытого (расследования) — как `can(req, "clients.securityReview") ? role : undefined`. */
  securityRole: string | undefined;
}

/**
 * «Отметить разобранной» — то же, что POST /errors/:id/resolve: ошибка уходит из
 * счётчиков и утреннего уведомления. Чужая по видимости или несуществующая — not-found.
 */
export async function resolveErrorLogEntry(id: string, viewer: ErrorLogViewer): Promise<"ok" | "not-found"> {
  try {
    await visibleErrorLogs(viewer.securityRole).update({
      where: { ...visibleSystemErrorWhere(viewer.role), id },
      data: { resolvedAt: new Date(), resolvedById: viewer.agentId },
    });
    return "ok";
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") return "not-found";
    throw err;
  }
}

/** «Вернуть в работу» — то же, что POST /errors/:id/reopen (и откат «разобрано» у помощницы). */
export async function reopenErrorLogEntry(id: string, viewer: ErrorLogViewer): Promise<"ok" | "not-found"> {
  try {
    await visibleErrorLogs(viewer.securityRole).update({
      where: { ...visibleSystemErrorWhere(viewer.role), id },
      data: { resolvedAt: null, resolvedById: null },
    });
    return "ok";
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") return "not-found";
    throw err;
  }
}

/** Одна строка журнала для решения «разобрать / оставить» — без стека и браузера. */
export interface ErrorLogEntryBrief {
  id: string;
  source: string;
  message: string;
  createdAt: Date;
  resolvedAt: Date | null;
  priority: "operational" | "actionable";
}

export interface ErrorLogDigest {
  /** Неразобранных за окно (всех категорий). */
  unresolvedTotal: number;
  /** Из них требующих действия человека (счётчик бейджа «Здоровье системы»). */
  actionable: number;
  /** Эксплуатационный шум: резерв, повтор — CRM решила сама. */
  operational: number;
  /** Типы поломок (одна поломка с разными номерами — один тип), важные и частые сверху. */
  groups: ErrorLogGroup[];
  /** Свежие строки с id — для «отметь разобранной». */
  latest: ErrorLogEntryBrief[];
  /** Окно выборки упёрлось в предел — счётчики снизу. */
  truncated: boolean;
}

/** Предел выборки: неделя редко даёт больше пары тысяч строк (тот же запас, что у экрана). */
const DIGEST_SCAN_LIMIT = 5000;

/**
 * Неразобранные ошибки за отрезок [from, to): счётчики, типы и свежие строки.
 * Те же кирпичи, что у экрана: видимость, `classifyErrorLog`, `groupErrorLogEntries`.
 */
export async function loadErrorLogDigest(
  viewer: ErrorLogViewer,
  window: { from: Date; to: Date },
  opts: { latestLimit?: number } = {},
): Promise<ErrorLogDigest> {
  const where: Prisma.ErrorLogWhereInput = {
    AND: [visibleSystemErrorWhere(viewer.role), { resolvedAt: null }, { createdAt: { gte: window.from, lt: window.to } }],
  };
  const visible = visibleErrorLogs(viewer.securityRole);
  const [rows, latestRows] = await Promise.all([
    visible.findMany({
      where,
      select: { source: true, message: true, url: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: DIGEST_SCAN_LIMIT,
    }),
    visible.findMany({
      where,
      select: { id: true, source: true, message: true, createdAt: true, resolvedAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.max(opts.latestLimit ?? 10, 1), 10),
    }),
  ]);
  const actionable = rows.filter((r) => classifyErrorLog(r.source, r.message) === "actionable").length;
  return {
    unresolvedTotal: rows.length,
    actionable,
    operational: rows.length - actionable,
    groups: groupErrorLogEntries(rows),
    latest: latestRows.map((r) => ({
      id: r.id,
      source: r.source,
      message: r.message,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
      priority: classifyErrorLog(r.source, r.message),
    })),
    truncated: rows.length >= DIGEST_SCAN_LIMIT,
  };
}
