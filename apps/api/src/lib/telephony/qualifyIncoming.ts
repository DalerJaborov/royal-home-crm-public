import { maskClientPhone } from "../clientPhone.js";
import { formatPropertyCode, type QualifyIncomingCallInput, type QualifyIncomingCallResult } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { recordIncomingNamedDeclaration } from "../clientWorkflowObservations.js";
// Через крючок, не напрямую из services/leads/selection.js: этот файл (в
// отличие от callTracker.ts/kpiQueueRouting.ts) приходит туда обратно через
// agentOccupancyShield.ts, прямой импорт замыкал бы цикл (аудит циклов
// 03.09.2026, см. pickAgentForLeadHook.ts).
import { assignAgentForLead, recordAssignReason } from "./assignAgentForLeadHook.js";
import type { LeadAssignment } from "../../services/leads/assignmentTypes.js";
import { identifyProperty, type PropertyClues } from "../propertyMatch.js";
import { sendPushToAgent, sendPushToAgents } from "../../push.js";
import { findAgentsWithPermission } from "../recipients.js";
import { detectRequestedAgent, requestedAgentNote, requestedAgentStillAvailable } from "../requestedAgent.js";
import { logSystemError } from "../systemError.js";
import { logTimeline } from "../timeline.js";
import { closeClientSatellites } from "../clientSatellites.js";
import { isPlaceholderName } from "../placeholderName.js";
import { normalizeClientName } from "../../ai/replyGuards.js";
import { loadIncomingSettings } from "./incomingSettings.js";
import { liveIncomingByRecordId } from "./liveIncomingLookupHook.js";
import { changeClientAgent } from "../changeClientAgent.js";
import { publishCallUpdated, publishClientUpdated } from "../livePublish.js";
import { findStaffPhone, staffPhoneError } from "../staffPhoneGuard.js";
import { describeRoleSwap, KIND_LABELS_RU } from "../../services/leads/intake.js";
import { canAutomationChangeKind } from "../kindChangePolicy.js";

/**
 * Разбор входящего звонка оператором: кто звонил и чего хочет.
 *
 * ЭТО ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ВХОДЯЩИЙ ПРЕВРАЩАЕТСЯ В ЛИДА. Дальше — обычная схема:
 * тот же pickAgentForLead, та же очередь по KPI, тот же таймер принятия. Второй
 * механики распределения здесь нет и быть не должно: два разных пути раздачи
 * клиентов означают два разных понимания справедливости, и агенты сравнят их в
 * первый же день.
 *
 * ТАЙМЕР ПЕРВОГО ЗВОНКА СТАРТУЕТ ОТСЮДА, а не от начала разговора: агент не может
 * отвечать за минуты, пока с клиентом говорил оператор. Поэтому assignedAt ставится
 * моментом назначения — так же, как у лида из любого другого канала.
 *
 * «ДРУГОЕ» АГЕНТАМ НЕ РАЗДАЁТСЯ — ровно как у лидов из бота (см. leads.ts): работа,
 * аренда и «ошиблись номером» уходят в «Прочие обращения» к руководству. Раздать их
 * по очереди KPI значило бы наказывать агента за чужой мусор.
 */
