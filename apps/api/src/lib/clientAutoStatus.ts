import type { ClientStatus } from "@royal-home/shared";
import { prisma } from "../db.js";
import { logTimeline } from "./timeline.js";
import { isHeldMeeting, isRealCallContact, inactiveExitData, TERMINAL_CLIENT_STATUSES } from "./clientContact.js";
import { sellersWithPropertyInWork } from "./sellerCardState.js";
import { publishClientUpdated } from "./livePublish.js";
import { logSystemError } from "./systemError.js";

/**
 * Статус клиента ставится сам.
 *
 * ЗАЧЕМ. Владелец 08.08.2026: «хочу, чтобы агенты меньше меняли всё руками».
 * Статус — самое частое ручное действие в CRM и самое бесполезное: всё, из чего
 * он следует, система и так знает. Клиент взял трубку — значит «На контакте».
 * Назначили показ — «Горячий». Две недели тишины — «Не отвечает». Агент, который
 * честно работает, всё равно опаздывает переставить статус, а тот, кто не
 * работает, ставит «Горячий» и оставляет карточку лежать.
 *
 * ПРАВИЛА (пороги согласованы владельцем):
 *   Новый          — лид только пришёл, событий ещё не было;
 *   На контакте    — состоялся разговор или клиент ответил в переписке;
 *   Горячий        — назначен показ, заведена сделка или клиент сам просит смотреть;
 *   Холодный       — 7 дней тишины со стороны клиента, хотя мы писали/звонили;
 *   Не отвечает    — 3 неотвеченных звонка подряд;
 *   Сделка закрыта — сделка перешла в «Завершена»;
 *   В архиве       — 60 дней вообще без событий.
 *
 * ЧЕГО АВТОМАТИКА НЕ ДЕЛАЕТ. Не трогает «Потерянный» — это решение человека с
 * причиной отказа, автоматике его не переиграть. Не трогает карточку, статус
 * которой поставили руками меньше недели назад. И не понижает «Сделку закрыта»
 * обратно: закрытая сделка не остывает.
 *
 * ПОКУПАТЕЛЬ И ПРОДАВЕЦ (15.09.2026). decideStatus — чистая функция, ей всё
 * равно, чей это клиент, она смотрит только на AutoStatusFacts. Отличается
 * лишь то, ОТКУДА эти факты берутся: collectFacts (покупатель) и
 * collectFactsForSeller (продавец) читают разные признаки «показа» и разные
 * источники сделок (Deal.clientId у покупателя, Deal.propertyId →
 * Property.sellerClientId у продавца), а общую часть (звонки, переписка,
 * серия недозвонов) делят через collectSharedFacts. Ручной PATCH статуса
 * заблокирован для обоих (routes/clients/card.ts) — этот файл единственный,
 * кто теперь двигает NEW/CONTACTED/HOT/COLD/UNRESPONSIVE/ARCHIVED у продавца.
 * Терминальные «Сделка закрыта»/«Потерянный» по продавцу считает и пишет
 * ОТДЕЛЬНЫЙ модуль lib/sellerCardState.ts — по составу его объектов, а не по
 * фактам звонков, — поэтому collectFactsForSeller всегда отдаёт
 * dealClosed:false и не создаёт второй источник правды по этим двум статусам.
 *
 * AISCORE У ПРОДАВЦА (16.09.2026, продолжение того же решения). Владелец
 * подтвердил: движок должен видеть не только грубые факты («звонок был/не
 * было»), но и реальную оценку содержания разговоров — `Client.aiScore`
 * (0-100, «вероятность закрытия сделки в ближайшее время», считает
 * `scoreClient()` из `ai/scoring.ts` и так уже работает для продавца — крон
 * `scoreAllActiveClients` и `clientAutopilot.ts` скорят оба вида клиентов).
 * Высокий скоринг — то же самое качество сигнала, что и назначенная встреча:
 * агент мог ещё не дойти до встречи, а по содержанию разговора уже видно, что
 * сделка близко. Порог 70 — не новое число, а тот же, что уже действует для
 * «продавец без объекта» (`lib/sellerNoPropertyAlarm.ts`) и для аналогичного
 * будильника у покупателя (`cron.ts`) — одно место правды по смыслу порога,
 * даже если каждый модуль читает его как отдельную константу.
 *
 * ТОЛЬКО ПРОДАВЕЦ. `collectFacts` (покупатель) НЕ заполняет `facts.aiScore` —
 * поле остаётся `undefined`, и ветка ниже в `decideStatus` для покупателя
 * никогда не срабатывает. Так решение владельца «покупателя пока не трогаем»
 * выполняется без if(kind) внутри чистой функции: decideStatus по-прежнему не
 * знает, чей это клиент, а разница целиком остаётся в том, что именно кладёт
 * в facts вызывающая сторона.
 */

