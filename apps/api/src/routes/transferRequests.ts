import { Router } from "express";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { listOutgoingTransferRequests, listPendingTransferReviews, reviewRopTransfer } from "../lib/ownershipTransferRequest.js";

/**
 * Передача РОП — уведомление директору (владелец 16.11.2026, вторая редакция) — тонкий слой над
 * lib/ownershipTransferRequest.ts: все правила живут там. Самой передачи здесь нет: РОП и директор передают
 * обычными дверями (POST /properties/:id/transfer, POST /clients/:id/assign); сюда попадает только решение.
 *
 * ⚠️ Статичные пути (`/pending`, `/outgoing`) объявлены раньше `/:id/...`.
 */
export const transferRequestsRouter = Router();

const who = (req: { agent?: { id: string; role?: string | null } | null }) => ({ id: req.agent!.id, role: req.agent?.role });

/** Передачи РОП, ждущие решения, — для окна директора. Не директору и не администратору — пустой список. */
transferRequestsRouter.get("/pending", requireAuth, async (req, res) => {
  res.json({ items: await listPendingTransferReviews(who(req)) });
});

/** Мои передачи и их исходы (РОП — свои, директор — все). */
transferRequestsRouter.get("/outgoing", requireAuth, requirePermission("transfers.request"), async (req, res) => {
  res.json({ items: await listOutgoingTransferRequests(who(req)) });
});

/** Решение директора: «Подтвердить» или «Отклонить» (вернуть прежнему хозяину). */
transferRequestsRouter.post("/:id/respond", requireAuth, async (req, res) => {
  const outcome = await reviewRopTransfer(who(req), req.params.id, req.body);
  res.status(outcome.status).json(outcome.body);
});