export async function qualifyIncomingCall(input: {
  callId: string;
  /**
   * Кто разобрал. `null` — разобрала САМА CRM по расшифровке разговора
   * (см. lib/telephony/autoLeadFromCall.ts): оператор теперь только говорит с
   * человеком и в CRM не заходит вовсе (решение владельца 18.08.2026).
   *
   * Автоматика идёт ЭТОЙ ЖЕ дверью, а не своей: здесь живут дедупликация по
   * номеру, отказ раздавать «Другое» агентам, однократное назначение через
   * pickAgentForLead и пуши. Второй путь к тем же данным разошёлся бы с этим в
   * первую же неделю — ровно то, о чём предупреждает шапка функции.
   */
  operatorId: string | null;
  /**
   * АГЕНТ, КОТОРЫЙ САМ ОТВЕТИЛ НА ЭТОТ ЗВОНОК (решение владельца 18.08.2026).
   *
   * Новая схема приёма: звонок незнакомого человека звонит СРАЗУ ВСЕМ агентам, и
   * кто снял трубку — тот и работает с клиентом. Такому лиду не нужны ни очередь
   * по KPI, ни кнопки «Принять/Отклонить»: агент уже поговорил с человеком, и
   * спрашивать его, берётся ли он, поздно. Дословно: «клиент должен попасть
   * именно к этому агенту уже принятым, потому что он в работе будет».
   *
   * Поэтому здесь карточка закрепляется за ним и сразу помечается принятой
   * (`acceptedAt`), минуя pickAgentForLead. Предел портфеля при этом не
   * проверяется — тем же решением владельца: разговор уже состоялся.
   *
   * null — обычный путь: разбирает автоматика или оператор, агента выбирает
   * очередь.
   */
  answeredByAgentId?: string | null;
  /**
   * ПРИМЕТЫ ОБЪЕКТА ИЗ РАЗГОВОРА, которых нет в карточке клиента: ориентир («у
   * фабрики Гулдаст»), этаж, этажность, площадь — только от разбора расшифровки.
   * Вместе с данными запроса (цена, район, тип, комнаты) узнают объект, о котором
   * спрашивали (identifyProperty в lib/propertyMatch.ts; ПК-000475 и решение владельца 24.09.2026).
   */
  listingClues?: Pick<PropertyClues, "place" | "floor" | "totalFloors" | "areaSqm" | "rooms" | "priceTjs" | "landSotka"> | null;
  /**
   * ОБЪЕКТ УЖЕ УЗНАН В РАЗГОВОРЕ (робозвонок, get_property; 24.09.2026). Робот
   * назвал человеку агента этого объекта — лид обязан уйти ему, а не тому, кого
   * выберет повторное узнавание по расшифровке, которое может и не узнать.
   * Объект за это время продан или снят — узнаём заново, как обычно.
   */
  knownPropertyId?: string | null;
  /**
   * КОГО ЧЕЛОВЕК НАЗВАЛ В РАЗГОВОРЕ («мне нужен Умед») — решение владельца
   * 18.08.2026. Сырая строка из расшифровки: имя ПОДСКАЗЫВАЕТ модель разбора
   * (ai/incomingCallLead.ts, без отдельного вызова — поле в том же ответе), а
   * сверяет его с базой и решает, кому отдавать, код (lib/requestedAgent.ts).
   *
   * Тёзки и недоступный сотрудник сюда доходят как обычная раздача плюс пометка
   * в хронологии: угадывать между двумя Баходурами нельзя, а промолчать о том,
   * что человек называл имя, — значит подставить агента, которому лид достался.
   */
  requestedAgentText?: string | null;
  data: QualifyIncomingCallInput;
}): Promise<QualifyIncomingCallResult | { error: "not_found" | "no_client" }> {
  const call = await prisma.incomingCall.findUnique({
    where: { id: input.callId },
    select: { id: true, phone: true, clientId: true, qualifiedAt: true, autoCreatedClient: true, interactionId: true },
  });
  if (!call) return { error: "not_found" };

  // «Не по делу» — единственный исход, которому карточка не нужна вовсе; его можно
  // поставить и звонку без карточки (автосоздание выключено). Поэтому он разбирается
  // до проверки clientId ниже.
  if (input.data.kind === "IRRELEVANT") {
    return markIrrelevant({ call, operatorId: input.operatorId });
  }

  const settings = await loadIncomingSettings();

  /**
   * Карточки нет — заводим её ЗДЕСЬ.
   *
   * Раньше это был отказ 409 «автосоздание выключено», и он врал в двух случаях из
   * трёх. Автосоздание могло быть выключено настройкой; звонок мог быть непринятым;
   * а чаще всего номер когда-то помечали «не по делу», и карточка не заводилась
   * намеренно — человек ошибся номером год назад, а сегодня звонит покупать
   * квартиру, и записать его было НЕВОЗМОЖНО ВООБЩЕ. Оператор при этом читал, что
   * дело в настройке, которая на самом деле включена.
   *
   * Раз оператор своими руками говорит «это покупатель», карточка нужна независимо
   * от того, почему её не завели раньше. Это и есть отмена прежней пометки: она
   * решала, заводить ли карточку молча, а не запрещала работать с человеком.
   */
  let clientId = call.clientId;
  let createdNow = false;
  if (!clientId) {
    const created = await createClientForCall(call.phone);
    if (!created) return { error: "no_client" };
    clientId = created;
    createdNow = true;
  }

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      kind: true,
      assignedAgentId: true,
      status: true,
      requirementsNotes: true,
      acceptedAt: true,
    },
  });
  if (!client) return { error: "no_client" };

  const { kind, fullName, requirementsNotes, budgetMin, budgetMax, desiredDistrictId, desiredRooms, desiredType } =
    input.data;

  /**
   * ПОКУПАТЕЛЬ↔ПРОДАВЕЦ НЕ МЕНЯЕТСЯ МОЛЧА И У ЗВОНКОВ (разбор 18.09.2026, жалоба
   * агента Нозы; ужесточено 21.09.2026 — владелец решил, что для ПРИНЯТОЙ карточки
   * этого мало). 18.09 здесь появилась защита «реальная смена БУДЕТ записана в
   * карточку и дальше, но с отметкой в хронологии и флагом dualIntent, а не
   * бесследно» — то есть смена записывалась ВСЕГДА, просто больше не молча. Живой
   * случай показал, что и этого недостаточно: у принятой карточки (агент уже
   * работает с человеком) смену типа должен совершать человек, а не любой звонок
   * — хоть от модели, хоть от оператора. `describeRoleSwap` остаётся источником
   * текста и флага `dualIntent` для настоящего разворота ПОКУПАТЕЛЬ↔ПРОДАВЕЦ;
   * `canAutomationChangeKind` (lib/kindChangePolicy.ts) — единая точка, которая
   * решает, доходит ли смена до самого поля `kind`, для звонков и переписки разом.
   */
  const roleSwap = describeRoleSwap(client.kind, kind, client.requirementsNotes);
  const kindActuallyDiffers = kind !== client.kind;
  const isHumanActor = input.operatorId !== null;
  /**
   * Оператор — живой человек, ему решение доверяем всегда (он же слышал разговор).
   * `operatorId === null` — разобрала сама CRM по расшифровке (autoLeadFromCall.ts);
   * для неё действует общее правило: пока карточка не принята, можно исправлять
   * тип самой, а с момента приёма — не трогать и ничего не писать (lib/kindChangePolicy.ts).
   */
  const canChangeKind =
    isHumanActor || canAutomationChangeKind({ acceptedAt: client.acceptedAt, currentKind: client.kind, nextKind: kind });
  const kindWillChange = kindActuallyDiffers && canChangeKind;

  /**
   * ИМЯ ОТ АВТОМАТИКИ — ЧЕРЕЗ ФИЛЬТР, ИМЯ ОТ ЧЕЛОВЕКА — КАК ЕСТЬ (30.08.2026).
   *
   * `operatorId === null` означает, что разобрала САМА CRM по расшифровке
   * (autoLeadFromCall → ai/incomingCallLead.ts), и «имя» там — строка от модели.
   * Именно так в поле «Имя» на проде оказались «Тел», «Ака», «Варзоб», «Адрес
   * курган»: любая непустая строка длиной от двух знаков записывалась в карточку.
   * Не распознали имя — оставляем заглушку: её CRM однажды заменит настоящим именем,
   * а мусор она примет за имя и не тронет больше никогда.
   *
   * Оператора и агента фильтром не ограничиваем: человек, который говорил с клиентом,
   * знает, как его зовут, лучше любого правила, и отказ записать введённое им имя он
   * увидел бы как несохранившийся ввод.
   */
  const nameToWrite = input.operatorId === null ? normalizeClientName(fullName) : fullName;

  // Ответственного ищем, только когда его ещё нет. Клиент, которого уже ведёт агент,
  // остаётся у него: перекидывать чужого клиента из-за того, что он позвонил в офис,
  // нечестно — то же правило, что у повторного обращения в бот (notifyRepeatInquiry).
  const needsAgent = !client.assignedAgentId && kind !== "OTHER" && settings.assignOnQualify;
  /**
   * Ответивший агент забирает клиента без очереди: он уже говорил с человеком.
   * Очередь по KPI остаётся для всех остальных путей — автоматики и оператора.
   */
  /**
   * Названный клиентом сотрудник — второй по силе после того, кто сам снял трубку:
   * ответивший уже поговорил с человеком, и это факт, а просьба — намерение.
   * Доступность сверяется по базе прямо сейчас: расшифровка приходит через минуты
   * после разговора, за которые агента могли отключить.
   */
  const requested = needsAgent ? await detectRequestedAgent(input.requestedAgentText, { requireCue: false }) : { status: "none" as const };
  const requestedAgentId =
    requested.status === "matched" ? await requestedAgentStillAvailable(requested.agentId) : null;

  /**
   * ПРАВИЛО «СВОЙ ОБЪЕКТ» И ДЛЯ ЗВОНКОВ (Пачка 1 п.4, 11.09.2026).
   *
   * Раньше звонок, не подхваченный ответившим и без названного сотрудника, шёл
   * прямиком в общую очередь по KPI (pickAgentForLead) — то есть клиент, который
   * позвонил ПРО КОНКРЕТНЫЙ ОБЪЕКТ, мог достаться чужому агенту только потому,
   * что написал он раньше, а позвонил позже. Теперь этот путь идёт через
   * assignAgentForLead — те же шаги «объект назван явно / бот уже показывал /
   * запрос совпал с объектом», что у переписки. Объект «назван явно» здесь
   * берётся из расшифровки (ai/incomingCallLead.ts::propertyHint), найден
   * существующим поиском (resolveCallPropertyHint), без новой эвристики.
   *
   * Ответивший агент и названный сотрудник по-прежнему сильнее — они не идут
   * через это правило вовсе (проверены раньше, синхронно).
   */
  let leadAssignment: LeadAssignment | null = null;
  let agentId: string | null = null;
  /** Что узнавание объекта сказало об этом звонке — строкой в хронологию. */
  let propertyNote: string | null = null;
  /**
   * Объект звонка: узнанный консультантом (knownPropertyId) — первым, иначе по
   * расшифровке. Приметы объявления — отдельно от запроса (24.09.2026): цена
   * объявления вычёркивает дальше 20 %, а бюджет клиента — нет; комнаты объявления
   * важнее «сколько нужно». Нет цены объявления — узнаём по бюджету мягко.
   */
  const identifyCallObject = async () => {
    const listing = input.listingClues ?? {};
    const known = input.knownPropertyId
      ? await prisma.property.findUnique({ where: { id: input.knownPropertyId }, select: { shortId: true } })
      : null;
    const byRobot = known ? await identifyProperty({ text: String(known.shortId) }) : null;
    const recognized = byRobot?.propertyId ? byRobot : await identifyProperty({
      text: input.data.propertyHint ?? null,
      ...listing,
      priceTjs: listing.priceTjs ?? null,
      budgetTjs: listing.priceTjs ? null : (input.data.budgetMax ?? null),
      districtId: input.data.desiredDistrictId ?? null,
      type: input.data.desiredType ?? null,
      rooms: listing.rooms ?? input.data.desiredRooms ?? null,
    });
    /**
     * ПРОДАВЕЦ — ТОЛЬКО ПО ПРЯМОМУ УКАЗАНИЮ (24.09.2026, проход по классам).
     * Продавец описывает СВОЁ жильё: «продаю двушку у Бодомзора за 300» по
     * приметам совпадёт с чужим объектом в том же доме, и лид ушёл бы агенту
     * чужого продавца. Номер, адрес или ЖК — прямое указание, по нему можно.
     */
    const identified: Awaited<ReturnType<typeof identifyProperty>> =
      kind === "SELLER" && recognized.via !== "hint" ? { propertyId: null, via: null, candidates: [] } : recognized;
    return { identified, byRobot: !!byRobot?.propertyId };
  };
  if (needsAgent) {
    if (input.answeredByAgentId) {
      /**
       * «КТО СНЯЛ» УСТУПАЕТ «ЧЕЙ ОБЪЕКТ», ЕСЛИ ОБЪЕКТ НАЗВАН ПРЯМО (10.10.2026,
       * аудит docs/audit-bots-2026-10-10-object-routing.md, P0-4; требование
       * владельца «клиент по объекту — хозяину объекта»). Трубку в KPI-очереди или
       * после перевода роботом снимает тот, кто свободен, — и клиент, позвонивший
       * по объекту А, уходил ответившему Б сразу принятым, а хозяин А не знал.
       * Теперь объект, узнанный консультантом или названный номером/адресом/ЖК
       * (via "hint"), отдаёт новый лид хозяину — тем же шагом «объект назван явно»,
       * что у переписки, — и лид ждёт его «Принять», а ответившему остаётся запись
       * в хронологии. Догадка по приметам (via "description") ответившего не
       * перебивает: он уже говорил с человеком, а догадка — не указание. Хозяин
       * уволен или исключён — лид у ответившего, как раньше.
       */
      const { identified, byRobot } = await identifyCallObject();
      if (identified.propertyId && (byRobot || identified.via === "hint")) {
        const byObject = await assignAgentForLead({
          clientId: client.id,
          kind: kind === "SELLER" ? "SELLER" : "BUYER",
          propertyId: identified.propertyId,
        });
        if (byObject.reason === "own_property_explicit" && byObject.agentId && byObject.agentId !== input.answeredByAgentId) {
          leadAssignment = byObject;
          agentId = byObject.agentId;
          const answerer = await prisma.agent.findUnique({ where: { id: input.answeredByAgentId }, select: { fullName: true } });
          propertyNote = [
            identificationNote(identified, { byRobot, toOwner: true }),
            `Трубку снял ${answerer?.fullName ?? "другой сотрудник"}, но звонок по объекту — лид отдан хозяину объекта`,
          ]
            .filter(Boolean)
            .join(". ");
        }
      }
      if (!agentId) agentId = input.answeredByAgentId;
    } else if (requestedAgentId) {
      agentId = requestedAgentId;
    } else {
      const { identified, byRobot } = await identifyCallObject();
      leadAssignment = await assignAgentForLead({
        clientId: client.id,
        kind: kind === "SELLER" ? "SELLER" : "BUYER",
        propertyId: identified.propertyId ?? undefined,
        // Запрос звонка ложится в карточку ниже, в транзакции, — а шаг «запрос
        // совпал с объектом» смотрит его уже сейчас (24.09.2026).
        requirements: {
          budgetMin: input.data.budgetMin ?? null,
          budgetMax: input.data.budgetMax ?? null,
          desiredDistrictId: input.data.desiredDistrictId ?? null,
          desiredRooms: input.data.desiredRooms ?? null,
          desiredType: input.data.desiredType ?? null,
        },
      });
      propertyNote = identificationNote(identified, {
        byRobot,
        toOwner: leadAssignment.reason === "own_property_explicit",
      });
      agentId = leadAssignment.agentId;
    }
  }
  const acceptedByAnswerer = !!agentId && agentId === input.answeredByAgentId;
  /**
   * ПОМЕТКА О НАЗВАННОМ ИМЕНИ — во всех исходах, включая «не определили».
   * Кнопку «Принять/Отклонить» она не трогает: с ЭТИМ агентом человек ещё не
   * говорил, значит агент вправе решать, берётся ли он (в отличие от того, кто
   * сам снял трубку).
   */
  const assignedToRequested = !!requestedAgentId && agentId === requestedAgentId;
  const namedNote =
    requested.status === "matched" && !assignedToRequested
      ? // Либо агента отключили, пока шла расшифровка, либо трубку снял другой и
        // клиент уже его: в обоих случаях обещать «закреплён за названным» — враньё.
        `Клиент называл сотрудника ${requested.fullName}, но лид распределён обычным порядком`
      : requestedAgentNote(requested);

  // Карточка и запись в хронологии — одной транзакцией: назначенный агент без записи
  // и без пуша означал бы молча зависший лид (тот же приём, что в leads.ts).
  let assignedNow = false;
  const updated = await prisma.$transaction(async (tx) => {
    /**
     * Назначение — ОТДЕЛЬНЫМ УСЛОВНЫМ ЗАПРОСОМ, а не полем в общем update.
     *
     * `needsAgent` выше считается по чтению вне транзакции, и два сохранения подряд
     * (окно сохраняет по паузе ввода, а два оператора могут разбирать один звонок)
     * оба увидели бы `assignedAgentId = null`, оба вызвали бы pickAgentForLead и
     * оба отправили бы пуш «примите заявку» — разным агентам. Клиент достался бы
     * последнему, а первый ждал бы заявку, которой у него уже нет. Условие
     * `assignedAgentId: null` прямо в запросе делает назначение однократным.
     */
    if (agentId) {
      // changeClientAgent — единственная точка записи assignedAgentId (аудит
      // владения 11.09.2026, docs/ownership-audit-11-09.md). Interaction о самом
      // назначении не дублируем: ниже по этой же транзакции и так пишется одна
      // системная запись «оператор записал обращение» на весь звонок.
      const claimed = await changeClientAgent({
        clientId: client.id,
        toAgentId: agentId,
        reason: "Входящий звонок квалифицирован оператором",
        source: "qualifyIncoming",
        tx,
        skipInteraction: true,
        guardWhere: { assignedAgentId: null },
        data: {
          assignedAt: new Date(),
          status: "NEW",
          // Причина назначения — тем же полем, что и у лида из переписки
          // (leads.ts::LeadAssignReason): раздел «почему лид у этого агента»
          // обязан отвечать одинаково независимо от канала.
          ...(assignedToRequested ? { assignReason: "requested_by_client" } : {}),
          // Агент снял трубку сам — лид сразу в работе, без окна принятия и без
          // таймера «прими за 15 минут». Спрашивать «берёшься?» у того, кто уже
          // поговорил с клиентом, поздно (решение владельца 18.08.2026).
          // workStatus вместе с acceptedAt — тот же случай, что в
          // lib/leadAccept.ts (владелец 19.09.2026): карточка молчавшего клиента
          // помечена «Неактивный» ночным кроном, а главная агента неактивных не
          // показывает вовсе. Агент снял трубку, поговорил — карточка снова
          // живая работа, метка обязана сняться и на этом пути тоже.
          ...(acceptedByAnswerer ? { acceptedAt: new Date(), workStatus: "ACTIVE" as const } : {}),
        },
      });
      assignedNow = claimed.ok;
    }

    const saved = await tx.client.update({
      where: { id: client.id },
      data: {
        // ТИП МЕНЯЕТ ЧЕЛОВЕК, ИИ ТОЛЬКО ПРЕДЛАГАЕТ (владелец 21.09.2026,
        // lib/kindChangePolicy.ts) — см. комментарий у canChangeKind выше.
        ...(kindWillChange ? { kind } : {}),
        ...(roleSwap ? { dualIntent: roleSwap.dualIntent } : {}),
        /**
         * Имя перезаписываем только настоящим и только поверх ЗАГЛУШКИ: затереть имя
         * давнего клиента опечаткой оператора нельзя.
         *
         * Признак заглушки — общий на весь проект (lib/placeholderName.ts). До
         * 30.08.2026 здесь стоял свой, `startsWith("Входящий ")`, и он не знал ни про
         * «Покупатель №…» бота, ни про «Клиент Instagram»: человек, который сначала
         * написал в Instagram, а потом позвонил и назвался, имени в карточке так и не
         * получал.
         */
        ...(nameToWrite && (call.autoCreatedClient || createdNow || isPlaceholderName(client.fullName))
          ? { fullName: nameToWrite }
          : {}),
        ...(requirementsNotes ? { requirementsNotes } : {}),
        ...(budgetMin !== undefined ? { budgetMin } : {}),
        ...(budgetMax !== undefined ? { budgetMax } : {}),
        ...(desiredDistrictId ? { desiredDistrictId } : {}),
        ...(desiredRooms !== undefined ? { desiredRooms } : {}),
        ...(desiredType ? { desiredType } : {}),
        // Клиент сам позвонил — это контакт, и он должен считаться контактом:
        // иначе CRM «остужает» статус и напоминает агенту про клиента, который
        // звонит каждый день (см. lib/clientAutoStatus.ts, lib/cardReminders.ts).
        lastContactAt: new Date(),
      },
      select: { id: true, shortId: true, fullName: true },
    });

    await tx.incomingCall.update({
      where: { id: call.id },
      data: {
        qualifiedAt: new Date(),
        qualifiedById: input.operatorId,
        clientId: client.id,
        // Разобрали как обращение — прежняя пометка «не по делу» снимается: она
        // существует только затем, чтобы не заводить карточку курьеру.
        irrelevant: false,
      },
    });

    /**
     * Запись в хронологию — ОДНА НА ЗВОНОК, а не одна на сохранение.
     *
     * Окно оператора сохраняет по паузе ввода, то есть вызывает этот путь пять-шесть
     * раз за разговор: выбрал тип, дописал имя, дописал запрос, поправил бюджет.
     * Без этой проверки хронология клиента получала бы шесть одинаковых системных
     * записей «оператор записал обращение» — и настоящие события в ней тонули бы.
     *
     * АВТОРСТВО (П-10, 17.09.2026, docs/audit/lead-ownership-17-09.md §2, дефект
     * «оператор пишет за ведущего», docs/audit/recon-17-09/04-timeline-authorship.md
     * §b.8). Раньше запись всегда подписывалась ОТВЕТСТВЕННЫМ агентом (`historyAgentId`),
     * хотя разговор вёл оператор (`input.operatorId`) — с карточкой у него формальной
     * связи нет, но разговор был его. Теперь: оператор есть — kind agent, это он;
     * `operatorId === null` — обращение разобрала сама CRM по расшифровке (AI), не
     * человек. В обоих случаях `subjectAgentId` = ответственный агент, чтобы запись
     * оставалась видна в его карточке клиента.
     */
    const historyAgentId = agentId ?? client.assignedAgentId;
    if (!call.qualifiedAt) {
      const notes =
        `Входящий звонок с ${call.phone}: оператор записал обращение` +
        (requirementsNotes ? ` — ${requirementsNotes}` : "") +
        (namedNote ? `
${namedNote}` : "") +
        (propertyNote ? `
${propertyNote}` : "");
      await logTimeline({
        clientId: client.id,
        actor: input.operatorId
          ? { kind: "agent", agentId: input.operatorId }
          : { kind: "ai", source: "qualify-incoming-ai", subjectAgentId: historyAgentId },
        type: "SYSTEM",
        notes,
        tx,
      });
    }
    /**
     * СМЕНА ТИПА — ОТДЕЛЬНОЙ ЗАПИСЬЮ, НЕЗАВИСИМО ОТ «ПЕРВЫЙ РАЗБОР ЛИ ЭТО»
     * (владелец 21.09.2026). Раньше текст про смену типа (`roleSwap.note`) жил
     * ВНУТРИ записи выше — то есть только на первом разборе звонка. Оператор
     * может увидеть настоящую смену типа и на повторном сохранении (второй звонок
     * по тому же звонку, уточнение после того, как дозвонился до клиента ещё
     * раз) — такую смену человек обязан увидеть в хронологии КАЖДЫЙ раз, когда
     * она произошла на самом деле, а не только если это был первый разбор.
     * Заблокированная автоматика (карточка принята) не пишет НИЧЕГО — ни смены,
     * ни «предложения»: решает агент сам (владелец 21.09.2026).
     */
    if (kindWillChange) {
      // Текст берём из roleSwap.note, если это настоящий разворот ПОКУПАТЕЛЬ↔ПРОДАВЕЦ;
      // иначе — общий текст для любой смены (включая переходы в/из OTHER, которые
      // describeRoleSwap не покрывает — dualIntent для них не имеет смысла).
      const changeNote =
        roleSwap?.note ??
        `Тип обращения изменён при разборе звонка: ${KIND_LABELS_RU[client.kind] ?? client.kind} → ${KIND_LABELS_RU[kind] ?? kind}`;
      await logTimeline({
        clientId: client.id,
        actor: input.operatorId
          ? { kind: "agent", agentId: input.operatorId }
          : { kind: "ai", source: "qualify-incoming-ai", subjectAgentId: historyAgentId },
        type: "SYSTEM",
        notes: changeNote,
        tx,
      });
    }
    if (assignedNow && assignedToRequested && requestedAgentId) await recordIncomingNamedDeclaration(tx, {
      clientId: client.id, callId: call.id, interactionId: call.interactionId, requestedAgentId, operatorId: input.operatorId,
    });
    return saved;
  });

  // Оператор разобрал звонок: изменились и строка журнала входящих, и карточка
  // (появилась либо сменила исполнителя). Публикуем ПОСЛЕ коммита транзакции.
  publishCallUpdated({ callId: call.id, clientId: updated.id, agentId: agentId ?? null });
  publishClientUpdated({ clientId: updated.id, agentIds: [agentId], actorId: input.operatorId });

  // Живой звонок в памяти знает имя карточки — обновляем, иначе окно оператора до
  // конца разговора показывало бы заглушку «Входящий +992…», которую он только что
  // заменил, и выглядело бы это как несохранившийся ввод.
  const liveEntry = liveIncomingByRecordId(call.id);
  if (liveEntry) {
    liveEntry.clientId = updated.id;
    liveEntry.clientShortId = updated.shortId;
    liveEntry.clientName = updated.fullName;
  }

  // Причина назначения — «свой объект» / «показ» / «совпадение» — пишется тем же
  // путём, что и у переписки (services/leads/assignment.ts::recordAssignReason):
  // проставляет assignReason/matchedPropertyId/ownPropertyLead на карточке и
  // отдельную строку в хронологию. Только когда назначение реально состоялось
  // (assignedNow) — на проигравшем повторном сохранении писать нечего.
  if (agentId && assignedNow && leadAssignment && leadAssignment.reason !== "queue") {
    await recordAssignReason(updated.id, agentId, leadAssignment);
  }

  let assignedAgentName: string | null = null;
  if (agentId && assignedNow) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { fullName: true } });
    assignedAgentName = agent?.fullName ?? null;
    sendPushToAgent(agentId, {
      title: "📞 Клиент позвонил в офис",
      body: `${updated.fullName} — оператор передал вам, примите заявку`,
      url: `/clients/${updated.shortId}`,
      tag: `lead-${updated.id}`,
    }).catch((err) => console.error("[push] лид из входящего звонка:", err));
  } else if (kind === "OTHER" && !call.qualifiedAt) {
    const supervisors = await findAgentsWithPermission("otherInquiries.view");
    sendPushToAgents(supervisors, {
      title: "🔔 Новое обращение: звонок в офис",
      body: `${updated.fullName} — «Прочие обращения», не для агентов`,
      url: `/clients/${updated.shortId}`,
      tag: `other-${updated.id}`,
    }).catch((err) => console.error("[push] прочее обращение из звонка:", err));
  }
  if (needsAgent && !agentId && !call.qualifiedAt) {
    /**
     * Агента не нашлось: режим «Вручную» в Настройках либо прямо сейчас нет ни
     * одного активного. Раньше это была ТИШИНА — оператор записал обращение, и оно
     * зависало без ответственного, а узнать о нём можно было только случайно. В
     * leads.ts на этот же случай пуш руководству есть, здесь его не было.
     */
    const supervisors = await findAgentsWithPermission("clients.assign");
    sendPushToAgents(supervisors, {
      title: "⏳ Обращение по телефону ждёт назначения",
      body: `${updated.fullName} — оператор записал, назначьте агента вручную`,
      url: `/clients/${updated.shortId}`,
      tag: `lead-unassigned-${updated.id}`,
    }).catch((err) => console.error("[push] звонок без агента:", err));
  }

  return { clientId: updated.id, clientShortId: updated.shortId, assignedAgentName };
}

