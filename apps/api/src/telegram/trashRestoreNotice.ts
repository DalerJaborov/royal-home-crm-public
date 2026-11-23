import { isReadOnlyRole } from "@royal-home/shared";
import { loadAgentAccess } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { describeError } from "../lib/describeError.js";
import { logAgentAudit } from "../lib/audit.js";
import { publishPropertyUpdated } from "../lib/livePublish.js";
import { restoreClientFromTrash } from "../lib/restoreClient.js";
import { claimCallback } from "../lib/telegramCallbackClaim.js";
import { logSystemError } from "../lib/systemError.js";
import { restorePropertyFromTrash } from "../lib/trashProperty.js";
import { sendPushToAgent } from "../push.js";
import { answerCallbackQuery, type TelegramCallbackQuery, type TelegramInlineButton } from "./api.js";
import { escapeHtml } from "./assistantReply.js";
import { clickerOf, sendStaffNotice } from "./staffNotice.js";

/**
 * «УДАЛИЛ СВОЁ ЧЕРЕЗ ШАБНАМ» — РУКОВОДСТВУ С КНОПКОЙ «ВОССТАНОВИТЬ» (владелец 15.11.2026:
 * «можно удалить свои объекты и клиентов через Шабнам… а потом всё идёт на модерацию РОП,
 * директору и админу»).
 *
 * Объект или клиент уходит в Корзину (мягко, жёсткого удаления из чата нет нигде). О каждом таком
 * удалении РОП, директор и админ получают ОДНО сообщение: что, кто, и кнопку «Восстановить».
 * Рассылка — через общую дверь сообщений помощницы (`sendStaffNotice`, вид `trash`): человек
 * выключает её «не присылай мне такое» или кнопкой «🔕 Не присылать такое». У кого Telegram не
 * привязан — то же самое лентой и пушем CRM (ссылка в Корзину), тоже одно на удаление.
 *
 * Кнопку «Восстановить» видит только тот, у кого есть право восстанавливать (объект —
 * `properties.delete`, клиент — `clients.delete`: общее правило Корзины, lib/trashAccess.ts);
 * остальные получают то же сообщение без кнопки. Нажатие исполняет ТЕ ЖЕ функции, что кнопка
 * «Восстановить» в CRM: `restorePropertyFromTrash` и `restoreClientFromTrash`, права
 * перечитываются на нажатии, а не берутся из момента рассылки.
 */
export const TRASH_NOTICE_ROLES = ["HEAD_OF_SALES", "DIRECTOR", "ADMIN"] as const;

const PROPERTY_PREFIX = "tr:p:";
const CLIENT_PREFIX = "tr:c:";
/**
 * В кнопке стоит и метка удаления (`deletedAt` в мс, base36): `tr:p:<id>:<метка>`. Объект могли
 * восстановить и удалить снова — старая кнопка тогда не должна поднимать то, что удалили заново.
 * Лимит callback_data Telegram — 64 байта: 5 + id (≤36) + 1 + метка (≤9) = 51.
 */
export const trashStamp = (deletedAt: Date): string => deletedAt.getTime().toString(36);

export type TrashedKind = "property" | "client";

export interface TrashRemovalInput {
  kind: TrashedKind;
  /** id удалённого объекта / клиента. */
  entityId: string;
  /** «ОБ-000088 · Рудаки 12» или «К-0042 · Иван Иванов» — без телефона. */
  label: string;
  /** Кто удалил. */
  byAgentId: string;
}

/** Получатели: РОП, директор, админ — активные, кроме самого удалившего. */
async function recipientsFor(byAgentId: string): Promise<{ id: string; permissions: ReadonlySet<string> }[]> {
  const agents = await prisma.agent.findMany({
    where: { isActive: true, role: { in: [...TRASH_NOTICE_ROLES] }, id: { not: byAgentId } },
    select: { id: true },
  });
  const out: { id: string; permissions: ReadonlySet<string> }[] = [];
  for (const { id } of agents) {
    const access = await loadAgentAccess(id);
    if (access?.isActive && !isReadOnlyRole(access.role)) out.push({ id, permissions: access.permissions });
  }
  return out;
}

