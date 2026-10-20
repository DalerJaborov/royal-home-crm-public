/**
 * Светофор неактивных клиентов (владелец 20-21.08.2026, переделан 03.09.2026 —
 * цвет по ГЛУБИНЕ ОТНОШЕНИЙ, не по причине).
 *
 * ГЛАВНОЕ ИНЖЕНЕРНОЕ РЕШЕНИЕ: цвет ставит СИСТЕМА по объективной истории карточки
 * (был ли реальный разговор, была ли встреча), а не по тому, что клиент СКАЗАЛ и
 * не по выбору агента. Слова клиента ненадёжны и разные люди формулируют одно и
 * то же по-разному; факт разговора и факт встречи — нет.
 *
 *   RED    — ни разу не дозвонились (нет ни одного состоявшегося разговора).
 *            Меньше всего вложено в клиента — меньше всего терпения: система
 *            быстро отпускает слот агенту под более перспективный лид.
 *   YELLOW — дозвонились хотя бы раз, но до встречи/показа не дошли.
 *   GREEN  — была встреча (показ у покупателя, встреча на объекте у продавца).
 *            Больше всего вложено — больше всего терпения на возврат.
 *
 * ПРИЧИНА (одна из INACTIVE_REASONS) цвет больше НЕ определяет. Она определяет
 * только ТЕМП внутри цвета — см. STRICT_TONE_REASONS ниже: «просил перезвонить
 * и не вышел на связь» или «перестал отвечать»/«другое» ужесточают шаг
 * напоминаний, «думает»/«нет денег»/аналогичные открытые причины — нет.
 *
 * У каждого уровня свой шаг напоминаний и свой предел попыток (Settings.inactive*) —
 * после предела карточка уходит в Потерянные (status=LOST), тем же путём, что и
 * исчерпанные передачи (см. lib/clientTransfer.ts).
 */
