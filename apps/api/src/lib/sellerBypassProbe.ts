import { prisma } from "../db.js";
import type { ConversationMessage } from "@royal-home/shared";
import { guessShownProperty, type ShownPropertyCandidate } from "../ai/shownPropertyGuess.js";
import { loadWorkWindow, outagesBetween, workingOutageMs } from "./stationOutage.js";

/**
 * ПРОВЕРКА СО СТОРОНЫ ПРОДАВЦА — порог 5 воронки
 * (docs/buyer-antifraud-funnel-13-09-2026.md).
 *
 * МЫСЛЬ ВЛАДЕЛЬЦА, С КОТОРОЙ ВСЁ НАЧАЛОСЬ: у кражи ДВЕ стороны. Покупатель может
 * быть в доле — ему выгодно купить без комиссии. Продавцу врать незачем: он
 * просто хочет продать. Значит там, где покупатель молчит, вторую половину
 * картины можно взять у собственника.
 *
 * ПРЯМОЕ УКАЗАНИЕ ВЛАДЕЛЬЦА 16.09.2026, определяющее весь этот файл: «звонить не
 * всем продавцам, у которых был показ». Сначала система сама сужает круг —
 * определяет по переписке и записям звонков, КАКОЙ объект покупатель реально
 * смотрел, и проверяет, не ушло ли общение из CRM. Звонок — только по объекту,
 * который агент мог продать мимо компании.
 *
 * ЛЕСТНИЦА, КАЖДАЯ СТУПЕНЬ РЕЖЕТ (порядок величин из файла воронки):
 *   агент ОТПРАВИЛ покупателю объекты               ~5
 *   из них РЕАЛЬНО ПОКАЗЫВАЛ                        ~2
 *   из них покупатель после показа молчит            1
 *   из них и ПРОДАВЕЦ замолчал в CRM                 ← сюда
 *
 * САМЫЙ СИЛЬНЫЙ СИГНАЛ И ОН БЕСПЛАТНЫЙ: молчат ОБЕ стороны по одному объекту
 * после одной встречи. Один человек может просто не отвечать — бывает. Двое, по
 * одной квартире, сразу после одной встречи — это не совпадение: разговор
 * продолжился, просто не у нас.
 *
 * ЭТОТ МОДУЛЬ НИКОМУ НЕ ЗВОНИТ И НИКОГО НЕ ОБВИНЯЕТ. Он собирает досье и считает
 * сошедшиеся признаки. Что с этим делать — решают вызывающие: робозвонок
 * продавцу (порог 5.2) и досье рядом с кнопкой «Одобрить» у заявки на удаление
 * объекта — то самое место, про которое владелец сказал: «я могу по ошибке
 * одобрить, не зная всей картины».
 */

/** Сколько признаков должно сойтись, прежде чем беспокоить собственника.
 *  Правило владельца из файла воронки: «звоним, только когда сошлись минимум три». */
export const SELLER_PROBE_MIN_SIGNALS = 3;

/** Раньше двух суток тишина ничего не значит: человек может быть занят. */
export const SELLER_PROBE_SILENCE_MS = 2 * 24 * 60 * 60 * 1000;

/** Дальше месяца копать нечего: за это время и объект, и клиент живут своей жизнью. */
export const SELLER_PROBE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Объекты, отправленные покупателю за неделю до показа, — кандидаты на «что смотрели». */
const EXPOSURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Куски переписки и разговоров вокруг дня показа, по которым модель опознаёт объект. */
const EXCERPT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export interface BypassSignal {
  key:
    | "both_silent"
    | "seller_stopped_answering"
    | "agent_stopped_seller"
    | "property_left_sale"
    | "agent_contacted_seller_before"
    | "agent_history";
  label: string;
}

export interface BypassDossier {
  showingId: string;
  showingAt: Date;
  clientId: string;
  clientName: string;
  clientShortId: number;
  agentId: string;
  agentName: string;
  propertyId: string | null;
  propertyTitle: string | null;
  /** Как опознан объект: запись показа, единственная отправка, разбор переписки. */
  propertySource: "showing" | "single_candidate" | "ai_guess" | "unknown";
  sellerClientId: string | null;
  sellerName: string | null;
  /** Карточку продавца завёл агент руками (номер никем не проверен) — см.
   *  правило про выключенный номер в файле воронки. */
  sellerCardCreatedByAgent: boolean;
  signals: BypassSignal[];
  /** Круг закрыт: по объекту есть сделка или бронь — проверять нечего. */
  closedByDeal: boolean;
  shouldAskSeller: boolean;
}

