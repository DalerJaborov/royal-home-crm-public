import {
  maskPhones,
  PROPERTY_VOICE_PRICE_REACTION_DAYS,
  PROPERTY_VOICE_TOP_TEXTS,
  PROPERTY_VOICE_WEEKS,
  REFUSAL_REASON_LABELS,
  type PropertyVoiceAds,
  type PropertyVoiceBargaining,
  type PropertyVoiceComments,
  type PropertyVoiceCount,
  type PropertyVoiceInterest,
  type PropertyVoiceResponse,
  type PropertyVoiceShowingFeedback,
  type PropertyVoiceText,
  type RefusalReason,
} from "@royal-home/shared";
import { isConductedShowing } from "../conductedShowing.js";
import { dushanbeWallClock } from "../dushanbeTime.js";
import { diagnoseProperty } from "./diagnosis.js";

/**
 * СВЁРТКА «ГОЛОСА РЫНКА» — ЧИСТАЯ ФУНКЦИЯ (03.10.2026).
 *
 * Запросы к базе живут в loadPropertyVoice.ts и отдают сюда уже прочитанные строки
 * (`PropertyVoiceRaw`); здесь только счёт. Так всё, что решает «что показать
 * владельцу», проверяется тестами на фикстурах без базы.
 *
 * Принципы свёртки:
 *  • «нет данных» — ноль, пустой список или null, но не выдуманное число;
 *  • тексты клиентов проходят `maskPhones`: сюда они попадают из комментариев,
 *    вопросов собственнику и разборов звонков, а там клиент диктует и номера;
 *  • частотный список сводит реплики без учёта регистра, пробелов и знаков на
 *    краях — «Нарх чанд?» и «нарх чанд» это один вопрос.
 */

const DAY_MS = 24 * 3600_000;
/** Длина одного текста в ответе: цитата не должна превращаться в простыню. */
const MAX_TEXT_LEN = 240;

export interface RawInterestEvent {
  kind: string;
  createdAt: Date;
  /** Карточка клиента или автор в канале; null — человек неизвестен (в «людей» не входит). */
  personKey: string | null;
}

export interface RawExposure {
  kind: string;
  sentAt: Date;
  /** `канал:собеседник` — один человек в одном канале. */
  personKey: string;
}

export interface RawComment {
  channel: string;
  status: string;
  note: string | null;
  text: string;
}

export interface RawPriceChange {
  createdAt: Date;
  oldPrice: number;
  newPrice: number;
  oldCurrency: string;
  newCurrency: string;
}

export interface RawDeal {
  stage: string;
  /** null — цена скрыта правами (чужая сделка без `finance.view`). */
  soldPrice: number | null;
  currency: string;
  closedAt: Date | null;
}

export interface RawShowing {
  clientId: string;
  type: string;
  declinedAt: Date | null;
  completedAt: Date | null;
  nextActionDate: Date | null;
}

export interface RawFeedbackCall {
  outcome: string | null;
  outcomeLabel: string | null;
  quote: string | null;
  summary: string | null;
  redFlags: string[];
}

export interface PropertyVoiceRaw {
  now: Date;
  windowDays: number;
  windowStart: Date;
  /** `onSale`/`daysOnSale` нужны только диагнозу; не заданы — считаем «в продаже, срок неизвестен». */
  property: { id: string; price: number; currency: string; onSale?: boolean; daysOnSale?: number | null };
  /** События интереса с запасом назад на PRICE_REACTION дней: нужны для сравнения до/после снижения. */
  interestEvents: RawInterestEvent[];
  /** Последнее событие интереса за всё время (может быть старше окна). */
  lastEventAt: Date | null;
  exposures: RawExposure[];
  conversationSources: { source: string; count: number }[];
  comments: RawComment[];
  ownerQuestions: { question: string; answer: string | null; askedAt: Date; answeredAt: Date | null }[];
  callObjections: string[][];
  showings: RawShowing[];
  refusalReasons: (string | null)[];
  priceChanges: RawPriceChange[];
  deals: RawDeal[];
  /** true — сделки уже отфильтрованы до СВОИХ (нет `deals.viewAll`): экран должен сказать, что чужие скрыты. */
  dealsOwnOnly: boolean;
  ads: {
    adsCount: number;
    /** true — нет права на деньги рекламы: `spendTjs`/`spendOriginal` уже null, диагноз строки расхода не строит. */
    moneyHidden: boolean;
    spendTjs: number | null;
    spendOriginal: number | null;
    currency: string | null;
    impressions: number;
    clicks: number;
    conversations: number;
    botConversations: number;
  };
  /** null — у пользователя нет права директора: раздел не читается и не отдаётся. */
  feedback: { calls: RawFeedbackCall[] } | null;
}

