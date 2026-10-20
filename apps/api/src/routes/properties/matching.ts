/** Подбор клиентов под объект: GET /:id/matching-clients (Г3, §1.3).
 * Перенос verbatim. Сам движок подбора живёт в routes/matching.ts. */
import { Router } from "express";
import { can, requireAuth, requirePermission } from "../../auth/middleware.js";
import { findMatchingClients } from "../matching.js";
import { clientNamePhoneSafe } from "../../lib/clientPhone.js";

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
  // 17.09.2026: findMatchingClients теперь сама возвращает { items, total } —
  // контракт для веба не меняется по форме, total раньше отсутствовал вовсе.
  const result = await findMatchingClients(req.params.id);
  // Гейт — clients.viewAll (менеджер, СБ), а имя карточки закрывается отдельным
  // правом clients.viewPhone (22.09.2026): у заведённых до 20.08.2026 номер лежит
  // в имени. См. lib/clientPhone.ts.
  const canSeePhone = can(req, "clients.viewPhone");
  res.json(
    canSeePhone
      ? result
      : { ...result, items: result.items.map((c) => ({ ...c, fullName: clientNamePhoneSafe(c.fullName, false) })) }
  );
});
