import { investigationViewerRole } from "../../auth/investigations.js";
import { visibleInteractionWhere } from "../../lib/investigationPrivacy.js";
/**
 * Карточка клиента: GET /:id, POST /, PATCH /:id, DELETE /:id, restore,
 * permanent (Г2, §1.2). Перенос verbatim.
 */
import { Router, type Request } from "express";
import {
  clientCreateSchema,
  clientUpdateSchema,
  clientDisplayName,
  CLIENT_KIND_LABELS,
  CLIENT_STATUS_LABELS,
  isClientCardFilled,
  INTERACTION_TYPES,
  SALES_AGENT_ROLES,
} from "@royal-home/shared";
import { z } from "zod";
import { prisma } from "../../db.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { can, canAccessAssignedAgent, requireAuth, requirePermission, scopeDealsToOwnAgent, scopeToOwnAgent } from "../../auth/middleware.js";
import { serializeDealMoney, seesDealMoney } from "../deals.js";
import { assignAgentForLead, recordAssignReason, type LeadAssignment } from "../../leads.js";
import { sendLeadPush } from "../../lib/pushLeadActions.js";
import { sendPushToAgent, sendPushToAgents } from "../../push.js";
import { logTimeline } from "../../lib/timeline.js";
import { loadEventPoints, recordScoreEvent } from "../../lib/scoreJournal.js";
import { notifySiteLeadStatus } from "../../lib/notifySite.js";
import { logAudit } from "../../lib/audit.js";
import { cancelClientCallbackRequests } from "../../lib/callbackRequests.js";
import { trashClient } from "../../lib/trashClient.js";
import { changeClientAgent } from "../../lib/changeClientAgent.js";
import { findAgentsWithPermission } from "../../lib/recipients.js";
import { publishClientUpdated } from "../../lib/livePublish.js";
import { logSystemError } from "../../lib/systemError.js";
import { loadMoneyContext } from "../../lib/money.js";
import { loadMatchWeights, scoreClientProperty } from "../matching.js";
import { refreshPropertiesOfSeller } from "../../lib/propertyAutoStatus.js";
import { cardWhereFromParam } from "../../lib/cardIdParam.js";
import { conductedShowingWhere } from "../../lib/conductedShowing.js";
import { loadSellerPropertyAddress } from "../../lib/sellerPropertyAnchor.js";
import { presentMessages, type PresentedMessage } from "../../lib/messageAttachments.js";
import type { MessageSender } from "@royal-home/shared";
import { presentInteractions, transcriptAccess } from "../../lib/callTranscripts.js";
import { incomingInteractionIds } from "../../lib/telephony/incomingInteractions.js";
import { firstCallStatus } from "../../leads.js";
import { SELF_CREATED_ASSIGN_REASON } from "../../services/leads/firstCall.js";
import { checkManualAssignTarget } from "../../lib/manualAssignTarget.js";
import { CLIENT_PHONE_MASK_CHAR } from "@royal-home/shared";
import { computeHiddenReason, foreignWriteDenied, normalizePhone, phoneOwnershipError, presentClient, restoreMaskedNotes } from "./shared.js";
import { findFuzzyDuplicateCandidate } from "../../lib/duplicateReview.js";
import { phoneTail } from "../../lib/clientPhones.js";
import { clientPhoneSelectionTokens } from "../../lib/clientPhoneSelection.js";
import { presentExtraPhoneOrigins } from "../../lib/clientPhoneOrigins.js";
import { clientNamePhoneSafe } from "../../lib/clientPhone.js";
import { findStaffPhone, staffPhoneError, STAFF_PHONE_ERROR_CODE } from "../../lib/staffPhoneGuard.js";
import { interactionPropertySelect } from "../../lib/interactionPropertySelect.js";
import { loadLeadReasons } from "../../lib/leadReason.js";
import { followSellerPhoneChange } from "../../lib/propertyOwnerRelink.js";
import { listDealDocumentFileNames } from "../../lib/dealDocumentsDb.js";
import { removeClientAvatarFile } from "../../lib/clientAvatar.js";
import { deleteDealDocumentFile } from "../../lib/dealDocumentFiles.js";
import { loadClientCardActivity } from "../../lib/clientCardActivity.js";
import { phoneSafeText } from "../../lib/clientPhone.js";

export const cardRouter = Router();

/**
 * Номер сотрудника среди присланных (главный + запасные) — одна точка для
 * создания и правки карточки (см. lib/staffPhoneGuard.ts). `whatsappPhone`
 * сюда не входит: этот роут его не принимает вовсе (проставляется только
 * автоматически из wa_id, см. services/leads/intake.ts).
 */
async function staffPhoneGuardError(
  data: { phone?: string; extraPhones?: string[] },
  existing?: { phone: string; extraPhones: string[] }
): Promise<string | null> {
  // Номера, которые у карточки УЖЕ есть, не проверяем: форма редактирования шлёт
  // phone/extraPhones целиком даже без правки, и старые карточки с номером
  // сотрудника (заведённые до защиты — №38/№233 на проде) иначе нельзя было бы
  // даже переименовать. Ловим только НОВЫЕ для карточки номера.
  const known = new Set([existing?.phone, ...(existing?.extraPhones ?? [])].filter(Boolean).map((p) => phoneTail(p!)));
  const candidates = [data.phone, ...(data.extraPhones ?? [])].filter((p) => p && !known.has(phoneTail(p)));
  const match = await findStaffPhone(candidates);
  return match ? staffPhoneError(match) : null;
}

/** Ответ GET /:id агенту, у которого клиента забрали (см. loadTransferAccess). */
interface TransferAccess {
  readOnly: true;
  transferredTo: { id: string; fullName: string } | null;
  transferredAt: Date;
  reason: string | null;
}

/**
 * Причина и новый владелец берутся из AuditLog (`CLIENT_AGENT_CHANGE`, пишет
 * ТОЛЬКО lib/changeClientAgent.ts — единый вход, см. его шапку) — последняя
 * запись, где `fromAgentId` совпадает с текущим агентом: это и есть момент,
 * когда клиента у него забрали. Текст причины — как передал changeClientAgent
 * (`reason`, без служебного префикса `[source]`, он для журнала, не для агента).
 */
async function loadTransferAccess(clientId: string, fromAgentId: string): Promise<TransferAccess> {
  const entry = await prisma.auditLog.findFirst({
    where: {
      entityType: "Client",
      entityId: clientId,
      action: "CLIENT_AGENT_CHANGE",
      meta: { path: ["fromAgentId"], equals: fromAgentId },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, meta: true },
  });
  const meta = (entry?.meta ?? null) as { reason?: string; toAgentId?: string | null } | null;
  const toAgentId = meta?.toAgentId ?? null;
  const toAgent = toAgentId
    ? await prisma.agent.findUnique({ where: { id: toAgentId }, select: { id: true, fullName: true } })
    : null;
  return {
    readOnly: true,
    transferredTo: toAgent,
    transferredAt: entry?.createdAt ?? new Date(),
    reason: meta?.reason ?? null,
  };
}

/** Сколько записей хронологии приходит вместе с карточкой; остальные — по
 *  кнопке «Показать более ранние» через GET /:id/timeline. */
const CARD_TIMELINE_LIMIT = 200;

/**
 * Поля записи хронологии — одни на карточку и на догрузку старых записей
 * (GET /:id/timeline), чтобы догруженная строка выглядела так же, как верхняя.
 *
 * SELECT, А НЕ INCLUDE (26.08.2026): include тянул ВСЕ скаляры, включая
 * transcript и transcriptRu — полные тексты разговоров, до десятков КБ
 * каждый. 200 записей × 2 текста = мегабайты из БД и в JSON при КАЖДОМ
 * открытии карточки (а сотруднику без права их тут же вырезал
 * presentInteractions — то есть тяжёлые поля поднимались и выбрасывались).
 * Сам текст хронология и так показывает только по клику «Послушать и
 * прочитать разговор» — теперь он грузится ровно в этот момент, отдельным
 * запросом GET /interactions/:id/transcript.
 *
 * property — interactionPropertySelect (lib/interactionPropertySelect.ts):
 * id/shortId/title плюс цена и превью фото (17.09.2026, план раздел 6) —
 * мини-карточка объекта в хронологии, а не голый текст. «Завершить сделку
 * → Успешно» (CloseDealChoiceModal) собирает по показам список объектов из
 * тех же id. Разбор разговора (callAnalysis) остаётся одним join'ом — он
 * на порядки легче расшифровки, а его счёт виден ещё до раскрытия записи.
 */
const TIMELINE_INTERACTION_SELECT = {
  investigationOnly: true,
  id: true,
  clientId: true,
  agentId: true,
  type: true,
  propertyId: true,
  notes: true,
  outcome: true,
  outcomeSource: true,
  nextAction: true,
  nextActionDate: true,
  completedAt: true,
  taskCancelledAt: true,
  confirmAskedAt: true,
  confirmedAt: true,
  declinedAt: true,
  recordingUrl: true,
  recordingDurationSec: true,
  transcriptionStage: true,
  transcriptionProgress: true,
  voiceNoteUrl: true,
  voiceNoteTranscript: true,
  createdAt: true,
  actorKind: true,
  agent: { select: { fullName: true } },
  // Держатель задачи, когда актор не человек (П-10, 17.09.2026) —
  // InteractionTimeline.tsx показывает его в заголовке строки: «Система
  // · для Иванова», без раскрытия записи.
  subjectAgent: { select: { fullName: true } },
  property: { select: interactionPropertySelect },
  callAnalysis: {
    select: {
      score: true,
      greeted: true,
      foundNeed: true,
      presentedValue: true,
      handledObjection: true,
      agreedNextStep: true,
      objections: true,
      agreements: true,
      summary: true,
      summaryTj: true,
      coaching: true,
    },
  },
} satisfies Prisma.InteractionSelect;

