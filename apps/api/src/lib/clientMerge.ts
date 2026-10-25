import type { Client } from "../generated/prisma/client.js";
import { prisma, type TxClient } from "../db.js";
import { pickFreeExtraPhones } from "./clientPhones.js";
import { clientPhoneHash } from "./clientPhoneOrigins.js";
import { closeClientSatellites } from "./clientSatellites.js";
import { findAgentsWithPermission } from "./recipients.js";
import { closeLeadPushNotifications, sendPushToAgent } from "../push.js";
import { publishClientUpdated } from "./livePublish.js";
import { logSystemError } from "./systemError.js";
import { logTimeline } from "./timeline.js";

/**
 * ЯДРО СЛИЯНИЯ ДВУХ КАРТОЧЕК ОДНОГО ЧЕЛОВЕКА — вынесено из routes/clients/duplicates.ts
 * (POST /merge) 03.09.2026, чтобы им же мог воспользоваться раздел L (проверка дублей
 * при раздаче, lib/duplicateReview.ts): агент подтвердил «это мой клиент» — новая
 * карточка вливается в старую ТЕМ ЖЕ кодом, что и ручное слияние с кнопки, без второй
 * копии переноса хронологии/звонков/показов (feedback_fix_everywhere_not_one_place.md —
 * почини в одном месте, ищи все остальные, а не наоборот).
 *
 * НАМЕРЕННО БЕЗ проверки «это точно один и тот же человек» (совпадение телефона/Telegram
 * в POST /merge) — вызывающая сторона уже установила это своим собственным, отдельным
 * сигналом (ручное подтверждение агента в duplicateReview, точное совпадение в /merge) и
 * несёт ответственность за то, что вызывает функцию только когда уверена. Дублировать
 * проверку здесь значило бы привязать это ядро к ОДНОМУ конкретному сценарию уверенности.
 */
/**
 * Одна из карточек уже в Корзине (B2 глубокой проверки 02.10.2026). Склейка В
 * удалённую карточку уводила живую новую заявку в Корзину вслед за ней — свежий
 * лид пропадал из всех списков без агента и без следа; повторный клик по
 * /merge прогонял склейку второй раз. Роуты отвечают на это 409.
 */
export class ClientMergeTrashedError extends Error {
  constructor(which: "primary" | "duplicate") {
    super(
      which === "primary"
        ? "Основная карточка в Корзине — объединять с ней нельзя. Сначала восстановите её"
        : "Дубликат уже удалён — объединение уже выполнено или карточка в Корзине"
    );
    this.name = "ClientMergeTrashedError";
  }
}

/**
 * У карточки-дубля идёт сделка у ДРУГОГО агента, чем владелец основной карточки
 * (решение владельца 02.10.2026 «да, по советам», п. 5 по лидам). Склейка
 * перенесла бы сделку на чужую карточку: агент сделки потерял бы к ней доступ,
 * а владелец основной получил бы клиента с чужой сделкой. Склеивать можно,
 * когда сделка закроется или будет отменена. Роуты отвечают на это 409.
 */
export class ClientMergeOpenDealError extends Error {
  constructor(dealAgentName: string) {
    super(`У второй карточки идёт сделка у агента ${dealAgentName} — склеить можно, когда сделка закроется`);
    this.name = "ClientMergeOpenDealError";
  }
}

/** Открытая сделка — не завершена и не отменена (тот же признак, что у changeClientAgent). */
const OPEN_DEAL_STAGE_FILTER = { notIn: ["COMPLETED", "CANCELLED"] as ("COMPLETED" | "CANCELLED")[] };