// ─── Малые чистые помощники ────────────────────────────────────────────────

/** Ключ сведения реплик: без регистра, пробелов и знаков на краях. */
export function textKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "")
    .trim();
}

/**
 * Частотный список текстов: по убыванию, при равенстве — по алфавиту (порядок стабилен).
 *
 * Ключ сведения строится от УЖЕ МАСКИРОВАННОГО текста: иначе «позвоните 90 111 22 33» и
 * «позвоните 90 444 55 66» были бы двумя группами, а в ответе — двумя одинаковыми строками
 * «позвоните +992 *** ***» (и с одним id на экране). Что неотличимо на экране, то и одна реплика.
 */
export function topTexts(texts: string[], limit = PROPERTY_VOICE_TOP_TEXTS): PropertyVoiceText[] {
  const groups = new Map<string, { text: string; count: number }>();
  for (const raw of texts) {
    const masked = maskPhones(raw.trim()).text;
    const key = textKey(masked);
    if (!key) continue;
    const found = groups.get(key);
    if (found) found.count += 1;
    else groups.set(key, { text: clipText(masked), count: 1 });
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, "ru"))
    .slice(0, limit);
}

function clipText(masked: string): string {
  return masked.length > MAX_TEXT_LEN ? `${masked.slice(0, MAX_TEXT_LEN - 1)}…` : masked;
}

/** Текст клиента для ответа: телефоны закрыты, длина ограничена. */
export function safeText(text: string): string {
  return clipText(maskPhones(text.trim()).text);
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

function sortedCounts(map: Map<string, number>): { key: string; count: number }[] {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Понедельник недели по Душанбе, «ГГГГ-ММ-ДД». */
export function dushanbeWeekStart(at: Date): string {
  const wall = dushanbeWallClock(at);
  const sinceMonday = (wall.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() - sinceMonday));
  return monday.toISOString().slice(0, 10);
}

/** Целых календарных суток по Душанбе между двумя моментами (a раньше b). */
export function dushanbeDaysBetween(a: Date, b: Date): number {
  const dayA = Date.UTC(dushanbeWallClock(a).getUTCFullYear(), dushanbeWallClock(a).getUTCMonth(), dushanbeWallClock(a).getUTCDate());
  const dayB = Date.UTC(dushanbeWallClock(b).getUTCFullYear(), dushanbeWallClock(b).getUTCMonth(), dushanbeWallClock(b).getUTCDate());
  return Math.round((dayB - dayA) / DAY_MS);
}

function pct(from: number, to: number): number | null {
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to)) return null;
  return Math.round(((to - from) / from) * 1000) / 10;
}

// ─── Разделы ───────────────────────────────────────────────────────────────

export function foldInterest(raw: PropertyVoiceRaw): PropertyVoiceInterest {
  const { now, windowStart } = raw;
  const inWindow = raw.interestEvents.filter((e) => e.createdAt >= windowStart);

  const people = new Set<string>();
  const byKind = new Map<string, { events: number; people: Set<string> }>();
  for (const e of inWindow) {
    const entry = byKind.get(e.kind) ?? { events: 0, people: new Set<string>() };
    entry.events += 1;
    if (e.personKey) {
      entry.people.add(e.personKey);
      people.add(e.personKey);
    }
    byKind.set(e.kind, entry);
  }

  // Недели считаются от текущей назад: пустые недели остаются нулями — график с
  // пропусками читался бы как «данных нет», а это «ничего не происходило».
  const weekStarts: string[] = [];
  for (let i = PROPERTY_VOICE_WEEKS - 1; i >= 0; i--) {
    weekStarts.push(dushanbeWeekStart(new Date(now.getTime() - i * 7 * DAY_MS)));
  }
  const weekly = new Map(weekStarts.map((w) => [w, { events: 0, people: new Set<string>() }]));
  for (const e of inWindow) {
    const bucket = weekly.get(dushanbeWeekStart(e.createdAt));
    if (!bucket) continue; // старше показанных недель
    bucket.events += 1;
    if (e.personKey) bucket.people.add(e.personKey);
  }

  const exposuresInWindow = raw.exposures.filter((x) => x.sentAt >= windowStart);
  const clientShared = exposuresInWindow.filter((x) => x.kind === "CLIENT_SHARED").length;

  return {
    events: inWindow.length,
    people: people.size,
    byKind: [...byKind.entries()]
      .map(([kind, v]) => ({ kind, events: v.events, people: v.people.size }))
      .sort((a, b) => b.events - a.events || a.kind.localeCompare(b.kind)),
    lastEventAt: raw.lastEventAt ? raw.lastEventAt.toISOString() : null,
    daysSinceLastEvent: raw.lastEventAt ? Math.max(0, dushanbeDaysBetween(raw.lastEventAt, now)) : null,
    weekly: weekStarts.map((weekStart) => {
      const b = weekly.get(weekStart)!;
      return { weekStart, events: b.events, people: b.people.size };
    }),
    exposures: {
      total: exposuresInWindow.length,
      uniquePeople: new Set(exposuresInWindow.map((x) => x.personKey)).size,
      clientShared,
      clientSharedShare:
        exposuresInWindow.length > 0 ? Math.round((clientShared / exposuresInWindow.length) * 1000) / 1000 : null,
      byKind: sortedCounts(countBy(exposuresInWindow, (x) => x.kind)).map(({ key, count }) => ({ kind: key, count })),
    },
    conversations: {
      total: raw.conversationSources.reduce((sum, s) => sum + s.count, 0),
      bySource: [...raw.conversationSources].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
    },
  };
}