/**
 * Хронология в том виде, в каком её видит смотрящий: запись, расшифровка и
 * разбор — по правилу lib/callTranscripts.ts. Одна функция на карточку и на
 * догрузку, иначе догруженный разговор мог бы открыться тому, кому в карточке
 * он закрыт.
 */
async function presentTimeline(
  req: Request,
  assignedAgentId: string | null,
  rows: Prisma.InteractionGetPayload<{ select: typeof TIMELINE_INTERACTION_SELECT }>[]
) {
  /**
   * Входящие, принятые оператором по очереди, — тоже «свои» для ответственного
   * агента (найдено 16.08.2026: CRM зовёт его в карточку пушем «Ваш клиент звонил
   * в офис», а правило «свой = я автор записи» держало запись под замком — см.
   * шапку lib/callTranscripts.ts). Считаем только когда карточка закреплена именно
   * за смотрящим: чужому агенту это доступа не добавляет.
   */
  const routedIncomingIds =
    req.agent && assignedAgentId === req.agent.id ? await incomingInteractionIds(rows.map((i) => i.id)) : undefined;

  // «Расшифровка есть» — лёгкой выборкой одних id: сам текст в хронологию больше
  // не поднимается (см. select выше), а признак hasTranscript нужен интерфейсу,
  // чтобы показать кнопку «Послушать и прочитать разговор».
  const transcriptIds = new Set(
    (
      await prisma.interaction.findMany({
        where: { id: { in: rows.map((i) => i.id) }, transcript: { not: null } },
        select: { id: true },
      })
    ).map((i) => i.id)
  );
  return presentInteractions(rows, transcriptAccess(req.agent), routedIncomingIds, transcriptIds);
}

/** Публичный идентификатор в URL — короткий числовой shortId, а не внутренний UUID.
 * Все остальные роуты (:id/accept, PATCH, /interactions, /match) по-прежнему принимают
 * настоящий id: фронтенд запрашивает их с уже загруженной карточки (client.id), не из
 * адресной строки, так что путать эти два идентификатора негде. */