import { sellersWithPropertyInWork } from "./sellerCardState.js";
import {
  INACTIVE_REASONS,
  dushanbeDayKey,
  type ClientKind,
  type InactiveReason,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { isWithinWorkingHours } from "./workingHours.js";
import { recordScoreEvent, loadEventPoints } from "./scoreJournal.js";
import { absentAgentIds } from "./agentAvailability.js";
import { markClientLost } from "./clientLifecycle.js";
import { isHeldMeeting, REAL_CALL_CONTACT_WHERE, TERMINAL_CLIENT_STATUSES } from "./clientContact.js";
import { publishClientUpdated } from "./livePublish.js";

const HOUR_MS = 3_600_000;

export type InactiveLevel = "GREEN" | "YELLOW" | "RED";

/** Причины, которые сами по себе доказывают, что разговор состоялся: клиент
 *  сказал что-то содержательное, а не просто не поднял трубку. */
const OPEN_ENDED_REASONS: ReadonlySet<InactiveReason> = new Set([
  "THINKING",
  "NO_MONEY_YET",
  "POSTPONED",
  "NOT_READY_YET",
  "FAMILY_CIRCUMSTANCES",
]);

/** Причина «попросил перезвонить позже» — единственная, где по определению есть
 *  обещанная точка возврата, которую можно нарушить (см. документацию модуля). */
const BROKEN_PROMISE_REASONS: ReadonlySet<InactiveReason> = new Set([
  "ASKED_LATER",
]);

/** Причины, при которых темп напоминаний внутри цвета ужесточается (владелец
 *  03.09.2026): нарушенное обещание перезвонить и «слабые» причины без
 *  содержательного объяснения. Открытые причины (клиент сам объяснился) — темп
 *  обычный. Цвет самих причин больше НЕ касается — см. classifyInactiveLevelByDepth. */
const STRICT_TONE_REASONS: ReadonlySet<InactiveReason> = new Set([
  "ASKED_LATER",
  "STOPPED_RESPONDING",
  "OTHER",
]);

/** Множитель шага напоминаний: строгие причины напоминают на четверть чаще.
 *  Причина не сохранена (недозвон-триггер без единого слова клиента) — тоже
 *  строгий темп: у молчания меньше доверия, чем у названной причины. */
function toneMultiplier(reason: InactiveReason | null): number {
  return reason && !STRICT_TONE_REASONS.has(reason) ? 1 : 0.75;
}

/**
 * ПОКАЗ ИЛИ ВСТРЕЧА ДЕЙСТВИТЕЛЬНО СОСТОЯЛИСЬ, А НЕ БЫЛИ СНЯТЫ АВТОМАТИКОЙ
 * (23.09.2026). `completedAt` у показа ставит не только агент кнопкой
 * «выполнено»: lib/nextActionAutoClose.ts::closeStaleNextActions гасит ВСЕ
 * открытые задачи клиента, когда приходит новое событие (очередной недозвон,
 * новый показ), — и назначенный на завтра показ получает completedAt сегодня.
 * Засчитать такой показ встречей значило бы покрасить клиента зелёным и
 * сбросить таймер светофора по встрече, которой не было. Отличие простое:
 * состоявшаяся встреча закрыта не раньше своего времени (или время не
 * назначалось вовсе — запись задним числом); снятая заранее — раньше.
 * Отменённая (declinedAt) отсекается ещё в запросе.
 */
/**
 * ЦВЕТ ПО ГЛУБИНЕ ОТНОШЕНИЙ (владелец 03.09.2026, заменяет цвет по причине).
 *
 * «Встреча» — по типу клиента: показ (SHOWING) у покупателя, встреча на объекте
 * (MEETING, outcome=SELLER_MEETING) у продавца. «Дозвонились» переиспользует
 * countContactTrace.talked — тот же порог и те же грабли исторических записей
 * без callAttempt, что уже разобраны и протестированы там; считать вторым,
 * расходящимся способом нельзя (CLAUDE.md: «одно место правды»).
 */
export async function classifyInactiveLevelByDepth(
  clientId: string,
  kind: ClientKind,
  leadCallMinSeconds: number,
): Promise<InactiveLevel> {
  /**
   * ОБЪЕКТ ПРОДАВЦА ЗАВЕДЁН — ВСТРЕЧА БЫЛА (владелец 23.09.2026). Объект в CRM
   * появляется только после того, как агент съездил, посмотрел и принял его у
   * собственника; отдельную запись «встреча на объекте» агенты при этом ставят
   * не всегда. Без этой проверки продавец, сдавший нам квартиру, красился
   * «ни разу не дозвонились» и получал самый короткий срок терпения. Любой
   * объект, не удалённый в корзину, в любом статусе: сам факт передачи и есть
   * встреча, а судьба объекта (продан, снят) глубину отношений не отменяет.
   */
  if (kind === "SELLER") {
    const property = await prisma.property.findFirst({
      where: { sellerClientId: clientId, deletedAt: null },
      select: { id: true },
    });
    if (property) return "GREEN";
  }
  const meetings = await prisma.interaction.findMany({
    where:
      kind === "SELLER"
        ? {
            clientId,
            type: "MEETING",
            outcome: "SELLER_MEETING",
            completedAt: { not: null },
            declinedAt: null,
          }
        : {
            clientId,
            type: "SHOWING",
            completedAt: { not: null },
            declinedAt: null,
          },
    select: { completedAt: true, nextActionDate: true },
    orderBy: { completedAt: "desc" },
    take: 50,
  });
  if (meetings.some(isHeldMeeting)) return "GREEN";

  const { talked } = await countContactTrace(clientId, leadCallMinSeconds);
  if (talked > 0) return "YELLOW";
  // Depth includes short/manual conversations; the first-call KPI retains
  // its independent duration threshold.
  const contact = await prisma.interaction.findFirst({
    where: { clientId, ...REAL_CALL_CONTACT_WHERE }, select: { id: true },
  });
  return contact ? "YELLOW" : "RED";
}

interface TrafficLightSettings {
  inactiveGreenPingHours: number;
  inactiveGreenMaxAttempts: number;
  inactiveYellowPingHours: number;
  inactiveYellowMaxAttempts: number;
  inactiveRedPingHours: number;
  inactiveRedMaxAttempts: number;
  inactivateMinAttempts: number;
  inactivateCooldownHours: number;
  leadCallMinSeconds: number;
}

/**
 * Числа перевёрнуты относительно исходных (владелец 03.09.2026): раньше самый
 * тёплый клиент (GREEN) сдавался быстрее всех (3 дня), а самый холодный (RED,
 * ни разу не дозвонились) держался дольше всех (6 дней) — владелец прямо
 * указал, что это задом наперёд. Больше вложено в клиента — больше терпения
 * на его возврат; меньше вложено — быстрее освобождаем слот агенту.
 */
const FALLBACK: TrafficLightSettings = {
  inactiveGreenPingHours: 24,
  inactiveGreenMaxAttempts: 5, // 5 дней всего — самый тёплый, больше всего терпения
  inactiveYellowPingHours: 48,
  inactiveYellowMaxAttempts: 2, // 4 дня всего
  inactiveRedPingHours: 36,
  inactiveRedMaxAttempts: 2, // ~3 дня всего — холодный след, отпускаем быстрее
  inactivateMinAttempts: 2,
  inactivateCooldownHours: 5,
  leadCallMinSeconds: 30,
};

export async function loadTrafficLightSettings(): Promise<TrafficLightSettings> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  return {
    inactiveGreenPingHours:
      s?.inactiveGreenPingHours ?? FALLBACK.inactiveGreenPingHours,
    inactiveGreenMaxAttempts:
      s?.inactiveGreenMaxAttempts ?? FALLBACK.inactiveGreenMaxAttempts,
    inactiveYellowPingHours:
      s?.inactiveYellowPingHours ?? FALLBACK.inactiveYellowPingHours,
    inactiveYellowMaxAttempts:
      s?.inactiveYellowMaxAttempts ?? FALLBACK.inactiveYellowMaxAttempts,
    inactiveRedPingHours:
      s?.inactiveRedPingHours ?? FALLBACK.inactiveRedPingHours,
    inactiveRedMaxAttempts:
      s?.inactiveRedMaxAttempts ?? FALLBACK.inactiveRedMaxAttempts,
    inactivateMinAttempts:
      s?.inactivateMinAttempts ?? FALLBACK.inactivateMinAttempts,
    inactivateCooldownHours:
      s?.inactivateCooldownHours ?? FALLBACK.inactivateCooldownHours,
    leadCallMinSeconds: s?.leadCallMinSeconds ?? FALLBACK.leadCallMinSeconds,
  };
}

function pingHoursFor(level: InactiveLevel, s: TrafficLightSettings): number {
  if (level === "GREEN") return s.inactiveGreenPingHours;
  if (level === "YELLOW") return s.inactiveYellowPingHours;
  return s.inactiveRedPingHours;
}

function maxAttemptsFor(level: InactiveLevel, s: TrafficLightSettings): number {
  if (level === "GREEN") return s.inactiveGreenMaxAttempts;
  if (level === "YELLOW") return s.inactiveYellowMaxAttempts;
  return s.inactiveRedMaxAttempts;
}

