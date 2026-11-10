import { z } from "zod";
import { formatPropertyCode, isReadOnlyRole, ROLE_LABELS, type Role } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { loadAgentAccess } from "../../../auth/middleware.js";
import {
  AssistantActionError,
  type AssistantActionActor,
  type AssistantActionExecutor,
  type AssistantActionSnapshot,
} from "../../../lib/assistantActions.js";
import { assignableAgentError } from "../../../lib/propertyAssignableAgent.js";
import { canTransferProperty, transferPropertyByManager, type PropertyTransferActor } from "../../../lib/propertyManualTransfer.js";
import { propertyOwnerAgentId } from "../../../lib/propertyOwner.js";
import { runAsActor } from "../../../lib/requestActor.js";
import { resolveRefOrThrow } from "./propertyToolSupport.js";
import { plainField } from "./safeField.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * transfer_property — «передай ОБ-123 Сайфуллоеву» (10.11.2026). Раньше у помощницы
 * этого не было вовсе: в карточке объекта кнопка «Передать» есть, а Шабнам отвечала
 * отказом. Исполнение — lib/propertyManualTransfer.ts, то же тело, что у
 * `POST /properties/:id/transfer`: права (properties.editForeign И clients.assign),
 * проданный/снятый объект, «уже у этого агента», уволенный/замороженный/не агент,
 * продавец едет вместе с объектом, причина обязательна (её читает получатель).
 * Отката нет — как в CRM: вернуть объект — новая передача.
 */

const argsSchema = z.object({
  ref: z.string().trim().min(1).max(200),
  toAgentId: z.guid(),
  reason: z.string().trim().min(3).max(500),
});
type Args = z.infer<typeof argsSchema>;

const TOOL = "transfer_property";

async function transferActorOf(actor: AssistantActionActor): Promise<PropertyTransferActor> {
  const access = await loadAgentAccess(actor.agentId, prisma);
  if (!access?.isActive || isReadOnlyRole(access.role)) throw new AssistantActionError(403, "FORBIDDEN", "Недостаточно прав на это действие");
  const transferActor: PropertyTransferActor = { id: actor.agentId, can: (p) => access.permissions.has(p) && actor.can(p) };
  if (!canTransferProperty(transferActor)) throw new AssistantActionError(403, "FORBIDDEN", "Передать объект другому агенту может руководитель");
  return transferActor;
}

async function readSnapshot(args: Args): Promise<AssistantActionSnapshot> {
  const { id } = await resolveRefOrThrow(args.ref);
  const [property, to] = await Promise.all([
    prisma.property.findUnique({
      where: { id },
      select: { id: true, shortId: true, title: true, status: true, deletedAt: true, intakeAgentId: true, assignedAgentId: true, createdById: true, handoverPendingSince: true },
    }),
    prisma.agent.findUnique({ where: { id: args.toAgentId }, select: { id: true, fullName: true, role: true, isActive: true, frozenAt: true } }),
  ]);
  return {
    propertyId: id,
    status: property?.status ?? null,
    deletedAt: property?.deletedAt?.toISOString() ?? null,
    ownerId: property ? propertyOwnerAgentId(property) : null,
    intakeAgentId: property?.intakeAgentId ?? null,
    assignedAgentId: property?.assignedAgentId ?? null,
    handoverPendingSince: property?.handoverPendingSince?.toISOString() ?? null,
    to: to ? { id: to.id, role: to.role, isActive: to.isActive, frozenAt: to.frozenAt?.toISOString() ?? null } : null,
  };
}

export const transferPropertyExecutor: AssistantActionExecutor<Args> = {
  tool: TOOL,
  requires: ["properties.editForeign", "clients.assign"],
  channels: ["crm", "telegram"],
  privateTelegram: true,
  parseArgs: (raw) => argsSchema.parse(raw),
  async snapshot(args, actor) {
    await transferActorOf(actor);
    return readSnapshot(args);
  },
  async buildPreview(args, raw) {
    const snap = raw as { propertyId: string; status: string | null; deletedAt: string | null; ownerId: string | null };
    const property = await prisma.property.findUnique({ where: { id: snap.propertyId }, select: { shortId: true, title: true } });
    if (!property || snap.deletedAt) throw new AssistantActionError(404, "NOT_FOUND", "Объект не найден");
    if (snap.status === "SOLD" || snap.status === "WITHDRAWN") {
      throw new AssistantActionError(409, "CLOSED", "Объект уже продан или снят с продажи — передавать нечего");
    }
    if (snap.ownerId === args.toAgentId) throw new AssistantActionError(409, "NO_CHANGE", "Объект уже у этого агента");
    const agentError = await assignableAgentError(args.toAgentId);
    if (agentError) throw new AssistantActionError(400, "TARGET", agentError);
    const [from, to] = await Promise.all([
      snap.ownerId ? prisma.agent.findUnique({ where: { id: snap.ownerId }, select: { fullName: true } }) : null,
      prisma.agent.findUnique({ where: { id: args.toAgentId }, select: { fullName: true, role: true } }),
    ]);
    const code = formatPropertyCode(property.shortId);
    return {
      title: `🏠 Передать ${code}: ${plainField(from?.fullName, 60) ?? "без агента"} → ${plainField(to?.fullName, 60)}`.slice(0, 200),
      was: { Объект: `${code} · ${plainField(property.title, 80)}`, href: `/properties/${snap.propertyId}`, Агент: plainField(from?.fullName, 80) ?? "—" },
      becomes: { Агент: `${plainField(to?.fullName, 80)} (${ROLE_LABELS[to?.role as Role] ?? to?.role})`, Причина: plainField(args.reason, 200) },
      risk: "Продавец переедет вместе с объектом. Новый агент получит уведомление и примет объект в CRM. Отката нет — только новая передача.",
    };
  },
  async execute(args, actor, ctx) {
    const transferActor = await transferActorOf(actor);
    const snap = ctx.snapshotBefore as { propertyId: string };
    const outcome = await runAsActor(actor.agentId, () =>
      transferPropertyByManager(transferActor, snap.propertyId, { toAgentId: args.toAgentId, reason: args.reason }, { via: "assistant" })
    );
    if (!outcome.ok) throw new AssistantActionError(outcome.status, outcome.status === 409 ? "CONFLICT" : "FAILED", outcome.body.error);
    return { result: { ...outcome.body, propertyId: snap.propertyId, href: `/properties/${snap.propertyId}` }, audit: { entityType: "Property", entityId: snap.propertyId } };
  },
};

export const transferPropertyTool: AssistantWriteToolPlugin = {
  name: TOOL,
  level: "C",
  statusPhrase: "Готовлю передачу объекта…",
  description:
    "Передать ОДИН объект недвижимости другому агенту (смена хозяина объекта). ref — номер ОБ-… или адрес; toAgentId — из list_staff. " +
    "Причина обязательна — спроси, если не названа: её прочитает новый агент. Передать клиента — change_client_agent, все дела " +
    "уходящего — handover_staff_work.",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Номер объекта (ОБ-123) или адрес" },
      toAgentId: { type: "string", description: "ID агента из list_staff" },
      reason: { type: "string", description: "Почему объект передаётся" },
    },
    required: ["ref", "toAgentId", "reason"],
  },
  allowed: (actor) =>
    actor.surface !== "telegram-group" && !isReadOnlyRole(actor.role) && actor.canEditForeignProperties && actor.canAssignClients,
  executor: transferPropertyExecutor as never,
};