cardRouter.get("/:id", requireAuth, async (req, res) => {
  const cardWhere = cardWhereFromParam(String(req.params.id));
  if (!cardWhere) return res.status(404).json({ error: "Клиент не найден" });
  const ownAgentId = scopeToOwnAgent(req);
  const client = await prisma.client.findUnique({
    where: cardWhere,
    include: {
      desiredDistrict: true,
      // Несколько желаемых мест поиска (12.09.2026, docs/geo-match-plan-12-09.md) —
      // блок «Где ищет» в карточке. По возрастанию createdAt: место, добавленное
      // первым, стоит первым в списке, а не в порядке, каким его вернула база.
      desiredPlaces: { orderBy: { createdAt: "asc" } },
      assignedAgent: { select: { id: true, fullName: true, avatarUrl: true } },
      // Предел выборки обязателен по стандарту проекта. Хронология росла без
      // границы: у клиента, которого ведут полгода, карточка тянула сотни записей
      // при каждом открытии, хотя дальше первых экранов их никто не листает.
      // Сортировка от новых к старым уже стояла — берём верхушку.
      interactions: {
        where: visibleInteractionWhere(investigationViewerRole(req)),
        // id — вторым ключом: «Показать более ранние» (GET /:id/timeline) идёт
        // курсором (createdAt, id) от последней записи, и порядок обязан быть
        // однозначным даже у записей с одинаковым временем.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: CARD_TIMELINE_LIMIT,
        // Поля и почему select, а не include, — у TIMELINE_INTERACTION_SELECT выше.
        select: TIMELINE_INTERACTION_SELECT,
      },
      deals: { include: { property: { select: { title: true } } } },
      // Сколько записей в хронологии ВСЕГО (02.10.2026): список выше режется на
      // 200, и экран писал «Показаны 25 из 200», будто двести — это всё.
      _count: { select: { interactions: { where: visibleInteractionWhere(investigationViewerRole(req)) } } },
      // Диалог клиента: у каналов Meta — botConversation, у Telegram своя
      // таблица. Обе отдаём одинаково, чтобы карточка не делила клиентов на сорта:
      // переписка, пауза бота и отправка сообщения работают в любом канале.
      // botConversation — МАССИВ (19.08.2026): у клиента может быть несколько
      // диалогов бот-платформы одновременно (написал в Instagram, потом попросили
      // написать в WhatsApp) — карточка показывает их все, не только последний.
      botConversation: {
        select: { id: true, pausedUntil: true, channel: true, messages: true, lastMessageAt: true },
        orderBy: { lastMessageAt: "desc" },
      },
      // id нужен фронту, чтобы кнопка «Написать» на телефоне вела в конкретный
      // диалог (`/messages?open=tg_<id>`, TG_PREFIX из routes/conversations.ts),
      // а не открывала плавающую панель поверх карточки (владелец 15.09.2026).
      telegramConversation: { select: { id: true, pausedUntil: true, messages: true } },
      telegramDirectConversations: {
        select: { id: true, pausedUntil: true, messages: true, lastMessageAt: true },
        orderBy: { lastMessageAt: "desc" },
      },
    },
  });
  if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });
  // Пачка 16 (11.09.2026, docs/archive/agent-briefs/ownership-security-11-09.md): агент,
  // у которого клиента забрали (lastAgentId — тот же самый), не должен получать
  // 403 «Недостаточно прав» — карточка у него уже открыта в списках/пуше, а
  // ссылка на нового владельца нужна, чтобы объяснить, что произошло. Доступ
  // read-only, без переписки и требований дальше по коду не режется — режется
  // только на фронте (кнопки скрыты) и на мутациях (foreignWriteDenied).
  let transferAccess: TransferAccess | null = null;
  if (ownAgentId && client.assignedAgentId !== ownAgentId) {
    // Клиент закреплён за другим агентом, но у текущего может быть сделка с ним
    // (например, её так назначил админ) — тогда карточку видеть можно, иначе
    // невозможно работать по собственной же сделке.
    const hasDeal = client.deals.some((d) => d.agentId === ownAgentId);
    const wasMine = client.lastAgentId === ownAgentId;
    if (!hasDeal && !wasMine) return res.status(403).json({ error: "Недостаточно прав" });
    if (!hasDeal && wasMine) {
      transferAccess = await loadTransferAccess(client.id, ownAgentId);
    }
  }
  // ОТКРЫЛ КАРТОЧКУ = ПРОЧИТАЛ ПЕРЕПИСКУ (владелец 31.08.2026: красный
  // индикатор в списке своих клиентов должен гаснуть, как в вотсапе). Только
  // когда карточку открывает СВОЙ агент — admin/director, заглянувший в чужую
  // карточку, не должен тушить чужой непрочитанный. Дожидаемся записи — как и
  // firstOpenedAt ниже: без await список клиентов, запрошенный сразу следом
  // (в т.ч. фронтом при возврате назад), иногда увидел бы ещё не сброшенный
  // индикатор. Сбой записи не должен ронять открытие карточки.
  if (ownAgentId && client.assignedAgentId === ownAgentId && client.acceptedAt) {
    await Promise.all([
      prisma.botConversation.updateMany({ where: { clientId: client.id }, data: { readAt: new Date() } }).catch(() => {}),
      prisma.telegramConversation.updateMany({ where: { clientId: client.id }, data: { readAt: new Date() } }).catch(() => {}),
      prisma.telegramDirectConversation.updateMany({ where: { clientId: client.id }, data: { readAt: new Date() } }).catch(() => {}),
    ]);
  }
  // АВТОФИКСАЦИЯ ВРЕМЁН (Royal Score): первое открытие карточки — факт, который
  // не переписывается. Не роняет запрос при сбое записи — объяснение счёта важнее
  // самого счёта, но не важнее того, что агент вообще видит карточку. Дожидаемся
  // записи (не fire-and-forget: было `void`, из-за чего сразу следом идущее чтение —
  // например, в тестах — иногда видело ещё не записанное значение).
  if (!client.firstOpenedAt) {
    try {
      await prisma.client.updateMany({ where: { id: client.id, firstOpenedAt: null }, data: { firstOpenedAt: new Date() } });
    } catch (err) {
      console.error("[clients] firstOpenedAt не записан:", err instanceof Error ? err.message : err);
    }
  }
  // Переписка отдаётся не «как лежит в jsonb»: у реплик клиента могут быть вложения,
  // а имя файла получают только те, кому владелец разрешил их открывать. Агент видит
  // тот же текст, что и раньше, и пометку вместо фото (см. lib/messageAttachments.ts).
  const attachmentsAllowed = can(req, "messages.viewAttachments");
  // Клиент диктует свой номер прямо в переписке чаще, чем можно подумать — без
  // этого право `clients.viewPhone` пробивалось бы первой же такой репликой.
  const phonesAllowed = can(req, "clients.viewPhone");

  // ЯВНОЕ ПРЕДЛОЖЕНИЕ «ПОЛУЧИТЬ КАК 7-ГО КЛИЕНТА» (Путь покупателя, п.5.2):
  // процент совпадения не хранится на клиенте (только текстом в хронологии,
  // см. leads.ts::recordAssignReason) — считаем заново по текущим весам из
  // Настроек, так показанный процент никогда не разойдётся с тем, что реально
  // определяет распределение. Только для непринятых лидов — карточка после
  // приёма это уже не показывает.
  let matchScore: number | null = null;
  if (!client.acceptedAt && client.assignReason === "own_property_match" && client.matchedPropertyId) {
    const matchedProperty = await prisma.property.findUnique({
      where: { id: client.matchedPropertyId },
      select: { id: true, price: true, currency: true, districtId: true, rooms: true },
    });
    if (matchedProperty) {
      const [money, weights] = await Promise.all([loadMoneyContext(), loadMatchWeights()]);
      // includeHotBonus: false — тем же приёмом, что pickByPropertyMatch (leads.ts)
      // считает балл при распределении. Без этого HOT-клиенту показанный процент
      // был бы выше числа, которое реально сравнивалось с порогом в Настройках.
      matchScore = scoreClientProperty(client, matchedProperty, money, { weights, includeHotBonus: false }).score;
    }
  }

  /**
   * СРОК И СТАТУС ПЕРВОГО ЗВОНКА (задание 17.09.2026, «клиент теряется, если
   * вовремя не позвонить»): та же функция, что кормит крон снятия лида
   * (services/leads/firstCall.ts::firstCallStatus, переиспользует
   * collectFirstCallFacts/decideFirstCall, своей копии правил здесь нет).
   * Только для принятых карточек, не для «Прочих обращений» — они правилу
   * первого звонка не подчиняются вовсе (firstCall.ts).
   */
  let firstCallDueAt: Date | null = null;
  let firstCallDone: boolean | null = null;
  if (client.acceptedAt && client.kind !== "OTHER") {
    const callSettings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        leadCallMinutes: true,
        leadCallMinSeconds: true,
        asteriskAriUrl: true,
        asteriskAriUsername: true,
        asteriskAriPassword: true,
      },
    });
    const status = (
      await firstCallStatus(
        [{ id: client.id, assignedAgentId: client.assignedAgentId, acceptedAt: client.acceptedAt }],
        callSettings ?? {
          leadCallMinutes: null,
          leadCallMinSeconds: null,
          asteriskAriUrl: null,
          asteriskAriUsername: null,
          asteriskAriPassword: null,
        }
      )
    ).get(client.id);
    firstCallDueAt = status?.dueAt ?? null;
    firstCallDone = status?.done ?? null;
  }

  // «Почему лид ваш» — та же строка, что в списке и окне приёма (lib/leadReason.ts).
  const leadReason = client.acceptedAt ? null : ((await loadLeadReasons([client])).get(client.id) ?? null);

  /**
   * СДЕЛКИ КЛИЕНТА — ПО ТОМУ ЖЕ ПРАВИЛУ, ЧТО СПИСОК СДЕЛОК (ночная проверка
   * 24.09.2026, находка №122). Раньше карточка отдавала `client.deals` как
   * лежит в базе: бывший владелец клиента (доступ read-only через hasDeal/
   * wasMine выше) или агент со своей единственной сделкой видел ЧУЖИЕ сделки
   * этого же клиента целиком — деньги и чужого агента, хотя на экране
   * «Сделки» (routes/deals.ts) те же самые сделки для него закрыты.
   *
   * scopeDealsToOwnAgent — то же право (deals.viewAll), что режет список
   * сделок, а не clients.viewAll: у карточки своя видимость клиента и своя
   * видимость его сделок, это разные права. serializeDealMoney/seesDealMoney
   * — та же функция, что и там (routes/deals.ts), чтобы не заводить второе
   * правило маскировки денег.
   */
  const dealsOwnAgentId = scopeDealsToOwnAgent(req);
  const visibleDeals = dealsOwnAgentId ? client.deals.filter((d) => d.agentId === dealsOwnAgentId) : client.deals;
  const scopedDeals = visibleDeals.map((d) => serializeDealMoney(d, seesDealMoney(req, d)));

  /**
   * ФАКТЫ ИСТОРИИ — ПО ПОЛНОЙ ТАБЛИЦЕ, А НЕ ПО 200 ЗАПИСЯМ КАРТОЧКИ (аудит
   * 04.10.2026, WEB-PAGES21). Список `interactions` выше режется на
   * CARD_TIMELINE_LIMIT, а экран выводил из него «был проведённый показ» (кнопки
   * «Завершить сделку» и «Передать»), «был настоящий разговор» и счёт звонков: после
   * 200 свежих служебных записей старый показ «исчезал», и кнопки прятались, хотя
   * сервер проверяет полный список. Критерий «проведён» — тот же, что у серверного
   * гейта (lib/conductedShowing.ts); порог разговора — leadCallMinSeconds.
   */
  const [conductedShowing, callsCount, realCalls] = await Promise.all([
    prisma.interaction.count({ where: { ...conductedShowingWhere(client.id), ...visibleInteractionWhere(investigationViewerRole(req)) } }).then((count) => count > 0),
    prisma.interaction.count({ where: { clientId: client.id, type: "CALL", ...visibleInteractionWhere(investigationViewerRole(req)) } }),
    prisma.settings
      .findUnique({ where: { id: "singleton" }, select: { leadCallMinSeconds: true } })
      .then((s) =>
        prisma.interaction.count({
          where: {
            clientId: client.id,
            type: "CALL",
            ...visibleInteractionWhere(investigationViewerRole(req)),
            recordingDurationSec: { gte: s?.leadCallMinSeconds ?? 30 },
          },
        })
      ),
  ]);

  const withMessages = {
    ...client,
    hadConductedShowing: conductedShowing,
    callsCount,
    hadRealCall: realCalls > 0,
    matchScore,
    leadReason,
    firstCallDueAt,
    firstCallDone,
    deals: scopedDeals,
    /**
     * Расшифровка, запись и разбор — по правилу из lib/callTranscripts.ts: свой
     * разговор агент слушает и читает (владелец 15.08.2026), чужой закрыт правом
     * calls.transcripts. Признак `hasRecording` остаётся всем: по нему в хронологии
     * видно, что разговор записан, — без этого он казался бы пропавшим бесследно.
     */
    interactions: await presentTimeline(req, client.assignedAgentId, client.interactions),
    interactionsTotal: client._count.interactions,
    // Служебный счётчик Prisma наружу не отдаём — число уже лежит в interactionsTotal.
    _count: undefined,
    botConversation: client.botConversation.map((c) => ({
      ...c,
      messages: presentMessages(c.messages, attachmentsAllowed, phonesAllowed),
    })),
    telegramConversation: client.telegramConversation && {
      ...client.telegramConversation,
      messages: presentMessages(client.telegramConversation.messages, attachmentsAllowed, phonesAllowed),
    },
    telegramDirectConversations: client.telegramDirectConversations.map((c) => ({
      ...c,
      channel: "TELEGRAM_DIRECT",
      canReply: false,
      messages: presentMessages(c.messages, attachmentsAllowed, phonesAllowed),
    })),
  };

  /**
   * ДО ПРИЁМА ЛИДА — ТОЛЬКО ИМЯ, БЕЗ ТРЕБОВАНИЙ И ПЕРЕПИСКИ (владелец 20.08.2026).
   *
   * Живой случай: агенту пришёл лид, он открыл карточку ДО принятия, увидел
   * маленький бюджет и отклонил объект — хотя принимать решение по клиенту,
   * которого формально ещё не взял, права не имел. Кнопка «Принять» уже стоит
   * первым делом в интерфейсе, но информацию, которая на неё влияет, ничто не
   * прятало — можно было решить и отказаться, так и не нажав «Принять».
   *
   * Только для СВОЕГО непринятого лида — не для руководителя, который открыл
   * ту же карточку до чьего-то приёма (`ownAgentId` пуст без scopeToOwnAgent,
   * см. auth/middleware.ts), и не для агента, который смотрит по своей сделке
   * чужого клиента (эта ветка выше уже требует `hasDeal`, там `acceptedAt`
   * обычно не пуст, а если пуст — сделки без принятия лида не бывает).
   */
  const gateUntilAccepted = !!ownAgentId && ownAgentId === client.assignedAgentId && !client.acceptedAt;
  const responseClient = gateUntilAccepted
    ? {
        ...withMessages,
        budgetMin: null,
        budgetMax: null,
        requirementsNotes: null,
        desiredDistrictId: null,
        desiredDistrict: null,
        desiredRooms: null,
        desiredType: null,
        // Сводка ИИ — пересказ той самой переписки и хронологии, которые ниже
        // закрыты: оставить её значило бы отдать закрытое содержимое коротким
        // текстом. Скоринг (aiScore) при этом остаётся: как и matchScore, он
        // помогает решить, принимать ли, и ничего о клиенте не рассказывает.
        aiInsight: null,
        aiInsightAt: null,
        // matchScore НЕ прячем — это не требование клиента, а «совпадает ли он с
        // ВАШИМ объектом», показывается прямо на кнопке «Принять» (Путь покупателя,
        // п.5.1-5.2) и специально помогает решить, стоит ли принимать, а не наоборот.
        interactions: [],
        interactionsTotal: 0,
        // История закрыта целиком — факты о ней не раскрываем.
        hadConductedShowing: false,
        callsCount: 0,
        hadRealCall: false,
        deals: [],
        botConversation: [],
        telegramConversation: null,
        telegramDirectConversations: [],
      }
    : withMessages;

  // canSeePhone форсированно снят тем же гейтом, что выше собрал responseClient:
  // право `clients.viewPhone` у агента почти всегда есть, но контакты (и
  // e-mail — presentClient закрывает его заодно при canSeePhone=false, см.
  // shared.ts:137) до приёма лида не его дело, а не вопрос права.
  // Отображаемое имя шапки («Джахонгир · Маяковский», владелец 21.09.2026) — тот
  // же расчёт, что в списке клиентов (routes/clients/list.ts), плюс адрес объекта
  // продавца одним точечным запросом (тут один клиент, а не страница — батч не нужен).
  const sellerPropertyAddress =
    client.kind === "SELLER" ? await loadSellerPropertyAddress(client.id) : null;
  const presentedClient = presentClient(
    responseClient,
    can(req, "clients.viewPhone") && !gateUntilAccepted,
    can(req, "clients.viewOrigin"), investigationViewerRole(req)
  );
  const activity = gateUntilAccepted ? { propertyActivitySummary: null, nextStep: null } : await loadClientCardActivity(client.id, investigationViewerRole(req));
  const payload = {
    ...presentedClient,
    phoneSelectionTokens: gateUntilAccepted ? {} : clientPhoneSelectionTokens(client),
    extraPhoneOrigins: gateUntilAccepted ? [] : presentExtraPhoneOrigins(client.extraPhones,
      await prisma.clientPhoneOrigin.findMany({ where: { clientId: client.id }, select: { phoneHash: true, addedAt: true, source: true } }), can(req, "clients.viewOrigin")),
    ...activity,
    nextStep: activity.nextStep ? { ...activity.nextStep,
      nextAction: phoneSafeText(activity.nextStep.nextAction, can(req, "clients.viewPhone")),
    } : null,
    // Из УЖЕ показанной карточки, а не из сырой: иначе «Входящий +992…» и источник
    // клиента уходили в displayName мимо clients.viewPhone/viewOrigin (ACCESS-01).
    displayName: clientDisplayName(presentedClient, { propertyAddress: sellerPropertyAddress }),
    // Шапка карточки (18.09.2026, задание В §f п.2) — карточка сама уже удалена
    // отдаётся 404 (:206 выше), поэтому здесь может прийти только «мягкое»
    // скрытое состояние (OTHER/LOST/DEAL_CLOSED/ARCHIVED/INACTIVE/DEFERRED/
    // эскалирован/СБ) — тот же текст, что в строке списка и в уведомлении.
    hiddenReason: computeHiddenReason(client, investigationViewerRole(req)),
  };
  res.json(transferAccess ? { ...payload, access: transferAccess } : payload);
});