/**
 * СЛЕД РАБОТЫ — два разных вопроса об одной хронологии.
 *
 * `talked` — РАЗГОВОР СОСТОЯЛСЯ: звонок дольше `minSeconds` (тот же порог, что
 * решает «звонок состоялся» во всей остальной CRM, см. leads.ts::decideFirstCall)
 * или ответ клиента в переписке.
 *
 * `attempts` — АГЕНТ ПЫТАЛСЯ СВЯЗАТЬСЯ, независимо от того, чем это кончилось.
 *
 * ПОЧЕМУ ИХ ДВА (27.08.2026, разбор жалобы «не могу перевести в Неактивные»).
 * Считалась только первая величина, и порог у неё — тридцать секунд. На проде
 * это заперло 39 карточек из 52: у них звонки по 0:05, 0:11, 0:17, 0:19 — клиент
 * брал трубку, говорил «неудобно, перезвоните» и клал её. Работа была, контакт
 * был, а система отвечала агенту «попыток связаться: 0» и не давала закрыть
 * карточку честной причиной «перестал отвечать». Слот не освобождался никогда,
 * портфели доросли до 17 активных при лимите 6.
 *
 * Тридцать секунд — правильный порог для вопроса «был ли СОДЕРЖАТЕЛЬНЫЙ
 * разговор» (первый звонок по лиду, KPI) и негодный для вопроса «работал ли
 * агент с клиентом вообще». Поэтому не «снизить порог», а разделить вопросы:
 * `talked` остаётся ровно прежним, `attempts` отвечает на второй.
 *
 * ЧТО СЧИТАЕТСЯ ПОПЫТКОЙ. Дозвон, который станция довела до телефона клиента:
 * `callAttempt` = "TALKED" (взял трубку — любой длительности) или "NO_ANSWER"
 * (звонил, не ответил). Плюс запись, сделанная агентом руками с заполненным
 * исходом: узнать исход разговора, не поговорив, нельзя, а длительности у такой
 * записи нет по природе — измерять было нечего.
 *
 * ЧТО НЕ СЧИТАЕТСЯ. "AGENT_NO_PICKUP" — агент не снял собственную трубку,
 * телефон клиента не звонил; "CANCELLED" — передумал и сбросил. Ровно это
 * владелец назвал «нажал и бросил»: иначе три случайных набора открывали бы
 * дверь в Неактивные, и гейт перестал бы что-либо защищать. Неотвеченный
 * ВХОДЯЩИЙ тоже не попытка — там дозванивались до нас (см. incomingCalls.ts).
 *
 * Экспортирована (мозговой штурм 20-21.08.2026, «рубеж 2: дверь передачи») —
 * тем же признаком «есть след работы» открывается досрочная «Передача» (см.
 * lib/clientTransfer.ts::canTransferClient), и повторять расчёт вторым куском
 * кода нельзя: разойдутся первыми же следующими правками порога.
 */
export interface ContactTrace {
  /** Состоявшихся разговоров: звонок дольше minSeconds или ответ в переписке. */
  talked: number;
  /** Попыток связаться: доведённый до клиента дозвон или ручная запись с исходом. */
  attempts: number;
}

export async function countContactTrace(
  clientId: string,
  minSeconds: number,
): Promise<ContactTrace> {
  const [talkedCalls, attemptCalls, client] = await Promise.all([
    prisma.interaction.count({
      where: {
        clientId,
        type: "CALL",
        recordingDurationSec: { gte: minSeconds },
      },
    }),
    prisma.interaction.count({
      where: {
        clientId,
        type: "CALL",
        OR: [
          // Станция довела вызов до телефона клиента — взял он трубку или нет.
          { callAttempt: { in: ["TALKED", "NO_ANSWER"] } },
          /**
           * Измеренная длительность — сама по себе доказательство разговора: её
           * ставит только callTracker и только когда клиент снял трубку. Ветка
           * нужна ради записей до 27.08.2026, у которых `callAttempt` пуст, и
           * ради коротких разговоров, не дотянувших до `minSeconds`, — ровно тех,
           * из-за которых всё и переделывалось.
           */
          { recordingDurationSec: { gt: 0 } },
          /**
           * Ручная запись агента о звонке. `callAttempt` у неё пуст (звонка через
           * CRM не было), поэтому опознаём по заполненному исходу — его ставит
           * человек в форме «Как прошёл звонок», а поставить его, не поговорив,
           * нельзя. Отвечает за такую запись сам агент: она подписана им и видна
           * руководителю в хронологии.
           */
          { callAttempt: null, outcome: { not: null } },
          /**
           * Расшифровка есть только у состоявшегося разговора (запись скачана со
           * станции) — сам разбираемый ИИ звонок и есть попытка. Без этой ветки
           * ИИ-перевод в Неактивные после первого же звонка упирался в гейт
           * «след работы» (03.09.2026, после того как гейт стал общим для всех причин).
           */
          { transcript: { not: null } },
          /**
           * «Связался со своего телефона» (пачка 10, 11.09.2026) — CRM звонка не
           * слышала, длительности и исхода станции у него нет, поэтому это ТОЛЬКО
           * попытка, а не критерий `talked`: тот отвечает на вопрос «был ли
           * СОДЕРЖАТЕЛЬНЫЙ разговор через CRM» (KPI первого звонка), и звонок мимо
           * CRM на него ответить не может — мы просто не знаем, сколько он длился.
           */
          { outsideCrm: true },
        ],
      },
    }),
    prisma.client.findUnique({
      where: { id: clientId },
      select: { lastClientMessageAt: true },
    }),
  ]);
  const wroteBack = client?.lastClientMessageAt ? 1 : 0;
  return {
    talked: talkedCalls + wroteBack,
    attempts: attemptCalls + wroteBack,
  };
}

export type DeactivationGate =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * МОЖНО ЛИ переводить в Неактивные с этой причиной — гейт против слива без
 * единой попытки связаться (мозговой штурм 21.08.2026, «рубеж 3»).
 *
 * Для ЛЮБОЙ причины (решение владельца 03.09.2026, аудит B9). До этого открытые
 * причины («думает», «просил перезвонить») пропускались без проверки — «сама
 * причина доказывает разговор». Но связаться можно и мимо CRM, а система этого не
 * видит: агент мог написать «клиент думает» про клиента, которому ни разу не
 * звонил через CRM, и светофор запускался без единого следа работы. Нурмухаммад
 * понимает светофор как защиту от слива без работы — значит след работы нужен
 * всегда. Порог — Settings.inactivateMinAttempts, попытка = звонок через CRM
 * (включая недозвон) или переписка (см. countContactTrace).
 */