/** Сколько автоматика не вмешивается после ручной правки статуса. */
const MANUAL_HOLD_DAYS = 7;
/** Тишина клиента, после которой лид считается остывшим. */
const COLD_AFTER_DAYS = 7;
/** Неотвеченных звонков подряд до «Не отвечает». */
const NO_ANSWER_STREAK = 3;
/** Полное молчание, после которого карточка уходит в архив. */
const ARCHIVE_AFTER_DAYS = 60;
/** Скоринг, с которого содержание разговора само по себе считается «Горячий»
 *  сигналом у продавца — тот же порог, что sellerNoPropertyAlarm.ts/cron.ts. */
const AI_SCORE_HOT_THRESHOLD = 70;

const DAY = 86_400_000;

/** Статусы, которые автоматика не переписывает никогда. */
const FROZEN: ClientStatus[] = ["LOST", "DEAL_CLOSED"];

export interface AutoStatusInput {
  id: string;
  status: ClientStatus;
  createdAt: Date;
  acceptedAt: Date | null;
  statusSetManuallyAt: Date | null;
  hotSince: Date | null;
}

export interface AutoStatusFacts {
  /** Был ли разговор, в котором клиент взял трубку. */
  talked: boolean;
  /** Отвечал ли клиент в переписке. */
  clientReplied: boolean;
  /** Назначен или проведён показ. */
  showing: boolean;
  /** Есть незакрытая сделка. */
  activeDeal: boolean;
  /** Сделка завершена. */
  dealClosed: boolean;
  /** Сколько последних звонков подряд остались без ответа. */
  noAnswerStreak: number;
  /** Когда с клиентом в последний раз что-то происходило. */
  lastEventAt: Date;
  /** Когда клиент в последний раз проявлял себя сам (ответил, пришёл). */
  lastClientActivityAt: Date | null;
  /** ИИ-скоринг содержания разговоров (0-100), только у продавца — см. шапку
   *  файла «AISCORE У ПРОДАВЦА». У покупателя всегда undefined. */
  aiScore?: number | null;
  /** An existing listing is ongoing seller work even without recent contact. */
  sellerPropertyInWork?: boolean;
}

/**
 * Куда должен переехать статус. null — оставить как есть.
 *
 * Чистая функция без обращений к базе: так её можно проверить тестами на любых
 * сочетаниях, не собирая клиента в БД, и так видно, что решение зависит только
 * от фактов, а не от того, кто и когда вызвал.
 */
export function decideStatus(client: AutoStatusInput, facts: AutoStatusFacts, now: Date = new Date()): ClientStatus | null {
  if (FROZEN.includes(client.status)) return null;
  // Свежая ручная правка — человек знает больше правил.
  if (client.statusSetManuallyAt && now.getTime() - client.statusSetManuallyAt.getTime() < MANUAL_HOLD_DAYS * DAY) {
    return null;
  }
  // A delayed analysis or system note cannot reopen an archive. A genuine new
  // client reply/call can: archiving for silence must not be a permanent lock.
  if (client.status === "ARCHIVED" && (!facts.lastClientActivityAt ||
    now.getTime() - facts.lastClientActivityAt.getTime() >= COLD_AFTER_DAYS * DAY)) return null;

  const next = ((): ClientStatus => {
    if (facts.dealClosed) return "DEAL_CLOSED";
    // Показ и сделка — самый сильный признак: клиент тратит на нас своё время.
    // Высокий aiScore — тот же уровень сигнала по содержанию разговора
    // (только продавец, см. «AISCORE У ПРОДАВЦА» в шапке файла).
    if (
      facts.showing ||
      facts.activeDeal ||
      client.hotSince ||
      (typeof facts.aiScore === "number" && facts.aiScore >= AI_SCORE_HOT_THRESHOLD)
    ) {
      return "HOT";
    }
    if (facts.sellerPropertyInWork) return "CONTACTED";
    if (facts.noAnswerStreak >= NO_ANSWER_STREAK) return "UNRESPONSIVE";

    const silence = now.getTime() - facts.lastEventAt.getTime();
    if (silence >= ARCHIVE_AFTER_DAYS * DAY) return "ARCHIVED";

    if (facts.talked || facts.clientReplied) {
      // Разговор был, но с тех пор клиент молчит неделю — остыл.
      const since = facts.lastClientActivityAt ?? facts.lastEventAt;
      if (now.getTime() - since.getTime() >= COLD_AFTER_DAYS * DAY) return "COLD";
      return "CONTACTED";
    }
    return "NEW";
  })();

  return next === client.status ? null : next;
}

