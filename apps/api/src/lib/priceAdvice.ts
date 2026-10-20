import {
  PRICE_WAITLIST_MIN_SAMPLE,
  PROPERTY_VOICE_PRICE_REACTION_DAYS,
  pluralizeRu,
  priceAdviceMoney,
  type PriceAdvice,
  type PriceWaitlistResponse,
  type PriceWaitlistStep,
  type PropertyVoiceResponse,
} from "@royal-home/shared";
import {
  DIAGNOSIS_CUT_RETURN_MIN_GAIN,
  DIAGNOSIS_CUT_RETURN_RATIO,
  DIAGNOSIS_MIN_EVENTS,
  DIAGNOSIS_MIN_PRICE_SIGNALS,
  DIAGNOSIS_PRICE_SHARE,
  DIAGNOSIS_SHARED_MIN,
  DIAGNOSIS_SHARED_SHARE,
  priceSignals,
} from "./propertyVoice/diagnosis.js";

/**
 * СОВЕТ ПО ЦЕНЕ — ЧИСТАЯ ФУНКЦИЯ (03.10.2026).
 *
 * Без ИИ и без базы: правила поверх уже собранного «голоса рынка» и листа ожидания по цене.
 * Это подсказка агенту перед разговором с собственником, а не приговор и не обещание:
 * в текстах нет «вернёт показы» и «продастся», только «по данным», и у каждого вывода
 * есть `evidence` с цифрами, чтобы можно было не согласиться.
 *
 * ПОЧЕМУ «СНИЗИТЬ» ТРЕБУЕТ ДВУХ НЕЗАВИСИМЫХ ПРИЗНАКОВ, А «ДЕРЖАТЬ» — НЕТ.
 * Ложный совет «снизить» стоит собственнику денег, а агенту — доверия: после двух таких
 * его перестают читать. Поэтому снижение предлагается, только когда сходятся минимум два
 * разных сигнала из трёх (возражения о цене, ждущие клиенты, долгая тишина). Один сигнал —
 * «держать, но вот что видно». А сильный спрос и свежее снижение, которое ещё не успело
 * проявиться, не переспорить никакими сигналами: торопить с ценой тогда не за чем.
 *
 * Сигналы (константы ниже, у каждой причина):
 *  A. цена преобладает в возражениях — та же мера, что у диагноза PRICE_OBJECTIONS;
 *  B. лист ожидания: небольшое снижение возвращает в круг минимум двух клиентов;
 *  C. долгая тишина: объект давно в продаже, а за последний месяц почти нет касаний.
 */

/** Показатели «голоса», которые читает совет. */
export type PriceAdviceVoice = Omit<PropertyVoiceResponse, "diagnosis">;

/** Сколько последних недель считаем «недавним» спросом: месяц — срок, за который цена и спрос ещё связаны. */
export const ADVICE_RECENT_WEEKS = 4;
/** «Сильный спрос»: столько касаний за последние ADVICE_RECENT_WEEKS недель … */
export const ADVICE_STRONG_RECENT_EVENTS = 8;
/** … от трёх разных людей (как у диагноза) … */
export const ADVICE_STRONG_PEOPLE = 3;
/** … и не меньше двух показов: ссылки открывают и из любопытства, показ — уже намерение. */
export const ADVICE_STRONG_SHOWINGS = 2;
/** «Долгая тишина»: дольше стольких дней в продаже … (до 45 дней отсутствие интереса — норма для нового объекта) */
export const ADVICE_QUIET_DAYS_ON_SALE = 45;
/** … и меньше стольких касаний за последний месяц. */
export const ADVICE_QUIET_RECENT_EVENTS = 4;
/** Ступень листа ожидания считается убедительной, когда она возвращает минимум столько клиентов: один — это случай, а не очередь. */
export const ADVICE_MIN_NEW_CLIENTS = 2;
/** Глубже этой ступени совет не называет цифру: снижение на 15 % — уже не рекомендация по данным, а отдельный разговор о стратегии. */
export const ADVICE_MAX_SUGGESTED_DROP_PCT = 10;

export interface PriceAdviceContext {
  onSale: boolean;
  /** Дней в продаже; null — неизвестно. */
  daysOnSale: number | null;
}

/**
 * Сколько показов ПРОВЕДЕНО. Раньше брали максимум из всех записей показа и событий интереса
 * SHOWING: оба создаются при НАЗНАЧЕНИИ, так что два будущих или отменённых показа давали
 * «люди доходят до показов» и «спрос сильный» (аудит 04.10.2026, APROP02). Проведённым
 * считается показ по единому правилу lib/conductedShowing.ts (его считает aggregate.ts).
 */
function showingsCount(voice: PriceAdviceVoice): number {
  return voice.questions.showings.conducted;
}

/** События интереса за последние ADVICE_RECENT_WEEKS недель — по недельной динамике «голоса». */
function recentEvents(voice: PriceAdviceVoice): number {
  return voice.interest.weekly.slice(-ADVICE_RECENT_WEEKS).reduce((s, w) => s + w.events, 0);
}

