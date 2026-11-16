import type { Prisma } from "../generated/prisma/client.js";
import { prisma, type TxClient } from "../db.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { sendPushToAgent } from "../push.js";
import { publishPropertyUpdated } from "./livePublish.js";

/**
 * ПЕРЕДАЧА ОБЪЕКТА ДРУГОМУ АГЕНТУ — единственный механизм на все входы
 * (владелец 24.09.2026: «дай возможность передать вручную любые объекты любому
 * агенту без ошибок и с логикой, чтобы другая логика не ломалась, а также все
 * объекты должны быть переданы, когда увольняется сотрудник и я нажимаю
 * “Передать дела”»).
 *
 * ЧТО БЫЛО. «Передача дел» переносила только объекты с `assignedAgentId =
 * уходящий`. Но хозяин объекта в этой системе — не он: `propertyOwnerAgentId`
 * (lib/propertyOwner.ts) считает хозяином `intakeAgentId ?? assignedAgentId ??
 * createdById`, карточка при создании пишет создателя в `intakeAgentId`, а
 * `assignedAgentId` на проде заполнен у 2 объектов из 46. Итог 24.09: у уволенной
 * сотрудницы 4 объекта в работе, «Передать дела» отчиталась «объектов: 0», и все
 * четыре остались «её» — с лидами по ним, напоминаниями конвейера и долей
 * комиссии на отключённой учётке. Ручной передачи из карточки не было вовсе:
 * PATCH assignedAgentId менял мёртвое поле, а хозяин (intake) оставался прежним.
 *
 * ЧТО ТЕПЕРЬ. Передача переписывает ОБА поля хозяина на получателя — и
 * `intakeAgentId`, и `assignedAgentId`, — чтобы объект стал его во всех местах,
 * где код спрашивает «чей объект» (лиды по объекту, конвейер, доступ, доля при
 * будущей сделке). `createdById` не трогаем: это история, кто завёл карточку.
 * Уже ЗАКРЫТЫЕ сделки прежнего хозяина это не переписывает — комиссия по ним
 * снята снапшотом в Deal в момент закрытия (см. lib/agentHandover.ts, «сделки
 * не переносятся»), задним числом ничего не меняется.
 *
 * ПРИНЯТИЕ БЕЗ ТАЙМЕРА. Объект, как и лид, новый хозяин принимает сам: он
 * должен прочитать, от кого объект пришёл и почему, прежде чем звонить
 * собственнику. Но таймера и штрафа нет — объект никого не заставляет ждать.
 * Пока `handoverPendingSince` не пуст, карточка помечена «передан вам».
 *
 * ПРОДАВЕЦ И ЕГО ОБЪЕКТ — ОДНА СВЯЗКА (владелец 24.09.2026, вечер). Первая
 * раздача дел Сурайё отдала продавцов №370/373/389/410 трём агентам, а их дома
 * №117/118/119/122 остались у неё: новый агент звонил собственнице «вслепую», та
 * отсылала его к Сурайё. Поэтому:
 *  - смена агента у клиента-продавца (любой механизм: раздача дел, ручная
 *    передача, очередь, отказ) тянет за собой его объекты, которыми владел
 *    прежний агент, — `transferSellerPropertiesWithClient`, вызывается из
 *    единственной точки записи `changeClientAgent`;
 *  - передача объекта (ручная или при увольнении) тянет за собой продавца,
 *    если он был у прежнего хозяина объекта — `lib/propertyTransferWithSeller.ts`
 *    (этажом выше, чтобы не заводить цикл импортов с changeClientAgent), —
 *    продавец приходит новому агенту как лид, как и при любой передаче клиента.
 * Объекты ТРЕТЬЕГО агента (принял не тот, кто вёл продавца) не трогаем: чужая
 * приёмка — чужая доля, такой разрыв решает руководитель руками.
 */
export const CLOSED_PROPERTY_STATUSES = ["SOLD", "WITHDRAWN"] as const;

/** Тот же тип чужой транзакции, что у changeClientAgent — без импорта оттуда (цикл). */
export type Tx = Pick<TxClient, "property" | "deal" | "agent" | "auditLog" | "propertyDeleteRequest">;

