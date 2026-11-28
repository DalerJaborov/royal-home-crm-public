import {
  AUTO_CLEANUP_DAYS,
  type AutoCleanupDaysKey,
  type CleanupMode,
  type CleanupScope,
  type CleanupTarget,
} from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { visibleSystemErrorWhere } from "./investigationOperations.js";
import { visibleErrorLogs } from "./systemErrorVisibility.js";
import { investigationNotificationWhere, visibleNotificationsWhere } from "./investigationNotifications.js";
import { canViewInvestigations } from "@royal-home/shared";
import { logSystemAudit } from "./audit.js";
import { logSystemError } from "./systemError.js";
import { dushanbeDateString } from "./dushanbeTime.js";

/**
 * ЧИСТКА МУСОРА (владелец 28.11.2026): ручные кнопки «Очистить» и ночная автоочистка.
 *
 * Удаление безвозвратное — поэтому всё здесь устроено через одну дверь, которую видно в тестах:
 *  - `cleanupWhere` — единственное место, где решается «что считается разобранным»;
 *  - ручная чистка и автоочистка используют одни и те же пачки (`deleteInBatches`);
 *  - не трогаем AuditLog, переписки, клиентов, сделки и объекты — они сюда не попадают вовсе.
 */

/** Размер одной пачки удаления: длинный DELETE держал бы блокировки на таблице уведомлений. */
export const CLEANUP_BATCH_SIZE = 1000;
/** Потолок пачек за один запуск ручной чистки (1000 × 50 = 50 000 строк) — дальше нажмут ещё раз. */
export const MANUAL_MAX_BATCHES = 50;
/** Потолок пачек на каждый вид за один ночной запуск. Пачки по 1000 — с запасом. */
export const AUTO_MAX_BATCHES_PER_TARGET = 40;

interface CleanupDelegate {
  findMany(args: { where: unknown; select: { id: true }; take: number }): Promise<Array<{ id: string }>>;
  deleteMany(args: { where: unknown }): Promise<{ count: number }>;
  count(args: { where: unknown }): Promise<number>;
}

type StepTarget = CleanupTarget | "guardHit" | "loginSmsCode" | "idempotencyKey" | "telegramCallbackSeen";

/** Журнал ошибок чистим тем же «окном», что и список на экране (закрытые для роли записи не видны и не удаляются). */
function errorLogDelegate(actor: CleanupActor): CleanupDelegate {
  const view = visibleErrorLogs(actor.securityReview ? actor.role : undefined);
  return {
    findMany: (a) => view.findMany(a as never) as never,
    count: (a) => view.count(a as never) as never,
    deleteMany: (a) => prisma.errorLog.deleteMany(a as never) as never,
  };
}

function delegateFor(target: StepTarget, actor?: CleanupActor): CleanupDelegate {
  if (target === "errorLog" && actor) return errorLogDelegate(actor);
  // Типы делегатов Prisma у каждой модели свои; здесь нужны только три общих метода.
  if (target === "notifications") return prisma.notification as unknown as CleanupDelegate;
  if (target === "directorAlerts") return prisma.pendingDirectorAlert as unknown as CleanupDelegate;
  if (target === "guardHit") return prisma.guardHit as unknown as CleanupDelegate;
  if (target === "loginSmsCode") return prisma.loginSmsCode as unknown as CleanupDelegate;
  if (target === "idempotencyKey") return prisma.idempotencyKey as unknown as CleanupDelegate;
  if (target === "telegramCallbackSeen") return prisma.telegramCallbackSeen as unknown as CleanupDelegate;
  return prisma.errorLog as unknown as CleanupDelegate;
}

export interface CleanupActor {
  id: string;
  role?: string | null;
  /** Право clients.securityReview: без него закрытые от роли ошибки не видны и не удаляются. */
  securityReview?: boolean;
}

/** Условие выборки для ручной чистки. `handled` — только прочитанное/доставленное/разобранное. */
export function cleanupWhere(
  target: CleanupTarget,
  mode: CleanupMode,
  scope: CleanupScope,
  actor: CleanupActor
): Prisma.NotificationWhereInput | Prisma.PendingDirectorAlertWhereInput | Prisma.ErrorLogWhereInput {
  if (target === "notifications") {
    return {
      // Закрытые от роли записи (расследования) не удаляем: «свои» — по правилам ленты, «у всех» — без закрытых.
      ...(scope === "mine"
        ? visibleNotificationsWhere(actor.id, actor.role ?? undefined)
        : canViewInvestigations(actor.role)
          ? {}
          : { OR: [{ tag: null }, { NOT: investigationNotificationWhere() }] }),
      ...(mode === "handled" ? { read: true } : {}),
    };
  }
  if (target === "directorAlerts") {
    return mode === "handled" ? { sentAt: { not: null } } : {};
  }
  // Журнал ошибок: только то, что этот человек и так видит в списке (закрытые для него записи не стираем).
  return {
    AND: [visibleSystemErrorWhere(actor.securityReview ? actor.role : undefined), mode === "handled" ? { resolvedAt: { not: null } } : {}],
  };
}

export async function countCleanup(target: CleanupTarget, mode: CleanupMode, scope: CleanupScope, actor: CleanupActor): Promise<number> {
  return delegateFor(target, actor).count({ where: cleanupWhere(target, mode, scope, actor) });
}

