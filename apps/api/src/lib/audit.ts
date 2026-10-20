import type { Request } from "express";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";

/** Записывает чувствительное действие (удаление/публикация и т.п.) в историю —
 * best-effort, никогда не блокирует и не роняет основной запрос. */
export function logAudit(
  req: Request,
  action: string,
  entityType: string,
  entityId?: string | null,
  meta?: Prisma.InputJsonValue
) {
  logAgentAudit(req.agent?.id ?? null, action, entityType, entityId, meta);
}

/**
 * То же без HTTP-запроса — действие совершил сотрудник, но пришло оно не через
 * API CRM, а, например, кнопкой в Telegram (lib/telegramModeration). Источник
 * вызывающий кладёт в meta.source, чтобы в истории было видно, откуда решение.
 */
export function logAgentAudit(
  agentId: string | null,
  action: string,
  entityType: string,
  entityId?: string | null,
  meta?: Prisma.InputJsonValue
) {
  prisma.agent
    .findUnique({ where: { id: agentId ?? "" }, select: { fullName: true } })
    .catch(() => null)
    .then((agent) =>
      prisma.auditLog.create({
        data: { action, entityType, entityId: entityId ?? null, agentId, agentName: agent?.fullName ?? "Неизвестно", meta },
      })
    )
    .catch((err) => console.error(`[audit] Не удалось записать ${action} ${entityType}:`, err));
}

/**
 * То же самое, но действие совершил не человек, а сама CRM (крон, автостатус,
 * реакция на событие). Автора запроса нет и быть не может, поэтому agentId
 * остаётся пустым, а в имени стоит «Система» — в истории карточки сразу видно,
 * что статус переставил не коллега, и спрашивать не с кого.
 */
export function logSystemAudit(
  action: string,
  entityType: string,
  entityId?: string | null,
  meta?: Prisma.InputJsonValue
) {
  prisma.auditLog
    .create({
      data: { action, entityType, entityId: entityId ?? null, agentId: null, agentName: "Система", meta },
    })
    .catch((err) => console.error(`[audit] Не удалось записать ${action} ${entityType}:`, err));
}