/** Одно сообщение на удаление каждому получателю; сбой одного не мешает остальным и не отменяет удаление. */
export async function notifyTrashRemoval(input: TrashRemovalInput): Promise<void> {
  try {
    const [deleter, recipients] = await Promise.all([
      prisma.agent.findUnique({ where: { id: input.byAgentId }, select: { fullName: true } }),
      recipientsFor(input.byAgentId),
    ]);
    const what = input.kind === "property" ? "объект" : "клиента";
    const who = deleter?.fullName ?? "Сотрудник";
    const html = `🗑 <b>${escapeHtml(who)} удалил(а) ${what}</b>\n${escapeHtml(input.label)}\n\nЛежит в Корзине, нигде не пропало. Если это ошибка — верните одной кнопкой.`;
    const restoreRight = input.kind === "property" ? "properties.delete" : "clients.delete";
    const url = "/archive";
    const trashed =
      input.kind === "property"
        ? await prisma.property.findUnique({ where: { id: input.entityId }, select: { deletedAt: true } })
        : await prisma.client.findUnique({ where: { id: input.entityId }, select: { deletedAt: true } });
    const stamp = trashed?.deletedAt ? `:${trashStamp(trashed.deletedAt)}` : "";
    for (const recipient of recipients) {
      const canRestore = recipient.permissions.has(restoreRight);
      const buttons: TelegramInlineButton[][] = canRestore
        ? [[{ text: "♻️ Восстановить", callback_data: `${input.kind === "property" ? PROPERTY_PREFIX : CLIENT_PREFIX}${input.entityId}${stamp}` }]]
        : [];
      const status = await sendStaffNotice({
        agentId: recipient.id,
        kind: "trash",
        html,
        buttons,
        dedupKey: `trash-removal:${input.kind}:${input.entityId}:${recipient.id}`,
        subject: input.label,
      }).catch((err: unknown) => {
        void logSystemError("telegram", `Сообщение об удалении в Корзину не ушло (${input.kind} ${input.entityId}): ${describeError(err)}`);
        return "failed" as const;
      });
      // Telegram не привязан — то же сообщение лентой и пушем CRM (одно на удаление; выключенный вид push не шлёт).
      if (status === "no-telegram") {
        void sendPushToAgent(recipient.id, {
          title: `🗑 ${who} удалил(а) ${what}`,
          body: `${input.label} — в Корзине, можно восстановить`,
          url,
          tag: `trash-removal-${input.kind}-${input.entityId}`,
          kind: "trash",
        }).catch((err: unknown) => {
          void logSystemError("api", `Пуш об удалении в Корзину не ушёл (${input.kind} ${input.entityId}): ${describeError(err)}`);
        });
      }
    }
  } catch (err) {
    void logSystemError("api", `Уведомление руководству об удалении в Корзину не собрано (${input.kind} ${input.entityId}): ${describeError(err)}`);
  }
}

/** «♻️ Восстановить» под сообщением об удалении. true — нажатие наше (обработано или отклонено). */
export async function handleTrashRestoreCallback(query: TelegramCallbackQuery): Promise<boolean> {
  const data = query.data ?? "";
  const isProperty = data.startsWith(PROPERTY_PREFIX);
  if (!isProperty && !data.startsWith(CLIENT_PREFIX)) return false;
  // Повторная доставка того же нажатия не исполняется заново.
  if (!(await claimCallback(query.id))) {
    await answerCallbackQuery(query.id);
    return true;
  }
  const [entityId, stamp] = data.slice((isProperty ? PROPERTY_PREFIX : CLIENT_PREFIX).length).split(":");
  try {
    const clicker = await clickerOf(query);
    if (!clicker) {
      await answerCallbackQuery(query.id, "Привяжите аккаунт в личке с ботом");
      return true;
    }
    // Свежие права нажавшего, а не права получателя на момент рассылки.
    const access = await loadAgentAccess(clicker.id);
    if (!access?.isActive || isReadOnlyRole(access.role)) {
      await answerCallbackQuery(query.id, "Нет прав на это действие");
      return true;
    }
    const can = (permission: Parameters<typeof access.permissions.has>[0]) => access.permissions.has(permission);
    if (stamp) {
      const current = isProperty
        ? await prisma.property.findUnique({ where: { id: entityId }, select: { deletedAt: true } })
        : await prisma.client.findUnique({ where: { id: entityId }, select: { deletedAt: true } });
      if (!current?.deletedAt) {
        await answerCallbackQuery(query.id, "Уже восстановлено или не в Корзине");
        return true;
      }
      if (trashStamp(current.deletedAt) !== stamp) {
        await answerCallbackQuery(query.id, "Это сообщение устарело: удалили заново — нажмите кнопку в новом сообщении");
        return true;
      }
    }
    if (isProperty) {
      const result = await restorePropertyFromTrash(entityId, { agentId: clicker.id, can });
      if (!result.ok) {
        await answerCallbackQuery(query.id, result.status === 404 || result.status === 409 ? "Уже восстановлено или не в Корзине" : result.error);
        return true;
      }
      logAgentAudit(clicker.id, "RESTORE", "Property", result.property.id, {
        source: "trash-notice",
        shortId: result.property.shortId,
        title: result.property.title,
      });
      publishPropertyUpdated({ propertyId: result.property.id, agentId: result.property.assignedAgentId, stage: result.property.status, actorId: clicker.id });
      await answerCallbackQuery(query.id, "Объект восстановлен");
      return true;
    }
    if (!can("clients.delete")) {
      await answerCallbackQuery(query.id, "Восстановить клиента может РОП, директор или администратор");
      return true;
    }
    const result = await restoreClientFromTrash(entityId, clicker.id);
    if (!result.ok) {
      await answerCallbackQuery(query.id, result.status === 404 ? "Уже восстановлено или не в Корзине" : result.error);
      return true;
    }
    logAgentAudit(clicker.id, "RESTORE", "Client", result.client.id, {
      source: "trash-notice",
      shortId: result.client.shortId,
      fullName: result.client.fullName,
      ownerReassignedToQueue: result.ownerReassignedToQueue,
    });
    await answerCallbackQuery(query.id, "Клиент восстановлен");
  } catch (err) {
    void logSystemError("telegram", `Кнопка «Восстановить» из Корзины не сработала: ${describeError(err)}`);
    await answerCallbackQuery(query.id, "Не получилось, попробуйте ещё раз").catch(() => undefined);
  }
  return true;
}
