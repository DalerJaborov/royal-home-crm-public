import {
  CURRENCIES,
  FALLBACK_USD_TO_TJS,
  centsToTjs as centsToTjsShared,
  convertToTjs,
  fromCents,
  roundMoney,
  toCents,
  type Currency,
} from "@royal-home/shared";
import { prisma } from "../db.js";

/**
 * Единый учёт денег в CRM.
 *
 * Суммы хранятся в БД в той валюте, в которой их ввели (объект в долларах —
 * комиссия по нему тоже в долларах). Любая АГРЕГАЦИЯ — месячная выручка, комиссия
 * агента, прибыль, стоимость лида — обязана приводить слагаемые к одной валюте,
 * иначе доллары складываются с сомони один к одному и отчётность врёт в разы.
 * Отчётная валюта компании — сомони (TJS): в ней ведутся расходы и в ней директор
 * видит итоги.
 *
 * Курс берётся из Настроек (Settings.usdToTjsRate) — он же обновляется ночью с
 * alif.tj и правится вручную (см. lib/exchangeRate.ts).
 */

/**
 * Запасной курс и чистая арифметика денег переехали в общий пакет
 * (`packages/shared/src/money.ts`, 22.09.2026): те же правила нужны фронту, а
 * два экземпляра одного правила уже разошлись — доска сделок считала перевод в
 * сомони без округления. Здесь остаётся реэкспорт, чтобы сорок с лишним файлов,
 * импортирующих эти функции отсюда, не пришлось трогать.
 */
export { toCents, fromCents, roundMoney };

export interface MoneyContext {
  usdToTjs: number;
}

/** Keep the supplied/captured rate for new entries; never claim it is a recovered historical rate. */
export function expenseCentsToTjs(expense: {amount: Parameters<typeof toCents>[0];currency: Currency;exchangeRate?: {toString():string}|number|null}, ctx:MoneyContext):number {
  const frozen=expense.exchangeRate==null?ctx.usdToTjs:Number(expense.exchangeRate);
  return centsToTjsShared(toCents(expense.amount),expense.currency,frozen);
}

/** Курс для агрегаций. Читается один раз на запрос и прокидывается в toTjs —
 *  не дёргаем Настройки на каждую строку выборки. */
export async function loadMoneyContext(): Promise<MoneyContext> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { usdToTjsRate: true },
  });
  const rate = settings?.usdToTjsRate ? Number(settings.usdToTjsRate) : null;
  return { usdToTjs: rate && rate > 0 ? rate : FALLBACK_USD_TO_TJS };
}

/**
 * Условие «цена объекта не выше потолка» с учётом валюты объекта.
 *
 * Property.price лежит в валюте самого объекта, поэтому `price <= max` по сырой
 * колонке сравнивает доллары с сомони один к одному: «до 200 000 сомони» пропускало
 * объект за 100 000 USD (миллион сомони). Потолок задан в `currency`, объекты в
 * другой валюте сравниваются по курсу. Один источник правила для подбора бота
 * (lib/propertyMatch.ts) и ассистента CRM (ai/assistant.ts), CHANNEL-NEW-41.
 */
export function priceCeilingFilter(max: number, currency: Currency, usdToTjs: number) {
  const tjsMax = currency === "USD" ? max * usdToTjs : max;
  const usdMax = currency === "USD" ? max : max / usdToTjs;
  return {
    OR: [
      { currency: "TJS" as const, price: { lte: tjsMax } },
      { currency: "USD" as const, price: { lte: usdMax } },
    ],
  };
}

/**
 * Приводит сумму к сомони. Decimal из Prisma, строка и число — всё принимается.
 *
 * РЕЗУЛЬТАТ ВСЕГДА РОВНО ДО КОПЕЙКИ. Раньше отсюда выходило `value * курс` как
 * есть: 9.53 × 11.27 = 107.40310000000001, и этот хвост дальше складывался,
 * сравнивался и уезжал в JSON, в выгрузку и в денежные колонки базы (они
 * объявлены обычным Decimal, то есть DECIMAL(65,30) — Postgres не округляет
 * ничего и сохраняет хвост целиком). Округление ровно одно и происходит здесь,
 * в единственном месте пересчёта валют, поэтому одна и та же сумма всегда даёт
 * одно и то же число — в отчёте, в выгрузке и в уведомлении.
 */
