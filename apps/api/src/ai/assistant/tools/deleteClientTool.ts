import { z } from "zod";
import { formatClientCode, isReadOnlyRole } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { AssistantActionError, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { logAgentAudit } from "../../../lib/audit.js";
import { assertClientWritable } from "../actor.js";
import { cardWhereFromParam } from "../../../lib/cardIdParam.js";
import { clientNamePhoneSafe } from "../../../lib/clientPhone.js";
import { trashBlocker, trashClient } from "../../../lib/trashClient.js";
import { notifyTrashRemoval } from "../../../telegram/trashRestoreNotice.js";
import { loadToolActor } from "./showingToolSupport.js";
import { plainField } from "./safeField.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * delete_client — УДАЛЕНИЕ В КОРЗИНУ СВОЕГО КЛИЕНТА (владелец 15.11.2026: «можно удалить свои
 * объекты и клиентов через Шабнам… а потом всё идёт на модерацию РОП, директору и админу»).
 *
 * Только мягкое удаление (`lib/trashClient.ts` — тот же путь, что у кнопки и одобрения заявки):
 * карточка уходит в Корзину, сделки и переписка остаются, «Восстановить» возвращает как была.
 * Жёсткого удаления из чата нет и не будет. Только СВОЙ клиент — закреплённый за самим сотрудником
 * и принятый им; чужой (в том числе руководителю) — отказ простыми словами. Клиент со сделкой или
 * продавец с объектами в работе не удаляется: причину называет сама `trashBlocker`.
 * О каждом удалении РОП, директор и админ получают одно сообщение с кнопкой «Восстановить»
 * (telegram/trashRestoreNotice.ts, вид `trash`, отключается словами).
 */
const argsSchema = z.object({
  clientId: z.string().trim().min(1).max(64),
  comment: z.string().trim().max(500).optional(),
});
type Args = z.infer<typeof argsSchema>;
type ClientKindArg = Parameters<typeof formatClientCode>[1];

const FOREIGN_MESSAGE = "Удалить можно только своего клиента. Этот клиент закреплён за другим сотрудником — попросите его или руководителя.";

interface Snap {
  clientId: string;
  shortId: number;
  kind: string;
  fullName: string;
  assignedAgentId: string | null;
  deleted: boolean;
  [extra: string]: unknown;
}

/** Свой клиент: за этим сотрудником, им принятый, не в Корзине. Иначе отказ понятными словами. */
async function loadOwnClient(actionActor: Parameters<NonNullable<AssistantActionExecutor<Args>["snapshot"]>>[1], ref: string) {
  const { actor } = await loadToolActor(actionActor);
  const where = cardWhereFromParam(ref);
  if (!where) throw new AssistantActionError(404, "NOT_FOUND", "Клиент не найден");
  const client = await prisma.client.findFirst({
    where,
    select: { id: true, shortId: true, kind: true, fullName: true, assignedAgentId: true, acceptedAt: true, deletedAt: true, assignmentCompletedAt: true },
  });
  if (!client || client.deletedAt !== null) throw new AssistantActionError(404, "NOT_FOUND", "Клиент не найден");
  if (client.assignedAgentId !== actor.id) throw new AssistantActionError(403, "FORBIDDEN", FOREIGN_MESSAGE);
  const denied = assertClientWritable(actor, client);
  if (denied) throw new AssistantActionError(403, "FORBIDDEN", denied);
  return client;
}

export const deleteClientExecutor: AssistantActionExecutor<Args> = {
  tool: "delete_client",
  channels: ["crm", "telegram"],
  // Карточка клиента и её подтверждение — только личка: в общей группе чужие глаза.
  privateTelegram: true,
  parseArgs: (raw) => argsSchema.parse(raw),

  async snapshot(args, actor): Promise<Snap> {
    const c = await loadOwnClient(actor, args.clientId);
    return { clientId: c.id, shortId: c.shortId, kind: c.kind, fullName: c.fullName, assignedAgentId: c.assignedAgentId, deleted: false };
  },

  async buildPreview(_args, raw) {
    const snap = raw as Snap;
    // Сделка и объекты продавца в работе — отказ ещё до карточки подтверждения, без записи.
    const blocker = await trashBlocker(snap.clientId);
    if (blocker) throw new AssistantActionError(blocker.status, "REFUSED", blocker.error);
    const code = formatClientCode(snap.shortId, snap.kind as ClientKindArg);
    return {
      title: `Удалить клиента ${code} в Корзину`,
      was: { Клиент: `${code} · ${plainField(clientNamePhoneSafe(snap.fullName, false), 80) ?? ""}`.trim() },
      becomes: { Клиент: "в Корзине, из ваших списков пропадёт" },
      risk: "Карточка уйдёт в Корзину. Руководство получит сообщение и сможет вернуть её одной кнопкой; насовсем из чата не удаляется.",
    };
  },

  async execute(args, actor, ctx) {
    const before = ctx.snapshotBefore as Snap;
    // Права и «свой ли» — свежо, а не по моменту превью: клиента успели передать — удалять нельзя.
    const own = await loadOwnClient(actor, before.clientId);
    const result = await trashClient(own.id, actor.agentId);
    if (!result.ok) throw new AssistantActionError(result.status, "REFUSED", result.error);
    logAgentAudit(actor.agentId, "TRASH", "Client", result.client.id, {
      source: "assistant",
      actionId: ctx.actionId,
      shortId: result.client.shortId,
      kind: result.client.kind,
      ...(args.comment ? { comment: args.comment } : {}),
    });
    // Руководству — после удаления, отдельным шагом: сбой рассылки не отменяет удаление (notifyTrashRemoval не бросает).
    void notifyTrashRemoval({
      kind: "client",
      entityId: result.client.id,
      label: `${formatClientCode(result.client.shortId, result.client.kind as ClientKindArg)} · ${clientNamePhoneSafe(result.client.fullName, false)}`,
      byAgentId: actor.agentId,
    });
    return {
      result: { trashed: true, clientShortId: result.client.shortId, message: "Клиент в Корзине" },
      audit: { entityType: "Client", entityId: result.client.id },
    };
  },
};

export const deleteClientPlugin: AssistantWriteToolPlugin = {
  name: "delete_client",
  level: "C",
  description:
    "Удалить СВОЕГО клиента в Корзину (мягко: карточка не пропадает насовсем, руководство получит сообщение и может вернуть её; насовсем из чата не удаляется). " +
    "Звать: «удали клиента К-0042», «убери дубль этого клиента». Только клиент, закреплённый за самим сотрудником; чужого удалить нельзя — скажи это простыми словами. " +
    "Клиента со сделкой или продавца с объектами в работе удалить нельзя — назови причину. После подготовки коротко предложи подтвердить удаление.",
  parameters: {
    type: "object",
    properties: {
      clientId: { type: "string", description: "id клиента из find_clients / get_client_card, либо его номер (например «42»)" },
      comment: { type: "string", description: "Причина (необязательно)" },
    },
    required: ["clientId"],
  },
  statusPhrase: "Готовлю удаление в Корзину…",
  allowed: (actor) => !isReadOnlyRole(actor.role),
  executor: deleteClientExecutor as unknown as AssistantWriteToolPlugin["executor"],
};
