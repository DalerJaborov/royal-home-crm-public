import { Prisma, type Client } from "../../generated/prisma/client.js";
import { prisma, type TxClient } from "../../db.js";
import { changeClientAgent } from "../../lib/changeClientAgent.js";
import { reactivationResetData } from "../../lib/clientLifecycle.js";
import { logTimeline } from "../../lib/timeline.js";
import { noticeInterestInOtherAgentProperty } from "../../lib/propertyInterestNotice.js";
import { matchesUniqueConstraint } from "../../lib/prismaUniqueConflict.js";
import { findPhoneOwners, pickFreeExtraPhones } from "../../lib/clientPhones.js";
import { findClientByPhoneDigits } from "../../lib/whatsappPhone.js";
import { dushanbeWallClock } from "../../lib/dushanbeTime.js";
import { type ClientSource, type ClientKind } from "@royal-home/shared";
import { sendPushToAgent, sendPushToAgents, closeLeadPushNotification } from "../../push.js";
import { sendLeadPush } from "../../lib/pushLeadActions.js";
import { findAgentsWithPermission } from "../../lib/recipients.js";
import { activeLeadCounts, loadLeadLimits, slotsTaken } from "../../lib/leadLimits.js";
import { requestedAgentStillAvailable } from "../../lib/requestedAgent.js";
import { decideReturningClient, preferredReturningOwnerId } from "../../lib/returningClientRouting.js";
import { notifyOwnerReturningBuyerSickAgent } from "../../lib/returningBuyerOwnerNotice.js";
import { noticeAbsentAgentReturn } from "../../lib/absentAgentNotice.js";
import { fuzzySimilarClientNotes } from "../../lib/fuzzySearch.js";
import { findFuzzyDuplicateCandidate, openDuplicateReview } from "../../lib/duplicateReview.js";
import { assignAgentForLead, recordAssignReason, recordAssignReasonTx, type LeadAssignment } from "./assignment.js";
import { findStaffPhone, staffPhoneError, loadStaffPhoneChecker, StaffPhoneLeadError } from "../../lib/staffPhoneGuard.js";
import { logSystemError } from "../../lib/systemError.js";
import { logSystemAudit } from "../../lib/audit.js";
import { canAutomationChangeKind } from "../../lib/kindChangePolicy.js";
import { closeOwnershipSatellites } from "../../lib/ownershipSatellites.js";
import { returnAcceptDueFromNow } from "../../lib/workingDue.js";
import { customerIntakeProgressSchema } from "../../lib/customerIntakeContext.js";

export interface ChannelLeadInput {
  fullName: string;
  phone: string;
  source: ClientSource;
  /// BUYER (по умолчанию) или SELLER — продавец попадает в отдельную вкладку «Продавцы».
  kind?: ClientKind;
  budgetMin?: number;
  budgetMax?: number;
  desiredDistrictId?: string;
  desiredRooms?: number;
  /// Тип жилья из разговора с ботом. Раньше выбрасывался: хранить было негде.
  desiredType?: string;
  requirementsNotes?: string;
  telegramChatId?: string;
  telegramUsername?: string;
  /// Номер WhatsApp, с которого клиент пишет (wa_id, см. lib/whatsappPhone.ts).
  /// Отдельно от phone: это адрес переписки, а не обязательно номер для звонка.
  /// Если карточка уже существует — только дозаполняется, никогда не перетирается.
  whatsappPhone?: string;
  /// ОСТАЛЬНЫЕ номера, найденные в сообщении клиента (extractAllPhones,
  /// ai/leadQualifier.ts). 18.08.2026: продавец прислал боту четыре номера
  /// столбиком, в карточку уходил один, а три остальных агент переписывал в
  /// заметки текстом — то есть терял для системы. Сюда попадает всё, кроме
  /// главного; чужие и уже записанные отсеет pickFreeExtraPhones.
  extraPhones?: string[];
  /// Канал и идентификатор собеседника, если лид пришёл из переписки. Нужны
  /// правилу «свой объект»: показы объектов записаны на пару (канал, собеседник)
  /// и к карточке клиента привяжутся только ПОСЛЕ её создания — то есть в момент
  /// выбора агента другого следа у них нет.
  channel?: string;
  recipientId?: string;
  endpointScopeId?: string;
  /**
   * ОБЪЕКТ НАЗВАН ЯВНО (Пачка 1 п.5, 11.09.2026): заявка с сайта пришла со
   * страницы конкретного объекта (`pageUrl` в routes/webhooks.ts, разобран
   * lib/resolvePropertyFromPageUrl.ts) — лид уходит его хозяину безусловно, выше показа
   * бота и совпадения по описанию (см. LeadAssignContext.propertyId).
   */
  propertyId?: string;
  /**
   * НИК СОЦСЕТИ И ЕГО СЕТЬ (закрывает п.10 разбора 31.08.2026: «новые карточки
   * поле не заполняют»). Заполняется вызывающей стороной (messengers/conversation.ts)
   * из профиля канала — тем же признаком «это ник, а не имя», что и разовый
   * скрипт переноса старых карточек (looksLikeSocialUsername, lib/clientOrigin.ts).
   * Право показывать это поле проверяется на выдаче (withHiddenOrigin), здесь
   * ограничений нет — карточка создаётся один раз, значение просто кладём.
   */
  socialUsername?: string;
  socialChannel?: string;
  /// Лид пришёл вне рабочих часов (см. lib/workingHours.ts) — не запускаем
  /**
   * КОГО КЛИЕНТ НАЗВАЛ САМ («мне нужен Умед») — решение владельца 18.08.2026.
   * Уже проверенный по базе id из lib/requestedAgent.ts: имя разбирает бот в
   * переписке, сюда попадает только однозначно определённый и доступный агент.
   * Перед назначением доступность сверяется ЕЩЁ РАЗ — между репликой клиента и
   * заявкой проходят часы, за которые агента могли уволить или он сам выключил
   * приём лидов.
   */
  requestedAgentId?: string;
  /** Что записать в хронологию про названного агента — включая случаи, когда лид
   *  ушёл в обычную очередь (тёзки, сотрудник недоступен). Терять этот факт нельзя:
   *  агент узнает о нём от самого клиента («я же просил Баходура»). */
  requestedAgentNote?: string;
  /// pickAgentForLead сейчас, лид остаётся без агента до утренней волны
  /// (assignPendingLeads, вызывается кроном при входе в рабочее окно). Молча,
  /// без пуша руководству — это ожидаемая ночная норма, а не сбой.
  deferAssignment?: boolean;
}

/**
 * Создаёт лида, пришедшего из автоматического канала (Telegram-бот и т.п.), через тот же
 * движок распределения, что и лиды от сотрудников (pickAgentForLead) — единая точка входа,
 * чтобы "уровень 2" (справедливое распределение) работал одинаково для всех источников.
 * По телефону — не дублирует существующего клиента, просто привязывает канал к нему.
 */
/**
 * Как называть источник обращения в записях и уведомлениях — БЕЗ названия платформы
 * (решение владельца 12.09.2026, ОТМЕНА запрета 17.08.2026: «пусть любой агент
 * видит, откуда пришёл клиент и в каком мессенджере общаются»).
 *
 * С 17.08 по 12.09 здесь стоял нейтральный «бот в мессенджере» — чтобы канал не
 * утёк агенту через текст заметки хронологии и пуша. Запрет снят: право
 * `clients.viewOrigin` теперь входит во все пресеты ролей (см.
 * packages/shared/src/permissions.ts), и прятать канал в тексте больше не от кого,
 * а агенту он нужен прямо в заметке — чтобы знать, куда отвечать.
 *
 * Имя константы оставлено прежним намеренно: на него ссылаются комментарии и
 * тесты, а смысл поля тот же — подпись канала для текста заметки.
 */
const NEUTRAL_CHANNEL_LABEL: Record<string, string> = {
  TELEGRAM: "Telegram-бот",
  WEBSITE: "сайт",
  INSTAGRAM: "Instagram-бот",
  FACEBOOK: "Facebook-бот",
  WHATSAPP: "WhatsApp-бот",
};

/** Не слать второй пуш о том же самом повторном обращении: вебхук сайта иногда
 *  дублирует отправку формы при плохой связи у клиента, а бот может завести
 *  этот путь дважды подряд, если сообщения пришли пачкой. Окно короткое —
 *  это защита от дублей одного события, а не троттлинг реальных обращений. */
const REPEAT_CONTACT_DEDUPE_MS = 5 * 60_000;

/** Нарушение уникальности телефона: карточку с этим номером успели создать
 *  параллельно (заявка с сайта и ход бота приходят в одну секунду). */
function isPhoneConflict(err: unknown): boolean {
  return matchesUniqueConstraint(err, "phone");
}

/**
 * Нарушение уникальности telegramChatId (аудит №4, 27.08).
 *
 * Чат уже привязан к ДРУГОЙ карточке — обычно после слияния дубликатов, где
 * chatId уехал в основную карточку. Раньше такой P2002 пролетал мимо всех
 * веток восстановления: бот отвечал живому клиенту «сейчас не получается
 * оформить заявку, позвоните нам напрямую», заявка и продиктованный номер
 * терялись, а в журнал ошибок не попадало ничего.
 */
function isTelegramChatConflict(err: unknown): boolean {
  return matchesUniqueConstraint(err, "telegramChatId");
}

export async function createLeadFromChannel(
  input: ChannelLeadInput
): Promise<{ clientId: string; created: boolean }> {
  let existing = await prisma.client.findUnique({ where: { phone: input.phone } });
  /**
   * НОМЕР ЕСТЬ У ЖИВОЙ КАРТОЧКИ — ОБРАЩЕНИЕ К НЕЙ (23.09.2026, проверка раздачи,
   * пункт 17). Главный номер уникален, но после слияния дублей он остаётся у
   * карточки в Корзине, а к основной переезжает запасным. Поиск только по
   * главному номеру находил карточку из Корзины и воскрешал её вторым лидом
   * другому агенту. Живая карточка с этим номером (запасной, WhatsApp) важнее
   * удалённой: один номер — один хозяин (lib/clientPhones.ts). Случай «главным
   * номером не записан ни у кого» разбирает поиск по цифрам ниже.
   */
  if (existing?.deletedAt) {
    const [live] = await findPhoneOwners([input.phone], { limit: 1 });
    if (live) existing = await prisma.client.findUnique({ where: { id: live.id } });
  }
  if (existing) return resumeExistingChannelLead(existing, input);

  /**
   * ТЕРПИМЫЙ ПОИСК ПО ХВОСТУ НОМЕРА (аудит №4, 27.08).
   *
   * Точное совпадение строки промахивается на ровном месте: бот нормализует
   * продиктованный номер в «+992910001044», а карточки, заведённые руками,
   * хранят его «как набрали» — «+992 910 00 10 44», «992-90-…». Клиент своего
   * же агента писал боту, диктовал номер — и получал ВТОРУЮ карточку, которая
   * уходила другому агенту по очереди: ровно тот увод клиента, ради которого
   * заведены запасные номера и слияние. Поиск по последним девяти цифрам уже
   * используется телефонией и WhatsApp-опознанием, здесь его не было.
   */
  const byDigits = await findClientByPhoneDigits(input.phone);
  if (byDigits) {
    const sameClient = await prisma.client.findUnique({ where: { id: byDigits.id } });
    if (sameClient) return resumeExistingChannelLead(sameClient, input);
  }

  /**
   * ГОНКА ПО ОДНОМУ НОМЕРУ — ЭТО НОРМА, А НЕ ОШИБКА.
   *
   * Между findUnique выше и create ниже карточку с тем же телефоном мог завести
   * кто угодно: человек отправляет форму на сайте и тут же пишет боту, вебхук Meta
   * доставляет сообщение дважды. Раньше это кончалось так: у бота — заглушка
   * «позвоните нам» при фактически созданном лиде, у /website-lead — 500 и потеря
   * заявки на стороне сайта. Проигравший гонку просто продолжает как с уже
   * существующим клиентом: результат тот же, что при обычном повторном обращении.
   */
  try {
    return await createNewChannelLead(input);
  } catch (err) {
    if (isTelegramChatConflict(err) && input.telegramChatId) {
      // Чат уже принадлежит другой карточке — ведём человека по ней, а не
      // отвечаем ему «позвоните нам напрямую» с потерей заявки.
      const chatOwner = await prisma.client.findFirst({ where: { telegramChatId: input.telegramChatId } });
      if (chatOwner) return resumeExistingChannelLead(chatOwner, input);
    }
    if (!isPhoneConflict(err)) throw err;
    const raced = await prisma.client.findUnique({ where: { phone: input.phone } });
    if (!raced) throw err;
    return resumeExistingChannelLead(raced, input);
  }
}

/** Клиент с таким телефоном уже есть: воскрешаем из Корзины либо отмечаем
 *  повторное обращение. Второй карточки по одному номеру не бывает никогда. */
/**
 * СВОДКА ПО ЗВОНКАМ — АГЕНТУ, КОГДА CRM УЗНАЁТ ВОЗВРАЩАЮЩЕГОСЯ КЛИЕНТА (владелец
 * 19.08.2026). Бот сам ничего не обсуждает в момент приёма заявки (нарочно скупой
 * промт — см. acceptLead), поэтому «клиент не переспрашивает уже известное»
 * решается не через бота, а через то, что видит АГЕНТ, открыв карточку: сводка
 * последних звонков — прямо в заметке о повторном обращении, а не спрятана
 * где-то в хронологии, которую ещё надо пролистать.
 */