function returned(before: number, after: number): boolean {
  return after >= before * DIAGNOSIS_CUT_RETURN_RATIO && after - before >= DIAGNOSIS_CUT_RETURN_MIN_GAIN;
}

/** Первая ступень листа ожидания, которую можно назвать собственнику: достаточно клиентов и не слишком глубоко. */
export function persuasiveStep(waitlist: PriceWaitlistResponse | null): PriceWaitlistStep | null {
  if (!waitlist || !waitlist.enoughData || !waitlist.onSale) return null;
  return waitlist.steps.find((s) => s.dropPct <= ADVICE_MAX_SUGGESTED_DROP_PCT && s.additional >= ADVICE_MIN_NEW_CLIENTS) ?? null;
}

function clientsWord(n: number): string {
  return `${n} ${pluralizeRu(n, ["клиент", "клиента", "клиентов"])}`;
}

/**
 * Готовый текст для разговора с собственником. Только то, что знают данные: `step.total` — это ждущие покупатели,
 * которые ПО АНКЕТЕ И БЮДЖЕТУ подходят объекту при цене ступени. Готовность смотреть объект и намерение прийти на
 * показ никто не подтверждал — поэтому текст такого не обещает (закреплено тестом «в исходах нет обещаний»).
 */
export function buildOwnerArgument(
  voice: PriceAdviceVoice,
  waitlist: PriceWaitlistResponse,
  step: PriceWaitlistStep
): string {
  const buyers = (n: number) => `${n} ${pluralizeRu(n, ["ждущий покупатель", "ждущих покупателя", "ждущих покупателей"])}`;
  const fit = (n: number) => pluralizeRu(n, ["подходит", "подходят", "подходят"]);
  const parts = [
    `По нашим данным: по анкете и бюджету при цене до ${priceAdviceMoney(step.price, waitlist.currency)} (−${step.dropPct}%) ${fit(step.total)} ${buyers(step.total)}.`,
    `При нынешней цене ${priceAdviceMoney(waitlist.price, waitlist.currency)} по бюджету ${fit(waitlist.fitNow)} ${buyers(waitlist.fitNow)}.`,
  ];
  if (voice.interest.events > 0) {
    parts.push(
      `Интерес к объекту за ${voice.windowDays} ${pluralizeRu(voice.windowDays, ["день", "дня", "дней"])}: ${voice.interest.events} ${pluralizeRu(
        voice.interest.events,
        ["касание", "касания", "касаний"]
      )}, ${voice.interest.people} ${pluralizeRu(voice.interest.people, ["человек", "человека", "человек"])}.`
    );
  }
  parts.push("Решение о цене остаётся за собственником.");
  return parts.join(" ");
}