/**
 * Показы, по которым стоит смотреть сторону продавца: покупатель после показа
 * так и не заговорил.
 *
 * Берём это из записей робозвонка, а не считаем заново: там уже учтено и
 * «клиент сам написал» (звонка не было, причина записана), и «не берёт трубку»
 * (две попытки потрачены). Исходы, где покупатель всё объяснил (понравилось, не
 * подошло, думает), сюда не попадают — там ничего расследовать не нужно.
 */
export async function findSellerProbeCandidates(now: Date = new Date(), limit = 50): Promise<string[]> {
  const rows = await prisma.postShowingCall.findMany({
    where: {
      createdAt: { gte: new Date(now.getTime() - SELLER_PROBE_MAX_AGE_MS), lte: new Date(now.getTime() - SELLER_PROBE_SILENCE_MS) },
      OR: [
        // «Не тот человек» на последней попытке — не молчание покупателя (третий аудит
        // 02.10.2026, В4): у такой строки номер мог быть чужим, собственнику из-за этого не звоним.
        // (null отдельно: в SQL «NOT LIKE» по пустому значению не истинно, и строки без пометок выпали бы)
        { status: "GIVEN_UP", OR: [{ skipReason: null }, { NOT: { skipReason: { contains: "wrong_person" } } }] },
        { status: "SKIPPED", skipReason: { in: ["no_phone", "weekly_limit", "stale"] } },
        { status: "DONE", outcome: { in: ["REFUSED", "UNCLEAR", "NO_MEETING", "AGENT_COMPLAINT", "BYPASS"] } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Куски переписки и расшифровок вокруг дня показа — сырьё для опознания объекта. */
async function collectExcerpts(clientId: string, showingAt: Date): Promise<string[]> {
  const from = new Date(showingAt.getTime() - EXCERPT_WINDOW_MS);
  const to = new Date(showingAt.getTime() + EXCERPT_WINDOW_MS);

  const [conversations, telegram, calls] = await Promise.all([
    prisma.botConversation.findMany({ where: { clientId }, select: { messages: true }, take: 5 }),
    prisma.telegramConversation.findMany({ where: { clientId }, select: { messages: true }, take: 5 }),
    prisma.interaction.findMany({
      where: { clientId, type: "CALL", createdAt: { gte: from, lte: to }, transcript: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { transcript: true, transcriptRu: true },
    }),
  ]);

  const excerpts: string[] = [];
  for (const conv of [...conversations, ...telegram]) {
    const messages = (Array.isArray(conv.messages) ? conv.messages : []) as unknown as ConversationMessage[];
    for (const message of messages) {
      const at = message.at ? new Date(message.at) : null;
      // Реплики без отметки времени пропускаем: без неё нельзя сказать, относится
      // ли фраза к этому показу или к другому, трёхмесячной давности.
      if (!at || Number.isNaN(at.getTime()) || at < from || at > to) continue;
      const text = (message.content ?? "").trim();
      if (text) excerpts.push(`${message.role === "user" ? "Клиент" : "Мы"}: ${text}`);
    }
  }
  for (const call of calls) {
    const text = (call.transcriptRu ?? call.transcript ?? "").trim();
    if (text) excerpts.push(`Разговор по телефону: ${text.slice(0, 2000)}`);
  }
  return excerpts.slice(-80);
}

/** Что агент отправлял этому покупателю около показа — кандидаты на «что смотрели». */
async function collectPropertyCandidates(clientId: string, showingAt: Date): Promise<ShownPropertyCandidate[]> {
  const from = new Date(showingAt.getTime() - EXPOSURE_WINDOW_MS);
  const [exposures, links] = await Promise.all([
    prisma.propertyExposure.findMany({
      where: { clientId, propertyId: { not: null }, sentAt: { gte: from, lte: showingAt } },
      orderBy: { sentAt: "desc" },
      take: 20,
      select: { propertyId: true },
    }),
    prisma.propertyShareLink.findMany({
      where: { clientId, createdAt: { gte: from, lte: showingAt } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { propertyId: true },
    }),
  ]);

  const ids = [...new Set([...exposures, ...links].map((r) => r.propertyId).filter((id): id is string => !!id))];
  if (ids.length === 0) return [];

  const properties = await prisma.property.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, title: true, address: true },
  });
  return properties.map((p) => ({ propertyId: p.id, title: p.title, address: p.address }));
}

/**
 * Досье по одному показу: какой объект смотрели, что с продавцом, сколько
 * признаков сошлось. `null` — показа или клиента уже нет.
 */
export async function buildBypassDossier(postShowingCallId: string, now: Date = new Date()): Promise<BypassDossier | null> {
  const call = await prisma.postShowingCall.findUnique({
    where: { id: postShowingCallId },
    select: {
      showingId: true,
      clientId: true,
      agentId: true,
      propertyId: true,
      client: { select: { fullName: true, shortId: true, lastClientMessageAt: true } },
      agent: { select: { fullName: true } },
      showing: { select: { nextActionDate: true, completedAt: true, createdAt: true } },
    },
  });
  if (!call) return null;

  const showingAt = call.showing.nextActionDate ?? call.showing.completedAt ?? call.showing.createdAt;

  // 1. КАКОЙ ОБЪЕКТ СМОТРЕЛИ. Запись показа — самый прямой ответ; дальше
  //    единственная отправка; дальше разбор переписки и разговоров.
  let propertyId = call.propertyId;
  let propertySource: BypassDossier["propertySource"] = propertyId ? "showing" : "unknown";
  if (!propertyId) {
    const candidates = await collectPropertyCandidates(call.clientId, showingAt);
    if (candidates.length === 1) {
      propertyId = candidates[0]!.propertyId;
      propertySource = "single_candidate";
    } else if (candidates.length > 1) {
      const guess = await guessShownProperty(candidates, await collectExcerpts(call.clientId, showingAt));
      if (guess) {
        propertyId = guess.propertyId;
        propertySource = "ai_guess";
      }
    }
  }

  const property = propertyId
    ? await prisma.property.findUnique({
        where: { id: propertyId },
        select: { id: true, title: true, status: true, deletedAt: true, sellerClientId: true, stageEnteredAt: true },
      })
    : null;

  // Продавец читается findFirst по строковому полю: внешнего ключа у
  // Property.sellerClientId нет (так в схеме), include по нему невозможен.
  const seller = property?.sellerClientId
    ? await prisma.client.findFirst({
        where: { id: property.sellerClientId, deletedAt: null },
        select: { id: true, fullName: true, source: true, lastClientMessageAt: true, createdAt: true },
      })
    : null;

  const dossier: BypassDossier = {
    showingId: call.showingId,
    showingAt,
    clientId: call.clientId,
    clientName: call.client.fullName,
    clientShortId: call.client.shortId,
    agentId: call.agentId,
    agentName: call.agent.fullName,
    propertyId: property?.id ?? null,
    propertyTitle: property?.title ?? null,
    propertySource,
    sellerClientId: seller?.id ?? null,
    sellerName: seller?.fullName ?? null,
    // Карточку из канала (звонок, мессенджер) подделать нельзя — номер проверен
    // самим фактом связи. WALK_IN здесь и значит «завёл агент руками».
    sellerCardCreatedByAgent: seller?.source === "WALK_IN",
    signals: [],
    closedByDeal: false,
    shouldAskSeller: false,
  };

  if (!property || !seller) return dossier;

  // 2. КРУГ ЗАКРЫТ? Сделка или бронь по объекту — проверять нечего.
  const deal = await prisma.deal.findFirst({
    where: { propertyId: property.id, stage: { notIn: ["CANCELLED"] } },
    select: { id: true },
  });
  if (deal || property.status === "RESERVED") {
    dossier.closedByDeal = true;
    return dossier;
  }

  dossier.signals = await collectSignals({ dossier, property, seller, showingAt, now });
  dossier.shouldAskSeller = dossier.signals.length >= SELLER_PROBE_MIN_SIGNALS;
  return dossier;
}

async function collectSignals(input: {
  dossier: BypassDossier;
  property: { id: string; status: string; deletedAt: Date | null; stageEnteredAt: Date };
  seller: { id: string; lastClientMessageAt: Date | null; createdAt: Date };
  showingAt: Date;
  now: Date;
}): Promise<BypassSignal[]> {
  const { dossier, property, seller, showingAt, now } = input;
  const signals: BypassSignal[] = [];

  const sellerSpokeAfter = !!seller.lastClientMessageAt && seller.lastClientMessageAt > showingAt;
  const sellerSpokeBefore = !!seller.lastClientMessageAt && seller.lastClientMessageAt <= showingAt;

  // (а) Молчат ОБЕ стороны по одному объекту. Покупательская тишина — условие
  //     попадания сюда, поэтому проверяется только вторая половина.
  if (!sellerSpokeAfter) {
    signals.push({ key: "both_silent", label: "После показа молчат и покупатель, и собственник" });
  }

  // (б) Собственник ОТВЕЧАЛ раньше и перестал — общение ушло в личку. Отличается
  //     от (а): человек, не писавший никогда, молчанием ничего не говорит.
  if (sellerSpokeBefore && !sellerSpokeAfter) {
    signals.push({ key: "seller_stopped_answering", label: "Собственник отвечал раньше, а после показа перестал" });
  }

  const [agentTouchesAfter, agentTouchesBefore] = await Promise.all([
    prisma.interaction.count({
      where: { clientId: seller.id, agentId: dossier.agentId, type: { not: "SYSTEM" }, createdAt: { gt: showingAt } },
    }),
    prisma.interaction.count({
      where: {
        clientId: seller.id,
        agentId: dossier.agentId,
        type: { not: "SYSTEM" },
        createdAt: { gte: new Date(showingAt.getTime() - 30 * 24 * 60 * 60 * 1000), lte: showingAt },
      },
    }),
  ]);

  // (в) Агент вёл продавца и перестал — зеркало покупательской тишины.
  //     Простой станции вычитается: день без телефонии не обвинение.
  if (agentTouchesBefore > 0 && agentTouchesAfter === 0) {
    const [outages, window] = await Promise.all([outagesBetween(showingAt, now), loadWorkWindow()]);
    const downMs = workingOutageMs(showingAt, now, outages, window);
    const silenceMs = now.getTime() - showingAt.getTime();
    if (downMs < silenceMs / 2) {
      signals.push({ key: "agent_stopped_seller", label: "Агент вёл собственника в CRM и после показа перестал" });
    }
  }

  // (г) Агент связывался с собственником перед показом — значит показ был
  //     настоящий и о нём знали обе стороны. Дальше тишина с обеих сторон и есть
  //     тот самый стык. (Точную фразу «завтра приведу покупателя» слышно в
  //     расшифровке; пока считаем сам факт контакта — это заведомо слабее, и в
  //     одиночку этот признак ничего не решает.)
  if (agentTouchesBefore > 0) {
    signals.push({ key: "agent_contacted_seller_before", label: "Перед показом агент общался с собственником" });
  }

  // (д) Объект ушёл с продажи ПОСЛЕ показа, а сделки нет. Квартира не снимается
  //     с продажи просто так; снялась сразу после показа, а денег компания не
  //     увидела — это стык. Но это ещё не улика: собственник мог передумать.
  const leftSale = property.deletedAt !== null || property.status === "WITHDRAWN" || property.status === "SOLD";
  // Когда именно ушёл: удалённый — по deletedAt, снятый или проданный — по
  // stageEnteredAt (он двигается только на СМЕНЕ статуса, а не на правке карточки,
  // поэтому это и есть дата снятия с продажи).
  const leftAfterShowing = leftSale && (property.deletedAt ?? property.stageEnteredAt) > showingAt;
  if (leftAfterShowing) {
    signals.push({ key: "property_left_sale", label: "Объект ушёл с продажи после показа, сделки нет" });
  }

  // (е) История самого агента: по нему уже был подтверждённый красный исход.
  const previousRed = await prisma.postShowingCall.count({
    where: {
      agentId: dossier.agentId,
      outcome: { in: ["NO_MEETING", "AGENT_COMPLAINT", "BYPASS"] },
      createdAt: { gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) },
      NOT: { showingId: dossier.showingId },
    },
  });
  if (previousRed > 0) {
    signals.push({ key: "agent_history", label: `У агента уже ${previousRed} подтверждённых случаев за 90 дней` });
  }

  return signals;
}