async function recentCallSummaryFor(clientId: string): Promise<string | null> {
  const calls = await prisma.interaction.findMany({
    where: { clientId, type: "CALL", callAnalysis: { isNot: null } },
    orderBy: { createdAt: "desc" },
    take: 2,
    select: { createdAt: true, callAnalysis: { select: { summary: true } } },
  });
  if (calls.length === 0) return null;
  return calls
    .reverse()
    .map((c) => `${dushanbeWallClock(c.createdAt).toISOString().slice(0, 10)}: ${c.callAnalysis!.summary}`)
    .join(" | ");
}

export const KIND_LABELS_RU: Record<string, string> = { BUYER: "Покупатель", SELLER: "Продавец", OTHER: "Прочее" };

/**
 * ПОКУПАТЕЛЬ↔ПРОДАВЕЦ НА УЖЕ ЗАВЕДЁННОЙ КАРТОЧКЕ — НИКОГДА МОЛЧА (разбор
 * 18.09.2026, жалоба агента Нозы: карточки путают, кто покупатель, а кто продавец).
 *
 * Общий кусок с `kindChangeUpdate` ниже (тот же `dualIntent`, тот же текст записи),
 * вынесен отдельной функцией, потому что у звонков (lib/telephony/qualifyIncoming.ts)
 * `kind` пишется НЕ через `kindChangeUpdate` — там своя форма входных данных
 * (`QualifyIncomingCallInput`, без `desiredType`/кастов под неё), и подключать ради
 * одной проверки всю функцию было бы явной подгонкой форм друг под друга. Сам факт
 * «роль сменилась молча» проверяет ровно одна эта функция для обоих каналов —
 * дублировать её условие (а не только текст записи) означало бы ровно ту ошибку
 * «защита подключена не во всех каналах», из-за которой и была подана жалоба.
 */
export function describeRoleSwap(
  existingKind: ClientKind,
  newKind: ClientKind,
  existingRequirementsNotes: string | null
): { dualIntent: true; note: string } | null {
  if (existingKind === newKind) return null;
  const isRoleSwap = (existingKind === "BUYER" || existingKind === "SELLER") && (newKind === "BUYER" || newKind === "SELLER");
  if (!isRoleSwap) return null;
  const oldLabel = KIND_LABELS_RU[existingKind] ?? existingKind;
  const newLabel = KIND_LABELS_RU[newKind] ?? newKind;
  const note =
    `Тип обращения изменён: ${oldLabel} → ${newLabel} (новый запрос перекрыл прежний).` +
    " Прежние данные не стёрты — похоже, интересует и то, и другое." +
    (existingRequirementsNotes ? ` Прежний запрос (${oldLabel.toLowerCase()}): «${existingRequirementsNotes}»` : "");
  return { dualIntent: true, note };
}

/**
 * СМЕНА ТИПА КЛИЕНТА ПРИ ПОВТОРНОМ ОБРАЩЕНИИ (владелец 19.08.2026, переработка
 * 06.09.2026 — разбор слепых зон п.4).
 *
 * Живой пробел: телефон уникален и всегда находит ОДНУ и ту же карточку — но раньше
 * при повторном обращении `kind` никогда не трогался. Продавец полгода назад, теперь
 * пишет как покупатель — карточка молча оставалась «Продавец», хотя человек сейчас
 * покупает. Агент путается, а статистика (сколько у нас покупателей/продавцов) врёт.
 *
 * ДО 06.09.2026 ЗДЕСЬ ОБНУЛЯЛИСЬ budgetMin/budgetMax/desiredDistrictId/desiredRooms/
 * desiredType ПРИ ПЕРЕХОДЕ В ПРОДАВЦА — на живом деле это стирало настоящий, ещё
 * актуальный запрос покупателя, который заодно продаёт свою квартиру (обычный
 * случай в недвижимости, не редкость). Теперь эти поля НЕ трогаем вообще при уходе
 * из покупателей — они остаются как были, а не «пропадают молча». `kind` всё равно
 * переключается на актуальную сторону (от него зависит маршрутизация лида и подбор
 * объектов), а факт «у него есть и вторая сторона тоже» пишем отдельным флагом
 * `dualIntent` — не подменяем один enum на два независимых значения ради этого
 * (десятки мест в коде фильтруют по `kind`, а флаг — чисто аддитивная отметка).
 *
 * requirementsNotes не обнуляем молча — старый текст уходит в системную запись
 * хронологии (agent должен видеть, что человек хотел РАНЬШЕ), а поле получает
 * свежий текст того же хода.
 *
 * ТИП МЕНЯЕТ ЧЕЛОВЕК, ИИ ТОЛЬКО ПРЕДЛАГАЕТ, У ПРИНЯТОЙ КАРТОЧКИ (владелец
 * 21.09.2026, lib/kindChangePolicy.ts — единая точка с qualifyIncoming.ts и
 * newInquiryDetector.ts). Пока карточка не принята (`acceptedAt === null`),
 * смена типа при повторном обращении остаётся прежней — так лид вообще и
 * заводится/уточняется до появления ответственного. С МОМЕНТА ПРИЁМА automation
 * (эта функция вызывается только из бота/сайта — человека-актора тут никогда не
 * бывает) не пишет ни `kind`, ни завязанные на него поля, ни заметку, ни пуш:
 * тип решает агент сам. `changed`
 * в ответе — специально для вызывающего кода: он решает, была ли смена типа НА
 * САМОМ ДЕЛЕ (значит, можно, например, назначить агента внове завёдшемуся
 * покупателю/продавцу), или это только предложение, на которое ничего из
 * «карточка стала работой агента»/«карточка ушла из работы агента» реагировать
 * не должно — кроме самого текста в хронологии.
 */
export function kindChangeUpdate(
  existing: Client,
  input: ChannelLeadInput
): { data: Prisma.ClientUncheckedUpdateInput; note: string | null; changed: boolean } {
  if (!input.kind || input.kind === existing.kind) return { data: {}, note: null, changed: false };
  const oldLabel = KIND_LABELS_RU[existing.kind] ?? existing.kind;
  const newLabel = KIND_LABELS_RU[input.kind] ?? input.kind;
  if (!canAutomationChangeKind({ acceptedAt: existing.acceptedAt, currentKind: existing.kind, nextKind: input.kind })) {
    // Принятая карточка: тип решает агент сам, автоматика не пишет ничего
    // (владелец 21.09.2026) — ни поля, ни заметки, ни особого пуша.
    return { data: {}, note: null, changed: false };
  }
  const becomingBuyer = input.kind === "BUYER";
  // dualIntent имеет смысл только для настоящей смены РОЛИ (покупатель↔продавец) —
  // OTHER не роль, а «прочее обращение», совмещать с ней нечего.
  const isRoleSwap =
    (existing.kind === "BUYER" || existing.kind === "SELLER") &&
    (input.kind === "BUYER" || input.kind === "SELLER");
  /**
   * «ПРОЧЕЕ ОБРАЩЕНИЕ» НИКОГДА НЕ ОСТАЁТСЯ У АГЕНТА (17.09.2026).
   *
   * Тип менялся, а assignedAgentId оставался — и карточка «работа»/«аренда»/
   * «другой город» продолжала висеть в портфеле агента, с таймером принятия и
   * KPI. Живой случай: человек когда-то спрашивал про квартиру, потом написал
   * «барои кор», и кандидат остался у Нозы. В ветке возврата из Корзины такая
   * защита была с 30.08.2026 (revivedKind !== "OTHER"), в обычной — нет.
   *
   * lastAgentId не трогаем: если окажется, что человек всё-таки покупатель,
   * возвращать его будет к кому.
   */
  const becomingOther = input.kind === "OTHER";
  const data: Prisma.ClientUncheckedUpdateInput = {
    kind: input.kind,
    dualIntentConfirmedAt: null,
    dualIntentConfirmedById: null,
    ...(isRoleSwap ? { dualIntent: true } : {}),
    ...(becomingOther
      ? { assignedAgentId: null, acceptedAt: null, escalatedAt: null, ...(existing.assignedAgentId ? { lastAgentId: existing.assignedAgentId } : {}) }
      : {}),
    // Свежие поля покупателя пишем только когда СТАНОВИТСЯ покупателем и модель их
    // прислала — переход в продавца эти поля больше не трогает вовсе (см. выше).
    ...(becomingBuyer
      ? {
          ...(input.budgetMin !== undefined ? { budgetMin: input.budgetMin ?? null } : {}),
          ...(input.budgetMax !== undefined ? { budgetMax: input.budgetMax ?? null } : {}),
          ...(input.desiredDistrictId !== undefined ? { desiredDistrictId: input.desiredDistrictId ?? null } : {}),
          ...(input.desiredRooms !== undefined ? { desiredRooms: input.desiredRooms ?? null } : {}),
          ...(input.desiredType !== undefined ? { desiredType: (input.desiredType as never) ?? null } : {}),
          // Свежие значения только что записаны ДЛЯ ЭТОГО kind — снимаем метку
          // «поля от прежней роли» (Client.requirementsFieldsKind, план 03.09 §M).
          // Уходя ОТ покупателя метку НЕ трогаем: расхождение с Client.kind и есть
          // сигнал «эти цифры от прошлой роли», его читает ClientDetail.tsx.
          requirementsFieldsKind: "BUYER" as const,
        }
      : {}),
    ...(input.requirementsNotes ? { requirementsNotes: input.requirementsNotes } : {}),
  };
  const note =
    `Тип обращения изменён: ${oldLabel} → ${newLabel} (клиент пишет с новым запросом).` +
    (becomingOther && existing.assignedAgentId ? " Карточка снята с агента: такие обращения агентам не раздаются." : "") +
    (isRoleSwap ? " Прежние данные не стёрты — похоже, интересует и то, и другое." : "") +
    (existing.requirementsNotes ? ` Прежний запрос (${oldLabel.toLowerCase()}): «${existing.requirementsNotes}»` : "");
  return { data, note, changed: true };
}

/**
 * ВЕРНУВШИЙСЯ КЛИЕНТ УХОДИТ В РАЗДАЧУ — ТЕМ ЖЕ ПРАВИЛОМ, ЧТО НОВЫЙ (02.10.2026).
 * Возврат из Корзины и из «Неактивных» звал голую очередь (pickAgentForLead), и
 * объект, по которому человек вернулся (ссылка, пересланный пост, реклама, номер),
 * терялся: лид уходил первому по очереди, а не агенту объекта. Dan: «любой
 * интерес… должен распознаваться и своему агенту идти». Ничего не нашлось —
 * assignAgentForLead сам заканчивается той же очередью.
 */
async function returningLeadAgent(existing: Client, input: ChannelLeadInput, kind: string): Promise<string | null> {
  const assignment = await assignAgentForLead({
    clientId: existing.id,
    channel: input.channel,
    recipientId: input.recipientId,
    inquiryText: input.requirementsNotes,
    propertyId: input.propertyId,
    kind: kind === "SELLER" ? "SELLER" : "BUYER",
  });
  return assignment.agentId;
}

async function resumeExistingChannelLead(
  existing: Client,
  input: ChannelLeadInput
): Promise<{ clientId: string; created: boolean }> {
  const result = await resumeExistingChannelLeadInner(existing, input);
  // Объект назван, а карточка осталась у своего агента — агенту объекта сообщаем
  // (02.10.2026, lib/propertyInterestNotice.ts). Не ждём: заявка уже
  // оформлена, пуш — дополнение.
  if (input.propertyId) {
    void noticeInterestInOtherAgentProperty({ clientId: result.clientId, propertyId: input.propertyId });
  }
  return result;
}

