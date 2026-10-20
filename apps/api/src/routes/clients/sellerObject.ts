import { Router } from "express";
import { z } from "zod";
import type { SellerObjectSummary } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { canAccessAssignedAgent, requireAuth, scopeToOwnAgent } from "../../auth/middleware.js";
import { getSellerObjectFacts, isSellerClient } from "../../lib/sellerFacts.js";

/**
 * ПОЛОСА «ОБЪЕКТ ПРОДАВЦА» В ЧАТЕ (владелец 21.09.2026) — сводка того, что уже
 * известно об объекте продавца, и объекты, уже заведённые из него.
 *
 * БЕЗ ВЫЗОВА ИИ: факты читаются готовыми (их копит фоновое задание seller-facts,
 * см. lib/sellerFacts.ts), счётчики вложений — по сохранённой переписке. Полоса
 * открывается на каждом заходе в чат, платный вызов здесь значил бы оплату за
 * каждый взгляд.
 */
export const sellerObjectRouter = Router();

/** Сколько объектов продавца показать в полосе — больше у одного человека не бывает. */
const MAX_PROPERTIES = 20;
/** Диалогов одного канала на клиента — единицы; предел по стандарту проекта. */
const MAX_CONVERSATIONS_PER_CHANNEL = 5;

/** Вложения, которые прислал САМ продавец (реплики role=user) — фото и видео объекта. */
function countSellerMedia(conversations: { messages: unknown }[]): { photoCount: number; videoCount: number } {
  let photoCount = 0;
  let videoCount = 0;
  for (const conv of conversations) {
    if (!Array.isArray(conv.messages)) continue;
    for (const item of conv.messages as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const { role, attachments } = item as { role?: unknown; attachments?: unknown };
      if (role !== "user" || !Array.isArray(attachments)) continue;
      for (const a of attachments as { kind?: unknown }[]) {
        if (a?.kind === "image") photoCount += 1;
        else if (a?.kind === "video") videoCount += 1;
      }
    }
  }
  return { photoCount, videoCount };
}

sellerObjectRouter.get("/:id/seller-object", requireAuth, async (req, res) => {
  const parsed = z.guid().safeParse(req.params.id);
  if (!parsed.success) return res.status(400).json({ error: "Неверный идентификатор клиента" });

  const client = await prisma.client.findUnique({
    where: { id: parsed.data },
    select: { id: true, kind: true, dualIntent: true, assignedAgentId: true, acceptedAt: true, deletedAt: true },
  });
  if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  // До принятия лида карточка агенту закрыта — тот же гейт, что у подсказки
  // черновика объекта (routes/ai.ts, /property-draft).
  if (scopeToOwnAgent(req) && !client.acceptedAt) {
    return res.status(403).json({ error: "Сначала примите лид — до принятия карточка закрыта" });
  }

  const isSeller = isSellerClient(client);
  if (!isSeller) {
    // Покупателю полоса не нужна — отвечаем пустой сводкой, а не ошибкой: фронту
    // проще не рисовать полосу, чем разбирать 400 на каждом чате покупателя.
    const empty: SellerObjectSummary = {
      clientId: client.id,
      isSeller: false,
      photoCount: 0,
      planCount: 0,
      videoCount: 0,
      facts: null,
      properties: [],
    };
    return res.json(empty);
  }

  const [facts, properties, botConversations, telegramConversation, directConversations] = await Promise.all([
    getSellerObjectFacts(client.id),
    prisma.property.findMany({
      where: { sellerClientId: client.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: MAX_PROPERTIES,
      select: { id: true, shortId: true, title: true },
    }),
    prisma.botConversation.findMany({
      where: { clientId: client.id },
      orderBy: { lastMessageAt: "desc" },
      take: MAX_CONVERSATIONS_PER_CHANNEL,
      select: { messages: true },
    }),
    prisma.telegramConversation.findUnique({ where: { clientId: client.id }, select: { messages: true } }),
    prisma.telegramDirectConversation.findMany({
      where: { clientId: client.id },
      orderBy: { lastMessageAt: "desc" },
      take: MAX_CONVERSATIONS_PER_CHANNEL,
      select: { messages: true },
    }),
  ]);

  const { photoCount, videoCount } = countSellerMedia([
    ...botConversations,
    ...(telegramConversation ? [telegramConversation] : []),
    ...directConversations,
  ]);

  const summary: SellerObjectSummary = {
    clientId: client.id,
    isSeller: true,
    photoCount,
    // Планировки различает только оценка снимков (ChatPhotoInsight), а её ключ —
    // sha256 СОДЕРЖИМОГО файла: чтобы сопоставить, пришлось бы читать с диска все
    // фото переписки на каждом открытии чата. Пока хэш не хранится рядом с
    // вложением — честный ноль, а не догадка по имени файла.
    planCount: 0,
    videoCount,
    facts,
    properties,
  };
  res.json(summary);
});