type SharedFacts = Omit<AutoStatusFacts, "activeDeal" | "dealClosed">;

/**
 * Общая часть сбора фактов — звонки, переписка, серия недозвонов. Одинакова для
 * покупателя и продавца: Interaction.clientId и BotConversation/
 * TelegramConversation читаются по clientId вне зависимости от kind. Отличается
 * только набор типов интеракции, который считается «показом» — его передаёт
 * вызывающий (collectFacts/collectFactsForSeller), чтобы не плодить if(kind)
 * внутри общей функции.
 */
async function collectSharedFacts(clientId: string, showingTypes: readonly string[]): Promise<SharedFacts> {
  const [interactions, client] = await Promise.all([
    prisma.interaction.findMany({
      where: { clientId },
      select: { type: true, outcome: true, createdAt: true, callAttempt: true, recordingDurationSec: true,
        completedAt: true, nextActionDate: true, declinedAt: true },
      orderBy: { createdAt: "desc" },
      // Больше и не нужно: все правила смотрят на последние события и на дату
      // самого свежего. Потолок обязателен — у старого клиента история длинная.
      take: 100,
    }),
    // Ответ клиента в переписке живёт не в хронологии, а в самом диалоге:
    // lastMessageAt — момент последнего ВХОДЯЩЕГО сообщения (см. BotConversation
    // и TelegramConversation). Хронология пишется по действиям агента, и по ней
    // «клиент ответил» не отличить от «агент написал».
    prisma.client.findUnique({
      where: { id: clientId },
      select: {
        lastClientMessageAt: true,
        botConversation: { select: { lastMessageAt: true } },
        telegramConversation: { select: { lastMessageAt: true } },
      },
    }),
  ]);

  const calls = interactions.filter((i) => i.type === "CALL");
  const talked = calls.some(isRealCallContact);
  // botConversation — массив (19.08.2026): у клиента может отвечать сразу
  // несколько диалогов бот-платформы, берём самый свежий ответ из ЛЮБОГО из них.
  const replies = [
    client?.lastClientMessageAt,
    ...(client?.botConversation.map((c) => c.lastMessageAt) ?? []),
    client?.telegramConversation?.lastMessageAt,
  ].filter((d): d is Date => !!d);
  const lastReplyAt = replies.length ? new Date(Math.max(...replies.map((d) => d.getTime()))) : null;
  const showing = interactions.some((i) => showingTypes.includes(i.type) && !i.declinedAt &&
    (!i.completedAt || isHeldMeeting(i)));
  // «Клиент проявил себя сам» — ответил в переписке или взял трубку.
  const answeredCall = calls.find(isRealCallContact)?.createdAt ?? null;
  const heldAt = interactions.filter((i) => showingTypes.includes(i.type) && isHeldMeeting(i))
    .map((i) => i.completedAt!);
  const activityDates = [lastReplyAt, answeredCall, ...heldAt].filter((d): d is Date => !!d);
  const lastClientActivityAt = activityDates.length ? new Date(Math.max(...activityDates.map((d) => d.getTime()))) : null;
  let noAnswerStreak = 0;
  for (const call of calls) {
    if (lastClientActivityAt && call.createdAt <= lastClientActivityAt) break;
    if (!isRealCallContact(call) && (call.callAttempt === "NO_ANSWER" || call.outcome === "NO_ANSWER")) noAnswerStreak++;
    else break;
  }
  const eventDates = [interactions[0]?.createdAt, ...activityDates].filter((d): d is Date => !!d);

  return {
    talked,
    clientReplied: !!lastReplyAt,
    showing,
    noAnswerStreak,
    lastEventAt: new Date(Math.max(0, ...eventDates.map((d) => d.getTime()))),
    lastClientActivityAt,
  };
}