async function resumeExistingChannelLeadInner(
  existing: Client,
  input: ChannelLeadInput
): Promise<{ clientId: string; created: boolean }> {
  // A new inbound message is retained by its channel, but cannot silently reopen
  // a completed/refused assignment. A manager makes that separate decision.
  if (existing.assignmentRefusedAt || existing.assignmentCompletedAt) return { clientId: existing.id, created: false };
  /**
   * НОМЕР СОТРУДНИКА В extraPhones/whatsappPhone ЭТОЙ КАРТОЧКИ НЕ ДОПИСЫВАЕМ
   * (см. lib/staffPhoneGuard.ts). Карточка `existing` уже легитимна (её номер —
   * не номер сотрудника, иначе она сюда бы не попала через createLeadFromChannel),
   * поэтому здесь не throw, а тихий пропуск поля — тот же приём, что уже есть у
   * pickFreeExtraPhones для чужих номеров. Один запрос на обе ветки ниже.
   */
  const staffPhone = await loadStaffPhoneChecker();
  const whatsappPhoneFromStaff = input.whatsappPhone && staffPhone([input.whatsappPhone]) ? null : input.whatsappPhone;
  // Карточка в Корзине — тоже совпадение по уникальному телефону, и раньше функция
  // просто отдавала created:false: сайт получал 200 «ок», а в CRM новой заявки не
  // появлялось нигде — ни карточки, ни пуша. Заявка терялась молча. Человек снова
  // обратился — значит он снова клиент: достаём карточку из Корзины и возвращаем
  // в обычный поток принятия со свежим таймером.
  if (existing.deletedAt) {
    /**
     * «ПРОЧЕЕ» НЕ ПОЛУЧАЕТ АГЕНТА ДАЖЕ ЧЕРЕЗ КОРЗИНУ (разбор 30.08.2026).
     *
     * Ветка воскрешения звала pickAgentForLead() безусловно — то есть карточка
     * арендатора или электрика, однажды удалённая руководством, при повторном
     * сообщении возвращалась В РАЗДАЧУ агентам. Это был третий обходной путь мимо
     * правила «OTHER не распределяется» (два других — ручное назначение в
     * routes/clients/lifecycle.ts и утренняя волна в reassignment.ts).
     *
     * Тип берём тот же, что запишется в карточку ниже: свежий из этого обращения,
     * а при его отсутствии — прежний из карточки.
     */
    const revivedKind = input.kind ?? existing.kind;
    /**
     * РЕАКТИВАЦИЯ К ПРЕЖНЕМУ АГЕНТУ (разбор 31.08.2026, п.12). Удалённый клиент
     * писал раньше конкретному агенту (Client.lastAgentId — пишется в trashClient
     * рядом с deletedAt), и владелец решил: карточка сперва предлагается ЕМУ, с
     * правом принять или отклонить — не улетает свежему агенту по карусели (как
     * было раньше в этой ветке) и не активируется молча.
     *
     * requestedAgentStillAvailable — та же проверка «доступен ли сотрудник прямо
     * сейчас» (уволен/заморожен/на паузе/не агент), что и у явно названного
     * клиентом агента (lib/requestedAgent.ts) — между удалением и сегодняшним днём
     * могло пройти что угодно.
     */
    /**
     * Кому достаётся вернувшийся клиент — решает lib/returningClientRouting.ts
     * (владелец 08.09.2026). Раньше здесь стояла общая проверка «доступен ли
     * сотрудник», из-за чего отпуск агента одинаково отбирал у него и покупателя,
     * и продавца с уже продающимся объектом, а пауза «не принимаю новых лидов»
     * отбирала даже его собственного вернувшегося клиента.
     */
    const route = await decideReturningClient({
      clientId: existing.id,
      kind: revivedKind,
      lastAgentId: await preferredReturningOwnerId(existing.assignedAgentId, existing.lastAgentId),
    });
    const offerAgentId = route.kind === "offer" ? route.agentId : null;
    /**
     * Клиент вернулся, а его агент отсутствует — объясняем это обоим
     * (lib/absentAgentNotice.ts). Передача уже решена правилом выше; здесь только
     * слова: клиенту — что его человек в отъезде, агенту — что клиент вернулся и
     * передан. Без этого клиент видит незнакомца вместо «своего», а агент выходит
     * из отпуска и обнаруживает, что карточки нет.
     *
     * Fire-and-forget: приём заявки важнее объяснений.
     */
    if (existing.lastAgentId && route.kind !== "offer") {
      void noticeAbsentAgentReturn({
        clientId: existing.id,
        absentAgentId: existing.lastAgentId,
        kind: route.kind === "keep" ? (route.reason === "seller-absent-agent" ? "kept" : "kept-buyer") : "handed-over",
      }).catch((err) =>
        console.error("[возврат] объяснение об отсутствии:", err instanceof Error ? err.message : err)
      );
    }
    /**
     * ПОКУПАТЕЛЬ ВЕРНУЛСЯ, А ЕГО АГЕНТ НА БОЛЬНИЧНОМ (владелец 16.09.2026). Карточка
     * остаётся за агентом — система её не отнимает, — но владелец обязан об этом
     * узнать: передавать или нет, решает он. Без этой строки случай был бы тихим:
     * клиент ждёт, агент болеет, и никто не знает.
     */
    if (route.kind === "keep" && route.notifyOwner) {
      void notifyOwnerReturningBuyerSickAgent(existing.id, route.agentId).catch((err) =>
        console.error("[возврат] уведомление владельцу:", err instanceof Error ? err.message : err)
      );
    }
    // «keep» — карточка просто оживает у своего агента, без предложения и без
    // очереди: продавец при любом отсутствии, покупатель при больничном.
    // Половина защиты «OTHER не у агента» здесь уже была (revivedKind !== "OTHER"
    // ниже), но только для ветки очереди: при route.kind === "keep" карточка
    // «работа»/«аренда» оживала прямо у прежнего агента. Дыра того же класса, что
    // чинится в kindChangeUpdate выше (17.09.2026) — закрываем одинаково.
    const keepAgentId = route.kind === "keep" && revivedKind !== "OTHER" ? route.agentId : null;
    // Прежнему не предлагаем и не оставляем — обычная раздача по очереди.
    /**
     * ТЕ ЖЕ ПРАВИЛА, ЧТО У НОВОЙ ЗАЯВКИ (B5 глубокой проверки 02.10.2026). Раньше
     * здесь стоял голый pickAgentForLead(): ночью агент назначался непринятым лидом
     * (пуш глушат тихие часы, в 09:30 карусель видит «не принят с ночи»), продавец
     * упирался в лимит покупателей (kind не передавался), а клиент, спросивший про
     * конкретный объект, уходил мимо агента этого объекта. Теперь ночью — без
     * агента, утренней волне (объект запоминаем, как у возврата из «Неактивных»
     * ниже); днём — общая лесенка assignAgentForLead (объект → пост → очередь).
     */
    const revivedQueueAssignment: LeadAssignment | null =
      route.kind === "queue" && revivedKind !== "OTHER" && !input.deferAssignment
        ? await assignAgentForLead({
            clientId: existing.id,
            channel: input.channel,
            recipientId: input.recipientId,
            inquiryText: input.requirementsNotes,
            propertyId: input.propertyId,
            kind: revivedKind === "SELLER" ? "SELLER" : "BUYER",
          })
        : null;
    const assignedAgentId = route.kind === "queue" ? (revivedQueueAssignment?.agentId ?? null) : keepAgentId;
    // Считаем ДО транзакции: pickFreeExtraPhones ходит в базу за чужими номерами,
    // и держать транзакцию открытой ради справочного запроса незачем.
    const revivedExtra = await pickFreeExtraPhones((input.extraPhones ?? []).filter((p) => !staffPhone([p])), {
      clientId: existing.id,
      phone: existing.phone,
      whatsappPhone: existing.whatsappPhone ?? input.whatsappPhone,
      existing: existing.extraPhones,
    });
    /**
     * `acceptedAt: null` — НЕ состояние карточки ДО Корзины, а то, каким оно
     * СТАНЕТ прямо этой транзакцией (несколькими строками выше): возврат из
     * Корзины всегда заново непринятый лид (`acceptedAt: null` в самом апдейте
     * ниже), независимо от того, была ли карточка принята до удаления. Отдавая
     * сюда старое `existing.acceptedAt`, мы бы блокировали ИИ-поправку типа на
     * КАЖДОМ возврате когда-то принятой карточки — то есть ровно тогда, когда
     * поправка нужнее всего (человек полгода назад продавал, а Корзину открыли,
     * потому что сделка сорвалась; сейчас он снова пишет и явно покупает).
     */
    const kindChange = kindChangeUpdate({ ...existing, acceptedAt: null }, input);
    // Особенно ценно именно здесь: новому (или прежнему, но давно не говорившему)
    // агенту достаётся клиент, о котором он мог ничего не помнить — без сводки он
    // бы не знал вообще ничего о прошлых разговорах.
    const callSummary = await recentCallSummaryFor(existing.id);
    // client.update и interaction.create — одной транзакцией: если вторая запись
    // упадёт после первой, карточка останется с назначенным агентом, но без записи
    // об этом и без пуша (см. пуш ниже, который тоже зависит от interaction),
    // и лид молча зависнет у агента, который о нём не узнает. Тот же паттерн
    // атомарности, что у reassignStaleLeads/assignPendingLeads ниже в этом файле.
    /**
     * СРОК ПРИНЯТЬ ВОСКРЕСШУЮ КАРТОЧКУ (23.09.2026, аудит №21). Она снова
     * непринятая (acceptedAt: null), но карусель «не принял — следующему» берёт
     * только карточки без прошлого контакта (firstContactAt, закон П-2), а
     * такой из Корзины почти всегда уже говорили. Без таймера возврата лид висел
     * у агента без напоминаний и эскалации — тот же таймер, что у вернувшегося
     * из Потерянных (reassignStaleReturns). Пока это только предложение
     * прежнему агенту — не ставим: решает он сам.
     */
    // Срок — в рабочих минутах (решение владельца 02.10.2026, B4): ночь не съедает его.
    const returnAcceptDueAt = assignedAgentId && !offerAgentId ? await returnAcceptDueFromNow() : null;
    const revived = await prisma.$transaction(async (tx) => {
      const updated = await tx.client.update({
        where: { id: existing.id },
        data: {
          // Сброс полей светофора и «Потерянных» (23.09.2026). Раньше писался
          // только status: "NEW", а workStatus INACTIVE, исчерпанный счётчик
          // напоминаний, старые inactiveSince/lostAt оставались от прошлой жизни:
          // ближайший тик светофора снова уводил карточку в «Потерянные», а ночной
          // перенос — обратно в Корзину. Ветка с предложением прежнему агенту ниже
          // снова ставит INACTIVE, но уже без часов светофора и переноса.
          ...reactivationResetData(existing),
          deletedAt: null,
          deletedById: null,
          status: "NEW",
          returnedAt: new Date(),
          returnAcceptDueAt,
          acceptedAt: null,
          escalatedAt: null,
          reassignCount: 0,
          assignedAt: new Date(),
          // LAW-A2-PENDING: возврат из Корзины (Х1, ownership policy 17.09.2026) —
          // прямая запись мимо changeClientAgent; перевод — пачка А2.
          assignedAgentId,
          // Тот же сброс, что и у обычной реактивации ниже по файлу (не через
          // Корзину) — карточка в Корзине почти всегда попала туда уже LOST/
          // INACTIVE, и старые отказы не должны тянуться в новый заход клиента.
          ...(existing.refusalCount > 0 && (existing.status === "LOST" || existing.workStatus === "INACTIVE")
            ? { refusalCount: 0 }
            : {}),
          ...(offerAgentId
            ? {
                // Пока предложение не решено, карточка НЕ активна и НЕ закреплена
                // формально ни за кем (assignedAgentId выше остался null) — это
                // читает GET /clients/reactivation-offers (routes/clients/reactivationOffers.ts).
                workStatus: "INACTIVE" as const,
                reactivationOfferedToAgentId: offerAgentId,
                reactivationOfferedAt: new Date(),
              }
            : {}),
          ...(input.telegramChatId && !existing.telegramChatId
            ? { telegramChatId: input.telegramChatId, telegramUsername: input.telegramUsername }
            : {}),
          ...(whatsappPhoneFromStaff && !existing.whatsappPhone ? { whatsappPhone: whatsappPhoneFromStaff } : {}),
          ...(input.socialUsername && !existing.socialUsername
            ? { socialUsername: input.socialUsername, socialChannel: input.socialChannel }
            : {}),
          // Номера, названные при повторном обращении, — тоже к делу: карточка
          // воскресает целиком, вместе со всеми способами узнать этого человека.
          ...(revivedExtra.length > 0 ? { extraPhones: { set: [...existing.extraPhones, ...revivedExtra] } } : {}),
          // Объект, названный ночью, — утренней волне (Client.requestedPropertyId, B5).
          ...(route.kind === "queue" && input.deferAssignment && input.propertyId
            ? { requestedPropertyId: input.propertyId }
            : {}),
          ...kindChange.data,
        },
      });
      if (assignedAgentId) {
        const base = "Клиент из Корзины снова обратился — карточка восстановлена автоматически";
        // Актор — клиент (его обращение вернуло карточку), не агент (П-10,
        // 17.09.2026): агент к восстановлению не притрагивался.
        await logTimeline({
          clientId: updated.id,
          actor: { kind: "client", source: "intake-revive", subjectAgentId: assignedAgentId },
          type: "SYSTEM",
          notes:
            base +
            (kindChange.note ? ` ${kindChange.note}` : "") +
            (callSummary ? ` Из прошлых звонков: ${callSummary}` : ""),
          tx,
        });
      } else if (offerAgentId) {
        await logTimeline({
          clientId: updated.id,
          actor: { kind: "client", source: "intake-revive", subjectAgentId: offerAgentId },
          type: "SYSTEM",
          notes:
            "Клиент из Корзины снова обратился — предложено вернуть карточку прежнему агенту, ждёт решения" +
            (kindChange.note ? ` ${kindChange.note}` : "") +
            (callSummary ? ` Из прошлых звонков: ${callSummary}` : ""),
          tx,
        });
      }
      return updated;
    });
    /**
     * П-1/П-10 (17.09.2026, Х1 из `docs/audit/recon-17-09/02-auto-transfer-mechanisms.md`):
     * та же ситуация, что у ветки реактивации из «Неактивных» ниже по файлу —
     * `assignedAgentId` в транзакции выше пишется мимо `changeClientAgent`
     * (переводить всю "воскресительную" транзакцию на неё рискованнее, чем
     * добавить видимость отдельной записью). Пишем только когда владелец
     * РЕАЛЬНО поменялся против того, что было до Корзины.
     */
    if (assignedAgentId && assignedAgentId !== existing.assignedAgentId) {
      logSystemAudit("CLIENT_AGENT_CHANGE", "Client", revived.id, {
        source: "intake.basket-return",
        from: existing.assignedAgentId,
        to: assignedAgentId,
        reason: "Клиент из Корзины снова обратился — карточка восстановлена и назначена по очереди",
      });
    }
    // Причина назначения (свой объект, пост) — в карточку, как у новой заявки (B5).
    if (assignedAgentId && revivedQueueAssignment) {
      await recordAssignReason(revived.id, assignedAgentId, revivedQueueAssignment).catch((err) =>
        console.error("[intake] причина назначения после Корзины:", err instanceof Error ? err.message : err)
      );
    }
    if (assignedAgentId) {
      // Карточка вернулась НЕпринятой (acceptedAt: null выше) — значит, это
      // предложение лида: кнопки «Принять»/«Отклонить» и окно новой заявки
      // (sendLeadPush), как у любого другого пути выдачи (пункт 8 разбора 23.09).
      sendLeadPush(assignedAgentId, revived.id, {
        title: "🔔 Вернулся удалённый клиент",
        body: `${revived.fullName} снова оставил заявку — карточка восстановлена`,
        url: `/clients/${revived.shortId}`,
        tag: `lead-${revived.id}`,
      }).catch((err) => console.error("[push] восстановление клиента:", err));
    } else if (offerAgentId) {
      sendPushToAgent(offerAgentId, {
        title: "🔔 Прежний клиент снова написал",
        body: `${revived.fullName} — вернуть карточку себе?`,
        url: `/clients/${revived.shortId}`,
        tag: `reactivation-offer-${revived.id}`,
      }).catch((err) => console.error("[push] предложение реактивации:", err));
    }
    return { clientId: revived.id, created: false };
  }
  // Дозаполняем каналы связи, которых в карточке ещё не было. Именно дозаполняем:
  // уже записанный chatId/номер WhatsApp — тоже факт, перетирать его втихую нельзя.
  const enrich: Prisma.ClientUncheckedUpdateInput = {};
  if (input.telegramChatId && !existing.telegramChatId) {
    enrich.telegramChatId = input.telegramChatId;
    enrich.telegramUsername = input.telegramUsername;
  }
  if (whatsappPhoneFromStaff && !existing.whatsappPhone) enrich.whatsappPhone = whatsappPhoneFromStaff;
  // Ник — тоже дозаполняем, не перетираем: если карточка уже открыта админом с
  // одним ником, второе обращение из другой сети не должно тихо стереть первый.
  if (input.socialUsername && !existing.socialUsername) {
    enrich.socialUsername = input.socialUsername;
    enrich.socialChannel = input.socialChannel;
  }
  /**
   * Запасные номера ДОПИСЫВАЕМ, а не перетираем: клиент называет их по одному в
   * разных сообщениях, и второй заход не должен стирать то, что дал первый (и уж
   * тем более то, что вписал агент руками).
   */
  const freshExtra = await pickFreeExtraPhones((input.extraPhones ?? []).filter((p) => !staffPhone([p])), {
    clientId: existing.id,
    phone: existing.phone,
    whatsappPhone: existing.whatsappPhone ?? input.whatsappPhone,
    existing: existing.extraPhones,
  });
  if (freshExtra.length > 0) enrich.extraPhones = { set: [...existing.extraPhones, ...freshExtra] };
  const kindChange = kindChangeUpdate(existing, input);
  Object.assign(enrich, kindChange.data);
  /**
   * ВОЗВРАЩЕНИЕ НЕАКТИВНОГО (ТЗ п. 26-27, переработка 12.08.2026, доделка
   * 31.08.2026 — разбор жалобы владельца, п.12): клиент, которого агент отложил в
   * «Неактивные», написал сам.
   *
   * Без этого «Неактивный» был бы дверью в одну сторону: слот освобождён, клиент
   * закреплён за агентом навсегда и никогда сам не вернётся в лимит, даже когда
   * пришёл с деньгами. Полный флоу из ТЗ (предложить прежнему агенту как 7-го,
   * приоритеты зелёный/жёлтый/красный) владелец когда-то пометил «ещё продумываем,
   * пока без запуска» — теперь вернулся к этому: раньше здесь стояло безусловное
   * `enrich.workStatus = "ACTIVE"`, карточка тут же возвращалась в работу тому же
   * агенту БЕЗ права отказаться. Теперь — предложение с решением, тем же приёмом,
   * что и у ветки Корзины выше (offerAgentId/requestedAgentStillAvailable): агент
   * должен принять или отклонить возврат, а не получать его молча.
   */
  const reactivating = existing.workStatus === "INACTIVE";
  /**
   * ДЕРЖАТЕЛЬ ДЛЯ РАЗБОРА — ТЕКУЩИЙ ВЛАДЕЛЕЦ, А НЕ lastAgentId (ночная проверка
   * 24.09.2026, находка №1 круга «Клиенты и владение»).
   *
   * В отличие от Корзины, неактивная карточка владельца НЕ теряет: в момент
   * перевода в «Неактивные» deactivateClient пишет lastAgentId = assignedAgentId,
   * и оба поля совпадают. Расходятся они после передачи: раздача дел уволенного
   * (lib/agentHandover.ts) переносит и неактивных, а changeClientAgent ставит
   * lastAgentId = уволенный А, assignedAgentId = живой Б. Раньше разбор шёл по
   * lastAgentId: А уволен, frozenAt пуст → «на месте, но недоступен» → очередь →
   * pickAgentForLead — и карточка, включая ПРОДАВЦА, уезжала случайному третьему
   * агенту, хотя у неё есть живой владелец Б. Правила владельца (docs/JOURNAL.md
   * §4): продавец не уходит никогда, передаёт клиента только владелец.
   *
   * Поэтому решение исходит из assignedAgentId, когда он есть; lastAgentId —
   * только у карточки без владельца. Уволен ли сам владелец, в отпуске ли он и
   * что тогда делать с покупателем — по-прежнему решает decideReturningClient:
   * эта строка меняет лишь того, о ком спрашивают.
   */
  const returningHolderId = await preferredReturningOwnerId(existing.assignedAgentId, existing.lastAgentId);
  // Тот же разбор, что и в ветке Корзины выше (lib/returningClientRouting.ts).
  const route = reactivating
    ? await decideReturningClient({ clientId: existing.id, kind: existing.kind, lastAgentId: returningHolderId })
    : null;
  const offerAgentId = route?.kind === "offer" ? route.agentId : null;
  const keepAgentId = route?.kind === "keep" ? route.agentId : null;
  // Реактивация нужна, но прежнего агента предложить некому (уволен/заморожен/на
  // паузе, либо lastAgentId вовсе не проставлен на старых карточках) — обычная
  // раздача по очереди, чтобы клиент не завис без ответа (тот же fallback, что и
  // у ветки Корзины выше).
  //
  // Ночью (deferAssignment — те же часы раздачи, что у новой заявки) агента не
  // выбираем: карточку разберёт утренняя волна (пункт 19 проверки 23.09.2026).
  // kind — продавец не упирается в лимит покупателей (B5, 02.10.2026).
  const reactivationFallbackAgentId =
    route?.kind === "queue" && !input.deferAssignment ? await returningLeadAgent(existing, input, existing.kind) : null;
  /**
   * ВОЗВРАТ ИЗ «НЕАКТИВНЫХ» К НОВОМУ АГЕНТУ — ЭТО НОВЫЙ ЛИД (23.09.2026,
   * проверка раздачи, пункт 19). Раньше карточка уходила новому агенту с
   * прежним acceptedAt, то есть сразу «принятой»: без кнопки «Принять», без
   * срока первого звонка и без круга «не принял», иногда ночью. Теперь
   * новому агенту она приходит, как любой лид: ждёт принятия, с кнопками в пуше.
   * Отдать некому или ночь — карточка без агента ждёт утренней волны.
   */
  const returnsAsFreshLead = route?.kind === "queue";
  // Ночью объект, названный вернувшимся клиентом, — утренней волне.
  if (returnsAsFreshLead && input.deferAssignment && input.propertyId) enrich.requestedPropertyId = input.propertyId;
  if (offerAgentId) {
    // workStatus остаётся INACTIVE, пока агент не решил — см.
    // GET /clients/reactivation-offers (routes/clients/reactivationOffers.ts).
    // assignedAgentId НЕ трогаем: карточка и так его, предложение — не передача.
    enrich.reactivationOfferedToAgentId = offerAgentId;
    enrich.reactivationOfferedAt = new Date();
  } else if (keepAgentId) {
    /**
     * Продавец с работающим объектом при отсутствующем агенте: карточка оживает
     * у него же. Отдавать её другому нельзя — объект и так продаётся всей
     * компанией, и продавец, дожидаясь своего человека, ничего не теряет.
     */
    // LAW-A2-PENDING: реактивация, ветка keepAgentId (Х2, ownership policy
    // 17.09.2026) — прямая запись мимо changeClientAgent; перевод — пачка А2.
    enrich.workStatus = "ACTIVE";
    enrich.assignedAgentId = keepAgentId;
  } else if (returnsAsFreshLead) {
    // LAW-A2-PENDING: та же ветка, fallback-агент — см. комментарий выше.
    enrich.workStatus = "ACTIVE";
    enrich.assignedAgentId = reactivationFallbackAgentId;
    enrich.acceptedAt = null;
    enrich.assignedAt = new Date();
    enrich.escalatedAt = null;
    enrich.triedAgentIds = [];
    // НОВАЯ ЖИЗНЬ ЛИДА (ПР-000477, 25.09.2026) — карточка возвращается в очередь
    // как свежий лид (returnsAsFreshLead), значит и отказы прошлой жизни к ней
    // отношения больше не имеют: тот же принцип, что уже применён к
    // triedAgentIds строкой выше. В отличие от ручного назначения руководителем
    // (routes/clients/lifecycle.ts, POST /:id/assign) — там подбора агента нет
    // вовсе, и declinedAgentIds намеренно НЕ трогается.
    enrich.declinedAgentIds = [];
    enrich.reassignCount = 0;
  }
  // Реактивация ЗАВЕРШИЛАСЬ прямо сейчас (не превратилась в предложение) — именно
  // для этого случая ниже нужны таймер возврата и проверка лимита портфеля.
  const reactivatedImmediately = !!reactivationFallbackAgentId;
  /**
   * ПОТЕРЯННЫЙ ВЕРНУЛСЯ — К ТОМУ ЖЕ АГЕНТУ, БЕЗ ПЕРЕРАСПРЕДЕЛЕНИЯ (владелец
   * 19.08.2026, тот же принцип, что у Неактивных выше). LOST — предел передач
   * между агентами исчерпан, CRM перестала распределять карточку автоматически,
   * но это не значит «клиент навсегда потерян»: сам написал/позвонил — статус
   * возвращаем в работу, агент остаётся прежним, никакой новой очереди KPI.
   */
  if (existing.status === "LOST") enrich.status = "NEW";
  /**
   * ДЕРЖАТЕЛЬ ПОТЕРЯННОЙ КАРТОЧКИ МОГ СТАТЬ НЕДОСТУПЕН (ночная проверка
   * 24.09.2026, находка №118). `agentHandover.ts` при увольнении переносит
   * только АКТИВНЫЕ статусы (`MOVABLE_STATUSES`) — LOST туда специально не
   * входит: `markClientLost` оставляет `assignedAgentId` прежним. Если тот
   * агент потом уволен/заморожен, а клиент написал сам, ветка выше безусловно
   * возвращала статус в работу — карточка «оживала» на уволенном, и об этом
   * узнавали только через ~4 часа на утренней сверке. Тот же принцип проверки,
   * что уже стоит у входящего звонка (`lib/telephony/inboundRouting.ts`) и у
   * реактивации сообщением уже привязанного диалога (`messengers/conversation.ts`).
   *
   * Пока `reactivating` (реактивация из «Неактивных» выше) уже сама разобрала
   * держателя через `decideReturningClient` — здесь трогать нечего, иначе одна
   * ветка перепишет решение другой. Продавец тоже уходит в очередь: агента
   * уволили — это не временное отсутствие вроде отпуска, где действует
   * «продавец не уходит», а его исчезновение — легальный случай
   * agent_unavailable (см. `lib/reactivationOffers.ts`).
   */
  const lostHolderId = returningHolderId;
  const lostHolderUnavailable =
    existing.status === "LOST" &&
    !reactivating &&
    !lostHolderId;
  if (lostHolderUnavailable) {
    // LAW-A2-PENDING: та же ветка enrich, что keepAgentId/fallback выше, —
    // прямая запись мимо changeClientAgent; в AuditLog уходит строкой
    // CLIENT_AGENT_CHANGE (source intake.lost-holder-unavailable) ниже.
    enrich.assignedAgentId = null;
    enrich.escalatedAt = existing.kind === "OTHER" ? new Date() : null;
    enrich.acceptedAt = null;
    enrich.assignedAt = new Date();
    enrich.triedAgentIds = [];
    enrich.reassignCount = 0;
  }
  const lostHistoricalOwnerId = existing.kind !== "OTHER" && existing.status === "LOST" && !reactivating && lostHolderId !== existing.assignedAgentId
    ? lostHolderId : null;
  if (lostHistoricalOwnerId) {
    enrich.acceptedAt = null;
    enrich.assignedAt = new Date();
    enrich.escalatedAt = null;
  }
  /**
   * СЧЁТЧИК ОТКАЗОВ СБРАСЫВАЕТСЯ И ЗДЕСЬ, НЕ ТОЛЬКО НА ЗАКРЫТОЙ СДЕЛКЕ
   * (routes/deals.ts, комментарий там же) — найдено 01.09.2026. Раньше сброс
   * происходил единственный раз: при закрытии сделки. Если клиент вместо этого
   * ушёл в Неактивные/Потерянные после нескольких отказов, а потом написал/
   * позвонил САМ (без новой сделки), refusalCount так и оставался прежним —
   * карточка навсегда несла старые отказы. Свежий контакт спустя долгое
   * молчание — не продолжение того же отказного цикла, а новый заход: старые
   * отказы к нему отношения не имеют.
   *
   * ТОЛЬКО для реального возврата из LOST/Неактивных (reactivating — workStatus
   * был INACTIVE, либо status был LOST) — для обычного повторного сообщения уже
   * активного клиента сбрасывать нечего и незачем: это не «клиент вернулся»,
   * а «клиент продолжает разговор».
   */
  if ((reactivating || existing.status === "LOST") && existing.refusalCount > 0) enrich.refusalCount = 0;
  /**
   * РАННИЙ ВОЗВРАТ ИЗ «ОТЛОЖЕННЫХ» (задача G, план 03-04.09.2026) — клиент,
   * которого отложили по «дорого»/«финансы»/«не подошли объекты», написал сам
   * ДО срока таймера (Client.deferredUntil). В отличие от возврата из
   * Неактивных выше — здесь БЕЗ предложения агенту принять/отклонить: агент не
   * отказывался от клиента и не прекращал быть за него ответственным, отсрочка
   * не была его паузой, а фактом про клиента, поэтому возврат немедленный, тем
   * же принципом, что и у lib/deferredClients.ts::returnDeferredClientEarly
   * (та функция обслуживает симметричный путь — входящий ЗВОНОК, см.
   * lib/telephony/inboundRouting.ts; здесь тот же исход, но для переписки, где
   * карточка и так уже находится в этой функции ради дозаполнения полей).
   */
  const deferredEarlyReturn = existing.workStatus === "DEFERRED";
  if (deferredEarlyReturn) {
    enrich.workStatus = "ACTIVE";
    enrich.deferredUntil = null;
    enrich.deferredReason = null;
  }
  // «Клиент вернулся» — на КАЖДОЕ повторное обращение (см. Client.returnedAt),
  // не только при смене статуса: значок в списке должен появляться всегда,
  // когда телефон уже был у нас, а не только в «тяжёлых» случаях.
  enrich.returnedAt = new Date();
  // Агент, который реально получает карточку АКТИВНОЙ прямо сейчас: для обычной
  // реактивации это прежний assignedAgentId (не менялся), а для fallback-ветки
  // выше (прежнего агента предложить не вышло) — свежий agentId из очереди.
  // existing.assignedAgentId сам по себе тут не годится: он мог устареть ровно
  // в этой ветке (реактивация переехала на другого агента), а держатель
  // потерянной карточки — если он только что признан недоступным выше.
  let effectiveAgentId = returnsAsFreshLead
    ? reactivationFallbackAgentId
    : lostHolderUnavailable
      ? null
      : lostHistoricalOwnerId ?? existing.assignedAgentId;
  /**
   * ТАЙМЕР ВОЗВРАТА (владелец 21.08.2026) — ТОЛЬКО для двух случаев выше
   * (реактивация из Неактивных или из Потерянных), не на любое обычное
   * повторное обращение уже активного клиента: тому таймер ни к чему, у него и
   * так нет причины «зависнуть» — агент и не переставал с ним работать. Пока
   * реактивация — только ПРЕДЛОЖЕНИЕ (offerAgentId), таймер не нужен: решает
   * не срок, а сам агент через accept/decline.
   * reassignStaleReturns (выше по файлу) снимет клиента с прежнего агента и
   * отдаст в общую очередь, если тот не тронет карточку до этого срока.
   */
  // Не для нового агента (returnsAsFreshLead): у него срок — принятие лида.
  if (((reactivatedImmediately && !returnsAsFreshLead) || existing.status === "LOST") && effectiveAgentId) {
    // Срок — в рабочих минутах (решение владельца 02.10.2026, B4): ночь не съедает его.
    enrich.returnAcceptDueAt = await returnAcceptDueFromNow();
  }
  if (Object.keys(enrich).length > 0) {
    if (lostHistoricalOwnerId) {
      const changed = await changeClientAgent({
        clientId: existing.id,
        toAgentId: lostHistoricalOwnerId,
        source: "intake.lost-historical-owner",
        reason: "Клиент снова обратился — возвращён прежнему активному агенту",
        data: enrich,
        guardWhere: { assignedAgentId: existing.assignedAgentId, assignedAt: existing.assignedAt, status: "LOST" },
      });
      if (!changed.ok) return { clientId: existing.id, created: false };
    } else {
      await prisma.client.update({ where: { id: existing.id }, data: enrich });
    }
  }
  /**
   * П-1/П-10 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §2, §4, Х2 из
   * `docs/audit/recon-17-09/02-auto-transfer-mechanisms.md`): `enrich`
   * выше — прямая запись `assignedAgentId` мимо `changeClientAgent`, оставлена
   * НЕ переведённой на неё намеренно (весь блок enrich копит десяток полей
   * одним `update`, разбивать транзакцию ради одного поля рискованнее, чем
   * оставить как есть). Но смена владельца (keepAgentId/reactivationFallbackAgentId
   * — реактивация из «Неактивных», прежнего агента предложить не вышло) без
   * этой строки была не видна в AuditLog вовсе. Пишется только когда владелец
   * РЕАЛЬНО поменялся — обычное «тот же агент» (route.kind==="keep" на своего
   * же lastAgentId) писать незачем.
   */
  /**
   * НЕПРИНЯТЫЙ ЛИД СТАЛ «ПРОЧИМ ОБРАЩЕНИЕМ» (B11, 02.10.2026): kindChangeUpdate
   * снял агента прямой записью — у агента оставались уведомление и пуш «новый
   * лид» и открытые задачи, а аудит записывал чужую причину «Возврат из
   * Неактивных». Своя причина и гашение спутников, как при любой смене владельца.
   */
  const kindOtherDropped =
    kindChange.changed && input.kind === "OTHER" && !!existing.assignedAgentId && enrich.assignedAgentId === null;
  if (
    (typeof enrich.assignedAgentId === "string" || enrich.assignedAgentId === null) &&
    enrich.assignedAgentId !== existing.assignedAgentId
  ) {
    logSystemAudit("CLIENT_AGENT_CHANGE", "Client", existing.id, {
      source: kindOtherDropped
        ? "intake.kind-other"
        : lostHolderUnavailable
          ? "intake.lost-holder-unavailable"
          : "intake.reactivation-fallback",
      from: existing.assignedAgentId,
      to: enrich.assignedAgentId,
      reason: kindOtherDropped
        ? "Обращение оказалось не про покупку или продажу (прочее обращение) — карточка снята с агента"
        : lostHolderUnavailable
          ? "Потерянный клиент написал сам — прежний держатель недоступен, карточка возвращена в очередь раздачи"
          : "Возврат из Неактивных — прежнего агента предложить не вышло, назначен по очереди",
    });
  }
  if (kindOtherDropped) {
    await closeOwnershipSatellites({
      clientId: existing.id,
      clientShortId: existing.shortId,
      fromAgentId: existing.assignedAgentId,
      toAgentId: null,
      reason: "Обращение оказалось прочим — карточка снята с агента",
    });
  }

  /**
   * КАРТОЧКА СТАЛА РАБОТОЙ АГЕНТА — ЗНАЧИТ, АГЕНТ ЕЙ НУЖЕН (17.09.2026, ревью #455).
   *
   * Дыра, которую вскрыла отсечка «пришёл по рекламе и ничего не написал»: она
   * НАМЕРЕННО заводит карточку «прочим обращением» без агента, и это правильно —
   * пока человек молчит, назначать некого. Но когда он наконец говорит своё
   * («3 комнаты в Сино»), сюда приходит kind=BUYER, kindChangeUpdate честно меняет
   * тип — и на этом всё: `pickAgentForLead` в этой ветке звался ТОЛЬКО при
   * реактивации из «Неактивных». Карточка оставалась покупателем без агента, то
   * есть каждый клик по рекламе объекта превращался в потерянный лид.
   *
   * До отсечки дыра тоже была (OTHER → BUYER после «бот не понял»), но случалась
   * редко; с рекламой она стала бы массовой.
   *
   * Назначаем ТЕМ ЖЕ путём, что и новую заявку (createNewChannelLead ниже):
   * assignAgentForLead — это правило «свой объект», лимиты портфеля и стратегия
   * раздачи разом, а не просто «следующий по очереди». И тот же набор следствий:
   * assignedAt (с него считается таймер принятия), запись в хронологию, причина
   * назначения и push агенту. acceptedAt остаётся null — лид ещё надо принять.
   */
  const becameAgentWork =
    // `changed`, не `note !== null` (21.09.2026): у принятой карточки без агента
    // (теоретический край — обычно принятая карточка агента как раз держит) note
    // может быть только ПРЕДЛОЖЕНИЕМ, а не настоящей сменой — назначать агента
    // на несостоявшуюся смену типа нельзя.
    kindChange.changed &&
    (input.kind === "BUYER" || input.kind === "SELLER") &&
    !existing.assignedAgentId &&
    // Реактивация уже сама решила, кому достанется карточка, — не спорим с ней.
    !offerAgentId &&
    !keepAgentId &&
    !returnsAsFreshLead;
  if (becameAgentWork) {
    const assigned = await assignKindChangedLead(existing, input);
    if (assigned) effectiveAgentId = assigned;
  }
  // Возврат в ACTIVE — тот же слот в лимите, что и у нового лида (OCCUPIES_SLOT_WHERE
  // считает по workStatus), но клиенту, который сам написал, отвечать нужно в любом
  // случае — блокировать реактивацию из-за лимита нельзя. Вместо этого, если агент
  // из-за возврата оказался НАД лимитом (найдено код-ревью 13.08.2026 — раньше
  // проходило тихо), руководителю уходит то же уведомление, что и по лимиту лидов
  // в целом, чтобы решение о разгрузке портфеля принял человек, а не тишина.
  // reactivatedImmediately, не reactivating: пока реактивация — только предложение
  // (offerAgentId), в лимит она не садится вовсе, проверять нечего.
  if (reactivatedImmediately && effectiveAgentId) {
    void (async () => {
      try {
        const limits = await loadLeadLimits();
        if (limits.activeLimit <= 0) return;
        const counts = (await activeLeadCounts([effectiveAgentId!])).get(effectiveAgentId!);
        if (slotsTaken(counts, limits) <= limits.activeLimit) return;
        const supervisors = await findAgentsWithPermission("clients.assign");
        await sendPushToAgents(supervisors, {
          title: "⚠️ Портфель агента сверх лимита",
          body: `Вернувшийся клиент №${existing.shortId} довёл портфель агента выше настроенного лимита ${limits.activeLimit} — стоит разгрузить.`,
          url: `/clients/${existing.shortId}`,
          tag: `over-limit-reactivation-${existing.id}`,
        });
      } catch (err) {
        console.error("[leads] уведомление о превышении лимита при возврате:", err instanceof Error ? err.message : err);
      }
    })();
  }

  // Клиент, который у нас уже есть, обратился заново — принимать его как новый
  // лид не нужно (он и так чей-то), но раньше это проходило совсем молча: ни
  // записи, ни пуша, а закреплённый агент узнавал об этом, только сам открыв
  // «Сообщения». Найдено 11.08.2026 при разборе того, куда деваются повторные
  // обращения. Решение владельца: агент видит это как push и запись в карточке,
  // принимать заново не нужно.
  // Та же причина, что у label ниже: заметку и пуш о повторном обращении читает
  // агент, и платформу в них называть нельзя (NEUTRAL_CHANNEL_LABEL).
  const repeatLabel = NEUTRAL_CHANNEL_LABEL[input.source] ?? "внешний канал";
  const callSummary = await recentCallSummaryFor(existing.id);
  const repeatNote =
    `Клиент снова обратился: ${repeatLabel}${input.requirementsNotes ? ` — ${input.requirementsNotes}` : ""}` +
    (kindChange.note ? ` ${kindChange.note}` : "") +
    (deferredEarlyReturn ? " Вернулся из «Отложенных» раньше срока — снова в активной работе." : "") +
    (callSummary ? ` Из прошлых звонков: ${callSummary}` : "");
  const recentRepeat = await prisma.interaction.findFirst({
    where: {
      clientId: existing.id,
      type: "SYSTEM",
      notes: { startsWith: "Клиент снова обратился" },
      createdAt: { gte: new Date(Date.now() - REPEAT_CONTACT_DEDUPE_MS) },
    },
    select: { id: true },
  });
  if (!recentRepeat) {
    // effectiveAgentId, не existing.assignedAgentId напрямую — см. определение
    // выше: в fallback-ветке реактивации агент мог смениться этим же ходом.
    /**
     * СТАЛО «ПРОЧИМ» — ПРЕЖНЕМУ АГЕНТУ НЕ ПИШЕМ (17.09.2026).
     *
     * kindChangeUpdate выше уже снял его с карточки, и push «Клиент вернулся с
     * другим запросом» звал бы его к человеку, которого у него больше нет. Ровно
     * это и происходило с кандидатами на вакансию: агент шёл звонить соискателю
     * как покупателю. Запись в хронологию при этом остаётся — от его же лица,
     * он последним вёл карточку.
     *
     * `kindChange.changed`, не сырой `input.kind` (21.09.2026): если смена в
     * OTHER заблокирована политикой (карточка принята — kindChangeUpdate вернул
     * только предложение), карточка на самом деле НЕ покинула работу агента, и
     * снимать с него пуши/уведомления было бы враньём поверх вранья.
     */
    const movedOutOfAgentWork = kindChange.changed && input.kind === "OTHER";
    const noteAgentId = effectiveAgentId;
    if (returnsAsFreshLead && !movedOutOfAgentWork) {
      // Новому агенту — как новый лид, с кнопками «Принять»/«Отклонить»
      // (sendLeadPush). Без агента ночью молчим: утренняя волна пришлёт лид
      // сама; днём без агента — руководству, как у любой нераспределённой заявки.
      await logTimeline({
        clientId: existing.id,
        actor: { kind: "client", source: "intake-repeat-contact", subjectAgentId: noteAgentId },
        type: "SYSTEM",
        notes: repeatNote,
      });
      if (noteAgentId) {
        sendLeadPush(noteAgentId, existing.id, {
          title: "🔔 Вернувшийся клиент — вам",
          body: `${existing.fullName} — снова написал(а), прежний агент недоступен. Примите или отклоните`,
          url: `/clients/${existing.shortId}`,
          tag: `lead-${existing.id}`,
        }).catch((err) => console.error("[push] вернувшийся клиент новому агенту:", err));
      } else if (await supervisorsNeedRepeatPush(existing, input)) {
        const supervisors = await findAgentsWithPermission("clients.assign");
        sendPushToAgents(supervisors, {
          title: "🔔 Клиент без агента снова обратился",
          body: `${existing.fullName} — написал(а) через ${repeatLabel}, назначьте агента`,
          url: `/clients/${existing.shortId}`,
          tag: `repeat-contact-${existing.id}`,
        }).catch((err) => console.error("[push] повторное обращение без агента:", err));
      }
    } else if (noteAgentId && becameAgentWork) {
      /**
       * Агента назначили ПРЯМО СЕЙЧАС, и он уже получил push «новый лид» — второе
       * уведомление «клиент вернулся с другим запросом» про того же человека в ту
       * же секунду читается как сбой. Запись в хронологию при этом нужна: в ней
       * видно, с чем именно человек вернулся.
       */
      // Актор — клиент (он написал сам), не агент (П-10, 17.09.2026).
      await logTimeline({
        clientId: existing.id,
        actor: { kind: "client", source: "intake-repeat-contact", subjectAgentId: noteAgentId },
        type: "SYSTEM",
        notes: repeatNote,
      });
    } else if (noteAgentId && !movedOutOfAgentWork) {
      await logTimeline({
        clientId: existing.id,
        actor: { kind: "client", source: "intake-repeat-contact", subjectAgentId: noteAgentId },
        type: "SYSTEM",
        notes: repeatNote,
      });
      sendPushToAgent(noteAgentId, {
        title: deferredEarlyReturn
          ? "🙋 Отложенный клиент написал сам"
          : kindChange.changed
            ? "🔔 Клиент вернулся с другим запросом"
            : "🔔 Ваш клиент снова обратился",
        body: deferredEarlyReturn
          ? `${existing.fullName} — снова в вашей активной работе, таймер отсрочки отменён`
          : kindChange.changed
            ? `${existing.fullName} — теперь ${KIND_LABELS_RU[input.kind!]?.toLowerCase() ?? input.kind}, было ${KIND_LABELS_RU[existing.kind]?.toLowerCase() ?? existing.kind}`
            : `${existing.fullName} — написал(а) через ${repeatLabel}`,
        url: `/clients/${existing.shortId}`,
        tag: `repeat-contact-${existing.id}`,
      }).catch((err) => console.error("[push] повторное обращение:", err));
    } else if (movedOutOfAgentWork) {
      // Хронология от лица прежнего агента (или последнего исторического), а зовём
      // тех, кто разбирает «Прочие обращения» — там такая карточка теперь и живёт.
      const historyAgentId = noteAgentId ?? existing.lastAgentId;
      if (historyAgentId) {
        await logTimeline({
          clientId: existing.id,
          actor: { kind: "client", source: "intake-repeat-contact", subjectAgentId: historyAgentId },
          type: "SYSTEM",
          notes: repeatNote,
        });
      }
      if (noteAgentId) {
        await closeLeadPushNotification(noteAgentId, `lead-${existing.id}`).catch(() => {});
      }
      const owners = await findAgentsWithPermission("otherInquiries.view");
      sendPushToAgents(owners, {
        title: "🔔 Обращение больше не для агентов",
        body: `${existing.fullName} — теперь ${KIND_LABELS_RU[input.kind!]?.toLowerCase() ?? input.kind}, карточка снята с агента`,
        url: `/clients/${existing.shortId}`,
        tag: `repeat-contact-${existing.id}`,
      }).catch((err) => console.error("[push] обращение ушло из работы агента:", err));
    } else {
      // У карточки нет агента (ждёт ручного назначения, «Вручную» в Настройках) —
      // сообщать некому конкретно, обращение уходит руководству, как и у нового лида.
      // С чем человек вернулся, остаётся в хронологии и тогда, когда будить
      // руководство не нужно (24.09.2026, пункт 26).
      await logTimeline({
        clientId: existing.id,
        actor: { kind: "client", source: "intake-repeat-contact", subjectAgentId: null },
        type: "SYSTEM",
        notes: repeatNote,
      });
      if (await supervisorsNeedRepeatPush(existing, input)) {
        const supervisors = await findAgentsWithPermission("clients.assign");
        sendPushToAgents(supervisors, {
          title: "🔔 Клиент без агента снова обратился",
          body: `${existing.fullName} — написал(а) через ${repeatLabel}, назначьте агента`,
          url: `/clients/${existing.shortId}`,
          tag: `repeat-contact-${existing.id}`,
        }).catch((err) => console.error("[push] повторное обращение без агента:", err));
      }
    }
  }

  return { clientId: existing.id, created: false };
}

