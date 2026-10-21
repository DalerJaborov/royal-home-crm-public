import type { Request, Response, NextFunction } from "express";
import { prisma } from "../db.js";
import { isSettingsMaintenancePath, settingsMaintenanceUntil, settingsMaintenanceWindowUntil } from "./settingsMaintenance.js";

/**
 * Step-up авторизация («sudo-режим») для критичных разделов — Настройки CRM и
 * управление сотрудниками. Даже с валидным JWT изменения требуют свежего
 * подтверждения личности: код Google Authenticator (если 2FA включена) или
 * пароль. Защищает от украденного/забытого открытым токена директора.
 *
 * Хранится в памяти процесса: API работает одним инстансом, при рестарте
 * элевации просто протухают — это безопасное поведение, а не потеря данных.
 *
 * СРОК НАСТРАИВАЕТСЯ (решение владельца 01.08.2026). Десять минут придумывались
 * под сценарий «зашёл, поменял ключ, вышел», а на разборе настроек и здоровья
 * системы окно истекало прямо посреди работы, и раздел закрывался на полуслове.
 *
 * Но убирать его нельзя, и потолок здесь не формальность. Это единственное, что
 * стоит между открытым ноутбуком администратора и ключами от WhatsApp, Instagram
 * и Anthropic: с валидным токеном, но без подтверждения, их не прочитать и не
 * подменить. Поэтому срок можно растянуть на рабочую сессию, но не на сутки.
 */
const DEFAULT_ELEVATION_MINUTES = 10;
const MAX_ELEVATION_MINUTES = 240;

/** Читается лениво и с потолком: значение приходит из Настроек, то есть снаружи. */
function elevationTtlMs(minutes?: number | null): number {
  const safe = Math.min(Math.max(minutes ?? DEFAULT_ELEVATION_MINUTES, 1), MAX_ELEVATION_MINUTES);
  return safe * 60 * 1000;
}

const elevations = new Map<string, number>();

export function grantElevation(agentId: string, minutes?: number | null): void {
  elevations.set(agentId, Date.now() + elevationTtlMs(minutes));
}

export { DEFAULT_ELEVATION_MINUTES, MAX_ELEVATION_MINUTES };

export function isElevated(agentId: string): boolean {
  const until = elevations.get(agentId);
  if (!until) return false;
  if (until < Date.now()) {
    elevations.delete(agentId);
    return false;
  }
  return true;
}

/** До какого момента подтверждение действует; null — не подтверждено или истекло. */
export function elevatedUntil(agentId: string): Date | null {
  return isElevated(agentId) ? new Date(elevations.get(agentId)!) : null;
}

export function revokeElevation(agentId: string): void {
  elevations.delete(agentId);
}

/** 428 Precondition Required — фронт по нему показывает окно подтверждения. */
export async function requireElevation<P>(req: Request<P>, res: Response, next: NextFunction) {
  if (!req.agent) return res.status(401).json({ error: "Не авторизован" });
  if (!isElevated(req.agent.id) && isSettingsMaintenancePath(req.originalUrl) && settingsMaintenanceWindowUntil()) {
    try {
      const actor = await prisma.agent.findUnique({ where: { id: req.agent.id },
        select: { role: true, permissions: true, isActive: true, totpEnabled: true, fullName: true } });
      const until = actor && settingsMaintenanceUntil(actor);
      if (until) {
        // Record authorization under the temporary policy, not a successful
        // business action or a fictitious SMS verification.
        await prisma.auditLog.create({ data: { action: "SETTINGS_MAINTENANCE_ACCESS", entityType: "Settings",
          entityId: "singleton", agentId: req.agent.id, agentName: actor.fullName,
          meta: { authority: "settings_maintenance", expiresAt: until, method: req.method, path: req.originalUrl.split("?")[0] } } });
        return next();
      }
    } catch (error) { return next(error); }
  }
  if (!isElevated(req.agent.id)) {
    return res.status(428).json({ error: "Требуется подтверждение личности", stepUpRequired: true });
  }
  next();
}