/** Собирает факты по клиенту-покупателю одним проходом — без запроса на каждый признак. */
export async function collectFacts(clientId: string): Promise<AutoStatusFacts> {
  const [shared, deals] = await Promise.all([
    // У покупателя «показ» — это и показ объекта (SHOWING), и любая другая
    // встреча (MEETING) на его карточке.
    collectSharedFacts(clientId, ["SHOWING", "MEETING"]),
    prisma.deal.findMany({ where: { clientId }, select: { stage: true }, take: 20 }),
  ]);

  return {
    ...shared,
    activeDeal: deals.some((d) => d.stage !== "COMPLETED" && d.stage !== "CANCELLED"),
    dealClosed: deals.some((d) => d.stage === "COMPLETED"),
  };
}

/**
 * Собирает факты по клиенту-продавцу. Общая часть (звонки/переписка) та же, что
 * у покупателя, а «показ» и «сделка» — свои:
 *  - showing — встреча/осмотр с продавцом (Interaction.type === "MEETING", в том
 *    числе с outcome SELLER_MEETING — см. requireSellerShowingSummaries/routes/me.ts);
 *    у продавца нет SHOWING-интеракций, это показ объекта ПОКУПАТЕЛЮ, а не ему.
 *  - activeDeal — незавершённая сделка по ЛЮБОМУ из объектов продавца. Deal не
 *    привязан к продавцу напрямую (Deal.clientId — это покупатель), связь через
 *    Deal.propertyId → Property.sellerClientId.
 *  - dealClosed — всегда false: терминальные DEAL_CLOSED/LOST по продавцу считает
 *    и пишет sellerCardState.ts по составу его объектов, а не по фактам звонков —
 *    не дублируем и не создаём второй источник правды.
 */
export async function collectFactsForSeller(clientId: string): Promise<AutoStatusFacts> {
  const [shared, deals, client, sellersInWork] = await Promise.all([
    collectSharedFacts(clientId, ["MEETING"]),
    prisma.deal.findMany({
      where: { property: { sellerClientId: clientId } },
      select: { stage: true },
      take: 50,
    }),
    // Отдельный лёгкий запрос на одно поле — refreshClientStatus уже читает
    // client, но своим набором select, не включающим aiScore; плодить второй
    // источник правды через передачу facts вручную дороже, чем один Int-select.
    prisma.client.findUnique({ where: { id: clientId }, select: { aiScore: true } }),
    sellersWithPropertyInWork([clientId]),
  ]);

  return {
    ...shared,
    activeDeal: deals.some((d) => d.stage !== "COMPLETED" && d.stage !== "CANCELLED"),
    dealClosed: false,
    aiScore: client?.aiScore ?? null,
    sellerPropertyInWork: sellersInWork.has(clientId),
  };
}

/**
 * Пересчитать статус одного клиента и записать, если он изменился.
 *
 * Смена пишется в хронологию тем же типом STATUS_CHANGE, что и ручная, но без
 * agentId: в карточке видно, что статус переставила система, а не коллега.
 * Возвращает новый статус или null, если ничего не поменялось.
 */