/**
 * БУДИТЬ ЛИ РУКОВОДСТВО ПРО КАРТОЧКУ БЕЗ АГЕНТА ПРЯМО СЕЙЧАС (24.09.2026,
 * разбор раздачи, пункт 26). Пуш «назначьте агента» нужен, только если лид
 * без человека иначе не разберётся. Ночью (`deferAssignment`) утренняя волна
 * раздаст его сама — то же правило silentDefer, что у новой заявки ниже; в
 * режиме «Вручную» волны нет, и молчать нельзя. Карточка, которая ждёт ответа
 * агента по возможному дублю (`duplicateReviewOfClientId`), разберётся ответом
 * или таймером — пуш руководителю звал назначить в обход этой проверки.
 */
async function supervisorsNeedRepeatPush(
  existing: Pick<Client, "duplicateReviewOfClientId">,
  input: Pick<ChannelLeadInput, "deferAssignment">
): Promise<boolean> {
  if (existing.duplicateReviewOfClientId) return false;
  if (!input.deferAssignment) return true;
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { leadDistributionStrategy: true },
  });
  return (settings?.leadDistributionStrategy ?? "fair") === "manual";
}

/**
 * Назначить агента карточке, которая только что перестала быть «прочим
 * обращением» (см. becameAgentWork в resumeExistingChannelLead).
 *
 * Повторяет путь новой заявки, а не изобретает свой: та же функция выбора
 * агента, та же единственная точка записи владельца (changeClientAgent), та же
 * запись в хронологию, та же причина назначения и тот же push. Возвращает id
 * назначенного агента либо null — лид не теряется и без агента: он виден в общей
 * очереди непринятых, а ночью его разберёт утренняя волна (assignPendingLeads).
 */
