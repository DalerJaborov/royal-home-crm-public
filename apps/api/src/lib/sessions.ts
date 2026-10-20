import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { prisma } from "../db.js";
import { resolveDeviceKey } from "./deviceKey.js";
import { clientIp } from "./ip.js";

/**
 * Максимум одновременно «живых» устройств на аккаунт — вход сверх лимита не
 * блокируется, а тихо вытесняет наименее недавно активное.
 *
 * БЫЛО ТРИ, СТАЛО ПЯТЬ (19.09.2026, жалоба владельца «сотрудника само по себе
 * выбрасывает из CRM»). Тройка казалась щедрой, пока «устройством» считали
 * физический аппарат. На деле отдельную строку Session получает каждое
 * ОБОСОБЛЕННОЕ ХРАНИЛИЩЕ браузера, а их у одного человека легко набирается
 * больше трёх:
 *   · установленное на телефон приложение и тот же сайт в Safari на том же
 *     телефоне — на iOS это разные хранилища, то есть два устройства;
 *   · рабочий компьютер и домашний;
 *   · любая чистка данных сайта или приватное окно — это НОВЫЙ случайный
 *     X-Device-Id (см. lib/deviceKey.ts), а прежняя строка занимает слот ещё
 *     неделю, до SESSION_INACTIVITY_MS.
 * Четвёртый вход молча гасил самое давнее устройство, и человек за ним узнавал
 * об этом экраном входа посреди рабочего дня, без единого объяснения.
 *
 * Пять — это всё ещё предел (украденный токен не живёт вечно, чужое устройство
 * по-прежнему видно и отзывается в Профиле), но он перестал срабатывать на
 * обычной работе одного сотрудника.
 */
export const MAX_DEVICES = 5;

/** Без единого /auth/refresh за этот срок сессия считается протухшей — устройство
 * не пользовались, автовыход. Обычный рабочий ритм (access-токен на 15 мин) держит
 * lastSeenAt свежим, пока приложение открыто хотя бы изредка. */
/* 90 дней (владелец 19.10.2026: «не в 30 дней спрашивать, а в 90»; паролей нет,
 * вход по коду, поэтому реже спрашивать и надёжнее). Устройство, которым не
 * пользуются, всё равно вытесняется пятым входом (MAX_DEVICES). */
export const SESSION_INACTIVITY_MS = 90 * 24 * 60 * 60 * 1000;

function isAlive(s: { revokedAt: Date | null; lastSeenAt: Date }): boolean {
  return s.revokedAt === null && Date.now() - s.lastSeenAt.getTime() <= SESSION_INACTIVITY_MS;
}

/**
 * Логин/логин+2FA: одна строка Session на устройство (agentId+deviceKey) — повторный
 * вход с уже известного и ЖИВОГО устройства обновляет её же, не плодит дубли и не
 * трогает лимит. Устройство, которого не было (или что было, но уже отозвано/протухло
 * по неактивности) — проходит через проверку лимита наравне с настоящим новым:
 * иначе повторный вход с уже вытесненного/явно разлогиненного устройства тихо
 * обходил бы MAX_DEVICES (перечитывание отозванной строки раньше считалось «уже
 * живой» и лимит для неё вообще не проверялся). Сверх MAX_DEVICES вытесняет
 * наименее недавно активное — лимит соблюдается без отказа в легитимном входе.
 */