export async function canDeactivateWithReason(
  clientId: string,
  reason: InactiveReason,
  settings?: TrafficLightSettings,
): Promise<DeactivationGate> {
  const s = settings ?? (await loadTrafficLightSettings());
  // Открытые причины и «просил перезвонить» — хотя бы ОДНА попытка (слово владельца:
  // «требовать хотя бы одну попытку звонка для любой причины»); «перестал отвечать»
  // и «другое» — полный порог из Настроек, как и раньше.
  const required =
    OPEN_ENDED_REASONS.has(reason) || BROKEN_PROMISE_REASONS.has(reason)
      ? Math.min(1, s.inactivateMinAttempts) || 1
      : s.inactivateMinAttempts;
  /**
   * Считаем ПОПЫТКИ, а не состоявшиеся разговоры (27.08.2026, решение владельца).
   * Вопрос гейта — «работал ли агент с клиентом», и недозвон на него отвечает
   * утвердительно: человек набрал номер, телефон клиента звонил. Требовать здесь
   * тридцатисекундный разговор значило бы запирать карточку именно там, где
   * причина перевода — «перестал отвечать»: у молчащего клиента разговора и не
   * будет, сколько ему ни звони. См. countContactTrace выше.
   */
  const { attempts } = await countContactTrace(clientId, s.leadCallMinSeconds);
  if (attempts >= required) return { allowed: true };
  const word = required === 1 ? "попытка" : "попытки";
  return {
    allowed: false,
    reason: `Нужно хотя бы ${required} зафиксированных ${word} связаться с клиентом (звонок через CRM или переписка), прежде чем перевести его в Неактивные с этой причиной — сейчас ${attempts}.`,
  };
}

/**
 * COOLDOWN. Слил клиента в Неактивные — следующий лид агенту не раньше чем через
 * inactivateCooldownHours (мозговой штурм 21.08.2026: «без задержки перевод в
 * Неактив был бы способом ускорить получение нового лида»).
 *
 * Считается по Client.inactiveEnteredAt, а НЕ по inactiveSince (владелец
 * 23.09.2026, ПР-000453). inactiveSince — таймер светофора: он сдвигается при
 * каждом разговоре с неактивным клиентом, при возврате агента из отпуска и
 * ставится ночным автопереводом молчащих. Пауза по нему наказывала ровно за
 * нужную работу: агент дозвонился до «уснувшего» клиента — и пять часов без
 * лидов. 23.09 на такой паузе стояли четверо из шести агентов, и весь поток шёл
 * одной Сурайё. inactiveEnteredAt ставит только deactivateClient
 * (lib/clientWorkStatus.ts) — вход в Неактивные по итогу работы агента.
 */
export async function agentsInCooldown(
  agentIds: string[],
  cooldownHours?: number,
): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const hours =
    cooldownHours ?? (await loadTrafficLightSettings()).inactivateCooldownHours;
  if (hours <= 0) return new Set();
  const since = new Date(Date.now() - hours * HOUR_MS);
  const rows = await prisma.client.findMany({
    where: {
      assignedAgentId: { in: agentIds },
      workStatus: "INACTIVE",
      deletedAt: null,
      status: { notIn: [...TERMINAL_CLIENT_STATUSES] },
      inactiveEnteredAt: { gte: since },
    },
    select: { assignedAgentId: true },
    distinct: ["assignedAgentId"],
  });
  return new Set(rows.map((r) => r.assignedAgentId!));
}

/**
 * Записать цвет светофора и точку отсчёта — вызывается из deactivateClient
 * (lib/clientWorkStatus.ts) и silentClientAutoDeactivate.ts сразу после того,
 * как гейт canDeactivateWithReason пропустил перевод. Асинхронна с 03.09.2026:
 * цвет теперь читает историю клиента (classifyInactiveLevelByDepth), не берётся
 * из одной причины.
 */
export async function inactiveLevelFields(
  clientId: string,
  kind: ClientKind,
  reason: InactiveReason,
  settings?: TrafficLightSettings,
  now: Date = new Date(),
): Promise<{
  inactiveReasonKey: InactiveReason;
  inactiveLevel: InactiveLevel;
  inactiveSince: Date;
  inactivePingCount: number;
}> {
  const s = settings ?? (await loadTrafficLightSettings());
  return {
    inactiveReasonKey: reason,
    inactiveLevel: await classifyInactiveLevelByDepth(
      clientId,
      kind,
      s.leadCallMinSeconds,
    ),
    inactiveSince: now,
    inactivePingCount: 0,
  };
}

interface DueClient {
  id: string;
  shortId: number;
  /** Тип клиента — от него зависит буквенный префикс номера карточки (ПК/ПР/ПО). */
  kind: ClientKind;
  fullName: string;
  assignedAgentId: string | null;
  inactiveLevel: InactiveLevel;
  inactiveSince: Date;
  inactivePingCount: number;
  inactiveReasonKey: InactiveReason | null;
  lastClientMessageAt: Date | null;
  lastContactAt: Date;
  status: string;
}