async function assignKindChangedLead(existing: Client, input: ChannelLeadInput): Promise<string | null> {
  const label = NEUTRAL_CHANNEL_LABEL[input.source] ?? "внешний канал";
  const reason = `Клиент назвал свой запрос — карточка вернулась в раздачу: ${label}`;

  // Вне рабочих часов назначение откладывается ровно как у новой заявки: ночью
  // лид всё равно некому взять, а таймер принятия шёл бы, пока агент спит.
  if (input.deferAssignment && input.propertyId) {
    // Объект, названный ночью, — утренней волне (см. Client.requestedPropertyId).
    await prisma.client.update({ where: { id: existing.id }, data: { requestedPropertyId: input.propertyId } });
  }
  const assignment: LeadAssignment = input.deferAssignment
    ? { agentId: null, reason: "queue" }
    : await assignAgentForLead({
        clientId: existing.id,
        channel: input.channel,
        recipientId: input.recipientId,
        inquiryText: input.requirementsNotes,
        propertyId: input.propertyId,
        // Продавец не упирается в лимит покупателей (владелец 20.08.2026).
        kind: input.kind === "SELLER" ? "SELLER" : "BUYER",
      });
  const agentId = assignment.agentId;
  if (!agentId) {
    // Некому прямо сейчас (режим «Вручную», нет активных агентов) — зовём
    // руководителя, иначе карточка молча зависнет покупателем без агента: ровно
    // то, что эта правка и чинит. Ночью молчим: утренняя волна раздаст сама
    // (24.09.2026, пункт 26).
    if (!(await supervisorsNeedRepeatPush(existing, input))) return null;
    const supervisors = await findAgentsWithPermission("clients.assign");
    sendPushToAgents(supervisors, {
      title: "🔔 Обращение стало лидом — нужен агент",
      body: `${existing.fullName} — назвал(а) свой запрос, назначьте агента`,
      url: `/clients/${existing.shortId}`,
      tag: `lead-${existing.id}`,
    }).catch((err) => console.error("[push] обращение стало лидом:", err));
    return null;
  }

  await prisma.$transaction(async (tx) => {
    // changeClientAgent — единственная точка записи assignedAgentId (аудит
    // владения 11.09.2026). assignedAt: с него считается таймер принятия;
    // acceptedAt намеренно не трогаем — лид ещё надо принять.
    await changeClientAgent({
      clientId: existing.id,
      toAgentId: agentId,
      reason,
      source: "intake.kindChangedToLead",
      tx,
      skipInteraction: true,
      data: { assignedAt: new Date(), acceptedAt: null, escalatedAt: null, reassignCount: 0 },
    });
    await logTimeline({
      clientId: existing.id,
      actor: { kind: "system", source: "intake-kind-changed", subjectAgentId: agentId },
      type: "SYSTEM",
      notes: reason,
      tx,
    });
  });
  await recordAssignReason(existing.id, agentId, assignment);
  sendLeadPush(agentId, existing.id, {
    title: `🔔 Новый лид: ${label}`,
    body: `${existing.fullName} — примите заявку, иначе её передадут другому агенту`,
    url: `/clients/${existing.shortId}`,
    tag: `lead-${existing.id}`,
  }).catch((err) => console.error("[push] обращение стало лидом:", err));
  return agentId;
}