/**
 * «Не по делу»: курьер, реклама, ошиблись номером.
 *
 * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ «ДРУГОГО». Аренда, работа, коммерция — настоящие обращения:
 * их смотрит руководство в «Прочих обращениях», и карточка там нужна. Курьер клиентом
 * не является ни в каком смысле, и карточка на него — это мусор, который через месяц
 * делает раздел «Прочие обращения» нечитаемым, а его перестают открывать вовсе.
 * Владелец сформулировал прямо (10.08.2026): «чтобы вообще карточка не создавалась,
 * если вопрос не касается этого всего».
 *
 * ЧТО ДЕЛАЕТСЯ:
 *  1. звонок помечается разобранным — он больше не висит в «без разбора»;
 *  2. карточка, ЗАВЕДЁННАЯ ЭТИМ ЖЕ ЗВОНКОМ, удаляется;
 *  3. номер запоминается: следующий звонок с него карточку не заведёт.
 *
 * ЧЕГО НЕ ДЕЛАЕТСЯ: звонок из журнала не исчезает. Нагрузка на оператора должна
 * считаться честно — двадцать звонков курьеров это двадцать снятых трубок.
 */
async function markIrrelevant(input: {
  call: { id: string; clientId: string | null; autoCreatedClient: boolean; interactionId: string | null };
  /** `null` — пометила автоматика по расшифровке, а не человек. */
  operatorId: string | null;
}): Promise<QualifyIncomingCallResult> {
  const { call } = input;
  let clientRemoved = false;
  let callMarked = false;
  /** Отметка «не по делу» на самом звонке. Связь с карточкой снимаем, когда её
   *  больше нет; если карточку решили сохранить (живой клиент), она к этому
   *  звонку всё равно отношения не имеет — но ссылку оставляем как была. */
  const markIrrelevant = (unlinkClient: boolean) => ({
    qualifiedAt: new Date(),
    qualifiedById: input.operatorId,
    irrelevant: true,
    ...(unlinkClient ? { clientId: null } : {}),
  });

  /**
   * Удаляем ТОЛЬКО карточку, заведённую этим звонком, и только пока к ней ничего не
   * успело прирасти. Карточку живого клиента, который однажды позвонил не по делу,
   * удалять нельзя ни при каких обстоятельствах — оператор помечает ЗВОНОК, а не
   * человека, и цена ошибки здесь несимметрична: лишняя карточка это мусор, стёртая
   * карточка это потерянный клиент вместе с историей.
   */
  if (call.clientId && call.autoCreatedClient) {
    const [interactions, deals, client] = await Promise.all([
      /**
       * ЗАПИСЬ САМОГО ЭТОГО ЗВОНКА «ПРИРАСТАНИЕМ» НЕ СЧИТАЕТСЯ.
       *
       * Счётчик отвечает на вопрос «успело ли к карточке что-то прирасти, кроме
       * заглушки». Разговор, из-за которого карточка и появилась, — это не «что-то
       * ещё»: finishIncomingCall заводит запись в хронологии на КАЖДОМ отвеченном
       * входящем, и без этого исключения условие удаления не выполнялось НИКОГДА.
       * То есть карточка курьера оставалась в базе всегда, а пометка «не по делу»
       * работала только на будущее — при следующем звонке с того же номера.
       */
      prisma.interaction.count({
        where: { clientId: call.clientId, ...(call.interactionId ? { id: { not: call.interactionId } } : {}) },
      }),
      prisma.deal.count({ where: { clientId: call.clientId } }),
      prisma.client.findUnique({
        where: { id: call.clientId },
        select: { assignedAgentId: true, fullName: true, requirementsNotes: true, budgetMax: true, kind: true },
      }),
    ]);
    /**
     * КАРТОЧКА ДОЛЖНА ОСТАТЬСЯ ЗАГЛУШКОЙ. Проверок «завёл этот звонок» и «нет
     * истории» мало: тот же человек мог позвонить второй раз, и ВТОРОЙ звонок
     * разобрали как обращение — записали имя, запрос, бюджет. Записи в хронологии
     * при этом могло не появиться вовсе (у «Другого» агента нет, писать некому).
     * Вечером оператор дочищает старые неразобранные звонки, ставит «не по делу» на
     * ПЕРВЫЙ — и стирает карточку с уже записанным обращением.
     *
     * Признак заглушки — имя вида «Входящий +992…» и пустые поля запроса: ровно то,
     * с чем карточка заводится автоматически.
     */
    const untouched =
      !!client &&
      client.fullName.startsWith("Входящий ") &&
      !client.requirementsNotes &&
      client.budgetMax === null;
    if (interactions === 0 && deals === 0 && !client?.assignedAgentId && untouched) {
      const clientId = call.clientId;
      /**
       * УСЛОВИЕ «ЗАГЛУШКА» ПОВТОРЯЕТСЯ В САМОМ ЗАПРОСЕ УДАЛЕНИЯ (04.10.2026, CHANNEL-NEW-19).
       *
       * Проверка выше читала карточку тремя запросами вне транзакции, и пока
       * транзакция начиналась, оператор мог закрепить карточку, дописать запрос или
       * завести сделку: удаление шло `where` только по id и стирало уже рабочую
       * карточку по устаревшему решению. Теперь удаляется только то, что и в момент
       * удаления остаётся нетронутой заглушкой; иначе помечается один звонок.
       */
      const stillStub = {
        id: clientId,
        deletedAt: null,
        assignedAgentId: null,
        fullName: { startsWith: "Входящий " },
        OR: [{ requirementsNotes: null }, { requirementsNotes: "" }],
        budgetMax: null,
        deals: { none: {} },
        interactions: { none: call.interactionId ? { id: { not: call.interactionId } } : {} },
      };
      /**
       * КАРТОЧКА И ОТМЕТКА НА ЗВОНКЕ — ОДНОЙ ТРАНЗАКЦИЕЙ (22.09.2026).
       *
       * Порознь перезапуск процесса между ними оставлял карточку стёртой, а звонок
       * — НЕразобранным в очереди оператора. Оператор жмёт «не по делу» второй раз,
       * а удалять уже нечего; при этом счётчик «дважды не по делу → служебный
       * номер» считает не то, что видел человек.
       */
      try {
        const removed = await prisma.$transaction(async (tx) => {
          const deleted = await tx.client.deleteMany({ where: stillStub });
          // Карточка за это время перестала быть заглушкой — не трогаем, звонок помечаем.
          await tx.incomingCall.update({ where: { id: call.id }, data: markIrrelevant(deleted.count > 0) });
          return deleted.count > 0;
        });
        clientRemoved = removed;
        callMarked = true;
      } catch (err) {
        // Не внешний ключ (база моргнула и т.п.) — не прячем карточку «мягко» по
        // ошибке, которая её удаления не объясняет: пусть упадёт, оператор повторит.
        if ((err as { code?: string } | null)?.code !== "P2003") throw err;
        // За карточку зацепилось что-то, чего мы не предусмотрели (внешний ключ без
        // каскада). Тогда убираем её с глаз мягким удалением — в Корзину: это хуже, чем
        // чисто, но несравнимо лучше, чем упавший разбор у оператора, который в итоге
        // бросит помечать такие звонки вовсе. Условие заглушки то же.
        const softRemoved = await prisma.$transaction(async (tx) => {
          const updated = await tx.client.updateMany({ where: stillStub, data: { deletedAt: new Date() } });
          await tx.incomingCall.update({ where: { id: call.id }, data: markIrrelevant(updated.count > 0) });
          return updated.count > 0;
        });
        clientRemoved = softRemoved;
        callMarked = true;
        if (softRemoved) {
          // Мимо trashClient — тот же класс бага, что у слияния дубликатов и
          // вебхука сайта (разведка 07.09): просьба о звонке по этой карточке
          // (маловероятна для нетронутой заглушки, но не исключена — оператор мог
          // успеть попросить перезвонить до пометки «не по делу») иначе продолжала
          // бы висеть, и крон автопрозвона звонил бы удалённому клиенту.
          // Спутники гасим ПОСЛЕ коммита: своя транзакция внутри, и к атомарности
          // пары «карточка + звонок» отношения не имеют.
          await closeClientSatellites(clientId);
          void logSystemError(
            "telephony",
            `Карточка «не по делу» не удалилась, отправлена в Корзину: ${err instanceof Error ? err.message : err}`
          );
        }
      }
    }
  }

  // Карточку не трогали (живой клиент или её и не было) — отмечаем только звонок.
  if (!callMarked) {
    await prisma.incomingCall.update({ where: { id: call.id }, data: markIrrelevant(clientRemoved) });
  }

  // Звонок помечен «не по делу»: из очереди неразобранных он ушёл.
  publishCallUpdated({ callId: call.id });
  if (clientRemoved && call.clientId) publishClientUpdated({ clientId: call.clientId, actorId: input.operatorId });

  return { clientId: null, clientShortId: null, assignedAgentName: null, clientRemoved };
}