/**
 * БЫЛ ЛИ РЕАЛЬНЫЙ КОНТАКТ С КЛИЕНТОМ ПОСЛЕ ПЕРЕВОДА В НЕАКТИВНЫЕ (владелец
 * 23.09.2026: «светофор решает всё сам и правильно, кнопок у людей нет»).
 *
 * До этой правки сброс таймера давал только звонок через CRM с отметкой станции
 * TALKED. Агент, который поговорил с клиентом со своего телефона и записал это
 * в карточку, свозил клиента на показ или получил от него ответ в переписке,
 * для светофора не сделал ничего — и клиент уходил в «Потерянные» с живым
 * разговором в хронологии. Контактом считается то же, что уже считает
 * контактом вход в Неактивные (countContactTrace), только строже в одном:
 * НЕДОЗВОН контактом не бывает. Попытка связаться — повод пустить в Неактивные,
 * но не повод держать там вечно.
 *
 *  - звонок через CRM, где клиент взял трубку (callAttempt=TALKED);
 *  - звонок без отметки станции (ручная запись агента, «связался со своего
 *    телефона» outsideCrm) с исходом, кроме «не дозвонился»: исход ставит
 *    человек в форме «Как прошёл звонок», и не поговорив его не узнать;
 *  - состоявшийся показ или встреча (см. isHeldMeeting);
 *  - сообщение от клиента (Client.lastClientMessageAt).
 *
 * Возвращает момент контакта только для тех, у кого он позже СВОЕГО
 * inactiveSince. Два запроса на всю выборку, не по одному на клиента: тик
 * разбирает до 500 карточек раз в полчаса.
 */
export async function lastRealContactAt(
  clients: Array<{
    id: string;
    inactiveSince: Date | null;
    lastClientMessageAt?: Date | null;
  }>,
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const withSince = clients.filter(
    (c): c is typeof c & { inactiveSince: Date } => c.inactiveSince !== null,
  );
  if (withSince.length === 0) return out;
  const since = new Map(withSince.map((c) => [c.id, c.inactiveSince]));
  const ids = [...since.keys()];
  const earliestSince = new Date(
    Math.min(...withSince.map((c) => c.inactiveSince.getTime())),
  );

  const note = (clientId: string, at: Date | null | undefined) => {
    if (!at) return;
    const from = since.get(clientId);
    if (!from || at <= from) return;
    const prev = out.get(clientId);
    if (!prev || at > prev) out.set(clientId, at);
  };

  const [calls, meetings] = await Promise.all([
    prisma.interaction.findMany({
      where: {
        clientId: { in: ids },
        ...REAL_CALL_CONTACT_WHERE,
        createdAt: { gte: earliestSince },
      },
      select: { clientId: true, createdAt: true },
    }),
    prisma.interaction.findMany({
      where: {
        clientId: { in: ids },
        type: { in: ["SHOWING", "MEETING"] },
        completedAt: { gte: earliestSince },
        declinedAt: null,
      },
      select: { clientId: true, completedAt: true, nextActionDate: true },
    }),
  ]);
  for (const call of calls) note(call.clientId, call.createdAt);
  for (const m of meetings) if (isHeldMeeting(m)) note(m.clientId, m.completedAt);
  for (const c of withSince) {
    // Строго позже: ответ клиента ровно в момент перевода — это тот самый
    // разговор, после которого его и перевели, а не новый контакт.
    if (c.lastClientMessageAt && c.lastClientMessageAt > c.inactiveSince)
      note(c.id, c.lastClientMessageAt);
  }
  return out;
}

/**
 * ОДИН ТИК СВЕТОФОРА — крон вызывает раз в час (см. cron.ts). Разово, а не по
 * подписке: карточек с workStatus=INACTIVE в любой момент немного, полный обход
 * с составным индексом (Client.workStatus+inactiveLevel+inactiveSince) дешёвый.
 *
 * Для каждой карточки, чей срок следующего напоминания настал:
 *  - предел попыток ещё не исчерпан → пуш агенту + inactivePingCount++;
 *  - предел исчерпан → status=LOST (Потерянные), workStatus остаётся INACTIVE
 *    (карточка теперь и потеряна, и неактивна — как и любой другой LOST, слот
 *    в лимите она не занимает независимо от workStatus, см. leadLimits.ts).
 *
 * Вне рабочих часов пуши не шлём (не будим агента ради «напомни про клиента»),
 * но и не откладываем сам расчёт — просто пропускаем тик, следующий подхватит.
 */