const timelineQuerySchema = z.object({
  /** Курсор — последняя уже показанная запись (createdAt, id); без него — с самой свежей. */
  before: z.coerce.date().optional(),
  beforeId: z.string().uuid().optional(),
  /** Вкладка «Звонки» листает только звонки. */
  type: z.enum(INTERACTION_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * «ПОКАЗАТЬ БОЛЕЕ РАННИЕ» В ХРОНОЛОГИИ (02.10.2026, класс «Пагинация»).
 *
 * Карточка приносит последние CARD_TIMELINE_LIMIT записей и честное число всех
 * (interactionsTotal); всё, что старше, догружается здесь курсором
 * (createdAt, id) от последней показанной строки — не номером страницы: пока
 * карточка открыта, сверху появляются новые записи, и страница «2» съехала бы.
 * Отдельный путь, а не больший take у карточки: открытие карточки не должно
 * тяжелеть ради истории позапрошлого года.
 *
 * Доступ — то же правило, что у GET /:id: свой клиент, своя сделка с ним или
 * бывший свой (только чтение); до приёма своего лида история закрыта целиком.
 */
cardRouter.get("/:id/timeline", requireAuth, async (req, res) => {
  const cardWhere = cardWhereFromParam(String(req.params.id));
  if (!cardWhere) return res.status(404).json({ error: "Клиент не найден" });
  const parsed = timelineQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверные параметры", details: parsed.error.flatten() });
  const { before, beforeId, type, limit } = parsed.data;
  if ((before && !beforeId) || (!before && beforeId)) {
    return res.status(400).json({ error: "Курсор задаётся парой before и beforeId" });
  }

  const ownAgentId = scopeToOwnAgent(req);
  const client = await prisma.client.findUnique({
    where: cardWhere,
    select: { id: true, deletedAt: true, assignedAgentId: true, lastAgentId: true, acceptedAt: true },
  });
  if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });
  if (ownAgentId && client.assignedAgentId !== ownAgentId) {
    const hasDeal = (await prisma.deal.count({ where: { clientId: client.id, agentId: ownAgentId } })) > 0;
    if (!hasDeal && client.lastAgentId !== ownAgentId) return res.status(403).json({ error: "Недостаточно прав" });
  }
  if (ownAgentId && ownAgentId === client.assignedAgentId && !client.acceptedAt) {
    return res.json({ items: [], total: 0, hasMore: false });
  }

  const baseWhere: Prisma.InteractionWhereInput = { ...visibleInteractionWhere(investigationViewerRole(req)), clientId: client.id, ...(type ? { type } : {}) };
  const where: Prisma.InteractionWhereInput =
    before && beforeId
      ? { ...baseWhere, OR: [{ createdAt: { lt: before } }, { createdAt: before, id: { lt: beforeId } }] }
      : baseWhere;
  const [rows, total] = await Promise.all([
    prisma.interaction.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: TIMELINE_INTERACTION_SELECT,
    }),
    prisma.interaction.count({ where: baseWhere }),
  ]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  res.json({ items: await presentTimeline(req, client.assignedAgentId, page), total, hasMore });
});

/** Подпись реплики бота для .txt/.json экспорта — тот же словарь смысла, что и
 *  у иконки/подписи в самой переписке (см. @royal-home/shared/conversationMessage
 *  MessageSender), просто текстом вместо значка. */
function describeSender(by: MessageSender | undefined | null): string {
  if (!by) return "бот";
  switch (by.kind) {
    case "bot":
      return "бот";
    case "system":
      return "система (CRM)";
    case "agent":
      return by.agentName || "агент";
    case "manual":
      return "ответ вручную (мимо CRM)";
    default:
      return "бот";
  }
}

interface ExportRow {
  channel: string;
  role: "user" | "assistant";
  at: string | null;
  sender: string;
  content: string;
  hasAttachments: boolean;
}

/**
 * GET /clients/:id/conversation-export — вся история переписки клиента (все
 * каналы разом: botConversation + telegramConversation) как .json или .txt, с
 * таймингами там, где они есть.
 *
 * ЗАЧЕМ (13.09.2026, владелец: «клиент пожаловался, что бот сказал что-то не
 * то — нет способа быстро выгрузить полную историю с таймингами»). Реплика
 * без `at` — запись до 01.08.2026 (см. ConversationMessage в
 * @royal-home/shared) — уходит в экспорт БЕЗ времени, а не с выдуманным.
 *
 * ПРАВА — ТЕ ЖЕ, ЧТО НА САМУ ПЕРЕПИСКУ В КАРТОЧКЕ (см. GET /:id выше,
 * дословно те же две проверки: чужой клиент без сделки/бывшего владения — 403,
 * непринятый свой лид — переписка ещё не открыта). presentMessages маскирует
 * вложения/телефон по тем же правам messages.viewAttachments/clients.viewPhone —
 * экспорт не может показать больше, чем показывает сам экран.
 */
cardRouter.get("/:id/conversation-export", requireAuth, async (req, res) => {
  const shortId = Number(req.params.id);
  if (!Number.isInteger(shortId)) return res.status(404).json({ error: "Клиент не найден" });
  const ownAgentId = scopeToOwnAgent(req);

  const client = await prisma.client.findUnique({
    where: { shortId },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      deletedAt: true,
      assignedAgentId: true,
      lastAgentId: true,
      acceptedAt: true,
      deals: { select: { agentId: true } },
      botConversation: {
        select: { channel: true, messages: true },
        orderBy: { lastMessageAt: "desc" },
      },
      telegramConversation: { select: { messages: true } },
      telegramDirectConversations: { select: { messages: true }, orderBy: { lastMessageAt: "desc" } },
    },
  });
  if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });

  if (ownAgentId && client.assignedAgentId !== ownAgentId) {
    const hasDeal = client.deals.some((d) => d.agentId === ownAgentId);
    const wasMine = client.lastAgentId === ownAgentId;
    if (!hasDeal && !wasMine) return res.status(403).json({ error: "Недостаточно прав" });
  }
  // До приёма лида переписка не открыта агенту даже в самой карточке (см. GET
  // /:id, gateUntilAccepted) — экспорт не должен открывать закрытое экрану.
  if (ownAgentId && ownAgentId === client.assignedAgentId && !client.acceptedAt) {
    return res.status(403).json({ error: "Лид ещё не принят — переписка не открыта" });
  }

  const attachmentsAllowed = can(req, "messages.viewAttachments");
  const phonesAllowed = can(req, "clients.viewPhone");

  const toRows = (channel: string, messages: unknown): ExportRow[] =>
    presentMessages(messages, attachmentsAllowed, phonesAllowed).map((m: PresentedMessage) => ({
      channel,
      role: m.role,
      at: m.at ?? null,
      sender: m.role === "user" ? "клиент" : describeSender(m.by),
      content: m.content,
      hasAttachments: !!m.attachments?.length,
    }));

  const rows: ExportRow[] = [
    ...client.botConversation.flatMap((c) => toRows(c.channel, c.messages)),
    ...(client.telegramConversation ? toRows("TELEGRAM", client.telegramConversation.messages) : []),
    ...client.telegramDirectConversations.flatMap(c => toRows("TELEGRAM_DIRECT", c.messages)),
  ];

  // Сортировка по времени там, где оно есть — иначе несколько каналов идут блоками
  // «сначала весь Instagram, потом весь WhatsApp» вместо общей хронологии. Реплики
  // без `at` остаются в конце, в исходном порядке — раскидывать их по неизвестному
  // времени значило бы его выдумывать.
  const withTime = rows.filter((r) => r.at);
  const withoutTime = rows.filter((r) => !r.at);
  withTime.sort((a, b) => (a.at! < b.at! ? -1 : a.at! > b.at! ? 1 : 0));
  const ordered = [...withTime, ...withoutTime];

  const format = req.query.format === "txt" ? "txt" : "json";
  const fileBase = `client-${client.shortId}-conversation`;
  // Шапка выгрузки — тем же правом, что сообщения под ней (A11, глубокая
  // проверка 02.10.2026): у старых карточек номер лежит в самом имени.
  const shownName = client.fullName ? clientNamePhoneSafe(client.fullName, phonesAllowed) : "без имени";

  logAudit(req, "EXPORT_CONVERSATION", "Client", client.id, {
    shortId: client.shortId,
    format,
    messageCount: ordered.length,
  });

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  if (format === "txt") {
    const header = [
      `Переписка клиента ${shownName} (#${client.shortId})`,
      `Экспортировано: ${new Date().toISOString()}`,
      ordered.length === 0 ? "(переписки нет)" : "",
    ].filter(Boolean);
    const body = ordered.map(
      (m) =>
        `[${m.at ?? "время неизвестно"}] ${m.channel} · ${m.sender}: ${m.content}${m.hasAttachments ? " [вложение]" : ""}`
    );
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.txt"`);
    return res.send([...header, "", ...body].join("\n"));
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.json"`);
  res.send(
    JSON.stringify(
      {
        client: { shortId: client.shortId, fullName: shownName },
        exportedAt: new Date().toISOString(),
        messages: ordered,
      },
      null,
      2
    )
  );
});