export function advisePrice(voice: PriceAdviceVoice, waitlist: PriceWaitlistResponse | null, ctx: PriceAdviceContext): PriceAdvice {
  if (!ctx.onSale) {
    return {
      verdict: "insufficient_data",
      evidence: [],
      text: "Объект сейчас не в продаже — совет по цене не строится.",
      ownerArgument: null,
    };
  }

  const wlEnough = waitlist?.enoughData === true;
  const evidenceBase: string[] = [];
  if (ctx.daysOnSale != null) evidenceBase.push(`В продаже дней: ${ctx.daysOnSale}`);
  evidenceBase.push(`Событий интереса за ${voice.windowDays} дн.: ${voice.interest.events}, людей: ${voice.interest.people}`);
  if (waitlist) {
    evidenceBase.push(
      wlEnough
        ? `Ждут объект по всем признакам, кроме цены: ${waitlist.sample} (цена подходит ${waitlist.fitNow}, выше бюджета ${waitlist.overBudget})`
        : `Лист ожидания по цене: мало данных (подходящих покупателей с бюджетом ${waitlist.sample}, нужно хотя бы ${PRICE_WAITLIST_MIN_SAMPLE})`
    );
  }

  // 1. Данных нет совсем: ни интереса, ни ждущих — любое слово про цену было бы догадкой.
  if (voice.interest.events < DIAGNOSIS_MIN_EVENTS && !wlEnough) {
    return {
      verdict: "insufficient_data",
      evidence: evidenceBase,
      text: "Данных мало, совета нет: касаний к объекту и ждущих клиентов с бюджетом пока слишком мало, любой вывод о цене был бы догадкой. Вернитесь к этому блоку, когда накопится больше обращений.",
      ownerArgument: null,
    };
  }

  const recent = recentEvents(voice);
  const showings = showingsCount(voice);
  const shared = voice.interest.exposures;

  // 2. Сильный спрос: цену не трогаем, что бы ни говорили остальные сигналы.
  const strongByActivity =
    recent >= ADVICE_STRONG_RECENT_EVENTS && voice.interest.people >= ADVICE_STRONG_PEOPLE && showings >= ADVICE_STRONG_SHOWINGS;
  const strongByClients =
    shared.clientShared >= DIAGNOSIS_SHARED_MIN && shared.clientSharedShare != null && shared.clientSharedShare >= DIAGNOSIS_SHARED_SHARE;
  if (strongByActivity || strongByClients) {
    const ev = [...evidenceBase];
    if (strongByActivity) ev.push(`За последние ${ADVICE_RECENT_WEEKS} нед.: касаний ${recent}, показов за всё время ${showings}`);
    if (strongByClients) ev.push(`Клиент прислал объект сам: ${shared.clientShared} раз из ${shared.total}`);
    return {
      verdict: "hold",
      evidence: ev,
      text: "По данным спрос на объект сильный: люди интересуются и доходят до показов. Оснований торопить собственника со снижением цены нет.",
      ownerArgument: null,
    };
  }

  // 3. Цену недавно снижали и окно наблюдения ещё идёт: рано судить, как бы тихо ни было.
  const latestCut = voice.bargaining.priceChanges.find((c) => c.deltaPct != null && c.deltaPct < 0);
  const newest = voice.bargaining.priceChanges[0];
  if (latestCut && newest === latestCut && latestCut.daysAfterObserved != null && latestCut.daysAfterObserved < PROPERTY_VOICE_PRICE_REACTION_DAYS) {
    return {
      verdict: "hold",
      evidence: [...evidenceBase, `Цену снизили ${latestCut.daysAfterObserved} дн. назад (${latestCut.deltaPct}%); наблюдаем ${PROPERTY_VOICE_PRICE_REACTION_DAYS} дн.`],
      text: `Цену недавно снижали, и ${PROPERTY_VOICE_PRICE_REACTION_DAYS} дней наблюдения ещё не прошло. По данным рано судить, помогло ли снижение, — стоит подождать.`,
      ownerArgument: null,
    };
  }

  // 4. Три сигнала.
  const price = priceSignals(voice);
  const signalA =
    showings >= 1 && price.price >= DIAGNOSIS_MIN_PRICE_SIGNALS && price.total > 0 && price.price / price.total > DIAGNOSIS_PRICE_SHARE;
  const step = persuasiveStep(waitlist);
  const signalB = step != null;
  const signalC = ctx.daysOnSale != null && ctx.daysOnSale >= ADVICE_QUIET_DAYS_ON_SALE && recent < ADVICE_QUIET_RECENT_EVENTS;

  const judged = voice.bargaining.priceChanges.filter(
    (c) =>
      c.deltaPct != null &&
      c.deltaPct < 0 &&
      c.eventsBefore != null &&
      c.eventsAfter != null &&
      c.daysAfterObserved != null &&
      c.daysAfterObserved >= PROPERTY_VOICE_PRICE_REACTION_DAYS &&
      c.eventsBefore + c.eventsAfter > 0
  );
  const pastCutsNoEffect = judged.length > 0 && judged.every((c) => !returned(c.eventsBefore!, c.eventsAfter!));

  const evidence = [...evidenceBase];
  if (signalA) evidence.push(`Про цену ${price.price} из ${price.total} возражений и отказов`);
  if (signalB && step) {
    evidence.push(`Лист ожидания: при цене до ${priceAdviceMoney(step.price, waitlist!.currency)} (−${step.dropPct}%) подходят ${step.total}, из них новых ${step.additional}`);
  }
  if (signalC) evidence.push(`Давно в продаже, за ${ADVICE_RECENT_WEEKS} нед. касаний: ${recent}`);
  if (pastCutsNoEffect) evidence.push(`Прошлых снижений цены: ${judged.length}, интерес после них заметно не вырос`);

  const count = [signalA, signalB, signalC].filter(Boolean).length;
  // Прошлые снижения не помогли — значит, дело, возможно, не в цене. Тогда нужен самый сильный довод: возражения о цене И клиенты в листе.
  const allowed = count >= 2 && (!pastCutsNoEffect || (signalA && signalB));

  if (allowed) {
    const dropText = step
      ? ` По листу ожидания при цене до ${priceAdviceMoney(step.price, waitlist!.currency)} (−${step.dropPct}%) подходят ${clientsWord(step.total)}.`
      : "";
    return {
      verdict: "consider_drop",
      ...(step ? { suggestedDropPct: step.dropPct } : {}),
      evidence,
      text: `По данным стоит обсудить с собственником цену: сошлись ${count === 3 ? "три" : "два"} признака.${dropText} Это повод для разговора, а не обещание результата.`,
      ownerArgument: step && waitlist ? buildOwnerArgument(voice, waitlist, step) : null,
    };
  }

  // Аргумент для собственника отдаётся только вместе с советом обсудить цену: при «держать» он противоречил бы тексту рядом.
  const why =
    count === 1
      ? "Виден только один признак в пользу снижения, этого мало."
      : pastCutsNoEffect
        ? "Прошлые снижения цены интерес не вернули — возможно, дело не в цене."
        : "Признаков в пользу снижения цены по данным нет.";
  return {
    verdict: "hold",
    evidence,
    text: `По данным оснований снижать цену сейчас нет. ${why}`,
    ownerArgument: null,
  };
}