/** Клиента с таким номером у нас ещё нет — заводим карточку и распределяем.
 *  Бросает P2002 по телефону, если карточку успели создать параллельно;
 *  разбирается с этим createLeadFromChannel. */
/**
 * ПУШ РУКОВОДИТЕЛЮ ПРИ ОЧЕНЬ ВЫСОКОМ СОВПАДЕНИИ ЗАМЕТОК (владелец 19.08.2026,
 * пункт 3 защиты от дублей). Баннер на карточке (GET /clients/:id/similar-notes,
 * порог 0.5) — пассивный, агент может его не заметить. Здесь порог заметно выше
 * (0.75): толкаем руководству только когда почти наверняка один и тот же
 * человек, а не намекаем на любое частичное сходство.
 *
 * Фоново и без await у вызывающей стороны: это не критично для приёма заявки,
 * а полный скан текстового сходства по базе не должен задерживать ответ клиенту.
 */
const HIGH_SIMILARITY_THRESHOLD = 0.75;

function notifySupervisorsOfHighSimilarityInBackground(clientId: string, fullName: string, notes: string): void {
  void (async () => {
    try {
      const matches = await fuzzySimilarClientNotes(clientId, notes, HIGH_SIMILARITY_THRESHOLD, 1);
      const match = matches[0];
      if (!match) return;
      const other = await prisma.client.findUnique({ where: { id: match.id }, select: { fullName: true } });
      if (!other) return;
      const supervisors = await findAgentsWithPermission("clients.merge");
      await sendPushToAgents(supervisors, {
        title: "⚠️ Похоже на дубликат карточки",
        body: `«${fullName}» очень похож на «${other.fullName}» (совпадение заметок ${Math.round(match.similarity * 100)}%) — проверьте`,
        url: `/clients/${clientId}`,
        tag: `similar-clients-${clientId}`,
      });
    } catch (err) {
      console.error("[лид] проверка похожих карточек:", err instanceof Error ? err.message : err);
    }
  })();
}

function channelLeadCreateData(input: ChannelLeadInput, kind: ClientKind, extraPhones: string[], includeCriteria: boolean): Prisma.ClientUncheckedCreateInput {
  return { fullName: input.fullName, phone: input.phone, source: input.source, kind, currency: "TJS",
    requirementsNotes: input.requirementsNotes, telegramChatId: input.telegramChatId,
    telegramUsername: input.telegramUsername, whatsappPhone: input.whatsappPhone,
    socialUsername: input.socialUsername, socialChannel: input.socialChannel, extraPhones,
    ...(includeCriteria ? { budgetMin: input.budgetMin, budgetMax: input.budgetMax,
      desiredDistrictId: input.desiredDistrictId, desiredRooms: input.desiredRooms, desiredType: input.desiredType as never,
      ...(kind === "BUYER" ? { requirementsFieldsKind: "BUYER" as const } : {}),
      ...(input.deferAssignment && input.propertyId ? { requestedPropertyId: input.propertyId } : {}),
    } : {}),
  };
}

/** Strict local seam for authenticated new-only intake. The short Client table
 * write fence serializes even legacy formatted/extra-phone writers. No resume,
 * assignment, push or HTTP occurs in this transaction. */
export async function createNewCustomerChannelLeadTx(tx: TxClient, input: ChannelLeadInput, actionId: string): Promise<
  { status: "created"; clientId: string } | { status: "needs_review"; reason: "staff_phone" | "phone_collision" }
