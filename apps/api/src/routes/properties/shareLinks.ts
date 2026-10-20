/** Приватные ссылки на объект: POST/GET /:id/share-links,
 * DELETE /share-links/:linkId (+presentShareLink) (Г3, §1.3). Перенос verbatim. */
import { Router } from "express";
import type { Request } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../db.js";
import { recordInterest } from "../../lib/propertyInterest.js";
import { canBindClient, requireAuth } from "../../auth/middleware.js";
import { shareLinkUrl } from "../../lib/propertyShareLink.js";
import { clientNamePhoneSafe, maskClientPhone } from "../../lib/clientPhone.js";
import { canManageProperty } from "./shared.js";

export const shareLinksRouter = Router();

/**
 * Приватная ссылка на объект для одного клиента (docs/plan-18-08-private-listings-and-video.md
 * §4) — механизм, ради которого заведён offSite: то, чем агент делится с конкретным
 * человеком напрямую, а не через общий список/AI-подбор (тот исключает offSite сам).
 *
 * Токен — 24 случайных байта из crypto.randomBytes, НЕ uuid и НЕ инкремент: уникальность
 * base64url-строки из crypto.randomBytes(24) даёт ~192 бита энтропии, подобрать
 * перебором невозможно, а последовательность создания (не как у shortId) ничего не
 * выдаёт о количестве созданных ссылок.
 */
const createShareLinkSchema = z.object({
  clientId: z.guid().optional(),
  /** Дней до истечения; 0/undefined трактуем по-разному — см. ниже. */
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

function presentShareLink(
  req: Request,
  link: {
    id: string;
    token: string;
    clientId: string | null;
    createdAt: Date;
    expiresAt: Date | null;
    viewedAt: Date | null;
    revokedAt: Date | null;
    client: { id: string; fullName: string; phone: string } | null;
    createdByAgent: { id: string; fullName: string } | null;
  }
) {
  // Телефон клиента — по тому же правилу, что и везде (clients/shared.ts,
  // решение владельца 07.08): целиком его видит только право clients.viewPhone.
  // До аудита №4 этот ответ был вторым механизмом видимости и отдавал сырой
  // номер любому, кто может управлять объектом.
  // Имя закрывается тем же правом, что и телефон (22.09.2026): у карточек
  // незнакомых звонивших номер лежит в имени, и presentShareLink отдавал его
  // рядом с замаскированным phone.
  const canSeePhone = req.agent!.can("clients.viewPhone");
  const client = link.client
    ? {
        ...link.client,
        fullName: clientNamePhoneSafe(link.client.fullName, canSeePhone),
        phone: canSeePhone ? link.client.phone : maskClientPhone(link.client.phone),
      }
    : null;
  return {
    id: link.id,
    token: link.token,
    url: shareLinkUrl(link.token),
    clientId: link.clientId,
    client,
    createdByAgent: link.createdByAgent,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    viewedAt: link.viewedAt,
    revokedAt: link.revokedAt,
    isExpired: link.expiresAt != null && link.expiresAt.getTime() < Date.now(),
  };
}

shareLinksRouter.post("/:id/share-links", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }

  const data = createShareLinkSchema.parse(req.body);
  if (data.clientId) {
    const client = await prisma.client.findUnique({ where: { id: data.clientId } });
    if (!client || client.deletedAt) return res.status(400).json({ error: "Клиент не найден" });
    if (!canBindClient(req, client)) return res.status(403).json({ error: "Этот клиент закреплён за другим агентом" });
  }

  // 30 дней по умолчанию (владелец, docs/plan-18-08-private-listings-and-video.md §4) —
  // настраивается конкретным числом дней при генерации.
  const days = data.expiresInDays ?? 30;
  const token = randomBytes(24).toString("base64url");

  const link = await prisma.propertyShareLink.create({
    data: {
      propertyId: property.id,
      clientId: data.clientId ?? null,
      token,
      createdByAgentId: req.agent!.id,
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
    },
    include: {
      client: { select: { id: true, fullName: true, phone: true } },
      createdByAgent: { select: { id: true, fullName: true } },
    },
  });

  // Сигнал интереса: агент отправил объект человеку (lib/propertyInterest.ts).
  // Вес у него самый низкий — отправить может и тот, кто рассылает всё подряд.
  void recordInterest(property.id, "SHARE_SENT", data.clientId ?? null);

  res.status(201).json(presentShareLink(req, link));
});

/** Сколько ссылок отдавать на объект — см. комментарий у выборки ниже. */
const SHARE_LINKS_LIMIT = 100;

shareLinksRouter.get("/:id/share-links", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }

  const links = await prisma.propertyShareLink.findMany({
    where: { propertyId: property.id },
    // Потолок обязателен: ссылка заводится на КАЖДУЮ отправку объекта клиенту и
    // никогда не чистится, а массив уходит в ответ целиком. Сотня свежих сверху
    // покрывает любой разумный разбор, порядок ниже — новые первыми.
    take: SHARE_LINKS_LIMIT,
    include: {
      client: { select: { id: true, fullName: true, phone: true } },
      createdByAgent: { select: { id: true, fullName: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json({ items: links.map((l) => presentShareLink(req, l)) });
});

/**
 * Досрочный отзыв — ссылка не удаляется физически (иначе метка «открыл/не открыл»
 * терялась бы из истории), только помечается revokedAt. Публичный роут (GET /l/:token)
 * обязан относиться к отозванной ссылке как к несуществующей.
 */
shareLinksRouter.delete("/share-links/:linkId", requireAuth, async (req, res) => {
  const link = await prisma.propertyShareLink.findUnique({
    where: { id: req.params.linkId },
    include: { property: true },
  });
  if (!link) return res.status(404).json({ error: "Ссылка не найдена" });
  if (!canManageProperty(req, link.property)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  if (!link.revokedAt) {
    await prisma.propertyShareLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } });
  }
  res.status(204).send();
});