export function toTjs(
  amount: unknown,
  currency: Currency | string | null | undefined,
  ctx: MoneyContext
): number {
  return convertToTjs(amount, currency, ctx.usdToTjs);
}

/**
 * ДЕНЬГИ СКЛАДЫВАЮТСЯ ТОЛЬКО В ЦЕЛЫХ ЦЕНТАХ.
 *
 * `0.1 + 0.2 !== 0.3` — это не придирка: в отчёте по рекламе складываются сотни
 * дневных строк, каждая из которых уже умножена на курс, и остаток набегает в
 * последних знаках. Дальше он вылезает там, где его больнее всего видеть: сумма
 * колонки не сходится с итогом под ней, а бухгалтер справедливо перестаёт верить
 * всей странице.
 *
 * Поэтому всякая сумма внутри отчёта живёт целым числом сотых (центов/дирамов),
 * округление происходит РОВНО ОДИН РАЗ — в момент перевода валюты, — а итог
 * складывается из тех же самых чисел, которые человек видит в строках. Тогда
 * столбец сходится с итогом по построению, а не по удаче.
 *
 * Сами `toCents`/`fromCents` живут в `packages/shared/src/money.ts` (реэкспорт
 * выше): то же правило нужно экранам, а второй экземпляр уже однажды разошёлся.
 */

/**
 * Сотые в валюте хранения → сотые в сомони. Единственное место, где в отчёте
 * происходит округление: дальше суммы только складываются, без потерь.
 */
export function centsToTjs(cents: number, currency: Currency | string | null | undefined, ctx: MoneyContext): number {
  return centsToTjsShared(cents, currency, ctx.usdToTjs);
}

/**
 * СЛОЖЕНИЕ СПИСКА СУММ. Отдельная функция, чтобы в коде не оставалось ни одного
 * `reduce` по деньгам с плавающей точкой: тип возвращается в сотых.
 */
export function sumCents(values: unknown[]): number {
  let total = 0;
  for (const v of values) total += toCents(v);
  return total;
}

/**
 * РАСХОД НА РЕКЛАМУ В СОМОНИ — ЕДИНОЕ ПРАВИЛО КУРСА (ревью 03.10.2026, п. 10).
 *
 * Курс применяется к СУММЕ объявления по валюте, один раз и до цента: сначала дневные
 * строки складываются в целых сотых КАЖДОЙ валюты, затем каждая сумма переводится
 * `centsToTjs`. Так считает отчёт по объектам (adSpendReport.ts, groupBy «объявление ×
 * валюта»), сверка и доска; раньше доска переводила каждую дневную строку отдельно, и
 * цифры на доске и в отчёте расходились на цент-два по тем же деньгам.
 */
export function adSpendToTjsCents(
  rows: readonly { spend: unknown; currency: Currency | string | null | undefined }[],
  ctx: MoneyContext
): number {
  const byCurrency = new Map<string, number>();
  for (const r of rows) {
    const key = String(r.currency ?? "");
    byCurrency.set(key, (byCurrency.get(key) ?? 0) + toCents(r.spend));
  }
  let total = 0;
  for (const [currency, cents] of byCurrency) total += centsToTjs(cents, currency, ctx);
  return total;
}

/**
 * ДЕЛЕНИЕ СУММЫ НА ДОЛИ БЕЗ ПОТЕРИ КОПЕЙКИ (метод наибольшего остатка).
 *
 * Комиссия 8 000,50 с. делится на 30/40/30: три независимых округления дают
 * 2 400,15 + 3 200,20 + 2 400,15 = 8 000,50 — если повезёт. Не повезёт (а с
 * реальными процентами не везёт постоянно) — сумма долей разойдётся с базой на
 * копейку-две, и в отчётах появится вечная неувязка: «начислено агентам» не
 * равно «комиссия по сделке». В деньгах живых людей это недопустимо.
 *
 * Здесь целая часть каждой доли считается вниз, а остаток раздаётся по одной
 * сотой тем долям, у которых дробный хвост был больше. Сумма результата РАВНА
 * входу по построению, при любых процентах и любой сумме.
 *
 * Веса — проценты из Настроек; нулевой вес получает ноль (например, приёмщика у
 * объекта нет, и его доля уходит в остальные).
 */
