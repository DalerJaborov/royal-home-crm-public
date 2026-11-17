import { z } from "zod";
import { formatClientCode, isReadOnlyRole } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { AssistantActionError, type AssistantActionActor, type AssistantActionExecutor } from "../../../lib/assistantActions.js";
import { logAgentAudit } from "../../../lib/audit.js";
import { cardWhereFromParam } from "../../../lib/cardIdParam.js";
import { clientNamePhoneSafe } from "../../../lib/clientPhone.js";
import { dushanbeDateString } from "../../../lib/dushanbeTime.js";
import { restoreClientFromTrash } from "../../../lib/restoreClient.js";
import { loadToolActor } from "./showingToolSupport.js";
import { plainField } from "./safeField.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * restore_client — ВЕРНУТЬ КЛИЕНТА ИЗ КОРЗИНЫ КАРТОЧКОЙ «Восстановить / Отмена» (17.11.2026).
 *
 * Тонкая обёртка над lib/restoreClient.ts::restoreClientFromTrash — той же дверью, что у
 * POST /clients/:id/restore в CRM и у кнопки «Восстановить» под сообщением об удалении.
 * Право — как у маршрута: `clients.delete` (директор, админ, РОП). Проверяется при подготовке И при
 * нажатии, свежими правами сотрудника. Агент и очередь раздачи (уволенный/замороженный хозяин),
 * пуш руководству — внутри общей функции, здесь второй копии правил нет.
 * Форма и уровень (C) — как у restore_property.
 */
const argsSchema = z.object({ clientId: z.string().trim().min(1).max(64) });
type Args = z.infer<typeof argsSchema>;
type ClientKindArg = Parameters<typeof formatClientCode>[1];

interface Snap {
  clientId: string;
  shortId: number;
  kind: string;
  fullName: string;
  deleted: boolean;
  deletedOn?: string | null;
  deletedBy?: string | null;
  [extra: string]: unknown;
}

const NOT_IN_TRASH = "В Корзине такого клиента нет. Назовите номер клиента или id из найденного в Корзине.";
const DENIED = "Вернуть клиента из Корзины может руководитель: директор, администратор или РОП.";

async function loadTrashedClient(actionActor: AssistantActionActor, ref: string) {
  const { actor } = await loadToolActor(actionActor);
  // Как у маршрута restore: право clients.delete, свежее из базы, а не из слов модели.
  if (!(actor.permissions?.has("clients.delete") ?? false)) throw new AssistantActionError(403, "FORBIDDEN", DENIED);
  const where = cardWhereFromParam(ref);
  if (!where) throw new AssistantActionError(404, "ENTITY_NOT_FOUND", NOT_IN_TRASH);
  const client = await prisma.client.findFirst({
    where,
    select: { id: true, shortId: true, kind: true, fullName: true, deletedAt: true, deletedBy: { select: { fullName: true } } },
  });
  if (!client) throw new AssistantActionError(404, "ENTITY_NOT_FOUND", NOT_IN_TRASH);
  if (!client.deletedAt) throw new AssistantActionError(409, "NOT_IN_TRASH", "Этот клиент не в Корзине — восстанавливать нечего.");
  return client;
}

export const restoreClientExecutor: AssistantActionExecutor<Args> = {
  tool: "restore_client",
  requires: ["clients.delete"],
  channels: ["crm", "telegram"],
  // Карточка клиента и её подтверждение — только личка: в общей группе чужие глаза.
  privateTelegram: true,
  parseArgs: (raw) => argsSchema.parse(raw),

  // Снимок «после» исполнения упадёт (клиент уже не в Корзине) — брокер это переносит, как у restore_property:
  // отката у восстановления нет, а повторное нажатие получает сохранённый итог.
  async snapshot(args, actor): Promise<Snap> {
    const c = await loadTrashedClient(actor, args.clientId);
    return {
      clientId: c.id,
      shortId: c.shortId,
      kind: c.kind,
      fullName: c.fullName,
      deleted: true,
      deletedOn: c.deletedAt ? dushanbeDateString(c.deletedAt) : null,
      deletedBy: c.deletedBy?.fullName ?? null,
    };
  },

  buildPreview(_args, raw) {
    const snap = raw as Snap;
    const code = formatClientCode(snap.shortId, snap.kind as ClientKindArg);
    const deletedLine = [snap.deletedOn, snap.deletedBy].filter(Boolean).join(", ");
    return {
      title: `Восстановить клиента ${code} из Корзины`,
      was: {
        Клиент: `${code} · ${plainField(clientNamePhoneSafe(snap.fullName, false), 80) ?? ""}`.trim(),
        Где: deletedLine ? `в Корзине (удалён ${deletedLine})` : "в Корзине",
      },
      becomes: { Клиент: "снова в работе" },
      risk: "Карточка вернётся в списки. Если прежний агент уже недоступен, она встанет в очередь раздачи, руководство получит уведомление.",
    };
  },

  async execute(_args, actor, ctx) {
    const before = ctx.snapshotBefore as Snap;
    // Права — свежо, а не по моменту превью.
    await loadTrashedClient(actor, before.clientId);
    const result = await restoreClientFromTrash(before.clientId, actor.agentId);
    if (!result.ok) throw new AssistantActionError(result.status, result.status === 409 ? "CONFLICT" : "REFUSED", result.error);
    logAgentAudit(actor.agentId, "RESTORE", "Client", result.client.id, {
      source: "assistant",
      actionId: ctx.actionId,
      shortId: result.client.shortId,
      ownerReassignedToQueue: result.ownerReassignedToQueue,
    });
    return {
      result: {
        restored: true,
        clientShortId: result.client.shortId,
        message: result.ownerReassignedToQueue ? "Клиент восстановлен и встал в очередь раздачи: прежний агент недоступен" : "Клиент восстановлен из Корзины",
      },
      audit: { entityType: "Client", entityId: result.client.id },
    };
  },
};

export const restoreClientPlugin: AssistantWriteToolPlugin = {
  name: "restore_client",
  level: "C",
  description:
    "Восстановить клиента ИЗ КОРЗИНЫ (готовит карточку «Восстановить / Отмена», исполняет человек кнопкой). " +
    "Зови, когда просят «верни клиента К-0042 из Корзины», «восстанови удалённого клиента». clientId — id клиента из find_clients (scope=both или trash) " +
    "или его номер, который назвал человек. Восстановить может директор, администратор или РОП; остальным инструмент сам откажет — передай отказ как есть. " +
    "Если прежний агент клиента уже недоступен, карточка встанет в очередь раздачи — скажи об этом.",
  parameters: {
    type: "object",
    properties: {
      clientId: { type: "string", description: "id клиента из find_clients (он в Корзине) либо его номер, например «42»" },
    },
    required: ["clientId"],
  },
  statusPhrase: "Готовлю восстановление клиента…",
  allowed: (actor) =>
    actor.surface !== "telegram-group" && !isReadOnlyRole(actor.role) && (actor.permissions?.has("clients.delete") ?? false),
  executor: restoreClientExecutor as unknown as AssistantWriteToolPlugin["executor"],
};