/**
 * Содержательные статусы комментария: бот ответил по делу (REPLIED) или передал человеку
 * (ESCALATED). Остальное — SKIPPED (спам, конкурент, loop_guard, bot_off), DELETED, HIDDEN —
 * не голос клиента, а шум; с 03.10.2026 `propertyId` проставляется и им (добор в `finish`,
 * messengers/comments.ts), и без этого фильтра спам завышал «Комментариев: N» и гасил диагноз
 * «интереса нет». Для расхода рекламы эти же строки считает adSpendReport — там они нужны.
 * PENDING/WORKING/FAILED итога не имеют: не отвечено — значит, и не услышано.
 */
export const MEANINGFUL_COMMENT_STATUSES: ReadonlySet<string> = new Set(["REPLIED", "ESCALATED"]);

export function foldComments(allComments: RawComment[]): PropertyVoiceComments {
  const comments = allComments.filter((c) => MEANINGFUL_COMMENT_STATUSES.has(c.status));
  const escalated = comments.filter((c) => c.status === "ESCALATED");
  return {
    total: comments.length,
    byChannel: sortedCounts(countBy(comments, (c) => c.channel)).map(({ key, count }) => ({ channel: key, count })),
    byStatus: sortedCounts(countBy(comments, (c) => c.status)).map(({ key, count }) => ({ status: key, count })),
    escalated: {
      count: escalated.length,
      notes: topTexts(escalated.map((c) => c.note ?? "").filter(Boolean)),
      topTexts: topTexts(escalated.map((c) => c.text)),
    },
  };
}

function foldRefusals(reasons: (string | null)[]): { total: number; byReason: PropertyVoiceCount[] } {
  const known = reasons.filter((r): r is string => !!r);
  return {
    // Отказ без причины в карточке тоже отказ — считаем в total, но в разбивку он не входит.
    total: reasons.length,
    byReason: sortedCounts(countBy(known, (r) => r)).map(({ key, count }) => ({
      key,
      label: REFUSAL_REASON_LABELS[key as RefusalReason] ?? key,
      count,
    })),
  };
}