export function splitCents(totalCents: number, weights: number[]): number[] {
  const total = Math.round(totalCents);
  const safe = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const weightSum = safe.reduce((acc, w) => acc + w, 0);
  if (weightSum <= 0 || total === 0) return safe.map(() => 0);

  const exact = safe.map((w) => (total * w) / weightSum);
  const floors = exact.map((v) => Math.floor(v));
  let rest = total - floors.reduce((acc, v) => acc + v, 0);

  // Кому достанутся оставшиеся сотые: у кого дробный хвост больше. При равных
  // хвостах — тому, у кого доля больше; порядок долей при этом не меняется.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v), weight: safe[i] }))
    .sort((a, b) => b.frac - a.frac || b.weight - a.weight || a.i - b.i);

  const out = floors.slice();
  for (const { i } of order) {
    if (rest <= 0) break;
    out[i] += 1;
    rest -= 1;
  }
  return out;
}

/** Обратное к toTjs: сумма из отчётной валюты в валюту хранения. */
export function fromTjs(tjs: number, currency: Currency, ctx: MoneyContext): number {
  return currency === "USD" ? tjs / ctx.usdToTjs : tjs;
}

/**
 * СУММЫ ОТ ИИ — ВСЕГДА В СОМОНИ, КАРТОЧКА — В СВОЕЙ ВАЛЮТЕ (аудит №4, 27.08).
 *
 * Разбор речи и переписки нормализует услышанное в сомони (промт в ai/cardFill.ts:
 * «суммы в долларах переводи по курсу»), а Client.currency агент может
 * переключить на доллары. Без пересчёта в такую карточку ложилось «миллион
 * долларов» вместо миллиона сомони — подбор объектов уходил в пустоту.
 *
 * Хелпер один на все точки записи (автопилот переписки и предложения из
 * звонка): раньше пересчёт был только в первой, и путь звонка тихо ломал
 * бюджет ровно тем же способом.
 *
 * Возвращает функцию, а не число: вызывающему обычно нужно пересчитать пару
 * границ бюджета, а курс читать при этом стоит один раз и только для USD.
 */
export async function cardCurrencyConverter(
  currency: Currency | string | null | undefined
): Promise<(tjs: number) => number> {
  if (currency !== "USD") return (tjs) => tjs;
  const ctx = await loadMoneyContext();
  return (tjs) => Math.round(fromTjs(tjs, "USD", ctx));
}

/** Одна ветка условия «цена от/до»: валюта хранения и границы, пересчитанные в неё. */
export interface PriceRangeBranch {
  currency: Currency;
  price: { gte?: number; lte?: number };
}

/**
 * Условие «цена от/до» для таблиц, где сумма лежит рядом со своей валютой
 * (Property.price + Property.currency). Границы приходят в ОДНОЙ валюте и дальше
 * пересчитываются в каждую валюту хранения — на выходе OR по парам (currency, price).
 * Без этого фильтр «до 50 000» отдавал и квартиру за 50 000 сомони, и за $50 000:
 * сравнение шло с колонкой price в обход валюты — ровно та же ошибка, которую уже
 * исправили в подборе объектов (clientMatchesProperty в routes/matching.ts).
 *
 * Пересчитываются ГРАНИЦЫ, а не данные: курс лежит в Настройках, а не в БД, и
 * привести колонку price к сомони внутри where нечем. Зато сравнение остаётся
 * сравнением колонок — пагинация и count целиком на стороне БД, выборка в память
 * не поднимается.
 */
export function priceRangeBranches(
  bounds: { min?: number; max?: number; currency: Currency },
  ctx: MoneyContext
): PriceRangeBranch[] {
  const minTjs = bounds.min !== undefined ? toTjs(bounds.min, bounds.currency, ctx) : undefined;
  const maxTjs = bounds.max !== undefined ? toTjs(bounds.max, bounds.currency, ctx) : undefined;
  return CURRENCIES.map((currency) => ({
    currency,
    price: {
      ...(minTjs !== undefined && { gte: fromTjs(minTjs, currency, ctx) }),
      ...(maxTjs !== undefined && { lte: fromTjs(maxTjs, currency, ctx) }),
    },
  }));
}