/**
 * Карточка под звонок, у которого её не оказалось: автосоздание было выключено,
 * звонок был непринятым, либо номер когда-то помечали «не по делу».
 *
 * Заводится ровно тем же способом, что и автоматически в момент разговора, — чтобы
 * не появилось второго определения «как выглядит карточка по звонку». Возвращает id
 * существующей карточки, если она всё-таки нашлась (номер могли завести руками,
 * пока оператор печатал).
 */
export async function createClientForCall(phone: string): Promise<string | null> {
  const existing = await prisma.client.findUnique({ where: { phone }, select: { id: true, deletedAt: true } });
  // Карточка в Корзине: оживлять её разбором звонка не наше решение — её удалил
  // человек. Отдаём отказ, оператор увидит понятное сообщение.
  if (existing) return existing.deletedAt ? null : existing.id;

  // Номер сотрудника — карточку под ручную квалификацию не заводим (см.
  // lib/staffPhoneGuard.ts): оператор своими руками подтвердил «это покупатель»
  // про собственного коллегу, чей номер оказался в журнале входящих.
  const staffMatch = await findStaffPhone([phone]);
  if (staffMatch) {
    void logSystemError("telephony", `Карточка при разборе звонка не заведена: ${staffPhoneError(staffMatch)}`);
    return null;
  }

  try {
    const created = await prisma.client.create({
      data: {
        // Номер в имени — замаскирован (B16, 02.10.2026): имя видно в списках и
        // уведомлениях и тем, кому номер закрыт. Так же, как incomingCalls.ts и
        // voicemailIngest.ts; сам номер живёт в `phone` и открывается правом.
        fullName: `Входящий ${maskClientPhone(phone)}`,
        phone,
        source: "PHONE_CALL",
        kind: "OTHER",
        status: "NEW",
        currency: "TJS",
      },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    void logSystemError("telephony", `Карточка при разборе звонка не заведена: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * ЖУРНАЛ УЗНАВАНИЯ ОБЪЕКТА — В КАРТОЧКЕ (24.09.2026, живой звонок про ОБ-000118).
 * Раньше итог узнавания не оставлял следа нигде: лид ушёл раздачей, и понять,
 * узнала ли CRM объект и почему нет, было не из чего. Теперь запись о звонке
 * говорит, какой объект узнан и по каким приметам, а если уверенно не узнан —
 * какие похожи и чьи они, чтобы агент или оператор решили сами.
 */
function identificationNote(
  found: Awaited<ReturnType<typeof identifyProperty>>,
  how: { byRobot: boolean; toOwner: boolean }
): string | null {
  const describe = (c: (typeof found.candidates)[number]) =>
    `${formatPropertyCode(c.shortId)}${c.agentName ? ` (агент ${c.agentName})` : ""}` +
    (c.signals.length ? ` — ${c.signals.join(", ")}` : "");
  if (found.propertyId) {
    const top = found.candidates.find((c) => c.id === found.propertyId);
    if (!top) return null;
    const head = how.byRobot
      ? `Объект ${formatPropertyCode(top.shortId)}${top.agentName ? ` (агент ${top.agentName})` : ""} узнал консультант в разговоре`
      : `Узнан объект ${describe(top)}`;
    /**
     * УЗНАН, НО ЛИД НЕ У АГЕНТА ОБЪЕКТА — СКАЗАТЬ ПОЧЕМУ (24.09.2026). Раньше
     * запись молчала, и «узнан объект агента Y», а лид у Z, выглядело поломкой.
     */
    if (how.toOwner) return head;
    const why =
      top.status === "SOLD"
        ? "объект уже продан"
        : top.status !== "AVAILABLE" && top.status !== "RESERVED"
          ? "объект снят с продажи"
          : "агент объекта сейчас не принимает лиды (отключён или не на связи)";
    return `${head}. Лид ушёл обычной раздачей: ${why}.`;
  }
  if (found.candidates.length === 0) return null;
  return `Объект по приметам уверенно не узнан. Похожие: ${found.candidates.map(describe).join("; ")}`;
}

