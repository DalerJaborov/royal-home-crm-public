import { propertyTransferSchema, type PermissionId } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { logAgentAudit } from "./audit.js";
import { assignableAgentError } from "./propertyAssignableAgent.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { transferPropertyWithSeller } from "./propertyTransferWithSeller.js";

/**
 * РУЧНАЯ ПЕРЕДАЧА ОБЪЕКТА ДРУГОМУ АГЕНТУ — ОДНА ДВЕРЬ (10.11.2026).
 *
 * Тело `POST /properties/:id/transfer` (routes/properties/transfer.ts) переехало
 * сюда без изменений, чтобы помощница (ai/assistant/tools/transferPropertyTool.ts)
 * передавала объект ровно тем же путём: те же отказы, тот же перенос вместе с
 * продавцом (lib/propertyTransferWithSeller.ts), та же строка журнала.
 *
 * Право — то же, что на смену риелтора в PATCH: properties.editForeign И
 * clients.assign (передаёт руководство, а не сам агент; с 02.10.2026 маркетинг и
 * монтажёр не передают вовсе). Первое право маршрут держит middleware, второе —
 * проверка ниже, поэтому она стоит здесь, а не только в маршруте.
 */
export interface PropertyTransferActor {
  id: string;
  can: (permission: PermissionId) => boolean;
}

export type PropertyTransferOutcome =
  | { ok: true; status: 200; body: { ok: true; fromAgentId: string | null; toAgentId: string; sellerMoved: boolean } }
  | { ok: false; status: number; body: { error: string; details?: unknown } };

const fail = (status: number, error: string, details?: unknown): PropertyTransferOutcome => ({
  ok: false,
  status,
  body: details === undefined ? { error } : { error, details },
});

export function canTransferProperty(actor: PropertyTransferActor): boolean {
  return actor.can("properties.editForeign") && actor.can("clients.assign");
}

export async function transferPropertyByManager(
  actor: PropertyTransferActor,
  propertyId: string,
  raw: unknown,
  opts: { via?: "assistant" } = {}
): Promise<PropertyTransferOutcome> {
  if (!canTransferProperty(actor)) return fail(403, "Передать объект другому агенту может руководитель");
  const parsed = propertyTransferSchema.safeParse(raw);
  if (!parsed.success) return fail(400, "Неверные данные", parsed.error.flatten());
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, deletedAt: true, status: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
  });
  if (!property || property.deletedAt) return fail(404, "Объект не найден");
  if (property.status === "SOLD" || property.status === "WITHDRAWN") {
    return fail(409, "Объект уже продан или снят с продажи — передавать нечего");
  }
  const { toAgentId, reason } = parsed.data;
  if (propertyOwnerAgentId(property) === toAgentId) return fail(409, "Объект уже у этого агента");
  // Уволенному, замороженному или не-агенту объект не передаётся — та же проверка,
  // что у PATCH intakeAgentId/assignedAgentId.
  const agentError = await assignableAgentError(toAgentId);
  if (agentError) return fail(400, agentError);

  // Продавец едет вместе с объектом (глубокая проверка A4) — право на это,
  // clients.assign, уже проверено в начале для любой передачи.
  const result = await transferPropertyWithSeller({
    propertyId: property.id,
    toAgentId,
    reason,
    actorId: actor.id,
    source: "manual",
  });
  logAgentAudit(actor.id, "PROPERTY_TRANSFER", "Property", property.id, {
    fromAgentId: result.fromAgentId,
    toAgentId,
    reason,
    ...(opts.via ? { source: opts.via } : {}),
  } as Prisma.InputJsonValue);
  return { ok: true, status: 200, body: { ok: true, fromAgentId: result.fromAgentId, toAgentId, sellerMoved: result.sellerMoved } };
}
