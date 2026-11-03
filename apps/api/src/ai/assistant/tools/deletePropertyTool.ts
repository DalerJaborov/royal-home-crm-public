import { z } from "zod";
import { PROPERTY_DELETE_REQUEST_REASONS, formatPropertyCode, isReadOnlyRole } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { AssistantActionError, type AssistantActionActor, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { logAgentAudit } from "../../../lib/audit.js";
import { publishPropertyUpdated } from "../../../lib/livePublish.js";
import { canManagePropertyAs } from "../../../lib/propertyAccess.js";
import { trashProperty } from "../../../lib/trashProperty.js";
import { loadWriterRole, resolveRefOrThrow } from "./propertyToolSupport.js";
import { plainField } from "./safeField.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * delete_property — УДАЛЕНИЕ В КОРЗИНУ СВОЕГО ОБЪЕКТА (владелец 03.11.2026: «дай все
 * разрешения, но в корзине всё можно будет смотреть»). Только мягкое удаление
 * (`lib/trashProperty.ts`, тот же путь, что кнопка и одобрение заявки на удаление):
 * объект снимается с сайта и уходит в Корзину, откуда директор/админ его восстанавливает.
 * Жёсткого удаления из чата нет и не будет. Своим объект считается по общему правилу
 * (`lib/propertyAccess.ts`: ведущий, приёмщик, создатель; руководство — любой).
 * Объект со сделкой trashProperty не удалит сам.
 */
const argsSchema = z.object({
  ref: z.string().trim().min(1).max(200),
  reason: z.enum(PROPERTY_DELETE_REQUEST_REASONS).optional(),
  comment: z.string().trim().max(500).optional(),
});
type Args = z.infer<typeof argsSchema>;

interface Snap {
  propertyId: string;
  shortId: number;
  title: string;
  status: string;
  publishedOnSite: boolean;
  deleted: boolean;
  [extra: string]: unknown;
}

async function load(actor: AssistantActionActor, ref: string) {
  const role = await loadWriterRole(actor.agentId);
  if (isReadOnlyRole(role)) throw new AssistantActionError(403, "READ_ONLY_ROLE", "Только просмотр");
  const { id } = await resolveRefOrThrow(ref);
  const property = await prisma.property.findUnique({ where: { id } });
  if (!property || property.deletedAt) throw new AssistantActionError(404, "ENTITY_NOT_FOUND", "Объект не найден");
  if (!canManagePropertyAs({ agentId: actor.agentId, can: actor.can }, property)) {
    throw new AssistantActionError(403, "FORBIDDEN", "Нет доступа к этому объекту");
  }
  return property;
}

export const deletePropertyExecutor: AssistantActionExecutor<Args> = {
  tool: "delete_property",
  channels: ["crm", "telegram"],
  parseArgs: (raw) => argsSchema.parse(raw),

  async snapshot(args, actor): Promise<Snap> {
    const p = await load(actor, args.ref);
    return { propertyId: p.id, shortId: p.shortId, title: p.title, status: p.status, publishedOnSite: p.publishedOnSite, deleted: false };
  },

  buildPreview(args, raw) {
    const snap = raw as Snap;
    const code = formatPropertyCode(snap.shortId);
    return {
      title: `Удалить объект ${code} в Корзину`,
      was: {
        Объект: `${code} · ${plainField(snap.title, 80) ?? ""}`.trim(),
        "На сайте": snap.publishedOnSite ? "опубликован" : "не опубликован",
      },
      becomes: {
        Объект: "в Корзине, снят с сайта",
        ...(args.reason ? { Причина: args.reason } : {}),
      },
      risk: "Объект уйдёт в Корзину и пропадёт с сайта. Директор или админ может восстановить его оттуда; насовсем из чата не удаляется.",
    };
  },

  async execute(args, actor, ctx) {
    const before = ctx.snapshotBefore as Snap;
    await load(actor, before.propertyId);
    const removal = { ...(args.reason ? { removalReason: args.reason } : {}), ...(args.comment ? { removalComment: args.comment } : {}) };
    const result = await trashProperty(before.propertyId, actor.agentId, removal);
    if (!result.ok) throw new AssistantActionError(result.status, "REFUSED", result.error);
    logAgentAudit(actor.agentId, "TRASH", "Property", result.property.id, {
      source: "assistant",
      actionId: ctx.actionId,
      shortId: result.property.shortId,
      publishedOnSite: result.property.publishedOnSite,
    });
    publishPropertyUpdated({ propertyId: result.property.id, actorId: actor.agentId, stage: "TRASHED" });
    return {
      result: { trashed: true, propertyShortId: result.property.shortId, message: "Объект в Корзине" },
      audit: { entityType: "Property", entityId: result.property.id },
    };
  },
};

export const deletePropertyPlugin: AssistantWriteToolPlugin = {
  name: "delete_property",
  level: "C",
  description:
    "Удалить СВОЙ объект в Корзину (мягко: снимается с сайта, директор может восстановить; насовсем из чата не удаляется). " +
    "Звать: «удали ОБ-88», «убери дубль ОБ-91». Причина необязательна: DUPLICATE, TEST_CARD, OWNER_CANCELLED, SOLD_ELSEWHERE, " +
    "WRONG_DATA, OTHER. Объект со сделкой удалить нельзя — скажи причину из ответа. После вызова ответь одной фразой: «Подтвердите удаление».",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Номер объекта: «ОБ-000088», «88» или id" },
      reason: { type: "string", enum: [...PROPERTY_DELETE_REQUEST_REASONS], description: "Причина (необязательно)" },
      comment: { type: "string", description: "Комментарий (необязательно)" },
    },
    required: ["ref"],
  },
  statusPhrase: "Готовлю удаление в Корзину…",
  allowed: (actor) => !isReadOnlyRole(actor.role),
  executor: deletePropertyExecutor as unknown as AssistantWriteToolPlugin["executor"],
};
