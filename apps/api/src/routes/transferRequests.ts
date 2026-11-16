import { Router } from "express";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import {
  cancelTransferRequest,
  createTransferRequest,
  listIncomingTransferRequests,
  listOutgoingTransferRequests,
  respondToTransferRequest,
  skipsOwnerConfirm,
  type TransferActor,
} from "../lib/ownershipTransferRequest.js";

/**
 * Передача с подтверждением хозяина (владелец 16.11.2026) — тонкий слой над
 * lib/ownershipTransferRequest.ts: все правила живут там.
 *
 * ⚠️ Статичные пути (`/incoming`, `/outgoing`) объявлены раньше `/:id/...`.
 */
export const transferRequestsRouter = Router();

const actorOf = (req: Parameters<typeof can>[0] & { agent?: { id: string; role?: string | null } | null }): TransferActor => ({
  id: req.agent!.id,
  role: req.agent?.role,
  can: (permission) => can(req, permission),
});

/** Ждущие моего ответа — для большого окна. Видит любой сотрудник: это его собственные карточки. */
transferRequestsRouter.get("/incoming", requireAuth, async (req, res) => {
  res.json({ items: await listIncomingTransferRequests(req.agent!.id) });
});

/** Мои запросы и их исходы (директор — все). */
transferRequestsRouter.get("/outgoing", requireAuth, requirePermission("transfers.request"), async (req, res) => {
  res.json({ items: await listOutgoingTransferRequests(req.agent!.id, skipsOwnerConfirm({ role: req.agent?.role })) });
});

transferRequestsRouter.post("/", requireAuth, requirePermission("transfers.request"), async (req, res) => {
  const outcome = await createTransferRequest(actorOf(req), req.body);
  res.status(outcome.status).json(outcome.body);
});

transferRequestsRouter.post("/:id/respond", requireAuth, async (req, res) => {
  const outcome = await respondToTransferRequest(actorOf(req), req.params.id, req.body);
  res.status(outcome.status).json(outcome.body);
});

transferRequestsRouter.post("/:id/cancel", requireAuth, requirePermission("transfers.request"), async (req, res) => {
  const outcome = await cancelTransferRequest(actorOf(req), req.params.id);
  res.status(outcome.status).json(outcome.body);
});