export async function refreshClientStatus(clientId: string, now: Date = new Date()): Promise<ClientStatus | null> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      status: true,
      createdAt: true,
      acceptedAt: true,
      statusSetManuallyAt: true,
      hotSince: true,
      fullName: true,
      kind: true,
      assignedAgentId: true,
      workStatus: true,
      returnedAt: true,
      lastClientMessageAt: true,
      assignmentCompletedAt: true,
      inactiveSince: true,
    },
  });
  // «Прочие обращения» (OTHER) не трогаем — для них нет ни описанных правил, ни
  // согласованных с владельцем статусов. Покупатель и продавец — оба двигаются
  // этим движком, каждый своим набором фактов (см. шапку файла, 15.09.2026).
  if (!client || (client.kind !== "BUYER" && client.kind !== "SELLER")) return null;

  const facts = client.kind === "SELLER" ? await collectFactsForSeller(clientId) : await collectFacts(clientId);
  const next = decideStatus(client, facts, now);
  const restoreSeller = facts.sellerPropertyInWork && client.workStatus === "INACTIVE" &&
    !client.assignmentCompletedAt && !TERMINAL_CLIENT_STATUSES.some(s => s === client.status);
  if (!next && !restoreSeller) return null;

  const from = client.status;
  // Автор записи — system (logTimeline, П-10): статус переставила автоматика, а
  // не агент, поэтому agentId не подставляем даже при наличии ответственного —
  // им становится subjectAgentId (кому в карточке принадлежит эта смена), «автоматически»
  // остаётся в тексте для читаемости. У клиента без ответственного subjectAgentId
  // просто null — запись всё равно пишется (раньше без агента её пропускали вовсе).
  // Решение принято по снимку, прочитанному ДО сбора фактов (несколько запросов): за это
  // время оператор мог поставить LOST и отметить ручную правку, а защиты FROZEN и
  // семидневной ручной блокировки в decideStatus сработали по старому снимку
  // (CHANNEL-NEW-21). Пишем только если статус, отметка ручной правки и Корзина всё ещё
  // как в снимке; иначе чужая запись выигрывает, а в хронологию ничего не пишем.
  const written = await prisma.$transaction(async (tx) => {
    // Serialize with seller lifecycle operations and recheck the live object.
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR UPDATE`;
    // A listing added or removed during fact collection invalidates the decision.
    if (client.kind === "SELLER" &&
      (await sellersWithPropertyInWork([clientId], {}, tx)).has(clientId) !== facts.sellerPropertyInWork) return false;
    const updated = await tx.client.updateMany({
      where: { id: clientId, deletedAt: null, status: client.status, statusSetManuallyAt: client.statusSetManuallyAt,
        workStatus: client.workStatus, returnedAt: client.returnedAt, lastClientMessageAt: client.lastClientMessageAt,
        assignmentCompletedAt: client.assignmentCompletedAt, kind: client.kind,
        assignedAgentId: client.assignedAgentId, inactiveSince: client.inactiveSince },
      data: { ...(next ? { status: next } : {}), ...(restoreSeller ? inactiveExitData() : {}) },
    });
    if (updated.count !== 1) return false;
    await logTimeline({
      clientId,
      actor: { kind: "system", source: "clientAutoStatus", subjectAgentId: client.assignedAgentId },
      type: "STATUS_CHANGE",
      notes: restoreSeller
        ? "Продавец возвращён в работу: есть действующий объект; ожидание покупателя не является неактивностью"
        : `Статус изменён автоматически: «${STATUS_LABEL[from]}» → «${STATUS_LABEL[next!]}»`,
      tx,
    });
    return true;
  });
  if (written) publishClientUpdated({ clientId, agentIds: [client.assignedAgentId],
    stage: restoreSeller ? "ACTIVE" : next });
  return written ? next ?? client.status : null;
}

/** Post-commit listing hook; a failed recalculation must not undo a saved listing. */
export async function refreshSellerAfterPropertyChange(sellerClientId: string | null): Promise<void> {
  if (!sellerClientId) return;
  try {
    if ((await sellersWithPropertyInWork([sellerClientId])).has(sellerClientId)) {
      await refreshClientStatus(sellerClientId);
    }
  }
  catch (err) {
    await logSystemError("api", `Пересчёт продавца после изменения объекта: ${String(err)}`);
  }
}

/** Подписи для хронологии — короткие, как в интерфейсе. */
const STATUS_LABEL: Record<ClientStatus, string> = {
  NEW: "Новый",
  CONTACTED: "На контакте",
  HOT: "Горячий",
  COLD: "Холодный",
  UNRESPONSIVE: "Не отвечает",
  LOST: "Потерянный",
  DEAL_CLOSED: "Сделка закрыта",
  ARCHIVED: "В архиве",
};

/**
 * Ночной проход по карточкам, где статус меняется от ВРЕМЕНИ, а не от события:
 * остывание, недозвоны, архив. Событийные переходы (поговорили, назначили показ)
 * пересчитываются сразу в момент события — ждать ночи там незачем.
 */
export async function refreshStatusesByTime(now: Date = new Date()): Promise<{ checked: number; changed: number }> {
  const candidates = await prisma.client.findMany({
    where: {
      kind: { in: ["BUYER", "SELLER"] },
      deletedAt: null,
      status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] },
      // Смысл имеет только то, что уже полежало: у карточки, тронутой сегодня,
      // ни один временной порог не наступил.
      lastContactAt: { lte: new Date(now.getTime() - COLD_AFTER_DAYS * DAY) },
    },
    select: { id: true },
    orderBy: { lastContactAt: "asc" },
    take: 500,
  });

  let changed = 0;
  for (const c of candidates) {
    const next = await refreshClientStatus(c.id, now);
    if (next) changed++;
  }
  return { checked: candidates.length, changed };
}