> {
  await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '500ms'`);
  await tx.$executeRaw(Prisma.sql`LOCK TABLE "Client" IN SHARE ROW EXCLUSIVE MODE`);
  if (await findStaffPhone([input.phone, input.whatsappPhone, ...(input.extraPhones ?? [])], tx)) {
    return { status: "needs_review", reason: "staff_phone" };
  }
  const phones = [input.phone, ...(input.whatsappPhone ? [input.whatsappPhone] : []), ...(input.extraPhones ?? [])];
  if ((await findPhoneOwners(phones, { includeDeleted: true, limit: 1, db: tx })).length) {
    return { status: "needs_review", reason: "phone_collision" };
  }
  const requestedActive = input.requestedAgentId ? await tx.agent.findFirst({ where: { id: input.requestedAgentId, isActive: true }, select: { id: true } }) : null;
  const kind: ClientKind = input.kind ?? (requestedActive ? "BUYER" : "OTHER");
  const normal = kind !== "OTHER" || !!requestedActive;
  const created = await tx.client.create({ data: { ...channelLeadCreateData(input, kind, input.extraPhones ?? [], normal), customerIntakeActionId: actionId }, select: { id: true } });
  return { status: "created", clientId: created.id };
}

type CustomerLeadPolicyOutcome = { mode: "assigned" | "other" | "duplicate_hold" | "staff_owned" | "night_pending" | "unassigned"; agentId?: string };

/** Own resource token + journal progress + required notification job are one
 * local commit. Notification delivery itself remains a separate observation. */
async function finishCustomerLeadPolicyTx(tx: TxClient, clientId: string, actionId: string, outcome: CustomerLeadPolicyOutcome): Promise<boolean> {
  const claimed = await tx.client.updateMany({ where: { id: clientId, customerIntakeActionId: actionId }, data: { customerIntakeActionId: null } });
  if (claimed.count !== 1) return false;
  const updated = await tx.$executeRaw(Prisma.sql`UPDATE "CustomerAction" SET "policyResult"=COALESCE("policyResult",'{}'::jsonb)||
    jsonb_build_object('intakeOutcome',${JSON.stringify(outcome)}::jsonb,'policyCommittedAt',now()),"updatedAt"=now()
    WHERE "id"=${actionId} AND "kind"='new_lead' AND "status"='COMMITTED' AND "resourceType"='Client' AND "resourceId"=${clientId}`);
  if (updated !== 1) throw new Error("Customer intake lacks its committed owned action");
  if (["assigned", "other", "unassigned"].includes(outcome.mode)) {
    await tx.backgroundJob.create({ data: { type: "customer-intake-notify", payload: { version: 1, actionId }, maxAttempts: 5,
      dedupeKey: `customer-intake-notify:${actionId}` } });
  }
  return true;
}

async function createNewChannelLead(input: ChannelLeadInput, ownedPending?: Client): Promise<{ clientId: string; created: boolean }> {
  /**
   * НОМЕР СОТРУДНИКА — КАРТОЧКУ ИЗ КАНАЛА НЕ ЗАВОДИМ (см. lib/staffPhoneGuard.ts,
   * прод-случай Маъруфа/Нурмухаммада). `clientId` вернуть здесь нечего — сигнатура
   * этой функции используется полутора десятком мест выше по стеку, поэтому
   * сигнал «не создано» идёт через throw, а не через смену возвращаемого типа.
   * HTTP-путь (POST /website-lead) ловит его в общем обработчике app.ts и
   * превращает в 409; остальные каналы уже оборачивают createLeadFromChannel
   * в try/catch (бот, мессенджеры) и получают то же «не удалось оформить», что
   * и при любом другом сбое.
   */
  const staffMatch = await findStaffPhone([input.phone, input.whatsappPhone]);
  if (staffMatch) {
    void logSystemError("api", `Лид из канала (${input.source}) на номер сотрудника не заведён: ${staffPhoneError(staffMatch)}`, {
      dedupKey: `staff-phone-lead:${staffMatch.agentId}`,
    });
    throw new StaffPhoneLeadError(staffMatch);
  }

  // Запасные номера отбираем ОДИН раз на обе ветки ниже (OTHER и обычный лид):
  // это поход в базу за чужими номерами, и дублировать его незачем. Карточки ещё
  // нет, поэтому clientId не передаём — исключать из проверки нечего.
  const extraPhones = await pickFreeExtraPhones(input.extraPhones ?? [], {
    phone: input.phone,
    whatsappPhone: input.whatsappPhone,
  });
  // Заметка в хронологии и пуш агенту — то, что читает рядовой сотрудник, поэтому
  // платформу здесь НЕ называем (см. NEUTRAL_CHANNEL_LABEL). Канал остаётся в
  // Client.source и виден руководителю по праву clients.viewOrigin.
  const label = NEUTRAL_CHANNEL_LABEL[input.source] ?? "внешний канал";

  // OTHER (работа/аренда/прочее из бота) — сознательно НЕ распределяется агентам:
  // видно только руководству в «Прочие обращения», нет ни приёма, ни переназначения.
  // `?? "OTHER"` — не косметика: канал, не передавший тип вовсе (Telegram и форма
  // сайта до 30.08.2026), попадал мимо этой ветки прямо в раздачу агентам как
  // покупатель. Неизвестный тип — это «прочее обращение», а не покупатель.
  /**
   * КЛИЕНТ САМ НАЗВАЛ СОТРУДНИКА — ЭТО НЕ «ПРОЧЕЕ ОБРАЩЕНИЕ» (30.08.2026, поймано
   * полным прогоном, тест requested-agent).
   *
   * Отсечка мусора выше сделана правильно: не понял человека — не выдавай его
   * агенту как покупателя. Но «соедините меня с Умеджоном» — это не «не понял»:
   * человек знает, к кому идёт, и почти всегда возвращается к своему же агенту.
   * Без этого исключения такой лид уходил в «Прочие обращения», названный агент о
   * нём не узнавал никогда, а requestedAgentId молча терялся вместе с причиной.
   *
   * Оговорка «активный сотрудник» обязательна: ниже по коду есть отдельная ветка
   * «названного отключили, пока клиент писал» — она возвращает лид в обычную
   * раздачу, и обойти её через это исключение нельзя.
   */
  const requestedActive = input.requestedAgentId
    ? await prisma.agent.findFirst({
        where: { id: input.requestedAgentId, isActive: true },
        select: { id: true },
      })
    : null;

  if ((input.kind ?? "OTHER") === "OTHER" && !requestedActive) {
    const client = ownedPending ?? await prisma.client.create({ data: channelLeadCreateData(input, "OTHER", extraPhones, false) });

    if (ownedPending) {
      await prisma.$transaction(tx => finishCustomerLeadPolicyTx(tx, ownedPending.id, ownedPending.customerIntakeActionId!, { mode: "other" }));
      return { clientId: client.id, created: true };
    }

    const supervisors = await findAgentsWithPermission("otherInquiries.view");
    sendPushToAgents(supervisors, {
      title: `🔔 Новое обращение: ${label}`,
      body: `${client.fullName} — «Прочие обращения», не для агентов`,
      url: `/clients/${client.shortId}`,
      tag: `lead-${client.id}`,
    }).catch((err) => console.error("[push] обращение (OTHER):", err));
    if (input.requirementsNotes) {
      notifySupervisorsOfHighSimilarityInBackground(client.id, client.fullName, input.requirementsNotes);
    }

    return { clientId: client.id, created: true };
  }

  // deferAssignment (вне рабочих часов) откладывает НАЗНАЧЕНИЕ, но не должно
  // откладывать УВЕДОМЛЕНИЕ, если причина отсутствия агента — режим "Вручную":
  // там никто и никогда не назначит лид автоматически (даже утренняя волна,
  // см. assignPendingLeads), так что руководителя нужно предупредить сразу,
  // а не молчать до бесконечности. Тихо (silentDefer) откладываем только тогда,
  // когда лид ДЕЙСТВИТЕЛЬНО будет разобран сам, просто позже — утром.
  let silentDefer = false;
  if (input.deferAssignment) {
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
    silentDefer = (settings?.leadDistributionStrategy ?? "fair") !== "manual";
  }

  // Карточка заводится БЕЗ агента и только потом получает его.
  //
  // Порядок изменился 11.08.2026 вместе с правилом «свой объект»: чтобы понять,
  // кому лид причитается, нужно знать запрос клиента (район, комнаты, бюджет) —
  // то есть карточка должна уже существовать. Раньше агент выбирался до неё, и
  // для нового правила сравнивать было не с чем.
  //
  // Заявке это не вредит, скорее наоборот: карточка сохраняется первой и не
  // теряется, даже если выбор агента следом упадёт. Ровно поэтому назначение
  // ниже идёт отдельной транзакцией вместе с записью в хронологию — иначе лид
  // молча завис бы у агента, который о нём не узнал.
  /**
   * ТИП НЕ НАЗВАН, НО ЛИД ИДЁТ НАЗВАННОМУ АГЕНТУ — «ПОКУПАТЕЛЬ» (23.09.2026,
   * проверка раздачи, пункт 14). Сюда без типа доходит только лид с названным
   * агентом (исключение у ветки OTHER выше): рекомендация после сделки
   * (lib/dealReviewIntake.ts) и «соедините с Умеджоном» из переписки. Раньше
   * такая карточка заводилась как «Прочее» и при этом лежала у агента, а круг
   * «не принял», правило первого звонка и эскалация тип «Прочее» пропускают
   * целиком: не принял — никто не узнает. Агент уточнит тип после разговора.
   */
  const newLeadKind: ClientKind = input.kind ?? (requestedActive ? "BUYER" : "OTHER");
  const created = ownedPending ?? await prisma.client.create({ data: channelLeadCreateData(input, newLeadKind, extraPhones, true) });
  if (input.requirementsNotes) {
    notifySupervisorsOfHighSimilarityInBackground(created.id, created.fullName, input.requirementsNotes);
  }

  // null — режим "Вручную" в Настройках, отложенное назначение (ночь) или прямо
  // сейчас нет ни одного активного агента: лид не теряется, просто ждёт, пока его
  // назначат (видно в общей очереди непринятых). Никогда не выбрасываем ошибку —
  // это создание лида из внешнего канала (вебхук), терять заявку нельзя.
  /**
   * НАЗВАННЫЙ КЛИЕНТОМ АГЕНТ ИДЁТ ПЕРВЫМ — раньше очереди и раньше правила «свой
   * объект»: прямое указание человека сильнее любого нашего сопоставления. Ночь
   * ему тоже не помеха (deferAssignment): откладывать назначение имеет смысл,
   * пока непонятно, кому лид достанется, а здесь это уже известно.
   *
   * Доступность проверяется ЗАНОВО, по базе: между репликой клиента и этой
   * секундой агента могли уволить, заморозить или он сам выключил приём. Не
   * прошёл проверку — обычный путь, а факт просьбы остаётся в заметке ниже.
   */
  const requestedAgentId = await requestedAgentStillAvailable(input.requestedAgentId);

  /**
   * РАЗДЕЛ L — ГЛАВНОЕ ПРАВИЛО (владелец, 03.09.2026 вечером, план вечерней сессии
   * §L): похожая новая заявка не раздаётся другому агенту, пока агент, за которым
   * закреплена похожая СУЩЕСТВУЮЩАЯ карточка, не подтвердит, что это разные люди.
   *
   * Пропускаем придержку, если новая заявка и так уже пойдёт ТОМУ ЖЕ агенту
   * (клиент сам назвал его по имени) — «раздать другому» не произойдёт, спрашивать
   * нечего. См. lib/duplicateReview.ts для сигнала (похожее имя + похожий, не
   * идентичный, номер) и полного разбора решения.
   */
  const duplicateCandidate = await findFuzzyDuplicateCandidate(created.fullName, created.phone, created.id);
  if (duplicateCandidate && duplicateCandidate.assignedAgentId !== requestedAgentId) {
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
    const held = await openDuplicateReview(created, duplicateCandidate, settings?.duplicateReviewTimeoutHours ?? 6);
    if (held) {
      if (ownedPending) await prisma.$transaction(tx => finishCustomerLeadPolicyTx(tx, ownedPending.id, ownedPending.customerIntakeActionId!, { mode: "duplicate_hold" }));
      return { clientId: created.id, created: true };
    }
  }

  const assignment: LeadAssignment = requestedAgentId
    ? { agentId: requestedAgentId, reason: "requested_by_client", note: input.requestedAgentNote }
    : input.deferAssignment
      ? { agentId: null, reason: "queue" }
      : await assignAgentForLead({
          clientId: created.id,
          channel: input.channel,
          recipientId: input.recipientId,
          endpointScopeId: input.endpointScopeId,
          // Текст обращения — ради ссылки на пост Instagram: клиент, приславший
          // ссылку, прямо показал нужный объект, и лид уходит его агенту
          // (lib/instagramPostLead.ts).
          inquiryText: input.requirementsNotes,
          // Объект назван явно (ссылка с сайта на конкретную карточку) — выше
          // показа бота и совпадения по описанию, см. LeadAssignContext.propertyId.
          propertyId: input.propertyId,
          // Продавец не упирается в лимит покупателей (владелец 20.08.2026).
          kind: created.kind === "SELLER" ? "SELLER" : "BUYER",
        });
  /**
   * ГОНКА «СОЗДАЛ КАРТОЧКУ → ПОТОМ НАЗНАЧИЛ» (B12, 02.10.2026). Карточка уже
   * записана без агента, а назначение идёт следующим шагом: утренняя волна
   * (assignPendingLeads) в ту же секунду видит её «ничьей» и назначает своего.
   * Запись — только если карточка всё ещё без агента (guardWhere); проиграли —
   * транзакция откатывается, пуша и записи от нас нет, карточку ведёт тот, кто успел.
   */
  let agentId = assignment.agentId;
  let lostRace = false;

  const client = agentId
    ? await prisma.$transaction(async (tx) => {
        // changeClientAgent — единственная точка записи assignedAgentId (аудит
        // владения 11.09.2026, docs/ownership-audit-11-09.md). Свою Interaction
        // пишем отдельно ниже — тем же текстом, что и раньше.
        const changed = await changeClientAgent({
          clientId: created.id,
          toAgentId: agentId,
          reason: `Лид создан автоматически: ${label}`,
          source: "intake.createNewChannelLead",
          tx,
          skipInteraction: true,
          guardWhere: { assignedAgentId: null, ...(ownedPending ? { customerIntakeActionId: ownedPending.customerIntakeActionId, duplicateReviewOfClientId: null } : {}) },
          data: { assignedAt: new Date() },
        });
        if (!changed.ok) throw new LeadAlreadyClaimed();
        const updated = await tx.client.findUniqueOrThrow({ where: { id: created.id } });
        // SYSTEM, не агент (П-10, 17.09.2026) — это алгоритм распределения
        // назвал получателя, агент лид ещё не открывал.
        await logTimeline({
          clientId: updated.id,
          actor: { kind: "system", source: "intake-new-channel-lead", subjectAgentId: agentId },
          type: "SYSTEM",
          notes: `Лид создан автоматически: ${label}`,
          tx,
        });
        if (ownedPending) {
          await recordAssignReasonTx(tx, updated.id, agentId!, assignment);
          if (assignment.reason !== "requested_by_client" && input.requestedAgentNote) {
            await logTimeline({ clientId: updated.id, actor: { kind: "system", source: "intake-requested-agent-note", subjectAgentId: agentId },
              type: "SYSTEM", notes: input.requestedAgentNote, tx });
          }
          await finishCustomerLeadPolicyTx(tx, updated.id, ownedPending.customerIntakeActionId!, { mode: "assigned", agentId: agentId! });
        }
        return updated;
      }).catch(async (err: unknown) => {
        if (!(err instanceof LeadAlreadyClaimed)) throw err;
        agentId = null;
        lostRace = true;
        return prisma.client.findUniqueOrThrow({ where: { id: created.id } });
      })
    : created;

  if (ownedPending) {
    if (!agentId) await prisma.$transaction(tx => finishCustomerLeadPolicyTx(tx, ownedPending.id, ownedPending.customerIntakeActionId!,
      { mode: lostRace ? "staff_owned" : silentDefer ? "night_pending" : "unassigned" }));
    return { clientId: client.id, created: true };
  }
  if (agentId) await recordAssignReason(client.id, agentId, assignment);
  /**
   * Просьба была, но лид ушёл в общую раздачу (тёзки либо названный недоступен) —
   * пишем это в хронологию отдельно: recordAssignReason молчит про очередь, а
   * агенту важно знать, что клиент называл имя.
   */
  if (agentId && assignment.reason !== "requested_by_client" && input.requestedAgentNote) {
    await logTimeline({
      clientId: client.id,
      actor: { kind: "system", source: "intake-requested-agent-note", subjectAgentId: agentId },
      type: "SYSTEM",
      notes: input.requestedAgentNote,
    }).catch((err) => console.error("[leads] заметка о названном агенте:", err instanceof Error ? err.message : err));
  }

  if (agentId) {
    sendLeadPush(agentId, client.id, {
      title: input.source === "WEBSITE" ? "🔔 Новая заявка с сайта" : `🔔 Новый лид: ${label}`,
      body: `${client.fullName}${leadGist(input.requirementsNotes)} — примите заявку, иначе её передадут другому агенту`,
      url: `/clients/${client.shortId}`,
      tag: `lead-${client.id}`,
    }).catch((err) => console.error("[push] новый лид из канала:", err));
  } else if (!silentDefer && !lostRace) {
    // Тихо (без пуша) — только когда лид реально будет разобран сам, утренней волной
    // (см. silentDefer выше). Здесь — режим "Вручную" (в любое время суток) или
    // прямо сейчас нет ни одного активного агента: без пуша заявка рискует
    // молча зависнуть навсегда, никто её не увидит.
    const supervisors = await findAgentsWithPermission("clients.assign");
    sendPushToAgents(supervisors, {
      title: "⏳ Лид ждёт назначения",
      body: `${client.fullName} — назначьте агента вручную`,
      url: `/clients/${client.shortId}`,
      tag: `lead-unassigned-${client.id}`,
    }).catch((err) => console.error("[push] лид без агента:", err));
  }

  return { clientId: client.id, created: true };
}

function finiteNumber(value: Prisma.Decimal | number | null | undefined): number | undefined {
  if (value == null) return undefined;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : undefined;
}

/** Existing post-create policy for a resource this journal actually created.
 * No arbitrary Client id, resumeExisting or foreign phone match is accepted. */
export async function processNewCustomerLeadPolicy(actionId: string): Promise<void> {
  const [action] = await prisma.$queryRaw<{ resourceId: string; policyResult: unknown; channel: string; peerId: string;
    endpointScopeId: string; nativeId: string | null }[]>`SELECT a."resourceId",a."policyResult",s."channel",i."peerId",i."endpointScopeId",i."conversationId" AS "nativeId"
    FROM "CustomerAction" a JOIN "CustomerInquiry" i ON i."id"=a."inquiryId" JOIN "CustomerEndpointScope" s ON s."id"=i."endpointScopeId"
    WHERE a."id"=${actionId} AND a."kind"='new_lead' AND a."status"='COMMITTED' AND a."resourceType"='Client' AND a."receiptVersion"=1`;
  if (!action) throw new Error("Customer intake policy has no committed resource");
  const progress = customerIntakeProgressSchema.parse(action.policyResult);
  if (progress.intakeOutcome) return;
  const client = await prisma.client.findUnique({ where: { id: action.resourceId } });
  if (!client || client.customerIntakeActionId !== actionId || client.deletedAt) throw new Error("Customer intake resource is not pending/available");
  if (client.assignedAgentId) {
    await prisma.$transaction(tx => finishCustomerLeadPolicyTx(tx, client.id, actionId, { mode: "staff_owned" }));
    return;
  }
  const [bound] = await prisma.$queryRaw<{ present: boolean }[]>`SELECT EXISTS(SELECT 1 FROM "BotConversation" WHERE "id"=${action.nativeId}
    AND "endpointScopeId"=${action.endpointScopeId} AND "clientId"=${client.id} AND "subscriberId"=${action.peerId}) AS present`;
  if (!bound?.present) throw new Error("Customer intake policy native binding changed");
  const context = progress.intakeContext;
  await createNewChannelLead({ ...context, fullName: client.fullName, phone: client.phone, source: client.source,
    kind: client.kind, budgetMin: finiteNumber(client.budgetMin), budgetMax: finiteNumber(client.budgetMax),
    desiredDistrictId: client.desiredDistrictId ?? undefined, desiredRooms: client.desiredRooms ?? undefined,
    desiredType: client.desiredType ?? undefined, requirementsNotes: client.requirementsNotes ?? undefined,
    whatsappPhone: client.whatsappPhone ?? undefined, extraPhones: client.extraPhones,
    channel: action.channel, recipientId: action.peerId, endpointScopeId: action.endpointScopeId,
    ...(context.requestedAgentId ? { requestedAgentNote: "Клиент назвал конкретного сотрудника" } : {}),
  }, client);
}

/**
 * РАЗДЕЛ L, ГЛАВНОЕ ПРАВИЛО, ПРОДОЛЖЕНИЕ — раздача, придержанная openDuplicateReview
 * выше (lib/duplicateReview.ts), возобновляется отсюда: агент, за которым закреплена
 * похожая карточка, подтвердил «это разные люди» (routes/clients/duplicateReviews.ts),
 * либо никто не ответил за Settings.duplicateReviewTimeoutHours
 * (lib/duplicateReview.ts::sweepExpiredDuplicateReviews). Карточка уже существует
 * (создана в createNewChannelLead), просто без агента — назначаем тем же путём, что
 * обычный лид без явно названного агента.
 *
 * НЕ воспроизводит правило «свой объект» через channel/recipientId — эти поля были
 * только у исходного входящего сообщения и на Client не хранятся. Для придержанного
 * лида (единицы в день, не весь поток) это приемлемый компромисс, не потеря заявки.
 */
/** Карточку уже назначил кто-то другой, пока мы выбирали агента (B12) — откатить свою запись. */
class LeadAlreadyClaimed extends Error {}

export async function assignHeldLead(clientId: string): Promise<void> {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  // Уже разобрано другим путём (удалён/слит/кто-то назначил вручную, пока крутилась
  // придержка) — молча выходим, трогать нечего.
  if (!client || client.deletedAt || client.assignedAgentId) return;

  const assignment = await assignAgentForLead({ clientId, kind: client.kind === "SELLER" ? "SELLER" : "BUYER" });
  const agentId = assignment.agentId;

  if (agentId) {
    // changeClientAgent — единственная точка записи assignedAgentId (аудит владения
    // 11.09.2026, docs/ownership-audit-11-09.md). Своя Interaction — тем же текстом.
    // guardWhere — та же гонка, что у createNewChannelLead (B12): «не дубль» и
    // утренняя волна/просрочка проверки в одну секунду назначали дважды.
    const claimed = await prisma.$transaction(async (tx) => {
      const changed = await changeClientAgent({
        clientId,
        toAgentId: agentId,
        reason: "Лид назначен по очереди — проверка на дубль закрыта (разные люди)",
        source: "intake.assignHeldLead",
        tx,
        skipInteraction: true,
        guardWhere: { assignedAgentId: null },
        data: { assignedAt: new Date() },
      });
      if (!changed.ok) throw new LeadAlreadyClaimed();
      await logTimeline({
        clientId,
        actor: { kind: "system", source: "intake-held-lead", subjectAgentId: agentId },
        type: "SYSTEM",
        notes: "Лид назначен по очереди — проверка на дубль закрыта (разные люди)",
        tx,
      });
      return true;
    }).catch((err: unknown) => {
      if (err instanceof LeadAlreadyClaimed) return false;
      throw err;
    });
    if (!claimed) return;
    await recordAssignReason(clientId, agentId, assignment);
    sendLeadPush(agentId, clientId, {
      title: "🔔 Новый лид",
      body: `${client.fullName} — примите заявку, иначе её передадут другому агенту`,
      url: `/clients/${client.shortId}`,
      tag: `lead-${clientId}`,
    }).catch((err) => console.error("[push] лид после проверки на дубль:", err));
  } else {
    const supervisors = await findAgentsWithPermission("clients.assign");
    sendPushToAgents(supervisors, {
      title: "⏳ Лид ждёт назначения",
      body: `${client.fullName} — назначьте агента вручную`,
      url: `/clients/${client.shortId}`,
      tag: `lead-unassigned-${clientId}`,
    }).catch((err) => console.error("[push] лид без агента после проверки на дубль:", err));
  }
}

/**
 * Уже известный клиент (заявка когда-то принята) снова пишет боту про заметно
 * другой запрос (другой район/бюджет/тип, или продать вместо купить) — не
 * заводим второй Client-дубликат и не перекидываем на другого агента (нечестно
 * забирать чужого клиента), а просто фиксируем это в истории взаимодействий и
 * пушим ТОМУ ЖЕ агенту, который уже ведёт этого клиента. Если у клиента почему-то
 * нет назначенного агента — тихо пропускаем пуш (запись в Interaction всё равно
 * останется видна в карточке).
 */
export async function notifyRepeatInquiry(clientId: string, summary: string): Promise<void> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, shortId: true, fullName: true, assignedAgentId: true },
  });
  // Interaction.agentId обязателен — без назначенного агента (редкий случай:
  // клиент из "Прочих обращений") записывать интеракцию не на кого, тихо выходим.
  if (!client || !client.assignedAgentId) return;

  // Актор — клиент, писавший боту (П-10, 17.09.2026, ровно случай из разбора
  // «Клиент снова написал боту…» → CLIENT/BOT).
  await logTimeline({
    clientId: client.id,
    actor: { kind: "client", source: "intake-repeat-inquiry-bot", subjectAgentId: client.assignedAgentId },
    type: "SYSTEM",
    notes: `Клиент снова написал боту с новым запросом: ${summary}`,
  }).catch((err) => console.error("[leads] запись повторного обращения:", err));

  await sendPushToAgent(client.assignedAgentId, {
    title: `🔔 ${client.fullName} снова на связи`,
    body: summary,
    url: `/clients/${client.shortId}`,
    tag: `repeat-inquiry-${client.id}`,
  }).catch((err) => console.error("[push] повторное обращение:", err));
}

/**
 * СУТЬ ЗАЯВКИ В ПУШЕ (ревизия бота 02.10.2026, сравнение с лучшими ассистентами).
 * Агент видел только «Имя — примите заявку» и открывал карточку, чтобы понять, кто
 * это. Первые слова запроса («2-комн в Сино до 45 000 $») прямо в пуше дают ему
 * решить, звонить ли сразу, не открывая CRM. Только начало: пуш — не карточка.
 */
export function leadGist(notes: string | null | undefined): string {
  const flat = (notes ?? "").replace(/\s*\n+\s*/g, "; ").replace(/\s{2,}/g, " ").trim();
  if (!flat) return "";
  return `: ${flat.length > 90 ? `${flat.slice(0, 89).trimEnd()}…` : flat}`;
}
