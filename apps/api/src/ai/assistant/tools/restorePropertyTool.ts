import { z } from "zod";
import { formatPropertyCode, isReadOnlyRole } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { AssistantActionError, type AssistantActionActor, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { logAgentAudit } from "../../../lib/audit.js";
import { dushanbeDateString } from "../../../lib/dushanbeTime.js";
import { publishPropertyUpdated } from "../../../lib/livePublish.js";
import { parseExactPropertyRef } from "../../../lib/propertyRefLookup.js";
import { canRestorePropertyAs, PROPERTY_RESTORE_DENIED } from "../../../lib/trashAccess.js";
import { restorePropertyFromTrash } from "../../../lib/trashProperty.js";
import { loadWriterRole } from "./propertyToolSupport.js";
import { plainField } from "./safeField.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * restore_property — ВОССТАНОВИТЬ ОБЪЕКТ ИЗ КОРЗИНЫ КАРТОЧКОЙ «Восстановить / Отмена»
 * (07.11.2026, решение владельца). Помощник только готовит действие; исполняет его человек
 * кнопкой. Право — общее правило Корзины (lib/trashAccess.ts: директор/админ или хозяин
 * объекта), проверяется при подготовке И при нажатии, свежими правами нажавшего. Само
 * восстановление — lib/trashProperty.ts::restorePropertyFromTrash, та же дверь, что у кнопки
 * «Восстановить» в CRM.
 *
 * Объект называют только номером: code из find_properties_by_place («ОБ-000130»), его href
 * («/properties/130»), голым номером «130» или id. Вернуть из Корзины «похожий по адресу»
 * объект нельзя.
 */
const argsSchema = z.object({ ref: z.string().trim().min(1).max(100) });
type Args = z.infer<typeof argsSchema>;

interface Snap {
  propertyId: string;
  shortId: number;
  title: string;
  deleted: boolean;
  deletedOn?: string | null;
  deletedBy?: string | null;
  [extra: string]: unknown;
}

const NOT_IN_TRASH = "В Корзине такого объекта нет. Назовите номер ОБ- из найденного в Корзине.";

async function loadTrashed(actor: AssistantActionActor, ref: string) {
  await loadWriterRole(actor.agentId);
  // Один разбор точной ссылки (id, номер, href) на Корзину — lib/propertyRefLookup.ts.
  const exact = parseExactPropertyRef(ref);
  if (!exact) throw new AssistantActionError(404, "ENTITY_NOT_FOUND", NOT_IN_TRASH);
  const property = await prisma.property.findFirst({
    where: exact,
    include: { deletedBy: { select: { fullName: true } } },
  });
  if (!property) throw new AssistantActionError(404, "ENTITY_NOT_FOUND", NOT_IN_TRASH);
  if (!property.deletedAt) throw new AssistantActionError(409, "NOT_IN_TRASH", "Этот объект не в Корзине — восстанавливать нечего.");
  if (!canRestorePropertyAs(actor, property)) throw new AssistantActionError(403, "FORBIDDEN", PROPERTY_RESTORE_DENIED);
  return property;
}

export const restorePropertyExecutor: AssistantActionExecutor<Args> = {
  tool: "restore_property",
  channels: ["crm", "telegram"],
  parseArgs: (raw) => argsSchema.parse(raw),

  // Снимок «после» исполнения упадёт (объект уже не в Корзине) — брокер это переносит:
  // отката у восстановления нет, а повторное нажатие получает сохранённый итог.
  async snapshot(args, actor): Promise<Snap> {
    const p = await loadTrashed(actor, args.ref);
    return {
      propertyId: p.id,
      shortId: p.shortId,
      title: p.title,
      deleted: true,
      deletedOn: p.deletedAt ? dushanbeDateString(p.deletedAt) : null,
      deletedBy: p.deletedBy?.fullName ?? null,
    };
  },

  buildPreview(_args, raw) {
    const snap = raw as Snap;
    const code = formatPropertyCode(snap.shortId);
    const deletedLine = [snap.deletedOn, snap.deletedBy].filter(Boolean).join(", ");
    return {
      title: `Восстановить объект ${code} из Корзины`,
      was: {
        Объект: `${code} · ${plainField(snap.title, 80) ?? ""}`.trim(),
        Где: deletedLine ? `в Корзине (удалён ${deletedLine})` : "в Корзине",
      },
      becomes: {
        Объект: "снова в работе",
        "На сайте": "не публикуется сам, при необходимости опубликуйте кнопкой",
      },
      risk: "Объект вернётся в работу со своим агентом. На сайт он сам не вернётся.",
    };
  },

  async execute(_args, actor, ctx) {
    const before = ctx.snapshotBefore as Snap;
    await loadWriterRole(actor.agentId);
    const result = await restorePropertyFromTrash(before.propertyId, { agentId: actor.agentId, can: actor.can });
    if (!result.ok) throw new AssistantActionError(result.status, result.status === 403 ? "FORBIDDEN" : "REFUSED", result.error);
    logAgentAudit(actor.agentId, "RESTORE", "Property", result.property.id, {
      source: "assistant",
      actionId: ctx.actionId,
      shortId: result.property.shortId,
      title: result.property.title,
    });
    publishPropertyUpdated({
      propertyId: result.property.id,
      agentId: result.property.assignedAgentId,
      stage: result.property.status,
      actorId: actor.agentId,
    });
    return {
      result: { restored: true, propertyShortId: result.property.shortId, message: "Объект восстановлен из Корзины" },
      audit: { entityType: "Property", entityId: result.property.id },
    };
  },
};

export const restorePropertyPlugin: AssistantWriteToolPlugin = {
  name: "restore_property",
  level: "C",
  description:
    "Восстановить объект ИЗ КОРЗИНЫ (готовит карточку «Восстановить / Отмена», исполняет человек кнопкой). " +
    "Зови, когда просят «восстанови ОБ-130», «верни объект из Корзины». ref — поле code удалённого объекта из find_properties_by_place " +
    "(«ОБ-000130»); подходит и его href или номер, который назвал человек. Адрес или описание не подходят. " +
    "Восстановить может директор, администратор или агент этого объекта; остальным инструмент сам откажет — передай отказ как есть. " +
    "На сайт объект сам не возвращается.",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "code объекта в Корзине из find_properties_by_place («ОБ-000130»), его href или номер «130»" },
    },
    required: ["ref"],
  },
  statusPhrase: "Готовлю восстановление из Корзины…",
  allowed: (actor) => !isReadOnlyRole(actor.role),
  executor: restorePropertyExecutor as unknown as AssistantWriteToolPlugin["executor"],
};
