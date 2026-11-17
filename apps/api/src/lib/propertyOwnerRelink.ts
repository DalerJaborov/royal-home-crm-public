import type { Request } from "express";
import { prisma } from "../db.js";
import { can, canBindClient } from "../auth/middleware.js";
import { normalizeDigits } from "./shared/phoneText.js";
import { findPhoneOwners, phoneTail, PHONE_TAIL_LEN } from "./clientPhones.js";
import { logTimeline, type TimelineTx } from "./timeline.js";
import { formatPropertyCode } from "@royal-home/shared";

/**
 * СМЕНИЛИ ТЕЛЕФОН СОБСТВЕННИКА В ОБЪЕКТЕ — ЧТО С КАРТОЧКОЙ ПРОДАВЦА
 * (решение 24.09.2026, вариант «Исправить номер»).
 *
 * Раньше PATCH объекта менял только `ownerContact`, а связь `sellerClientId`
 * оставалась прежней: в «Кто ведёт объект» имя было одного человека, а номер —
 * другого. Чаще всего номер правят из-за опечатки, поэтому:
 *
 *  - номер уже записан у другой живой карточки — объект переходит к ней (если
 *    сотруднику можно привязать эту карточку — то же правило, что на создании);
 *  - номер ничей — он правится у того же продавца, главным номером карточки;
 *  - номер уже есть у самого продавца (запасной или WhatsApp) — связь та же.
 *
 * Здесь только решение: запись делает PATCH в своей транзакции вместе с объектом.
 */
export type OwnerPhonePlan =
  | { kind: "none" }
  | { kind: "relink"; clientId: string }
  | { kind: "fixSellerPhone"; clientId: string; phone: string; oldPhone: string }
  | { kind: "error"; status: 403 | 409; error: string };

export async function planOwnerPhoneChange(
  req: Request,
  existing: { sellerClientId: string | null; ownerContact: string | null },
  newContact: string
): Promise<OwnerPhonePlan> {
  const phone = normalizeDigits(newContact.replace(/[^\d]/g, ""));
  const tail = phoneTail(phone);
  if (tail.length !== PHONE_TAIL_LEN || tail === phoneTail(existing.ownerContact ?? "")) return { kind: "none" };

  const owners = await findPhoneOwners([phone], { limit: 5 });
  if (existing.sellerClientId && owners.some((o) => o.id === existing.sellerClientId)) return { kind: "none" };

  const owner = owners[0];
  if (owner) {
    if (!canBindClient(req, owner)) {
      return { kind: "error", status: 403, error: "Этот номер у клиента другого агента — объект к нему не привязать" };
    }
    return { kind: "relink", clientId: owner.id };
  }

  if (!existing.sellerClientId) return { kind: "none" };
  const seller = await prisma.client.findFirst({
    where: { id: existing.sellerClientId, deletedAt: null },
    select: { id: true, phone: true, assignedAgentId: true },
  });
  if (!seller) return { kind: "none" };
  // Номер в карточке клиента меняет тот, кто может её править (foreignWriteDenied
  // в routes/clients/shared.ts): её агент или руководство.
  if (!can(req, "clients.assign") && seller.assignedAgentId !== req.agent!.id) {
    return {
      kind: "error",
      status: 403,
      error: "Номер продавца меняет его агент или руководитель — у карточки продавца другой агент",
    };
  }
  // Живых владельцев у номера нет, а карточка в Корзине с ним же не даст сохранить:
  // главный номер клиента уникален.
  const trashed = await prisma.client.findFirst({
    where: { phone, id: { not: seller.id }, deletedAt: { not: null } },
    select: { id: true },
  });
  if (trashed) {
    return {
      kind: "error",
      status: 409,
      error: "Этот номер записан у карточки в Корзине — восстановите её или укажите другой номер",
    };
  }
  return { kind: "fixSellerPhone", clientId: seller.id, phone, oldPhone: seller.phone };
}

type PropertyTx = Pick<typeof prisma, "property">;

/**
 * Запись варианта «номер ничей»: главный номер продавца и строка в его хронологии.
 * Здесь, а не в маршруте объекта: единственная точка записи ответственного за
 * клиента сторожится тестом assigned-agent-single-writer, и прямой Client.update
 * рядом с `...data` объекта он справедливо считает дырой.
 */
export async function applySellerPhoneFix(
  tx: TimelineTx,
  plan: Extract<OwnerPhonePlan, { kind: "fixSellerPhone" }>,
  agentId: string,
  propertyShortId: number
): Promise<void> {
  await tx.client.update({ where: { id: plan.clientId }, data: { phone: plan.phone } });
  await logTimeline({
    clientId: plan.clientId,
    actor: { kind: "agent", agentId },
    type: "SYSTEM",
    notes: `Номер исправлен в карточке объекта ${formatPropertyCode(propertyShortId)}`,
    tx,
  });
}

/**
 * Обратный путь: номер исправили в карточке продавца (PATCH /clients/:id) —
 * «Телефон собственника» у его объектов, где стоял тот же старый номер, следует
 * за ним. Объекты, где записан другой номер (продавец дал объекту второй
 * телефон), не трогаются. Зовётся в транзакции правки клиента.
 */
export async function followSellerPhoneChange(
  tx: PropertyTx,
  clientId: string,
  oldPhone: string,
  newPhone: string
): Promise<number> {
  const tail = phoneTail(oldPhone);
  if (tail.length !== PHONE_TAIL_LEN || tail === phoneTail(newPhone)) return 0;
  const rows = await tx.property.findMany({
    where: { sellerClientId: clientId },
    select: { id: true, ownerContact: true },
    take: 500,
  });
  const ids = rows.filter((r) => phoneTail(r.ownerContact ?? "") === tail).map((r) => r.id);
  if (ids.length === 0) return 0;
  const result = await tx.property.updateMany({
    where: { id: { in: ids } },
    data: { ownerContact: newPhone, version: { increment: 1 } },
  });
  return result.count;
}