export async function runInactiveTrafficLightTick(
  now: Date = new Date(),
): Promise<{ pinged: number; lost: number }> {
  const withinHours = await isWithinWorkingHours(now);
  if (!withinHours) return { pinged: 0, lost: 0 };

  const settings = await loadTrafficLightSettings();
  let pinged = 0;
  let lost = 0;
  let afterId: string | undefined;
  const absent = await absentAgentIds();
  for (;;) {
    const candidates = await prisma.client.findMany({
      /**
       * status: не LOST — иначе уже потерянный клиент (агент сохраняется, слот не
       * занимает, см. promoteToLost выше) навсегда остаётся кандидатом: тот же тик
       * находит его снова и снова каждые 30 минут и пытается «перевести в
       * Потерянные» повторно. Штраф агенту не дублируется (sourceId у
       * recordScoreEvent идемпотентен), но AuditLog/Interaction/push дублируются —
       * найдено 16.09.2026, у одной карточки набралось 69 повторов за неделю.
       */
      where: {
        ...(afterId ? { id: { gt: afterId } } : {}),
        workStatus: "INACTIVE",
        status: { notIn: [...TERMINAL_CLIENT_STATUSES] },
        assignedAgentId: { not: null },
        reactivationOfferedToAgentId: null,
        deletedAt: null,
      },
      select: {
        id: true,
        shortId: true,
        // kind нужен номеру карточки: префикс зависит от типа клиента (ПК/ПР/ПО).
        kind: true,
        fullName: true,
        assignedAgentId: true,
        inactiveLevel: true,
        inactiveSince: true,
        inactivePingCount: true,
        inactiveReasonKey: true,
        reactivationOfferedToAgentId: true,
        lastClientMessageAt: true,
        lastContactAt: true,
        status: true,
      },
      orderBy: { id: "asc" }, take: 500,
    });
    if (candidates.length === 0) break;
    afterId = candidates[candidates.length - 1].id;
    // Older entry points could set INACTIVE without starting the traffic clock.
    // Start a complete cycle now rather than charging an unknown past period.
    for (const c of candidates) {
      if (c.inactiveLevel && c.inactiveSince) continue;
      if (!c.assignedAgentId || absent.has(c.assignedAgentId)) continue;
      const level = await classifyInactiveLevelByDepth(c.id, c.kind, settings.leadCallMinSeconds);
      const repaired = await prisma.client.updateMany({
        where: { id: c.id, workStatus: "INACTIVE", status: c.status, deletedAt: null,
          assignedAgentId: c.assignedAgentId, inactiveSince: c.inactiveSince, inactiveLevel: c.inactiveLevel,
          reactivationOfferedToAgentId: null },
        data: { inactiveLevel: level, inactiveSince: now, inactivePingCount: 0 },
      });
      if (repaired.count === 1) publishClientUpdated({ clientId: c.id, agentIds: [c.assignedAgentId], stage: "INACTIVE" });
    }

    /**
     * B1 (audit 02.09.2026): таймер сбрасывает только РЕАЛЬНЫЙ КОНТАКТ с клиентом
     * после inactiveSince, а не пуш, заметка или запись «не дозвонился» — иначе
     * агент бесконечно откладывал бы LOST, просто не открывая карточку. Что
     * именно считается контактом — см. lastRealContactAt ниже (с 23.09.2026 это
     * не только TALKED-звонок через CRM).
     */
    /**
     * АГЕНТА НЕТ НА РАБОТЕ — его клиентов светофор не трогает (владелец 08.09.2026).
     *
     * До этой правки заморозка (отпуск, больничный, разбирательство) была светофору
     * неизвестна: агент уходил в отпуск, напоминания продолжали ему сыпаться, счётчик
     * попыток досчитывал до предела, и его неактивные клиенты уходили в «Потерянные»
     * АВТОМАТИЧЕСКИ — со штрафом ему же за «слитого клиента». Человек возвращался и
     * обнаруживал, что часть портфеля растворилась, пока его не было, а система
     * записала это ему в вину.
     *
     * Пауза «не принимаю новых лидов» отсутствием НЕ считается (см. agentAvailability.ts):
     * там агент на месте и обязан работать со своими — светофор для него работает как
     * обычно.
     */
    const live = (candidates as DueClient[]).filter(
      (c) =>
        c.assignedAgentId &&
        !absent.has(c.assignedAgentId) &&
        c.inactiveLevel &&
        c.inactiveSince,
    );
    const lastContactAt = await lastRealContactAt(live);

    const keepFromLost = await clientsProtectedFromAutoLost(live);

    for (const c of live) {
      if (!c.assignedAgentId || !c.inactiveLevel || !c.inactiveSince) continue;

      if (lastContactAt.has(c.id)) {
        /**
         * С клиентом был реальный контакт после перевода в Неактивные —
         * сбрасываем таймер: inactiveSince = сейчас, pingCount = 0. Клиент
         * остаётся INACTIVE (вернуть ли в ACTIVE, решает агент), но светофор
         * начинает отсчёт заново.
         *
         * ЦВЕТ ПЕРЕСЧИТЫВАЕТСЯ ТУТ ЖЕ (владелец 23.09.2026). До этого цвет ставился
         * один раз при входе в Неактивные и дальше не менялся: клиент, которого
         * после перевода свозили на показ, оставался «красным» с самым коротким
         * сроком терпения. Тот же classifyInactiveLevelByDepth, что при входе, —
         * второго правила цвета не заводим. Запросы на каждого СБРОШЕННОГО клиента,
         * а не на каждого кандидата: сброс редок, а правило цвета одно.
         */
        const level = await classifyInactiveLevelByDepth(
          c.id,
          c.kind,
          settings.leadCallMinSeconds,
        );
        const reset = await prisma.client.updateMany({
          where: trafficSnapshotWhere(c),
          data: { inactiveSince: now, inactivePingCount: 0, inactiveLevel: level },
        });
        if (reset.count !== 1) continue;
        publishClientUpdated({ clientId: c.id, agentIds: [c.assignedAgentId], stage: "INACTIVE" });
        /**
         * НАГРАДА ЗА ВОЗВРАТ (владелец 03.09.2026): усилие агента видно сразу, не
         * только избеганием потери позже. Только красный/жёлтый — зелёный тикает
         * каждые 24ч и был бы слишком лёгкой и частой целью для фарма баллов.
         * sourceId привязан к календарному месяцу — одна награда за клиента в
         * месяц, а не за каждый цикл «замолчал — дозвонились».
         */
        if (c.inactiveLevel !== "GREEN") {
          // Месяц по Душанбе (Ф12, 02.10.2026): по UTC с 00:00 до 05:00 первого
          // числа ключ был ещё прошломесячным, и награда за новый месяц молча
          // подавлялась как уже выданная.
          const monthKey = dushanbeDayKey(now).slice(0, 7);
          const points = await loadEventPoints();
          const kind =
            c.inactiveLevel === "RED"
              ? "client_revived_from_red"
              : "client_revived_from_yellow";
          void recordScoreEvent({
            agentId: c.assignedAgentId,
            kind,
            delta: points[kind],
            reason: `Дозвонился и вывел клиента из ${LEVEL_LABEL[c.inactiveLevel]} — ${c.fullName}`,
            sourceId: `${kind}-${c.id}-${monthKey}`,
          }).catch((err) =>
            console.error("[scoreJournal] награда за возврат из светофора:", err),
          );
        }
        continue;
      }

      const stepHours =
        pingHoursFor(c.inactiveLevel, settings) *
        toneMultiplier(c.inactiveReasonKey);
      const maxAttempts = maxAttemptsFor(c.inactiveLevel, settings);
      const elapsedHours = (now.getTime() - c.inactiveSince.getTime()) / HOUR_MS;
      const dueAttempt = Math.floor(elapsedHours / stepHours);
      if (dueAttempt <= c.inactivePingCount) continue; // ещё не подошёл срок следующего напоминания

      if (c.inactivePingCount >= maxAttempts) {
        // Живой по делу клиент в «Потерянные» сам не уходит (см.
        // clientsProtectedFromAutoLost): карточка остаётся у агента в «Решить
        // сейчас», решение — за человеком.
        if (keepFromLost.has(c.id)) continue;
        if (await promoteToLost(c)) lost++;
        continue;
      }

      const advanced = await prisma.client.updateMany({
        where: trafficSnapshotWhere(c),
        data: { inactivePingCount: { increment: 1 } },
      });
      if (advanced.count !== 1) continue;
      /**
       * НАПОМИНАНИЯ АГЕНТУ «Клиент давно не отвечает» УБРАНЫ (владелец 02.10.2026:
       * «не нужные уведомления»). Остаётся счётчик inactivePingCount выше — по нему
       * светофор решает, когда клиент уходит в Потерянные, — и карточка в «Решить
       * сейчас». Пуш и запись в ленте больше не создаются.
       */
      pinged++;
    }
    if (candidates.length < 500) break;
  }
  return { pinged, lost };
}

