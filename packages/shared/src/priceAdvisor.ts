/**
 * «ЦЕНА И СПРОС» КАРТОЧКИ ОБЪЕКТА (03.10.2026) — договор двух ответов:
 *
 *  GET /properties/:id/price-waitlist  — лист ожидания по цене (ступени «цена → сколько клиентов»);
 *  GET /properties/:id/price-advice    — совет по цене и температура объекта; лестницу (тот же лист ожидания)
 *                                         отдаёт внутри ответа в поле `waitlist`, чтобы карточка не считала её дважды.
 *
 * Идея владельца: агент идёт к собственнику не с «давайте снизим», а с цифрами —
 * «по анкете и бюджету при цене не выше X подходят 3 ждущих покупателя». Считает
 * сервер (lib/priceWaitlist.ts, lib/priceAdvice.ts, lib/propertyHeat.ts), здесь
 * только ФОРМА и общие константы.
 *
 * Правила, которые читатель экрана обязан знать:
 *  • В ступенях и в совете НЕТ ни имён, ни телефонов, ни бюджетов отдельных клиентов —
 *    только числа. Конкретные клиенты приходят отдельным полем `visibleClients`
 *    и ТОЛЬКО те, кого этот человек и так видит (агент — своих, руководитель — всех).
 *  • «Нет данных» — это `enoughData: false` / вердикт `insufficient_data`, а не выдуманное число.
 *  • Совет — «по данным», не обещание: слов «вернёт показы» и «продастся» здесь нет и быть не должно.
 */

/** Ступени снижения цены, % от текущей, по возрастанию. Менять — только вместе с тестами. */
export const PRICE_WAITLIST_DROPS_PCT = [3, 5, 8, 10, 15] as const;

/** Меньше стольких подходящих «по всему, кроме цены» покупателей с бюджетом — опираться на ступени нельзя: «мало данных». */
export const PRICE_WAITLIST_MIN_SAMPLE = 3;

/** Предел выборки покупателей под один объект; упёрлись — `truncated: true`, число занижено. */
export const PRICE_WAITLIST_TAKE = 500;

/** Сколько конкретных клиентов отдаём в `visibleClients` — это подсказка для звонков, не выгрузка. */
export const PRICE_WAITLIST_VISIBLE_MAX = 30;

export interface PriceWaitlistStep {
  /** На сколько процентов ниже текущей цены (3, 5, 8, 10, 15). */
  dropPct: number;
  /** Цена ступени в валюте объекта, округлена вниз до целого: «при цене не выше». */
  price: number;
  /** Сколько клиентов ПРИБАВИТСЯ к тем, кому цена уже подходит (накопительно от текущей цены). */
  additional: number;
  /** Сколько всего клиентов с указанным бюджетом подойдёт при этой цене: уже подходящие + additional. Вниз по ступеням не убывает. */
  total: number;
}

/** Клиент, которого вызывающий и так видит (агент — своих). Без телефона; имя — через маску `clients.viewPhone`. */
export interface PriceWaitlistVisibleClient {
  id: string;
  shortId: number;
  fullName: string;
  /** Верхняя граница бюджета в валюте клиента; null — не указана (есть только нижняя). */
  budgetMax: number | null;
  budgetCurrency: string | null;
  /** 0 — цена уже подходит; иначе первая ступень (%), при которой клиент подойдёт. */
  fitsAtDropPct: number;
}

export interface PriceWaitlistResponse {
  propertyId: string;
  generatedAt: string;
  /** Текущая цена объекта и её валюта. */
  price: number;
  currency: string;
  /** Объект в продаже. Не в продаже — лист строится, но совет по цене не даётся. */
  onSale: boolean;
  /** Подходящие по всему, кроме цены, у кого бюджет указан: fitNow + overBudget + belowBudget. */
  sample: number;
  /** false — `sample` меньше PRICE_WAITLIST_MIN_SAMPLE: ступени есть, но опираться на них нельзя («мало данных»). */
  enoughData: boolean;
  /** Кому цена подходит уже сейчас (в допуске бюджета подбора). */
  fitNow: number;
  /** Кому цена выше бюджета — те, ради кого и считаются ступени. */
  overBudget: number;
  /** Из них не дотянутся и при самой глубокой ступени. */
  beyondLadder: number;
  /** Цена ниже нижней границы бюджета клиента — снижение им не поможет. */
  belowBudget: number;
  /** Подходят по всему, кроме цены, но бюджет не указан: в ступени не входят. */
  noBudget: number;
  /** Выборка упёрлась в PRICE_WAITLIST_TAKE: числа занижены. */
  truncated: boolean;
  steps: PriceWaitlistStep[];
  /** Область видимости списка ниже: "own" — только свои клиенты, "all" — все. */
  visibleScope: "own" | "all";
  visibleClients: PriceWaitlistVisibleClient[];
}

export const PRICE_ADVICE_VERDICTS = ["hold", "consider_drop", "insufficient_data"] as const;
export type PriceAdviceVerdict = (typeof PRICE_ADVICE_VERDICTS)[number];

export interface PriceAdvice {
  verdict: PriceAdviceVerdict;
  /** Только при `consider_drop` и только когда ступень подтверждена листом ожидания. */
  suggestedDropPct?: number;
  /** Цифры, на которых построен вывод; показывать всегда. */
  evidence: string[];
  /** Готовая формулировка для агента, без обещаний. */
  text: string;
  /**
   * Готовый текст для разговора с собственником: «По нашим данным: по анкете и бюджету при цене до X подходят N ждущих покупателей…».
   * Готовность смотреть объект данные не подтверждают — в тексте её нет.
   * null — аргумента нет: он отдаётся только при `consider_drop` и только когда ступень подтверждена листом ожидания.
   */
  ownerArgument: string | null;
}

export const PROPERTY_HEAT_LABELS = ["cold", "warm", "hot"] as const;
export type PropertyHeatLabel = (typeof PROPERTY_HEAT_LABELS)[number];

export interface PropertyHeat {
  /** 0..100. */
  score: number;
  label: PropertyHeatLabel;
  /** «холодный» | «тёплый» | «горячий». */
  word: string;
  /** Коротко, из чего сложилось (для подсказки): «за 7 дней: 4 события». */
  reasons: string[];
}

export interface PriceAdviceResponse {
  propertyId: string;
  generatedAt: string;
  advice: PriceAdvice;
  heat: PropertyHeat;
  /**
   * Лист ожидания по цене — тот же ответ, что у GET /price-waitlist (посчитан ОДИН раз вместе с советом):
   * экран берёт лестницу и «ваших клиентов» отсюда и не зовёт второй роут. `visibleClients` уже по правам
   * (агент — только свои, имя с маской номера).
   */
  waitlist: PriceWaitlistResponse | null;
}

/** Сумма для текстов совета: «400 000 сомони» / «$50 000». */
export function priceAdviceMoney(value: number, currency: string): string {
  const n = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(value));
  return currency === "USD" ? `$${n}` : `${n} сомони`;
}