/**
 * DELETE /clients/:id — удаление карточки. Только админ/директор. Мягкое: клиент
 * уходит в Корзину (deletedAt), сделки/переписка/диалоги остаются нетронутыми —
 * «Восстановить» в Корзине возвращает карточку как была. Любая сделка кроме
 * CANCELLED блокирует удаление: COMPLETED входит в бухгалтерию и KPI, а рабочие
 * стадии (переговоры/договор) молча исчезли бы с канбана — сначала отмените
 * или завершите сделку. Физическое удаление — отдельно, см. DELETE /:id/permanent.
 */
cardRouter.delete("/:id", requireAuth, requirePermission("clients.delete"), async (req, res) => {
  // Само удаление (проверка сделок, deletedAt, гашение требований и просьб о
  // звонке) живёт в lib/trashClient.ts: тот же путь проходит одобрение заявки
  // агента (routes/clients/deleteRequests.ts), и второй копии этой логики быть
  // не должно — см. комментарий там.
  const result = await trashClient(req.params.id, req.agent!.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  logAudit(req, "TRASH", "Client", result.client.id, {
    shortId: result.client.shortId,
    fullName: result.client.fullName,
    phone: result.client.phone,
    kind: result.client.kind,
  });

  res.json({ ok: true });
});

/**
 * Восстановление клиента из Корзины — только ADMIN.
 *
 * ПРОВЕРКА АГЕНТА (аудит владения 11.09.2026, дыра №3, `docs/ownership-audit-11-09.md`):
 * карточка могла пролежать в Корзине неделями, а агент за это время уволиться —
 * `restore` без проверки оживил бы клиента на уволенном (isActive=false), который
 * его физически не увидит. По явному уточнению П8 от 25.10.2026 восстановление
 * исключает также любую заморозку; действующий портфель вне восстановления
 * это правило не перераспределяет.
 */
cardRouter.post("/:id/restore", requireAuth, requirePermission("clients.delete"), async (req, res) => {
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client || !client.deletedAt) return res.status(404).json({ error: "Клиент не найден в корзине" });

  const eligible = (agent: { isActive: boolean; frozenAt: Date | null; role: string } | null | undefined) =>
    !!agent?.isActive && agent.frozenAt === null && (SALES_AGENT_ROLES as readonly string[]).includes(agent.role);
  const owner = client.assignedAgentId
    ? await prisma.agent.findUnique({ where: { id: client.assignedAgentId }, select: { isActive: true, frozenAt: true, role: true } })
    : null;
  const historicalOwner = !eligible(owner) && client.lastAgentId && !client.assignmentRefusedAt && !client.assignmentCompletedAt
    ? await prisma.agent.findUnique({ where: { id: client.lastAgentId }, select: { id: true, isActive: true, frozenAt: true, role: true } }) : null;
  const restoredAgentId = client.kind !== "OTHER" && eligible(historicalOwner) ? historicalOwner!.id : null;
  const completedAssignment = Boolean(client.assignmentRefusedAt || client.assignmentCompletedAt);
  const ownerGone = !completedAssignment && client.assignedAgentId != null && !eligible(owner);
  /**
   * КАРТОЧКА БЕЗ АГЕНТА ПОСЛЕ ВОССТАНОВЛЕНИЯ — В РАЗДАЧУ, И РУКОВОДСТВО ЗНАЕТ
   * (23.09.2026, проверка раздачи, пункты 20 и 24). Раньше при уволенном агенте
   * ставился escalatedAt без агента: утренняя волна такие карточки пропускает,
   * напоминаний нет, в счётчиках её нет, пуша не было — карточка пропадала из
   * виду. Карточка, лежавшая в Корзине вовсе без агента, тоже восстанавливалась
   * молча, а в режиме «Вручную» о ней не узнавал никто. Теперь карточка для
   * агентов (не «Прочее») встаёт в очередь как новый лид: волна отдаст её
   * агенту, и тот примет её сам. Руководство получает пуш «назначьте агента».
   */
  const endsWithoutAgent = !restoredAgentId && (ownerGone || client.assignedAgentId == null);
  const toQueue = !completedAssignment && endsWithoutAgent && client.kind !== "OTHER";
  const queueData = toQueue
    ? { escalatedAt: null, acceptedAt: null, assignedAt: new Date(), triedAgentIds: [], reassignCount: 0 }
    : {};

  const restoreConflict = new Error("Restore conflict");
  const restored = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${client.id} FOR UPDATE`;
    const current = await tx.client.findUnique({ where: { id: client.id } });
    if (!current?.deletedAt || current.updatedAt.getTime() !== client.updatedAt.getTime()) {
      return false;
    }
    const checkedOwners = [[client.assignedAgentId, eligible(owner)], [historicalOwner?.id ?? null, eligible(historicalOwner)]] as const;
    // Не назначать сотрудника, которого заморозили/уволили между выбором и записью.
    // FOR SHARE удерживает eligibility до коммита; одинаковый порядок исключает
    // взаимную блокировку двух восстановлений с обратной парой владельцев.
    for (const [id, expected] of [...checkedOwners].sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""))) {
      if (id && !completedAssignment) {
        await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${id} FOR SHARE`;
        const agent = await tx.agent.findUnique({ where: { id }, select: { isActive: true, frozenAt: true, role: true } });
        if (eligible(agent) !== expected) return false;
      }
    }
    // Часы ночного переноса в Корзину — заново с момента восстановления
    // (23.09.2026). Карточку, которую перенос убрал сам (Потерянный/Неактивный
    // старше срока), он в ту же ночь уносил обратно: lostAt и inactiveSince
    // оставались прежними. Статус не трогаем — это решение человека, а не кнопки.
    const now = new Date();
    await tx.client.update({
      where: { id: client.id },
      data: {
        deletedAt: null,
        deletedById: null,
        ...(ownerGone ? {} : queueData),
        ...(client.status === "LOST" ? { lostAt: now } : {}),
        ...(client.workStatus === "INACTIVE" && client.inactiveSince ? { inactiveSince: now, inactivePingCount: 0 } : {}),
      },
    });
    if (ownerGone || restoredAgentId) {
      const changed = await changeClientAgent({
        clientId: client.id,
        toAgentId: restoredAgentId,
        reason: restoredAgentId ? "Восстановление из Корзины: возвращена прежнему активному агенту" : "Восстановление из Корзины: агент карточки недоступен — карточка в очереди раздачи",
        actorId: req.agent!.id,
        source: "restore",
        data: restoredAgentId ? { assignedAt: now, acceptedAt: null, escalatedAt: null } : toQueue ? queueData : { escalatedAt: new Date() },
        tx,
      });
      if (!changed.ok) throw restoreConflict;
    }
    return true;
  }).catch(error => { if (error === restoreConflict) return false; throw error; });
  if (!restored) return res.status(409).json({ error: "Карточка изменилась. Обновите страницу" });
  if (toQueue) {
    const supervisors = (await findAgentsWithPermission("clients.assign")).filter((id) => id !== req.agent!.id);
    sendPushToAgents(supervisors, {
      title: "♻️ Карточка восстановлена без агента",
      body: `${client.fullName} — вернулась из Корзины, агента у неё нет. Раздача отдаст её сама, либо назначьте вручную`,
      url: `/clients/${client.shortId}`,
      tag: `restore-no-agent-${client.id}`,
    }).catch((err) => console.error("[push] восстановление без агента:", err));
  }

  logAudit(req, "RESTORE", "Client", client.id, {
    shortId: client.shortId,
    fullName: client.fullName,
    phone: client.phone,
    ownerReassignedToQueue: ownerGone,
  });
  // Живое обновление ПОСЛЕ коммита (аудит 11.09.2026, второй заход по осиротевшим
  // спутникам, п.4 задания): карточка ушла из Корзины и снова видна в списках —
  // ownerGone=true уже опубликовал changeClientAgent сам (через
  // closeOwnershipSatellites), здесь покрываем и обычный случай «агент тот же».
  publishClientUpdated({ clientId: client.id, agentIds: [client.assignedAgentId] });
  res.status(204).send();
});

/** Безвозвратное удаление — только из Корзины (deletedAt уже проставлен), только
 * ADMIN. Ровно та логика, что раньше была обычным DELETE: CANCELLED-сделки
 * стираются явно (без каскада в схеме), диалоги бота/Telegram отвязываются
 * (clientId=null, переписка остаётся), Interaction уходит каскадом схемы. */