/** Название цвета — только для записей истории и причины перевода в Потерянные:
 *  их читает руководитель, разбирая, почему клиент ушёл. В тексты, которые видит
 *  агент (пуш, бейдж на карточке), цвет словом не выносится — см. пуш выше. */
const LEVEL_LABEL: Record<InactiveLevel, string> = {
  GREEN: "зелёный",
  YELLOW: "жёлтый",
  RED: "красный",
};

/**
 * ПРЕДЕЛ ПОПЫТОК СВЕТОФОРА → LOST, АГЕНТ СОХРАНЯЕТСЯ (аудит владения
 * 11.09.2026, дыра №2, `docs/ownership-audit-11-09.md`). До 01.09.2026 карточка
 * оставалась за агентом навсегда при статусе LOST; 01.09.2026 это поменяли на
 * обнуление `assignedAgentId`, но два других пути в LOST (отказ, передача) агента
 * не трогали — три пути расходились. Решение владельца 11.09.2026: LOST не
 * занимает слот в портфеле (`lib/leadLimits.ts::TERMINAL_STATUSES`), значит и не
 * нужно отбирать карточку — агент видит своего потерянного клиента в истории, а
 * не как «ничей». Единый путь — `markClientLost` (`lib/clientLifecycle.ts`),
 * которая тем же приёмом проставляет `lastAgentId`, что не мешает
 * `reassignStaleReturns` по-прежнему предлагать вернувшегося клиента СНАЧАЛА
 * этому же агенту.
 *
 * ШТРАФ — переиспользован тот же `client_lost_agent_fault` (-5 по умолчанию), что
 * уже начисляется при явном «Отказе» (routes/clients/lifecycle.ts). Не через
 * `classifyClientLossFault` (эвристика по просроченным окнам/задачам): светофор
 * не заводит ни то, ни другое на каждое напоминание, эвристика почти всегда
 * отвечала бы «без вины» — а сам факт «дошли до предела попыток и не спасли
 * клиента» уже и есть объективный след вины, отдельная проверка не нужна.
 */
function trafficSnapshotWhere(c: DueClient) {
  return {
    id: c.id, workStatus: "INACTIVE" as const, deletedAt: null,
    status: c.status as import("@royal-home/shared").ClientStatus,
    assignedAgentId: c.assignedAgentId, inactiveSince: c.inactiveSince,
    inactivePingCount: c.inactivePingCount, lastClientMessageAt: c.lastClientMessageAt,
    lastContactAt: c.lastContactAt,
  };
}

async function promoteToLost(c: DueClient): Promise<boolean> {
  const originalAgentId = c.assignedAgentId!;
  // lostAt — владелец 30.08.2026: момент перехода в «Потерянный», отдельно от
  // updatedAt (см. Client.lostAt в schema.prisma) — по нему считается «через
  // 3 месяца в корзину» (lib/lostInactiveTrashSweep.ts). markClientLost ставит
  // его сама (data.lostAt) — здесь только причина для истории.
  const changed = await markClientLost({
    clientId: c.id,
    reason: `Светофор неактивных: предел попыток (${LEVEL_LABEL[c.inactiveLevel]}) исчерпан — клиент переведён в Потерянные`,
    actorId: null,
    source: "lost.promote",
    guardWhere: {
      ...trafficSnapshotWhere(c),
      reactivationOfferedToAgentId: null,
      deals: { none: { stage: { notIn: ["COMPLETED", "CANCELLED"] } } },
      interactions: { none: { ...REAL_CALL_CONTACT_WHERE, createdAt: { gt: c.inactiveSince } } },
    },
  });
  if (!changed.ok) return false;

  const points = await loadEventPoints();
  await recordScoreEvent({
    agentId: originalAgentId,
    kind: "client_lost_agent_fault",
    delta: points.client_lost_agent_fault,
    reason: `Клиент потерян через светофор неактивных (${LEVEL_LABEL[c.inactiveLevel]}, предел попыток) — ${c.fullName}`,
    sourceId: `client-lost-traffic-light-${c.id}`,
  }).catch((err) =>
    console.error("[scoreJournal] штраф за слитого клиента (светофор):", err),
  );
  return true;

  /* Гашение открытых требований-окон убрано 14.09.2026 вместе с самим механизмом
     обязательных окон итогов: гасить больше нечего, и выдачу лидов у этого агента
     ничто не держит. Причина, по которой гашение завели (аудит 02.09.2026, баг B14 —
     агент терял лиды из-за окна по клиенту, которого у него уже нет), исчезла
     вместе с окнами. */

  /**
   * СЛЕД ШТАТНОГО СОБЫТИЯ — НЕ ОШИБКА (13.09.2026). Это не logSystemError: механизм
   * работает штатно, след остаётся в Interaction «SYSTEM» выше. Уведомление агенту в
   * ленту («Клиент переведён в Потерянные») убрано владельцем 02.10.2026.
   */
}