export function foldBargaining(raw: PropertyVoiceRaw): PropertyVoiceBargaining {
  const reactionMs = PROPERTY_VOICE_PRICE_REACTION_DAYS * DAY_MS;
  const eventTimes = raw.interestEvents.map((e) => e.createdAt.getTime());
  const countBetween = (from: number, to: number) => eventTimes.filter((t) => t >= from && t < to).length;

  const priceChanges = [...raw.priceChanges]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((c) => {
      const at = c.createdAt.getTime();
      // До изменения данных нет, если оно старше окна событий (запас назад ровно
      // PRICE_REACTION дней от начала окна): честный null вместо ложного нуля.
      const covered = c.createdAt >= raw.windowStart;
      const observedMs = Math.min(reactionMs, Math.max(0, raw.now.getTime() - at));
      return {
        at: c.createdAt.toISOString(),
        oldPrice: c.oldPrice,
        newPrice: c.newPrice,
        oldCurrency: c.oldCurrency,
        newCurrency: c.newCurrency,
        deltaPct: c.oldCurrency === c.newCurrency ? pct(c.oldPrice, c.newPrice) : null,
        eventsBefore: covered ? countBetween(at - reactionMs, at) : null,
        eventsAfter: covered ? countBetween(at, at + reactionMs) : null,
        daysAfterObserved: covered ? Math.floor(observedMs / DAY_MS) : null,
      };
    });

  const deals = raw.deals.map((d) => ({
    stage: d.stage,
    soldPrice: d.soldPrice,
    listPrice: raw.property.price,
    currency: d.currency,
    listCurrency: raw.property.currency,
    // Цены сравниваются только в одной валюте: сделка хранит валюту объекта на
    // момент своего создания, и если её потом сменили — честный null.
    discountPct: d.soldPrice != null && d.currency === raw.property.currency ? pct(raw.property.price, d.soldPrice) : null,
    closedAt: d.closedAt ? d.closedAt.toISOString() : null,
  }));

  return { priceChanges, deals, dealsOwnOnly: raw.dealsOwnOnly };
}

function foldShowings(raw: PropertyVoiceRaw) {
  const showings = raw.showings.filter((s) => s.type === "SHOWING");
  return {
    total: showings.length,
    conducted: showings.filter((s) => isConductedShowing(s, raw.now)).length,
    declined: showings.filter((s) => s.declinedAt !== null).length,
    uniqueClients: new Set(showings.map((s) => s.clientId)).size,
  };
}

export function foldShowingFeedback(calls: RawFeedbackCall[]): PropertyVoiceShowingFeedback {
  const outcomes = new Map<string, { label: string; count: number }>();
  for (const call of calls) {
    if (!call.outcome) continue;
    const entry = outcomes.get(call.outcome) ?? { label: call.outcomeLabel ?? call.outcome, count: 0 };
    entry.count += 1;
    outcomes.set(call.outcome, entry);
  }
  const quotes = calls
    .map((c) => c.quote?.trim() || c.summary?.trim() || "")
    .filter(Boolean)
    .map(safeText)
    .slice(0, PROPERTY_VOICE_TOP_TEXTS);
  return {
    calls: calls.length,
    byOutcome: [...outcomes.entries()]
      .map(([key, v]) => ({ key, label: v.label, count: v.count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    quotes,
    redFlags: topTexts(calls.flatMap((c) => c.redFlags)),
  };
}

function foldAds(ads: PropertyVoiceRaw["ads"]): PropertyVoiceAds {
  return { ...ads };
}

/** Сборка всего ответа. Раздел `showingFeedback` кладётся ТОЛЬКО если `raw.feedback` не null. */
export function foldPropertyVoice(raw: PropertyVoiceRaw): PropertyVoiceResponse {
  const answered = raw.ownerQuestions.filter((q) => q.answeredAt !== null || !!q.answer).length;
  const response: Omit<PropertyVoiceResponse, "diagnosis"> = {
    propertyId: raw.property.id,
    generatedAt: raw.now.toISOString(),
    windowDays: raw.windowDays,
    windowFrom: raw.windowStart.toISOString(),
    interest: foldInterest(raw),
    questions: {
      comments: foldComments(raw.comments),
      ownerQuestions: {
        total: raw.ownerQuestions.length,
        answered,
        items: [...raw.ownerQuestions]
          .sort((a, b) => b.askedAt.getTime() - a.askedAt.getTime())
          .slice(0, 20)
          .map((q) => ({
            question: safeText(q.question),
            answer: q.answer ? safeText(q.answer) : null,
            askedAt: q.askedAt.toISOString(),
            answeredAt: q.answeredAt ? q.answeredAt.toISOString() : null,
          })),
      },
      callObjections: { calls: raw.callObjections.length, top: topTexts(raw.callObjections.flat()) },
      showings: foldShowings(raw),
      refusals: foldRefusals(raw.refusalReasons),
    },
    bargaining: foldBargaining(raw),
    ads: foldAds(raw.ads),
  };
  if (raw.feedback) response.showingFeedback = foldShowingFeedback(raw.feedback.calls);
  // Диагноз — правила поверх уже собранного ответа (diagnosis.ts), читает и showingFeedback,
  // если он есть: у агента его нет, и диагноз строится по меньшему набору данных.
  const diagnosis = diagnoseProperty(response, {
    onSale: raw.property.onSale ?? true,
    daysOnSale: raw.property.daysOnSale ?? null,
  });
  return { ...response, diagnosis };
}