cardRouter.delete("/:id/permanent", requireAuth, requirePermission("clients.purge"), async (req, res) => {
  const client = await prisma.client.findUnique({
    where: { id: req.params.id },
    include: { deals: { select: { id: true, stage: true } } },
  });
  if (!client || !client.deletedAt) return res.status(404).json({ error: "Клиент не найден в корзине" });

  if (client.deals.some((d) => d.stage !== "CANCELLED")) {
    return res.status(409).json({
      error: "У клиента есть активная сделка — удалить навсегда нельзя",
    });
  }

  /**
   * ТРЕБОВАНИЯ ГАСИМ ДО УДАЛЕНИЯ, А НЕ ПОСЛЕ (27.08.2026).
   *
   * После `client.delete` искать их уже не по чему: Interaction уходит каскадом
   * схемы, а PendingSummary внешнего ключа на клиента не имеет и переживает
   * любое удаление. Требование осталось бы с «висячим» subjectId — окно, чей
   * предмет не найти ничем, и погасить его смог бы только сам агент.
   */
  await cancelClientCallbackRequests(client.id).catch(() => 0);

  // ФАЙЛЫ ДОКУМЕНТОВ СДЕЛОК (C6, 02.10.2026): строки DealDocument уходят каскадом
  // вместе со сделками, а сами файлы (паспорт покупателя, договор) оставались на
  // сервере навсегда — без владельца и без способа найти их из CRM. Имена
  // собираем ДО удаления, стираем ПОСЛЕ коммита: откат транзакции не должен
  // оставить строку документа без файла.
  const dealDocumentFiles = await listDealDocumentFileNames(client.deals.map((d) => d.id));
  // Аватар — в открытой uploads/avatars, после удаления строки его не найти (G10).

  await prisma.$transaction(async (tx) => {
    await tx.botConversation.updateMany({ where: { clientId: client.id }, data: { clientId: null } });
    await tx.telegramConversation.updateMany({ where: { clientId: client.id }, data: { clientId: null } });
    // ОТЗЫВЫ ПО СДЕЛКАМ (аудит 04.10.2026, SCHEMA01). DealReview ссылается на клиента и на
    // сделку обязательными связями (ON DELETE RESTRICT, миграция 20260911190100). Строка
    // появляется при постановке вопроса, в том числе ПРОДАВЦУ объекта (у него нет сделок
    // по Deal.clientId) и стороне аннулированной сделки, так что без этой чистки
    // client.delete / deal.deleteMany падали P2003 и карточка навсегда оставалась в
    // Корзине. Стираем отзывы самого клиента и все отзывы по удаляемым сделкам (сделка
    // стирается, отзыв второй стороны на неё иначе остался бы без предмета). Миграция не
    // нужна: это обычный DELETE перед теми же удалениями.
    await tx.dealReview.deleteMany({
      where: { OR: [{ clientId: client.id }, { dealId: { in: client.deals.map((d) => d.id) } }] },
    });
    await tx.deal.deleteMany({ where: { clientId: client.id } });
    await tx.client.delete({ where: { id: client.id } });
  });
  for (const fileName of dealDocumentFiles) deleteDealDocumentFile(fileName);

  await removeClientAvatarFile(client.avatarUrl);

  logAudit(req, "PERMANENT_DELETE", "Client", client.id, {
    shortId: client.shortId,
    fullName: client.fullName,
    phone: client.phone,
    kind: client.kind,
    cancelledDealsDeleted: client.deals.length,
  });

  res.status(204).send();
});

/**
 * ЧТО ВИДНО О ДУБЛЕ ПРИ СОЗДАНИИ КЛИЕНТА (аудит 23.09.2026, №43).
 *
 * Предупреждение «клиент уже есть» отдавало найденную карточку ЦЕЛИКОМ: заметки,
 * запасные номера, бюджет, сводку ИИ — любому, кто набрал чужой номер. Кнопке
 * «Открыть карточку» нужны только ссылка и имя; имя проходит то же правило, что
 * и в самой карточке (presentClient): номер внутри имени скрыт, если карточка не
 * своя или права на номер нет.
 */
function duplicateHint(
  req: Request,
  c: Parameters<typeof presentClient>[0] & { id: string; shortId: number; fullName: string; assignedAgentId: string | null },
): { id: string; shortId: number; fullName: string } {
  const own = can(req, "clients.viewAll") || c.assignedAgentId === req.agent!.id;
  const shown = presentClient(c, own && can(req, "clients.viewPhone"), can(req, "clients.viewOrigin"), investigationViewerRole(req));
  return { id: c.id, shortId: c.shortId, fullName: String((shown as { fullName?: string }).fullName ?? "") };
}