/** Дословный список причин — переэкспорт для тестов/форм, чтобы не тянуть
 *  @royal-home/shared там, где нужен только список этого модуля. */
export const ALL_INACTIVE_REASONS = INACTIVE_REASONS;

/**
 * КОГО СВЕТОФОР САМ В «ПОТЕРЯННЫЕ» НЕ ПЕРЕВОДИТ (живая жалоба агента 23.09.2026).
 *
 * «Клиент не терялся никуда… его объекты у меня в каталоге, подходящему
 * покупателю я их предлагаю». Светофор считал попыткой только звонок через CRM
 * и по исчерпанию попыток переводил в «Потерянные» и продавца с объектом в
 * работе, а ночная сверка статусов снимала его объекты с продажи. Правило
 * владельца уже было записано в lib/sellerCardState.ts: объект в работе —
 * продавец живой клиент. Здесь оно применено и к светофору, плюс два таких же
 * случая:
 * - продавец, у которого объект в работе (на подготовке, в продаже, в резерве);
 * - клиент с живой сделкой;
 * - клиент, который сам вернулся и ждёт решения агента о возврате
 *   (reactivationOfferedToAgentId).
 * Такой клиент остаётся неактивным у агента, напоминание уже было; в
 * «Потерянные» его переводит только человек.
 */
async function clientsProtectedFromAutoLost(
  clients: Array<{
    id: string;
    kind?: string | null;
    reactivationOfferedToAgentId?: string | null;
  }>,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (clients.length === 0) return out;
  for (const c of clients) if (c.reactivationOfferedToAgentId) out.add(c.id);
  const ids = clients.map((c) => c.id);
  const sellerIds = clients.filter((c) => c.kind === "SELLER").map((c) => c.id);
  const [sellersInWork, deals] = await Promise.all([
    sellersWithPropertyInWork(sellerIds),
    prisma.deal.findMany({
      where: {
        clientId: { in: ids },
        stage: { notIn: ["COMPLETED", "CANCELLED"] },
      },
      select: { clientId: true },
    }),
  ]);
  for (const id of sellersInWork) out.add(id);
  for (const d of deals) out.add(d.clientId);
  return out;
}

/** Клиент базы или интерактивная транзакция расширенного клиента — тип
 *  выводится из самого $transaction (см. Tx в lib/changeClientAgent.ts). */
type ShiftDb =
  | Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
  | typeof prisma;

/**
 * ОТСУТСТВИЕ АГЕНТА В СРОК СВЕТОФОРА НЕ ИДЁТ (владелец 23.09.2026).
 *
 * Пока агент заморожен (отпуск, больничный, разбирательство), тик его клиентов
 * пропускает — см. absentAgentIds в runInactiveTrafficLightTick. Но inactiveSince
 * при этом оставался прежним, и часы шли дальше: вернулся человек из двухнедельного
 * отпуска — и на первом же тике у всех его неактивных клиентов «прошло» по две
 * недели. Все недосланные напоминания срабатывали за час-два, и клиенты пачкой
 * уходили в «Потерянные» со штрафом агенту — ровно то, от чего защищала заморозка,
 * только с отсрочкой до дня возврата.
 *
 * Поэтому при разморозке точка отсчёта каждого такого клиента сдвигается вперёд
 * на время отсутствия, пришедшееся на его ТЕКУЩИЙ цикл: от начала заморозки или
 * от inactiveSince, если клиент ушёл в Неактивные уже во время отсутствия (такое
 * бывает — ночной крон молчащих работает и по замороженным). inactivePingCount не
 * трогаем: отправленные до отпуска напоминания были, и сдвиг ровно продолжает
 * расписание с того места, где отпуск его остановил.
 *
 * Начало заморозки неизвестно (не должно случаться — frozenAt и есть признак
 * заморозки — но вызывающий может его не иметь) — честно начинаем цикл заново:
 * inactiveSince = сейчас, счётчик = 0. Лучше лишний круг напоминаний, чем
 * пачка потерянных клиентов.
 *
 * Одна запись на всех клиентов агента, не по одной: сдвиг у каждого свой, поэтому
 * сырым SQL. Даты передаются числом миллисекунд и переводятся в UTC на стороне
 * базы — колонки TIMESTAMP(3) без пояса и хранят UTC, так что часовой пояс
 * сеанса в расчёт не вмешивается. Вызывать ДО или в одной транзакции со снятием
 * frozenAt: routes/agents.ts (POST /:id/unfreeze) и lib/absenceReturn.ts.
 */
export async function shiftInactiveClockAfterAbsence(
  agentId: string,
  frozenAt: Date | null,
  now: Date = new Date(),
  db: ShiftDb = prisma,
): Promise<number> {
  if (!frozenAt) {
    const { count } = await db.client.updateMany({
      where: {
        assignedAgentId: agentId,
        workStatus: "INACTIVE",
        status: { not: "LOST" },
        inactiveSince: { not: null },
        deletedAt: null,
      },
      data: { inactiveSince: now, inactivePingCount: 0 },
    });
    return count;
  }
  const nowMs = now.getTime();
  const frozenMs = frozenAt.getTime();
  return db.$executeRaw`
    UPDATE "Client"
    SET "inactiveSince" = "inactiveSince" + (
      (to_timestamp(${nowMs}::double precision / 1000) AT TIME ZONE 'UTC')
      - GREATEST("inactiveSince", (to_timestamp(${frozenMs}::double precision / 1000) AT TIME ZONE 'UTC'))
    )
    WHERE "assignedAgentId" = ${agentId}
      AND "workStatus" = 'INACTIVE'
      AND "status" <> 'LOST'
      AND "deletedAt" IS NULL
      AND "inactiveSince" IS NOT NULL
      AND "inactiveSince" < (to_timestamp(${nowMs}::double precision / 1000) AT TIME ZONE 'UTC')`;
}