/** Объекты, которые сейчас в работе у агента-хозяина (по тем же трём полям, что и propertyOwnerAgentId). */
export function propertiesOwnedByWhere(agentId: string): Prisma.PropertyWhereInput {
  return {
    deletedAt: null,
    status: { notIn: [...CLOSED_PROPERTY_STATUSES] },
    OR: [
      { intakeAgentId: agentId },
      { intakeAgentId: null, assignedAgentId: agentId },
      { intakeAgentId: null, assignedAgentId: null, createdById: agentId },
    ],
  };
}

export interface TransferPropertyInput {
  propertyId: string;
  toAgentId: string;
  /** Причина — её прочитает получатель перед тем, как принять объект. */
  reason: string;
  /** Кто передал: руководитель (ручная передача) или он же — запустив «Передать дела». */
  actorId: string | null;
  actorName?: string;
  source: "manual" | "handover";
  /** Пуш получателю. «Передача дел» шлёт один сводный пуш на всю раздачу и передаёт false. */
  notify?: boolean;
  /** Участвовать в чужой транзакции (вызов из changeClientAgent). */
  tx?: Tx;
}

export interface TransferPropertyResult {
  changed: boolean;
  fromAgentId: string | null;
  shortId: number;
  title: string;
}

export async function transferPropertyToAgent(input: TransferPropertyInput): Promise<TransferPropertyResult> {
  const db: Tx = input.tx ?? prisma;
  const property = await db.property.findUniqueOrThrow({
    where: { id: input.propertyId },
    select: {
      id: true,
      shortId: true,
      title: true,
      status: true,
      intakeAgentId: true,
      assignedAgentId: true,
      createdById: true,
    },
  });
  const fromAgentId = propertyOwnerAgentId(property);
  if (fromAgentId === input.toAgentId) {
    return { changed: false, fromAgentId, shortId: property.shortId, title: property.title };
  }

  // РИЕЛТОР ЖИВОЙ СДЕЛКИ ОСТАЁТСЯ (глубокая проверка 02.10.2026, D9/О10).
  // Сделка ставит объекту assignedAgentId = риелтор покупателя; передача
  // перетирала его вместе с хозяином-продавцом — риелтор терял доступ к объекту
  // своей сделки, а её отмена (routes/deals.ts) снимала риелтора по
  // `assignedAgentId: Deal.agentId` и уже не находила его. Передаётся сторона
  // продавца (intake); сделку передача объекта не переносит (то же решение
  // владельца, что и для клиентов: сделку не переносить, №208).
  const liveDeal = await db.deal.findFirst({
    where: { propertyId: property.id, stage: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { agentId: true },
  });
  const keepRealtor = liveDeal !== null && property.assignedAgentId !== null && property.assignedAgentId === liveDeal.agentId;

  const actorName =
    input.actorName ??
    (input.actorId
      ? ((await db.agent.findUnique({ where: { id: input.actorId }, select: { fullName: true } }))?.fullName ?? "Неизвестно")
      : "Система");

  // Смена хозяина, след в журнале и снятие чужой заявки на удаление — одной
  // транзакцией: объект у нового агента без записи «кто и почему передал» —
  // тот самый случай, который раньше нельзя было восстановить. Внутри чужой
  // транзакции (tx) те же три записи идут в ней последовательно.
  const writes = (t: Tx) => [
    t.property.update({
      where: { id: property.id },
      data: {
        intakeAgentId: input.toAgentId,
        ...(keepRealtor ? {} : { assignedAgentId: input.toAgentId }),
        handoverPendingSince: new Date(),
        handoverFromAgentId: fromAgentId,
        handoverReason: input.reason,
      },
    }),
    t.auditLog.create({
      data: {
        action: "PROPERTY_HANDOVER",
        entityType: "Property",
        entityId: property.id,
        agentId: input.actorId,
        agentName: actorName,
        meta: {
          fromAgentId,
          toAgentId: input.toAgentId,
          shortId: property.shortId,
          title: property.title,
          reason: input.reason,
          source: input.source,
          was: { intakeAgentId: property.intakeAgentId, assignedAgentId: property.assignedAgentId },
        },
      },
    }),
    // Открытая заявка прежнего хозяина на удаление объекта у нового хозяина не
    // имеет смысла и опасна: одобрение стёрло бы карточку из-под человека,
    // который о заявке не знает (класс «осиротевшие спутники», разведка 07.09.2026).
    t.propertyDeleteRequest.updateMany({
      where: { propertyId: property.id, status: "PENDING" },
      data: {
        status: "REJECTED",
        decidedById: null,
        decidedAt: new Date(),
        decisionNote: "Объект передан другому агенту — заявка снята автоматически",
      },
    }),
  ];
  if (input.tx) {
    for (const w of writes(input.tx)) await w;
  } else {
    await prisma.$transaction(writes(prisma));
  }

  publishPropertyUpdated({ propertyId: property.id, agentId: input.toAgentId, stage: property.status, actorId: input.actorId });

  if (input.notify ?? true) {
    void sendPushToAgent(input.toAgentId, {
      title: `🏠 Вам передан объект №${property.shortId}`,
      body: `${property.title}. ${input.reason} Откройте карточку и примите объект.`,
      url: `/properties/${property.id}`,
      tag: `property-handover-${property.id}`,
    }).catch(() => {});
  }

  return { changed: true, fromAgentId, shortId: property.shortId, title: property.title };
}

/**
 * Объекты продавца едут за ним: клиент-продавец сменил агента → его объекты,
 * которыми владел прежний агент (или ничьи), переходят новому. Зовётся из
 * единственной точки записи `changeClientAgent` (внутри её транзакции), поэтому
 * покрывает ВСЕ механизмы смены агента разом — раздачу дел, ручную передачу,
 * очередь, отказ, возврат из Корзины. Возвращает число переданных объектов.
 */
export async function transferSellerPropertiesWithClient(input: {
  clientId: string;
  fromAgentId: string | null;
  toAgentId: string;
  reason: string;
  actorId: string | null;
  actorName?: string;
  source: string;
  tx?: Tx;
}): Promise<number> {
  const db: Tx = input.tx ?? prisma;
  const candidates = await db.property.findMany({
    where: {
      sellerClientId: input.clientId,
      deletedAt: null,
      status: { notIn: [...CLOSED_PROPERTY_STATUSES] },
    },
    select: { id: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
  });
  let moved = 0;
  for (const p of candidates) {
    const owner = propertyOwnerAgentId(p);
    if (owner === input.toAgentId) continue;
    if (owner !== null && owner !== input.fromAgentId) continue;
    const result = await transferPropertyToAgent({
      propertyId: p.id,
      toAgentId: input.toAgentId,
      reason: `Продавец передан другому агенту — объект переходит вместе с ним. ${input.reason}`,
      actorId: input.actorId,
      actorName: input.actorName,
      source: input.source === "handover" ? "handover" : "manual",
      notify: false,
      tx: input.tx,
    });
    if (result.changed) moved++;
  }
  return moved;
}

export type AcceptPropertyHandoverOutcome = "accepted" | "not_pending" | "not_owner";

/** Новый хозяин прочитал причину и принял объект: отметка «передан вам» снимается. */
export async function acceptPropertyHandover(propertyId: string, agentId: string): Promise<AcceptPropertyHandoverOutcome> {
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
    select: { id: true, status: true, handoverPendingSince: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
  });
  if (!property.handoverPendingSince) return "not_pending";
  if (propertyOwnerAgentId(property) !== agentId) return "not_owner";
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { fullName: true } });
  await prisma.$transaction([
    prisma.property.update({ where: { id: property.id }, data: { handoverPendingSince: null } }),
    prisma.auditLog.create({
      data: {
        action: "PROPERTY_HANDOVER_ACCEPTED",
        entityType: "Property",
        entityId: property.id,
        agentId,
        agentName: agent?.fullName ?? "Неизвестно",
        meta: { pendingSince: property.handoverPendingSince.toISOString() },
      },
    }),
  ]);
  publishPropertyUpdated({ propertyId: property.id, agentId, stage: property.status, actorId: agentId });
  return "accepted";
}