export async function createOrRefreshSession(req: Request, agentId: string): Promise<{ id: string }> {
  const { label, key } = resolveDeviceKey(req);
  const ip = clientIp(req);
  const truncatedUa = req.headers["user-agent"]?.slice(0, 500) ?? null;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.session.findUnique({
      where: { agentId_deviceKey: { agentId, deviceKey: key } },
    });
    if (existing && isAlive(existing)) {
      const updated = await tx.session.update({
        where: { id: existing.id },
        data: { device: label, ip, userAgent: truncatedUa, lastSeenAt: new Date() },
      });
      return { id: updated.id };
    }

    // Строка этого устройства есть, но отозвана или протухла: оживляя её, обязаны
    // сменить id. id строки — это `sid` в refresh-токене, и с прежним id ожил бы
    // каждый ранее выданный токен этого устройства — в том числе украденный, ради
    // гашения которого человек жал «Выйти» или менял пароль (G1, 02.10.2026).
    // updateMany, а не update: два одновременных входа сюда приходят оба, второй
    // после первого не найдёт строку по старому id и тихо получит 0 вместо P2025,
    // которая перевела бы транзакцию в aborted (см. комментарий у upsert ниже).
    if (existing) {
      await tx.session.updateMany({
        where: { id: existing.id },
        data: { id: randomUUID(), createdAt: new Date() },
      });
    }

    const alive = (await tx.session.findMany({ where: { agentId, revokedAt: null } })).filter(isAlive);
    if (alive.length >= MAX_DEVICES) {
      const oldest = alive.reduce((a, b) => (a.lastSeenAt < b.lastSeenAt ? a : b));
      await tx.session.update({ where: { id: oldest.id }, data: { revokedAt: new Date() } });
    }

    // Два конкурентных логина с одного и того же нового устройства могут оба
    // дойти сюда — второй обязан не падать 500, а продлить строку, которую
    // создал первый. Именно поэтому upsert, а не create с ловлей P2002:
    // в PostgreSQL любая ошибка ВНУТРИ транзакции переводит её в состояние
    // aborted, и следующая же команда отвергается («current transaction is
    // aborted, commands ignored until end of transaction block», код 25P02).
    // То есть прежний catch с восстановительным update гарантированно падал
    // тем самым 500, от которого защищался. Найдено регрессионным прогоном
    // 06.08.2026: семь ролей логинились параллельно, две вкладки одного
    // пользователя совпали по deviceKey.
    const session = await tx.session.upsert({
      where: { agentId_deviceKey: { agentId, deviceKey: key } },
      create: { agentId, deviceKey: key, device: label, ip, userAgent: truncatedUa },
      update: { device: label, ip, userAgent: truncatedUa, lastSeenAt: new Date(), revokedAt: null },
    });
    return { id: session.id };
  });
}

/**
 * Проверка при POST /auth/refresh: сессия должна существовать, быть неотозванной и не
 * протухшей по неактивности. Живую — продлевает (lastSeenAt=now, обновляет IP — вдруг
 * сменился); протухшую — сама помечает revokedAt, чтобы не мешала будущему подсчёту
 * активных устройств. Возвращает false — вызывающий код обязан ответить 401 и стереть cookie.
 */
export async function touchSession(req: Request, sessionId: string): Promise<boolean> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.revokedAt) return false;
  if (Date.now() - session.lastSeenAt.getTime() > SESSION_INACTIVITY_MS) {
    await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    return false;
  }
  await prisma.session.update({
    where: { id: sessionId },
    data: { lastSeenAt: new Date(), ip: clientIp(req) },
  });
  return true;
}

/** Отзыв конкретного устройства — «выйти» удалённо (например, старый телефон сдох,
 * а сессия в нём всё ещё активна). Только своя сессия — id чужой сессии здесь не найдётся. */
export async function revokeSession(agentId: string, sessionId: string): Promise<boolean> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.agentId !== agentId) return false;
  await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  return true;
}

/** Список активных устройств текущего агента — для «Активные сессии» в Профиле. */
export async function listActiveSessions(agentId: string) {
  const rows = await prisma.session.findMany({
    where: { agentId, revokedAt: null },
    orderBy: { lastSeenAt: "desc" },
  });
  // Тот же isAlive, что и при входе: без него список показывал протухшие
  // устройства, которые лимит уже не занимают. Человек видел «три устройства»
  // там, где реально работало одно, и не понимал, почему вход не блокируется.
  return rows.filter(isAlive);
}

/**
 * Выйти со всех устройств, кроме текущего. Вызывается при смене пароля: иначе
 * совет «заметили незнакомое устройство — смените пароль» не работал, и чужая
 * сессия жила ещё неделю с прежним refresh-токеном.
 */
export async function revokeOtherSessions(agentId: string, keepSessionId?: string): Promise<number> {
  const res = await prisma.session.updateMany({
    where: { agentId, revokedAt: null, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return res.count;
}
