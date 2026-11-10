/** Подбор клиентов под объект: GET /:id/matching-clients (Г3, §1.3).
 * Перенос verbatim. Сам движок подбора живёт в routes/matching.ts. */
import { Router } from "express";
import { requireAuth, requirePermission } from "../../auth/middleware.js";
import { matchingClientsForViewer } from "../../lib/propertyMatchingClients.js";

export const matchingRouter = Router();

/**
 * Кому этот объект может подойти — список клиентов с оценкой близости.
 *
 * Отдельным маршрутом, а не полем карточки: это выборка по всей активной базе
 * покупателей, и платить за неё при каждом открытии объекта (в том числе из
 * Корзины, из списка, из окна сделки) незачем. Открывают её тогда, когда
 * собираются звонить.
 *
 * Право то же, что на просмотр клиентов: список содержит имена, и агенту, которому
 * чужие клиенты закрыты, показывать их нельзя даже в виде подсказки.
 */
matchingRouter.get("/:id/matching-clients", requireAuth, requirePermission("clients.viewAll"), async (req, res) => {
  // Тело — lib/propertyMatchingClients.ts (его же зовёт мастер в Telegram).
  // Гейт — clients.viewAll (менеджер, СБ), имя карточки закрывается правом
  // clients.viewPhone (22.09.2026).
  res.json(await matchingClientsForViewer(req, req.params.id));
});