/** Удаляет пачками по id, пока есть что удалять или не вышел потолок. Возвращает число удалённых строк. */
export async function deleteInBatches(
  delegate: CleanupDelegate,
  where: unknown,
  maxBatches: number,
  batchSize = CLEANUP_BATCH_SIZE
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const rows = await delegate.findMany({ where, select: { id: true }, take: batchSize });
    if (rows.length === 0) break;
    // Условие повторяем: между выбором и удалением строка могла «ожить» (повтор события) — её не стираем.
    const { count } = await delegate.deleteMany({ where: { AND: [where, { id: { in: rows.map((r) => r.id) } }] } });
    total += count;
    if (rows.length < batchSize) break;
  }
  return total;
}

export async function runManualCleanup(
  target: CleanupTarget,
  mode: CleanupMode,
  scope: CleanupScope,
  actor: CleanupActor
): Promise<number> {
  return deleteInBatches(delegateFor(target, actor), cleanupWhere(target, mode, scope, actor), MANUAL_MAX_BATCHES);
}

// ---------- автоочистка ----------

export type AutoCleanupSettings = { autoCleanupEnabled: boolean } & Record<AutoCleanupDaysKey, number>;

function clampDays(raw: unknown, key: AutoCleanupDaysKey): number {
  const limits = AUTO_CLEANUP_DAYS[key];
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : limits.default;
  return Math.min(limits.max, Math.max(limits.min, n));
}

/** Сроки из настроек, приведённые к допустимым пределам: кривое число в базе не должно стереть свежее. */
export function autoCleanupDays(settings: Partial<Record<AutoCleanupDaysKey, number | null>> | null): Record<AutoCleanupDaysKey, number> {
  return {
    autoCleanupNotificationsReadDays: clampDays(settings?.autoCleanupNotificationsReadDays, "autoCleanupNotificationsReadDays"),
    autoCleanupErrorsResolvedDays: clampDays(settings?.autoCleanupErrorsResolvedDays, "autoCleanupErrorsResolvedDays"),
    autoCleanupDirectorAlertsDays: clampDays(settings?.autoCleanupDirectorAlertsDays, "autoCleanupDirectorAlertsDays"),
    autoCleanupBotCountersDays: clampDays(settings?.autoCleanupBotCountersDays, "autoCleanupBotCountersDays"),
    autoCleanupOneTimeDays: clampDays(settings?.autoCleanupOneTimeDays, "autoCleanupOneTimeDays"),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AutoCleanupResult {
  ran: boolean;
  notifications: number;
  errorLog: number;
  directorAlerts: number;
  botCounters: number;
  oneTime: number;
}

/**
 * Ночная автоочистка. Рубильник Settings.autoCleanupEnabled (ВЫКЛ по умолчанию). Непрочитанное и
 * неразобранное не трогаем никогда. Сбой одного вида не мешает остальным: ошибка уходит в logSystemError.
 */
export async function runAutoCleanup(now: Date = new Date()): Promise<AutoCleanupResult> {
  const result: AutoCleanupResult = { ran: false, notifications: 0, errorLog: 0, directorAlerts: 0, botCounters: 0, oneTime: 0 };
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (!settings?.autoCleanupEnabled) return result;
  result.ran = true;
  const days = autoCleanupDays(settings);
  const cutoff = (key: AutoCleanupDaysKey) => new Date(now.getTime() - days[key] * DAY_MS);

  const steps: Array<{ name: keyof Omit<AutoCleanupResult, "ran">; target: StepTarget; where: unknown }> = [
    { name: "notifications", target: "notifications", where: { read: true, createdAt: { lt: cutoff("autoCleanupNotificationsReadDays") } } },
    { name: "errorLog", target: "errorLog", where: { resolvedAt: { not: null, lt: cutoff("autoCleanupErrorsResolvedDays") } } },
    { name: "directorAlerts", target: "directorAlerts", where: { sentAt: { not: null, lt: cutoff("autoCleanupDirectorAlertsDays") } } },
    // GuardHit.day — строка «ГГГГ-ММ-ДД» по Душанбе, не дата: сравниваем строкой.
    { name: "botCounters", target: "guardHit", where: { day: { lt: dushanbeDateString(cutoff("autoCleanupBotCountersDays")) } } },
    // Одноразовые: код входа — только уже истёкший и старше срока; ключи повтора и метки кнопок — старше срока.
    { name: "oneTime", target: "loginSmsCode", where: { expiresAt: { lt: now }, createdAt: { lt: cutoff("autoCleanupOneTimeDays") } } },
    { name: "oneTime", target: "idempotencyKey", where: { createdAt: { lt: cutoff("autoCleanupOneTimeDays") } } },
    { name: "oneTime", target: "telegramCallbackSeen", where: { createdAt: { lt: cutoff("autoCleanupOneTimeDays") } } },
  ];
  for (const step of steps) {
    try {
      result[step.name] += await deleteInBatches(delegateFor(step.target), step.where, AUTO_MAX_BATCHES_PER_TARGET);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void logSystemError("cron", `Автоочистка «${step.target}» не удалась: ${message}`, { dedupKey: `data-cleanup:${step.target}` });
    }
  }
  const total = result.notifications + result.errorLog + result.directorAlerts + result.botCounters + result.oneTime;
  if (total > 0) {
    logSystemAudit("CLEANUP", "AutoCleanup", null, {
      notifications: result.notifications,
      errorLog: result.errorLog,
      directorAlerts: result.directorAlerts,
      botCounters: result.botCounters,
      oneTime: result.oneTime,
      days,
    });
  }
  return result;
}