cardRouter.post("/", requireAuth, async (req, res) => {
  const parsed = clientCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  // desiredPlaces — не скаляр Client, а отдельная таблица (ClientDesiredPlace):
  // вынимаем из data, иначе Prisma не примет её обычным полем в create ниже.
  const { force, assignedAgentId: requestedAgentId, desiredPlaces, ...data } = parsed.data;
  if (!canAccessAssignedAgent(req, requestedAgentId ?? req.agent!.id)) {
    return res.status(403).json({ error: "Агент не может назначать клиента другому сотруднику" });
  }
  // Получатель — ДО создания карточки (B13, решение владельца 02.10.2026):
  // отключённому или замороженному назначить нельзя, иначе клиент висит у того,
  // кто его не увидит. Не агенту (директору) — можно, экран предупреждает сам.
  if (requestedAgentId && can(req, "clients.assign")) {
    const target = await checkManualAssignTarget(requestedAgentId);
    if (!target.ok) return res.status(target.status).json({ error: target.error });
  }

  // deletedAt: null — клиент, убранный в Корзину, продолжал блокировать создание
  // нового с тем же номером, а кнопка «Открыть {имя}» вела на карточку, которая
  // отвечает 404. findFirst, а не findUnique: с дополнительным условием уникальный
  // индекс по телефону больше не подходит как ключ поиска.
  const existing = await prisma.client.findFirst({
    where: { phone: data.phone, deletedAt: null },
    include: { assignedAgent: { select: { fullName: true } } },
  });
  if (existing) {
    // Телефон и почту чужого клиента агенту не отдаём — та же маскировка, что и в
    // мягком предупреждении ниже. Раньше карточка уходила целиком.
    return res.status(409).json({ error: "Клиент с таким телефоном уже существует", client: duplicateHint(req, existing) });
  }

  // Телефон уникален глобально, и мягкое удаление индекс не снимает: клиент,
  // лежащий в Корзине, предпроверку выше не проходит, но create об него споткнётся.
  // Без этой ветки человек получал 500 вместо понятного «восстановите из Корзины».
  const inTrash = await prisma.client.findFirst({
    where: { phone: data.phone, deletedAt: { not: null } },
    select: { id: true },
  });
  if (inTrash) {
    return res.status(409).json({
      error: "Клиент с таким телефоном лежит в Корзине — восстановите его в Архиве вместо создания нового",
    });
  }

  {
    // До создания: чужой номер в запасных (или чужой запасной как главный) —
    // жёсткий отказ, `force` его не снимает. Это не «похоже на дубликат», а прямое
    // противоречие: у номера уже есть хозяин.
    const owned = await phoneOwnershipError(req, data);
    if (owned) return res.status(409).json({ error: owned });
    // Номер сотрудника — не то же самое, что чужой номер клиента (повод см.
    // в шапке lib/staffPhoneGuard.ts): владельца-человека здесь нет вовсе,
    // а `force` дубликат не снимает и его тоже не снимает.
    const staffError = await staffPhoneGuardError(data);
    if (staffError) return res.status(409).json({ error: staffError, code: STAFF_PHONE_ERROR_CODE });
  }

  if (!force) {
    // Тот же критерий, что и в GET /duplicates: только совпадение по телефону (в любом
    // формате — с кодом страны, пробелами и т.п.) считается дубликатом. Раньше здесь
    // искали по совпадению ПЕРВОГО СЛОВА ИМЕНИ и (инвертированным условием) предупреждали
    // как раз о клиентах с ДРУГИМ телефоном — то есть почти о любых тёзках (Далер, Умед
    // и т.п. в маленьком городе встречаются часто), а настоящее совпадение телефона в
    // другом формате (например "+992 90..." против "992-90-...") никогда не ловилось.
    // Сравниваем ЦИФРЫ, а не строку: в колонке phone номер лежит как его набрали
    // (clientPhoneSchema разрешает пробелы и скобки), поэтому LIKE '%900000001%'
    // по сырой колонке не находил «+992 90 000 00 01» НИКОГДА — то есть ровно тот
    // случай, который обещает комментарий выше. Тот же предикат уже работает в
    // lib/whatsappPhone.ts, где на нём и ловятся дубликаты из мессенджеров.
    const normalized = normalizePhone(data.phone);
    const suffix = normalized.slice(-9);
    const matched =
      suffix.length === 9
        ? await prisma.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "Client"
            WHERE "deletedAt" IS NULL
              AND right(regexp_replace("phone", '[^0-9]', '', 'g'), 9) = ${suffix}
            ORDER BY "createdAt" ASC
            LIMIT 5`
        : [];
    const candidates = matched.length
      ? await prisma.client.findMany({
          where: { id: { in: matched.map((m) => m.id) } },
          include: { assignedAgent: { select: { fullName: true } } },
        })
      : [];
    const similar = candidates[0];
    if (similar) {
      // 200, не 409 — это мягкое предупреждение, не блокирующая ошибка: агент может
      // подтвердить создание повторно с force=true. Телефон чужого клиента агенту не отдаём.
      return res.status(200).json({
        warning: `Похоже, клиент уже есть у ${similar.assignedAgent?.fullName ?? "другого сотрудника"}`,
        client: duplicateHint(req, similar),
      });
    }

    /**
     * РАЗДЕЛ L, УРОВЕНЬ 3 (03.09.2026, план вечерней сессии §L) — точный номер не
     * совпал (проверка выше это уже исключила), но похоже имя + похож (не
     * идентичен) номер: последние 7 цифр совпадают, а не 9. Сигнал слабее
     * (см. lib/duplicateReview.ts) — то же мягкое предупреждение 200, не блок.
     * Владелец просил ПРЕДУПРЕЖДЕНИЕ ДО создания, а не после — здесь это как раз
     * до: клиент ещё не создан, force повторно подтверждает намерение.
     */
    const fuzzy = await findFuzzyDuplicateCandidate(data.fullName, data.phone);
    if (fuzzy) {
      const fuzzyClient = await prisma.client.findUnique({
        where: { id: fuzzy.id },
        include: { assignedAgent: { select: { fullName: true } } },
      });
      if (fuzzyClient) {
        const hint = duplicateHint(req, fuzzyClient);
        return res.status(200).json({
          warning:
            `Похожее имя и похожий номер уже есть в базе — карточка «${hint.fullName}» у ` +
            `${fuzzyClient.assignedAgent?.fullName ?? "другого сотрудника"}. Проверьте, не тот же ли это человек`,
          client: hint,
        });
      }
    }
  }

  // Уровень 2: распределение лидов. Агент, который сам привёл клиента, работает с ним сразу.
  // Лид без явного агента распределяется автоматически по нагрузке и очерёдности,
  // и до принятия (уровень 3) контакты для агента закрыты.
  const creator = req.agent!;
  let assignedAgentId: string;
  let acceptedAt: Date | null;
  let assignment: LeadAssignment | null = null;

  // Карточка заводится ПЕРВОЙ и без агента: чтобы понять, кому лид причитается по
  // правилу «свой объект», нужен запрос клиента (район, комнаты, бюджет), то есть
  // сама карточка. Тот же порядок, что и у лида из канала (leads.ts).
  // Раздел M (03.09.2026, §M): та же отметка, что в services/leads/intake.ts —
  // без неё первый переход этой карточки в продавца не смог бы отличить «поля
  // устарели» от «поля никогда не заполняли».
  const client = await prisma.client.create({
    data: {
      ...data,
      assignedAt: new Date(),
      ...(data.kind === "BUYER" ? { requirementsFieldsKind: "BUYER" as const } : {}),
      // Места создаются вместе с карточкой — вложенный create, тот же неявный
      // единый запрос Prisma, что и остальные поля создания.
      ...(desiredPlaces && desiredPlaces.length
        ? {
            desiredPlaces: {
              create: desiredPlaces.map((p) => ({ lat: p.lat, lng: p.lng, radiusM: p.radiusM, label: p.label ?? null })),
            },
          }
        : {}),
    },
    include: { desiredPlaces: { orderBy: { createdAt: "asc" } } },
  });

  // Право «назначать риелтора» и есть граница: у кого его нет — тот заводит клиента
  // только на себя (и сразу принимает), у кого есть — может отдать коллеге.
  if (!can(req, "clients.assign")) {
    assignedAgentId = creator.id;
    acceptedAt = new Date();
  } else if (requestedAgentId) {
    assignedAgentId = requestedAgentId;
    acceptedAt = requestedAgentId === creator.id ? new Date() : null;
  } else {
    // Продавец не упирается в лимит покупателей (владелец 20.08.2026).
    assignment = await assignAgentForLead({
      clientId: client.id,
      kind: client.kind === "SELLER" ? "SELLER" : "BUYER",
    });
    assignedAgentId = assignment.agentId ?? creator.id;
    acceptedAt = assignment.agentId ? null : new Date();
  }

  // LAW-A2-PENDING: первичное назначение при СОЗДАНИИ карточки (Х4, ownership
  // policy 17.09.2026) — не "передача" (before.assignedAgentId ещё нет), но по
  // единому входу тоже обязано идти через changeClientAgent; перевод — пачка
  // А2 (docs/audit/recon-17-09/02-auto-transfer-mechanisms.md, раздел (г)).
  await prisma.client.update({
    where: { id: client.id },
    data: {
      // LAW-A2-PENDING (маркер повторён у самой строки: комментарий выше ушёл за
      // окно сторожа, когда в data добавилось поле assignReason).
      assignedAgentId,
      acceptedAt,
      // Завёл на себя — не лид из очереди, окно первого звонка его не касается.
      ...(assignedAgentId === creator.id && acceptedAt ? { assignReason: SELF_CREATED_ASSIGN_REASON } : {}),
    },
  });
  client.assignedAgentId = assignedAgentId;
  client.acceptedAt = acceptedAt;
  if (assignment?.agentId) await recordAssignReason(client.id, assignment.agentId, assignment);

  // Кто завёл карточку и на кого она сразу легла — в журнал (12.09.2026). Удаление,
  // восстановление и слияние клиента журнал пишет, заведение не писало, а споры о
  // владении клиентом разбираются именно по первой записи.
  logAudit(req, "CLIENT_CREATE", "Client", client.id, {
    shortId: client.shortId,
    fullName: client.fullName,
    kind: client.kind,
    assignedAgentId,
  });
  /**
   * П-1/П-10 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §2, §4):
   * `assignedAgentId` выше пишется прямым `prisma.client.update` (шорткат
   * `data: { assignedAgentId, acceptedAt }`), мимо `changeClientAgent` — и
   * намеренно НЕ переведено на неё: это первое назначение при создании
   * карточки, а не смена владельца, отдельная транзакция ради этого не
   * заводится. Но инструменты, которые ищут владение по CLIENT_AGENT_CHANGE
   * (а не по CLIENT_CREATE.meta.assignedAgentId), без этой строки не видели
   * первое назначение вовсе — добавлена отдельная запись source=client.create.
   */
  logAudit(req, "CLIENT_AGENT_CHANGE", "Client", client.id, {
    source: "client.create",
    from: null,
    to: assignedAgentId,
    reason: "Карточка создана и сразу назначена",
  });

  // Лид ждёт принятия — агент, скорее всего, сейчас не в CRM: push нужен, чтобы он не
  // проворонил окно до автопереназначения (Настройки → leadAcceptMinutes).
  if (!acceptedAt) {
    sendLeadPush(assignedAgentId, client.id, {
      title: "🔔 Новый лид",
      body: `${client.fullName} — примите заявку, иначе её передадут другому агенту`,
      url: `/clients/${client.shortId}`,
      tag: `lead-${client.id}`,
    }).catch((err) => console.error("[push] новый лид:", err));
  }

  res.status(201).json(presentClient(client, can(req, "clients.viewPhone"), can(req, "clients.viewOrigin"), investigationViewerRole(req)));
});

cardRouter.patch("/:id", requireAuth, async (req, res) => {
  const parsed = clientUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const ownAgentId = scopeToOwnAgent(req);
  const existing = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Клиент не найден" });
  if (ownAgentId && existing.assignedAgentId !== ownAgentId) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  if (ownAgentId && !existing.acceptedAt) {
    return res.status(403).json({ error: "Сначала примите лид — до принятия карточка закрыта" });
  }
  // Правка чужой карточки — только закреплённому агенту и руководству, см.
  // foreignWriteDenied: «видеть все» само по себе права писать не даёт.
  const patchDenied = foreignWriteDenied(req, existing, ownAgentId);
  if (patchDenied) return res.status(403).json({ error: patchDenied });

  // ИМЯ, КОТОРОЕ ЧЕЛОВЕКУ ПОКАЗАНО СКРЫТЫМ, ЕГО ЖЕ СОХРАНЕНИЕМ НЕ ПЕРЕПИСЫВАЕТСЯ
  // (аудит 23.09.2026, №67). Кому номер скрыт, тот видит имя с «•» вместо цифр или
  // подпись «Покупатель ПК-…» вместо ника; форма шлёт имя при каждом сохранении —
  // правка бюджета переписывала настоящее имя показанным. Тот же приём, что для
  // номера собственника объекта (№31).
  if (parsed.data.fullName !== undefined) {
    const canSeePhone = can(req, "clients.viewPhone");
    const canSeeOrigin = can(req, "clients.viewOrigin");
    if (!canSeePhone || !canSeeOrigin) {
      const shown = String(presentClient(existing, canSeePhone, canSeeOrigin, investigationViewerRole(req)).fullName ?? "");
      if (shown !== existing.fullName && parsed.data.fullName.trim() === shown.trim()) {
        delete parsed.data.fullName;
      } else if (!canSeePhone && parsed.data.fullName.includes(CLIENT_PHONE_MASK_CHAR)) {
        return res.status(400).json({ error: "В имени скрытый номер. Поправить имя может тот, кому номер виден." });
      }
    }
  }
  // То же для «Заметок» (глубокая проверка 02.10.2026, A5): кому номер скрыт,
  // тому они показаны с «•», а форма шлёт их при каждом сохранении.
  if (typeof parsed.data.requirementsNotes === "string" && !can(req, "clients.viewPhone")) {
    const restored = restoreMaskedNotes(parsed.data.requirementsNotes, existing.requirementsNotes);
    if (restored === null) {
      return res.status(400).json({
        error: "В заметках правится строка со скрытым номером. Поправить её может тот, кому номер виден, — остальные строки можно менять.",
      });
    }
    parsed.data.requirementsNotes = restored;
  }
  if (!canAccessAssignedAgent(req, parsed.data.assignedAgentId ?? existing.assignedAgentId)) {
    return res.status(403).json({ error: "Агент не может переназначать клиента" });
  }

  /**
   * СОСТОЯНИЕ ПОКУПАТЕЛЯ АГЕНТ НЕ ТРОГАЕТ (ТЗ владельца 12.08.2026, п. 3 и голосовое:
   * «другие статусы даёт сама CRM… эти статусы он не имеет права их трогать»).
   *
   * ПРОВЕРКА ИМЕННО НА СЕРВЕРЕ, а не только скрытой кнопкой. Кнопку из карточки я
   * убрал (ClientDetail.tsx), но одного этого мало: у CRM установлено как PWA, и
   * старая версия интерфейса живёт в кэше служебного воркера — она продолжала бы
   * слать status и молча возвращать агенту право, которого у него больше нет.
   *
   * Руководству (право clients.assign) оставлено: автоматика знает не всё, и
   * запирать ЕЁ ошибку без единого способа поправить — та же беда с другого конца.
   *
   * 15.09.2026 (просьба владельца через Нурмухаммада): запрет на продавца
   * РАСШИРЕН с одного только «Сделка закрыта» на ЛЮБОЙ статус — раньше здесь
   * был дырявый частный случай (запрещалось только DEAL_CLOSED, потому что
   * именно на нём 05.09.2026 нашли пропажу комиссии/Royal Score/«Продано»),
   * а ручная смена дропдауном («Состояние заявки», ManualStatus в
   * ClientDetail.tsx — компонент удалён этой же правкой вместе с вызовом)
   * оставалась разрешена для остальных статусов продавца. Теперь продавец
   * симметричен покупателю: агент не ставит ему статус вручную ни в каком
   * виде, только автоматика/бизнес-логика (крон, sellerCardState.ts,
   * закрытие сделки в deals.ts — все они пишут status через прямой
   * prisma.client.update/updateMany в транзакции, минуя этот HTTP-роут,
   * так что запрет здесь их не касается).
   */
  /**
   * ТИП КАРТОЧКИ ПРИ ЭТОМ — ТОЖЕ НЕ ЛАЗЕЙКА (аудит Codex 04.10.2026, ACCESS-08).
   * Гейт смотрел только на текущий `existing.kind`, а тип агент меняет сам (это
   * отдельная кнопка «Тип карточки», 19.09.2026): PATCH {kind:OTHER}, затем
   * PATCH {kind:BUYER, status:DEAL_CLOSED} — и закрытый клиент без сделки и оплаты.
   * Поэтому: (1) считаем и ЗАПРОШЕННЫЙ тип, (2) карточка OTHER статус от агента тоже
   * не принимает — это та же промежуточная остановка, а интерфейс статус через
   * PATCH не шлёт вовсе (ни форма, ни хронология), так что штатные пути не задеты.
   */
  const requestedKind = parsed.data.kind ?? existing.kind;
  if (parsed.data.status && parsed.data.status !== existing.status && !can(req, "clients.assign")) {
    return res.status(403).json({
      error:
        existing.kind === "SELLER" || requestedKind === "SELLER"
          ? "Состояние продавца ставит CRM автоматически (закрытие сделки, «Итог объекта» и т.п.) — агенту менять статус вручную нельзя"
          : "Состояние покупателя ставит CRM. Агенту доступны «Неактивный», «Передача» и «Завершить сделку»",
    });
  }

  // desiredPlaces — не скаляр Client (см. POST выше): вынимаем из data, переписываем
  // отдельными запросами внутри той же транзакции ниже.
  // assignedAgentId — тоже вынимаем и ИГНОРИРУЕМ (как и в POST выше): единственная
  // разрешённая точка записи этого поля — changeClientAgent()
  // (apps/api/src/lib/changeClientAgent.ts, аудит владения 11.09.2026) через
  // /assign, /transfer, /claim-pool и т.д. — они пишут историю, закрывают
  // уведомления/задачи старого агента и публикуют live-событие. Прямой PATCH
  // раньше мог переставить владельца в обход всего этого (canAccessAssignedAgent
  // выше проверяет только clients.viewAll, не clients.assign).
  const { desiredPlaces, assignedAgentId: _ignoredAssignedAgentId, ...data } = parsed.data;
  {
    // Та же проверка, что и на создании, но с исключением САМОЙ карточки: иначе
    // сохранение без единой правки падало бы на собственных же номерах.
    const owned = await phoneOwnershipError(req, data, existing.id);
    if (owned) return res.status(409).json({ error: owned });
    // Только присланные поля — clientUpdateSchema частичен, сохранение без
    // правки номера не должно спотыкаться о собственный же номер карточки.
    const staffError = await staffPhoneGuardError(data, existing);
    if (staffError) return res.status(409).json({ error: staffError, code: STAFF_PHONE_ERROR_CODE });
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Список мест ЗАМЕЩАЕТСЯ целиком, если ключ прислан (пустой массив — значит
    // «очистить»); ключ не прислан — существующий список не трогаем. Удалить
    // старые и вставить новые — в ОДНОЙ транзакции с самой карточкой ниже, иначе
    // карточка сохранится, а места — нет (или наоборот) при сбое между запросами.
    if (desiredPlaces !== undefined) {
      await tx.clientDesiredPlace.deleteMany({ where: { clientId: existing.id } });
      if (desiredPlaces.length) {
        await tx.clientDesiredPlace.createMany({
          data: desiredPlaces.map((p) => ({
            clientId: existing.id,
            lat: p.lat,
            lng: p.lng,
            radiusM: p.radiusM,
            label: p.label ?? null,
          })),
        });
      }
    }
    if (data.status && data.status !== existing.status) {
      await logTimeline({
        clientId: existing.id,
        actor: { kind: "agent", agentId: req.agent!.id },
        type: "STATUS_CHANGE",
        notes: `Статус изменён с «${CLIENT_STATUS_LABELS[existing.status]}» на «${CLIENT_STATUS_LABELS[data.status]}»`,
        tx,
      });
    }
    // Имя — единственное текстовое поле карточки, которое меняют вручную заметно
    // чаще прочих (запасное «Покупатель №…»/«Продавец №…» дозаполняется агентом
    // или автопилотом, см. messengers/conversation.ts и lib/clientAutopilot.ts) —
    // владелец 19.08.2026 попросил, чтобы такая правка тоже была видна в хронологии,
    // как и смена статуса, а не терялась молча.
    if (typeof data.fullName === "string" && data.fullName.trim() && data.fullName !== existing.fullName) {
      await logTimeline({
        clientId: existing.id,
        actor: { kind: "agent", agentId: req.agent!.id },
        type: "SYSTEM",
        notes: `Имя изменено с «${existing.fullName}» на «${data.fullName.trim()}»`,
        tx,
      });
    }
    /**
     * СМЕНА KIND — БЕЗ ХРОНОЛОГИИ ВООБЩЕ (18.09.2026, задание В, §b п.4 разведки
     * 17.09: «kind → OTHER через PATCH без хронологии»). Обратный случай
     * (OTHER → BUYER/SELLER) уже пишет след — этот, прямой, нет: карточка
     * молча переставала быть «Покупателем»/«Продавцом» у держателя, и он не
     * находил её ни в одном из своих списков, не понимая, что случилось.
     * `logTimeline`, не прямой create — П-10, единая точка записи.
     */
    if (data.kind && data.kind !== existing.kind) {
      await logTimeline({
        clientId: existing.id,
        actor: { kind: "agent", agentId: req.agent!.id },
        type: "SYSTEM",
        notes: `Тип карточки изменён с «${CLIENT_KIND_LABELS[existing.kind]}» на «${CLIENT_KIND_LABELS[data.kind]}»`,
        tx,
      });
    }
    // Номер исправили в карточке продавца — у его объектов с тем же старым номером
    // «Телефон собственника» следует за ним (24.09.2026, lib/propertyOwnerRelink.ts).
    if (typeof data.phone === "string" && data.phone !== existing.phone) {
      await followSellerPhoneChange(tx, existing.id, existing.phone, data.phone);
    }
    return tx.client.update({
      where: { id: req.params.id },
      // Ручная правка статуса замораживает автоматику на неделю: человек,
      // который только что говорил с клиентом, знает о нём больше правил
      // (см. lib/clientAutoStatus.ts).
      data: { ...data,
        ...(data.status && data.status !== existing.status ? { statusSetManuallyAt: new Date() } : {}),
        ...(data.kind && data.kind !== existing.kind ? { dualIntentConfirmedAt: null, dualIntentConfirmedById: null } : {}),
      },
      include: { desiredPlaces: { orderBy: { createdAt: "asc" } } },
    });
  });

  // Royal Score: «Карточка клиента полностью заполнена» (таблица владельца, п. 10) —
  // ровно на переходе пусто→заполнено, а не при каждом сохранении уже заполненной
  // карточки (иначе одна и та же заслуга начислялась бы на каждую мелкую правку).
  // sourceId = id клиента: если карточку потом очистят и заполнят снова, повторно
  // баллы не начисляются — награда даётся один раз, за первое достижение.
  if (!isClientCardFilled(existing) && isClientCardFilled(updated) && updated.assignedAgentId) {
    const points = await loadEventPoints();
    recordScoreEvent({
      agentId: updated.assignedAgentId,
      kind: "card_filled",
      delta: points.card_filled,
      reason: `Карточка полностью заполнена: ${updated.fullName}`,
      sourceId: updated.id,
    });
  }

  // Клиент, пришедший с сайта, ведёт параллельную запись в собственной таблице
  // заявок сайта — держим её статус в курсе. Не внутри транзакции и без await:
  // недоступность сайта не должна ни блокировать, ни откатывать смену статуса в CRM.
  if (data.status && data.status !== existing.status && existing.source === "WEBSITE") {
    notifySiteLeadStatus(existing.id, data.status);
  }

  // Держатель узнаёт о смене типа карточки — та же причина, что у записи в
  // хронологию выше: OTHER выпадает из его «Покупателей»/«Продавцов» молча.
  // Себя не уведомляем — сменил тип своей же карточки сам, ему и так видно.
  if (data.kind && data.kind !== existing.kind && existing.assignedAgentId && existing.assignedAgentId !== req.agent!.id) {
    void sendPushToAgent(existing.assignedAgentId, {
      title: "🔀 Тип карточки изменён",
      body: `${existing.fullName}: «${CLIENT_KIND_LABELS[existing.kind]}» → «${CLIENT_KIND_LABELS[data.kind]}»`,
      url: `/clients/${existing.shortId}`,
      tag: `client-kind-changed-${existing.id}`,
    }).catch((err) => {
      void logSystemError(
        "api",
        `Пуш о смене типа карточки не отправлен (${existing.id}, держатель ${existing.assignedAgentId}): ${err instanceof Error ? err.message : err}`
      );
    });
  }

  // Собственник отказался от работы с нами — его объекты снимаются с продажи сами
  // (см. lib/propertyAutoStatus.ts). Раньше это была вторая ручная операция после
  // первой: агент помечал продавца потерянным, а объект оставался висеть в продаже
  // и на сайте — иногда месяцами, пока по нему не звонил покупатель.
  if (data.status === "LOST" && existing.status !== "LOST" && existing.kind === "SELLER") {
    void refreshPropertiesOfSeller(existing.id).catch((err) =>
      console.error("[clients] автостатус объектов продавца:", err instanceof Error ? err.message : err)
    );
  }

  // Через presentClient, как и все остальные ответы этого файла: без него агенту
  // достаточно было сохранить карточку, чтобы получить в ответе закрытый ему номер
  // (и фронтенд положил бы его в кэш).
  res.json(presentClient(updated, can(req, "clients.viewPhone"), can(req, "clients.viewOrigin"), investigationViewerRole(req)));
});