export async function mergeClients(
  primaryId: string,
  duplicateId: string,
  actorAgentId: string,
  note: string
): Promise<Client> {
  const [primary, duplicate] = await Promise.all([
    prisma.client.findUnique({ where: { id: primaryId } }),
    prisma.client.findUnique({
      where: { id: duplicateId },
      include: { telegramConversation: true, botConversation: true },
    }),
  ]);
  if (!primary || !duplicate) throw new Error("Клиент не найден");
  if (primaryId === duplicateId) throw new Error("Нельзя объединить карточку саму с собой");
  if (primary.deletedAt) throw new ClientMergeTrashedError("primary");
  if (duplicate.deletedAt) throw new ClientMergeTrashedError("duplicate");

  const merged = await prisma.$transaction(async (tx) => {
    /**
     * ЗАХВАТ ДУБЛЯ ПЕРВЫМ ШАГОМ ТРАНЗАКЦИИ (B2, 02.10.2026). Условная запись
     * «удалить, только если ещё жив» — арбитр против двойного клика и
     * параллельной склейки: вторая транзакция ждёт блокировку строки и после
     * коммита первой видит 0 строк — ничего не переносит и не пишет. Основную
     * карточку там же перечитываем: её могли отправить в Корзину между чтением
     * выше и началом транзакции.
     */
    const claimed = await tx.client.updateMany({
      where: { id: duplicateId, deletedAt: null },
      data: { deletedAt: new Date(), deletedById: actorAgentId },
    });
    if (claimed.count === 0) throw new ClientMergeTrashedError("duplicate");
    // Serialize the current primary state with manual edits and phone writes.
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${primaryId} FOR UPDATE`;
    const primary = await tx.client.findFirst({ where: { id: primaryId, deletedAt: null } });
    if (!primary) throw new ClientMergeTrashedError("primary");
    const lockedIntent = primary;
    const primaryOrigins = await tx.clientPhoneOrigin.findMany({ where: { clientId: primaryId } });
    const duplicateOrigins = await tx.clientPhoneOrigin.findMany({ where: { clientId: duplicateId } });

    /**
     * ОТКРЫТАЯ СДЕЛКА ДУБЛЯ У ДРУГОГО АГЕНТА — НЕ СКЛЕИВАЕМ (решение владельца
     * 02.10.2026). Проверка внутри транзакции, после захвата дубля: отказ
     * откатывает и сам захват, карточки остаются как были. Владелец основной —
     * свежий, из той же транзакции (его могли сменить после чтения выше).
     */
    const foreignOpenDeal = await tx.deal.findFirst({
      where: {
        clientId: duplicateId,
        stage: OPEN_DEAL_STAGE_FILTER,
        ...(primary.assignedAgentId ? { agentId: { not: primary.assignedAgentId } } : {}),
      },
      select: { agent: { select: { fullName: true } } },
    });
    if (foreignOpenDeal) throw new ClientMergeOpenDealError(foreignOpenDeal.agent.fullName);
    await closeMergedSellerControls(tx, duplicateId, primaryId);

    /**
     * ОТКРЫТЫЕ ЗАДАЧИ ДУБЛЯ — ВЛАДЕЛЬЦУ ОСНОВНОЙ КАРТОЧКИ (B6, 02.10.2026). Задачи и
     * показы переезжают по clientId ниже, но исполнитель у них оставался прежним:
     * у агента дубля в календаре висели показ и напоминание по клиенту, которого
     * он больше не видит (клик — 403, просрочка — в его KPI), а владелец основной
     * карточки их не видел. Те же две половины, что у обычной передачи
     * (lib/ownershipSatellites.ts, transferOpenTasks): поставленные самим агентом
     * (agentId) и заведённые на него ботом/системой (subjectAgentId). Выполненные
     * остаются как были — это история. Основная без агента — задачи не трогаем.
     */
    const dupAgentId = duplicate.assignedAgentId;
    const primaryAgentId = primary.assignedAgentId;
    if (dupAgentId && primaryAgentId && dupAgentId !== primaryAgentId) {
      await tx.interaction.updateMany({
        where: { clientId: duplicateId, agentId: dupAgentId, nextActionDate: { not: null }, completedAt: null, taskCancelledAt: null },
        data: { agentId: primaryAgentId },
      });
      await tx.interaction.updateMany({
        where: { clientId: duplicateId, agentId: null, subjectAgentId: dupAgentId, nextActionDate: { not: null }, completedAt: null, taskCancelledAt: null },
        data: { subjectAgentId: primaryAgentId },
      });
    }
    await tx.interaction.updateMany({ where: { clientId: duplicateId }, data: { clientId: primaryId } });
    await tx.deal.updateMany({ where: { clientId: duplicateId }, data: { clientId: primaryId } });
    await tx.incomingCall.updateMany({ where: { clientId: duplicateId }, data: { clientId: primaryId } });
    await tx.voicemailMessage.updateMany({ where: { clientId: duplicateId }, data: { clientId: primaryId } });
    await tx.propertyExposure.updateMany({ where: { clientId: duplicateId }, data: { clientId: primaryId } });
    await tx.propertyShareLink.updateMany({ where: { clientId: duplicateId }, data: { clientId: primaryId } });
    await tx.callbackRequest.updateMany({ where: { clientId: duplicateId }, data: { clientId: primaryId } });
    await tx.cardSuggestion.updateMany({ where: { clientId: duplicateId }, data: { clientId: primaryId } });
    await moveRemainingClientLinks(tx, duplicateId, primaryId);
    if (duplicate.telegramConversation) {
      const primaryHas = await tx.telegramConversation.findUnique({ where: { clientId: primaryId } });
      await tx.telegramConversation.update({
        where: { id: duplicate.telegramConversation.id },
        data: { clientId: primaryHas ? null : primaryId },
      });
    }
    if (duplicate.botConversation.length > 0) {
      await tx.botConversation.updateMany({
        where: { id: { in: duplicate.botConversation.map((c) => c.id) } },
        data: { clientId: primaryId },
      });
    }
    if (duplicate.telegramChatId && !primary.telegramChatId) {
      await tx.client.update({ where: { id: duplicateId }, data: { telegramChatId: null } });
    }
    const phonesFromDuplicate = await pickFreeExtraPhones(
      [duplicate.phone, duplicate.whatsappPhone ?? "", ...(duplicate.extraPhones ?? [])].filter(Boolean),
      {
        clientId: primaryId,
        phone: primary.phone,
        whatsappPhone: primary.whatsappPhone,
        existing: primary.extraPhones ?? [],
        /**
         * НОМЕРА ДУБЛЯ — ЕГО ЖЕ, А НЕ ЧУЖИЕ (23.09.2026, проверка раздачи,
         * пункт 17). Дубль в этот момент ещё жив, и без этой строки его номера
         * считались «занятыми» им самим: к основной карточке не переезжало
         * ничего. Потом сообщение или звонок с этого номера находили только
         * карточку в Корзине, воскрешали её вторым лидом другому агенту, а
         * звонки к основной карточке не привязывались.
         */
        releasingClientIds: [duplicateId],
      }
    );

    /**
     * БЮДЖЕТ ПЕРЕЕЗЖАЕТ ТОЛЬКО ВМЕСТЕ С ВАЛЮТОЙ (аудит 04.10.2026, CRM-05). Сумма
     * в Client.budgetMin/Max читается в Client.currency основной карточки, поэтому
     * 500000 сомони из дубля, положенные в карточку в USD, становились полумиллионом
     * долларов. Валюты совпали: границы дополняют друг друга по-старому. Разошлись:
     * пустой бюджет основной заменяется бюджетом дубля вместе с его валютой, а
     * заполненный не трогаем и бюджет дубля не копируем (без пересчёта по курсу).
     */
    const sameCurrency = primary.currency === duplicate.currency;
    const primaryBudgetEmpty = primary.budgetMin == null && primary.budgetMax == null;
    const takeDuplicateBudget = sameCurrency || primaryBudgetEmpty;
    await tx.client.update({
      where: { id: primaryId },
      data: {
        ...(phonesFromDuplicate.length > 0
          ? { extraPhones: [...(primary.extraPhones ?? []), ...phonesFromDuplicate] }
          : {}),
        whatsappPhone: primary.whatsappPhone ?? duplicate.whatsappPhone,
        email: primary.email ?? duplicate.email,
        budgetMin: takeDuplicateBudget ? primary.budgetMin ?? duplicate.budgetMin : primary.budgetMin,
        budgetMax: takeDuplicateBudget ? primary.budgetMax ?? duplicate.budgetMax : primary.budgetMax,
        ...(!sameCurrency && primaryBudgetEmpty && (duplicate.budgetMin != null || duplicate.budgetMax != null)
          ? { currency: duplicate.currency }
          : {}),
        desiredDistrictId: primary.desiredDistrictId ?? duplicate.desiredDistrictId,
        desiredRooms: primary.desiredRooms ?? duplicate.desiredRooms,
        requirementsNotes: primary.requirementsNotes ?? duplicate.requirementsNotes,
        requestedPropertyId: primary.requestedPropertyId ?? duplicate.requestedPropertyId,
        telegramChatId: primary.telegramChatId ?? duplicate.telegramChatId,
        telegramUsername: primary.telegramUsername ?? duplicate.telegramUsername,
        createdAt: duplicate.createdAt < primary.createdAt ? duplicate.createdAt : primary.createdAt,
        /**
         * ВТОРАЯ РОЛЬ НЕ ТЕРЯЕТСЯ (№6 проверки объектов 02.10.2026). kind остаётся
         * основной карточки (от него зависит раздача и KPI), но продавец, влитый в
         * покупателя (или наоборот), — это человек с обеими сторонами: тот же
         * признак dualIntent, что ставит kindChangeUpdate при смене роли
         * (services/leads/intake.ts). Иначе встречный подбор и тревоги продавца
         * переставали видеть вторую сторону.
         */
        dualIntent: lockedIntent.dualIntentDecisionSource === "MANUAL" ? lockedIntent.dualIntent :
          primary.dualIntent ||
          duplicate.dualIntent ||
          (primary.kind === "BUYER" && duplicate.kind === "SELLER") ||
          (primary.kind === "SELLER" && duplicate.kind === "BUYER"),
      },
    });
    // The array update fires the future-addition trigger. Merge is not a new
    // observation: replace its placeholders with source history (or unknown).
    const existingOriginHashes = new Set(primaryOrigins.map(row => row.phoneHash));
    const sourceOrigins = new Map(duplicateOrigins.map(row => [row.phoneHash, row]));
    for (const phone of phonesFromDuplicate) {
      const hash = clientPhoneHash(phone);
      if (!existingOriginHashes.has(hash) && !sourceOrigins.has(hash)) {
        await tx.clientPhoneOrigin.deleteMany({ where: { clientId: primaryId, phoneHash: hash } });
      }
    }
    for (const origin of duplicateOrigins) {
      if (existingOriginHashes.has(origin.phoneHash)) continue; // Preserve both conflicting history rows, primary wins presentation.
      await tx.clientPhoneOrigin.deleteMany({ where: { clientId: primaryId, phoneHash: origin.phoneHash } });
      await tx.clientPhoneOrigin.update({ where: { id: origin.id }, data: { clientId: primaryId } });
    }
    await logTimeline({
      clientId: primaryId,
      actor: { kind: "agent", agentId: actorAgentId },
      type: "SYSTEM",
      notes: note,
      tx,
    });
    // Дубль уже помечен удалённым захватом в начале транзакции. Проверки дубля,
    // заведённые К нему, истекают сейчас — как при отправке в Корзину
    // (lib/trashClient.ts): «да, мой клиент» по ним теперь получил бы отказ.
    await tx.client.updateMany({
      where: { duplicateReviewOfClientId: duplicateId, deletedAt: null, duplicateReviewDueAt: { not: null } },
      data: { duplicateReviewDueAt: new Date() },
    });
    await tx.pendingSummary.updateMany({
      where: { subjectId: duplicateId, doneAt: null },
      data: { doneAt: new Date() },
    });
    return tx.client.findUnique({ where: { id: primaryId } });
  });

  if (!merged) throw new Error("Клиент не найден (гонка с удалением во время слияния)");

  /**
   * СПУТНИКИ ДУБЛЯ ГАСНУТ ЗДЕСЬ, А НЕ У КАЖДОГО ВЫЗЫВАЮЩЕГО (11.09.2026, второй
   * заход по осиротевшим спутникам). Раньше это делал только роут /merge
   * (routes/clients/duplicates.ts), и `lib/duplicateReview.ts::confirmDuplicateReview`
   * (агент подтвердил «это мой клиент», зовёт mergeClients напрямую) уходил в
   * Корзину БЕЗ гашения требований/просьб о звонке и БЕЗ закрытия заявки на
   * удаление — тот же класс бага, что и у trashClient до 07.09. Best-effort и
   * ПОСЛЕ коммита, как у trashClient/closeClientSatellites — ничего из этого не
   * должно уронить само слияние, которое уже необратимо.
   */
  await closeClientSatellites(duplicateId).catch((err) => {
    void logSystemError(
      "api",
      `Спутники дубликата не погашены при слиянии (${duplicateId}): ${err instanceof Error ? err.message : err}`
    );
  });
  await closePendingDeleteRequestsOnMerge(duplicateId, actorAgentId).catch((err) => {
    void logSystemError(
      "api",
      `Заявка на удаление дубликата не закрыта после слияния (${duplicateId}): ${err instanceof Error ? err.message : err}`
    );
  });

  /**
   * П-9/П-10 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §2, §4): если у
   * дубля был СВОЙ агент, переписка и история дубля переезжают к агенту
   * основной карточки без единой строки в аудите (`Client.assignedAgentId`
   * дубля не меняется — карточка просто уходит в Корзину, — но именно ЭТО и
   * есть неявная передача: держатель дубля молча теряет клиента). Запись
   * заводится на карточку-дубль (её видно из «Все мои» ушедшего держателя,
   * см. П-11), уведомление — обоим агентам.
   */
  if (duplicate.assignedAgentId && duplicate.assignedAgentId !== primary.assignedAgentId) {
    await recordMergeOwnershipChange({
      duplicateId,
      primaryShortId: merged.shortId,
      fromAgentId: duplicate.assignedAgentId,
      toAgentId: primary.assignedAgentId,
      actorAgentId,
    }).catch((err) => {
      void logSystemError(
        "api",
        `Запись о смене владельца при слиянии не записана (${duplicateId}): ${err instanceof Error ? err.message : err}`
      );
    });
  }

  publishClientUpdated({
    clientId: primaryId,
    agentIds: [primary.assignedAgentId, duplicate.assignedAgentId],
    actorId: actorAgentId,
  });

  return merged;
}

/**
 * ЗАЯВКА НА УДАЛЕНИЕ ДУБЛИКАТА ЗАКРЫВАЕТСЯ ВМЕСТЕ СО СЛИЯНИЕМ.
 *
 * Слияние удаляет карточку дубликата СВОИМ update (в обход lib/trashClient.ts —
 * слияние разрешено MANAGER, у которого нет properties.delete/clients.delete).
 * Без этого заявка агента («Ошиблись номером» / «Дубль») повисает в Архиве:
 * «Удалить в корзину» упирается в 404 (карточка уже удалена слиянием),
 * «Отклонить» соврала бы — агент просил удалить, и карточка удалена.
 */
async function closePendingDeleteRequestsOnMerge(clientId: string, actorAgentId: string): Promise<void> {
  const pending = await prisma.clientDeleteRequest.findMany({
    where: { clientId, status: "PENDING" },
    select: { id: true },
  });
  if (pending.length === 0) return;
  await prisma.clientDeleteRequest.updateMany({
    where: { id: { in: pending.map((r) => r.id) } },
    data: {
      status: "APPROVED",
      decidedById: actorAgentId,
      decidedAt: new Date(),
      decisionNote: "Карточка объединена с другой — как дубликат",
    },
  });
  const recipients = await findAgentsWithPermission("clients.delete");
  await closeLeadPushNotifications(
    pending.flatMap((r) => recipients.map((agentId) => ({ agentId, tag: `delete-request-${r.id}` })))
  );
}

/**
 * П-9/П-10: слияние двух карточек с РАЗНЫМИ агентами — неявная передача
 * (см. вызов выше). AuditLog.CLIENT_AGENT_CHANGE пишется на карточку-дубль
 * (её id никуда не переезжает, в отличие от истории), actorId = кто
 * подтвердил слияние. Оба агента получают уведомление: держатель дубля —
 * что клиент ушёл вместе с карточкой, держатель основной — что к его
 * карточке добавилась чужая переписка.
 */
async function recordMergeOwnershipChange(input: {
  duplicateId: string;
  primaryShortId: number;
  fromAgentId: string;
  toAgentId: string | null;
  actorAgentId: string;
}): Promise<void> {
  const actor = await prisma.agent.findUnique({ where: { id: input.actorAgentId }, select: { fullName: true } });
  await prisma.auditLog.create({
    data: {
      action: "CLIENT_AGENT_CHANGE",
      entityType: "Client",
      entityId: input.duplicateId,
      agentId: input.actorAgentId,
      agentName: actor?.fullName ?? "Неизвестно",
      meta: {
        source: "merge",
        from: input.fromAgentId,
        to: input.toAgentId,
        reason: "Карточка объединена как дубликат — история и переписка перешли к агенту основной карточки",
      },
    },
  });

  sendPushToAgent(input.fromAgentId, {
    title: "🔗 Клиент объединён с другой карточкой",
    body: "Ваша карточка оказалась дубликатом — история и переписка перешли к другому агенту",
  }).catch((err) => console.error("[push] уведомление держателю дубля после слияния:", err));

  if (input.toAgentId) {
    sendPushToAgent(input.toAgentId, {
      title: "🔗 К вашему клиенту добавили историю",
      body: `Клиент №${input.primaryShortId}: обнаружился дубликат у другого агента, история объединена`,
      url: `/clients/${input.primaryShortId}`,
    }).catch((err) => console.error("[push] уведомление держателю основной карточки после слияния:", err));
  }
}

/**
 * ВСЁ, ЧТО ЕЩЁ ССЫЛАЕТСЯ НА КАРТОЧКУ, ПЕРЕЕЗЖАЕТ К ОСНОВНОЙ (аудит 23.09.2026, №32).
 *
 * Слияние переносило восемь таблиц из двадцати с лишним. Объекты продавца
 * (`Property.sellerClientId`), бронь, досье, вопросы собственнику, опросы после
 * показа оставались у дубля, который тут же уходит в Корзину: у основной
 * карточки продавца «нет объекта», срабатывала тревога, бронь указывала на
 * удалённого. Полный список ссылок на `Client` сверяет тест
 * `client-merge-moves-every-link.test.ts` со схемой — новая таблица со ссылкой
 * на клиента не пройдёт проверку, пока её не впишут сюда или в
 * `MERGE_LINKS_LEFT_BEHIND` с причиной.
 */
export const MERGE_LINKS_MOVED = [
  // Unique-origin/report collisions remain on the soft-deleted duplicate as
  // immutable history; primary rows win. Cases retain original caseKey/epoch.
  "ClientPhoneOrigin.clientId", "InvestigationCase.clientId", "OwnerReportDelivery.sellerClientId",
  "Interaction.clientId",
  "Deal.clientId",
  "IncomingCall.clientId",
  "VoicemailMessage.clientId",
  "PropertyExposure.clientId",
  "PropertyShareLink.clientId",
  "CallbackRequest.clientId",
  "CardSuggestion.clientId",
  "TelegramConversation.clientId",
  "BotConversation.clientId",
  "Property.sellerClientId",
  "Property.reservedForClientId",
  "TelegramDirectConversation.clientId",
  "ContactProfile.clientId",
  "OwnerQuestion.clientId",
  "PropertyInterestEvent.clientId",
  "PostShowingCall.clientId",
  "ShowingSurveyCall.clientId",
  "SellerProbeCall.sellerClientId",
  "PropertyCountDispute.clientId",
  "ClientDesiredPlace.clientId",
  "InsightCase.clientId",
  "SmsMessage.clientId",
  "LiveVoiceSession.clientId",
  "DealReview.clientId",
  "CallWhisper.clientId",
  "SellerObjectFacts.clientId",
  "JobApplication.clientId",
  // Первое сообщение агента в WhatsApp (B9, 02.10.2026): без переноса ответ
  // клиента находил строку на удалённом дубле — ни ссылки на объект, ни пуша.
  "WhatsAppFirstContact.clientId",
] as const;

/** Ссылки, которые при слиянии намеренно остаются у дубля. */
export const MERGE_LINKS_LEFT_BEHIND: Record<string, string> = {
  "OwnerReportSubscription.sellerClientId": "согласие старой карточки не переносится: подписка отозвана, требуется новое подтверждение",
  "SellerControlEpisode.clientId": "эпизод старого назначения закрывается при слиянии; исходные факты и события сохраняются",
  "BuyerShowingCandidate.clientId": "кандидат старого назначения закрывается при слиянии; исходная реплика и история сохраняются",
  "SellerProbeCall.buyerClientId": "исторический покупатель нового источника проверки не переименовывается: слияние делает исходное назначение недействительным",
  "SellerIntakeAppointmentEvidence.clientId": "неизменяемый источник прежнего назначения; после слияния не используется как новая приёмка",
  "ClientWorkflowObservation.clientId": "неизменяемое наблюдение прежней карточки, не новое основание по назначению основной карточки",
  "ClientDeleteRequest.clientId": "заявка на удаление дубля закрывается отдельно (closePendingDeleteRequestsOnMerge)",
  "PushActionToken.clientId": "одноразовые токены кнопок в пуше: истекают сами, переносить нечего",
  "Client.duplicateReviewOfClientId": "проверка дублей ведёт свой цикл и сама гасит ссылку на удалённую карточку",
};

async function moveRemainingClientLinks(tx: TxClient, from: string, to: string): Promise<void> {
  const move = { where: { clientId: from }, data: { clientId: to } };
  await tx.property.updateMany({ where: { sellerClientId: from }, data: { sellerClientId: to } });
  await tx.ownerReportSubscription.updateMany({ where: { sellerClientId: from, active: true },
    data: { active: false, revokedAt: new Date(), revision: { increment: 1 } } });
  await tx.investigationCase.updateMany({ where: { clientId: from }, data: { clientId: to } });
  const occupiedReports = new Set((await tx.ownerReportDelivery.findMany({ where: { sellerClientId: to }, select: { propertyId: true, period: true } })).map(row => `${row.propertyId}:${row.period}`));
  for (const report of await tx.ownerReportDelivery.findMany({ where: { sellerClientId: from }, select: { id: true, propertyId: true, period: true } })) {
    if (!occupiedReports.has(`${report.propertyId}:${report.period}`)) {
      await tx.ownerReportDelivery.update({ where: { id: report.id }, data: { sellerClientId: to } });
    }
  }
  await tx.property.updateMany({ where: { reservedForClientId: from }, data: { reservedForClientId: to } });
  await tx.telegramDirectConversation.updateMany(move);
  await tx.contactProfile.updateMany(move);
  await tx.ownerQuestion.updateMany(move);
  await tx.propertyInterestEvent.updateMany(move);
  await tx.postShowingCall.updateMany(move);
  await tx.showingSurveyCall.updateMany(move);
  await tx.sellerProbeCall.updateMany({ where: { sellerClientId: from }, data: { sellerClientId: to } });
  await tx.propertyCountDispute.updateMany(move);
  await tx.clientDesiredPlace.updateMany(move);
  await tx.insightCase.updateMany(move);
  await tx.smsMessage.updateMany(move);
  await tx.liveVoiceSession.updateMany(move);
  await tx.jobApplication.updateMany(move);

  // Уникальные пары: переезжает только то, чего у основной карточки ещё нет.
  const primaryReviewDeals = (await tx.dealReview.findMany({ where: { clientId: to }, select: { dealId: true } })).map((r) => r.dealId);
  await tx.dealReview.updateMany({ where: { clientId: from, dealId: { notIn: primaryReviewDeals } }, data: { clientId: to } });
  const primaryWhispers = await tx.callWhisper.findMany({ where: { clientId: to }, select: { direction: true, language: true } });
  const taken = new Set(primaryWhispers.map((w) => `${w.direction}:${w.language}`));
  for (const w of await tx.callWhisper.findMany({ where: { clientId: from }, select: { id: true, direction: true, language: true } })) {
    if (!taken.has(`${w.direction}:${w.language}`)) await tx.callWhisper.update({ where: { id: w.id }, data: { clientId: to } });
  }
  const primaryFacts = await tx.sellerObjectFacts.findUnique({ where: { clientId: to }, select: { clientId: true } });
  if (!primaryFacts) await tx.sellerObjectFacts.updateMany(move);
  await tx.whatsAppFirstContact.updateMany(move);
}

/** Cancel before open-task reassignment so historical assignees stay intact. */
async function closeMergedSellerControls(tx: TxClient, from: string, to: string) {
  for (const candidate of await tx.buyerShowingCandidate.findMany({ where: { clientId: from, status: { notIn: ["RESOLVED", "CANCELLED"] } } })) {
    await tx.buyerShowingCandidate.update({ where: { id: candidate.id }, data: { status: "CANCELLED", revision: { increment: 1 } } });
    if (candidate.taskId) await tx.interaction.updateMany({ where: { id: candidate.taskId, completedAt: null, taskCancelledAt: null }, data: { taskCancelledAt: new Date() } });
  }
  for (const episode of await tx.sellerControlEpisode.findMany({ where: { clientId: from, resolvedAt: null } })) {
    await tx.sellerControlEpisode.update({ where: { id: episode.id }, data: { status: "CANCELLED", resolvedAt: new Date(), revision: { increment: 1 } } });
    await tx.sellerControlEvent.create({ data: { episodeId: episode.id, requestKey: `merge:${from}:${episode.id}`,
      type: "MERGED", payload: { previousClientId: from, primaryClientId: to } } });
    const taskIds = [episode.agentTaskId, episode.ropTaskId].filter((id): id is string => !!id);
    if (taskIds.length) await tx.interaction.updateMany({ where: { id: { in: taskIds }, completedAt: null, taskCancelledAt: null }, data: { taskCancelledAt: new Date() } });
  }
}
