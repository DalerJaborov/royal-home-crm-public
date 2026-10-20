import {
  PACING_MIN_RANGE_DAYS,
  PACING_MIN_USUAL_TJS,
  type AdPacingAccount,
  type AdPacingFlag,
  type AdPacingForecast,
  type AdPacingForecastState,
  type AdPacingResponse,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { dushanbeDateString, dushanbeWallClock } from "../dushanbeTime.js";
import {
  adSpendToTjsCents,
  fromCents,
  loadMoneyContext,
  roundMoney,
  toTjs,
  type MoneyContext,
} from "../money.js";
import { evaluateAccountAlerts } from "./adAlerts.js";
import { deliveryCounts } from "./adDelivery.js";
import { percentile } from "./percentile.js";
import type { AdAccountDetails } from "./metaAdsApi.js";

/**
 * ТЕМП РАСХОДА И ПРОГНОЗ БЮДЖЕТА (03.10.2026): сколько потрачено сегодня против
 * обычного дня и чем кончится месяц.
 *
 * КАЛЕНДАРЬ — ДУШАНБЕ (lib/dushanbeTime.ts), как весь учёт CRM. Но строки расхода Meta
 * нарезает по часовому поясу КАБИНЕТА (AdSpendDaily.date): исходных часов в её ответе
 * нет, и пересчитать нечем. Если кабинет живёт в поясе позади Душанбе, «сегодня» по
 * Душанбе утром ещё пустое — поэтому флаг «нет расхода сегодня» не поднимается до
 * полудня и при несвежих данных, а ответ несёт `timezoneNote`, и экран пишет его рядом
 * с цифрами. Исправлять расхождение «тихо» нельзя: это была бы выдумка.
 *
 * ДЕНЬГИ — единым правилом money.ts::adSpendToTjsCents: строки одной валюты
 * складываются, курс применяется к сумме один раз. Месячный итог и «обычный день»
 * считаются по сумме СТРОК периода (а не сложением дневных округлений), поэтому
 * месячный итог совпадает с доской за «этот месяц» для кабинетов в сомони. Для кабинетов в
 * долларах возможно расхождение на дирамы: доска (`/ads/board`) переводит в сомони каждое
 * объявление отдельно и округляет по каждому, а здесь курс применяется к сумме один раз.
 *
 * ПРОГНОЗ ПРОСТОЙ И ЧЕСТНЫЙ: потрачено + текущий темп × оставшиеся дни, где темп —
 * среднее за последние 7 ПОЛНЫХ дней (без сегодняшнего: он ещё не закончился). Если
 * траты начались позже, чем неделю назад (кампания запущена 3 дня назад), среднее считается
 * от первого дня со строками Meta, а не по семи: делить три дня на семь вдвое занизило бы
 * «обычный день» и дало бы ложный флаг «вдвое выше». Вместо одной цифры — вилка «от–до»:
 * остаток месяца по самому тихому и по самому дорогому ДНЮ СО СТРОКАМИ этой же недели
 * (дни без строк Meta — не «нулевые траты», а отсутствие данных). Мало строк за неделю —
 * прогноза нет (не выдумываем).
 *
 * ВИЛКА — ТИПИЧНЫЕ ДНИ, А НЕ КРАЙНОСТИ (03.10.2026). Первая версия брала самый тихий и самый
 * дорогой день недели: на проде «≈ 4 938,96 с., от 1 607,24 до 10 872,07 с.» — вилка в семь
 * раз шире прогноза, потому что один тихий день и один день со всплеском задавали оба края.
 * Теперь края — 25-й и 75-й перцентили дневных расходов тех же семи дней
 * (lib/ads/percentile.ts): внутрь попадает половина обычных дней, выбросы — нет. При менее
 * чем PACING_MIN_RANGE_DAYS днях со строками вилку не строим вовсе (перцентили по трём точкам —
 * те же крайности): остаётся точечный прогноз, `rangeState: "too_few_days"`.
 */

/** Сколько полных дней берём за «обычный». */
export const PACING_BASELINE_DAYS = 7;
/** Меньше стольких дней со строками от Meta из семи — прогноз и «вдвое выше» не считаем. */
export const PACING_MIN_BASELINE_DAYS = 3;
export { PACING_MIN_RANGE_DAYS };
/**
 * Края вилки прогноза — 25-й и 75-й перцентили дневных расходов. Почему не 10/90 и не
 * min/max: на неделе из семи точек крайние значения — это один случайный день, и вилка
 * превращается в «от нуля до всплеска». Межквартильный размах — та часть дней, которая
 * действительно похожа на обычную неделю.
 */
export const PACING_RANGE_LOW_PERCENTILE = 0.25;
export const PACING_RANGE_HIGH_PERCENTILE = 0.75;
/**
 * «Вдвое выше обычного» не поднимаем, пока обычный день меньше 10 сомони (≈ доллар):
 * при таком базисе «вдвое» — это несколько дирамов, то есть шум, а не событие.
 * Значение живёт в @royal-home/shared (его же читает красный столбик графика на экране).
 */
export { PACING_MIN_USUAL_TJS };
/** Во сколько раз сегодняшний расход должен превысить обычный, чтобы поднять флаг. */
export const PACING_DOUBLE_FACTOR = 2;
/** «Нет расхода сегодня» — не раньше этого часа по Душанбе: утром Meta ещё ничего не прислала. */
export const PACING_NO_SPEND_FROM_HOUR = 12;
/**
 * Для кабинета в другом поясе: «нет расхода сегодня» — не раньше этого часа по ЧАСАМ КАБИНЕТА.
 * Строки Meta режутся по его суткам: у кабинета в Америке в полдень по Душанбе там ещё ночь,
 * и пустой «сегодня» — не поломка.
 */
export const PACING_NO_SPEND_CABINET_FROM_HOUR = 9;
/** Данные Meta старше этого срока считаем несвежими: «нет расхода» по ним утверждать нельзя. */
export const PACING_FRESH_MS = 6 * 60 * 60 * 1000;
/** Реквизиты кабинета из кэша /ads/accounts старше этого срока не показываем (долг мог измениться). */
export const PACING_ACCOUNTS_MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** Предел строк «дата × валюта» за запрос: месяц + неделя × 2 валюты — с огромным запасом. */
const MAX_DAY_ROWS = 400;

const DAY_MS = 86_400_000;

type DayRow = { spend: number; currency: string };

export interface PacingInput {
  now: Date;
  /** Строки расхода по дням: ГГГГ-ММ-ДД → суммы по валютам (дни без строк от Meta в карте отсутствуют). */
  days: ReadonlyMap<string, readonly DayRow[]>;
  money: MoneyContext;
  /** Включённые объявления: идут + простаивают (по adDelivery). */
  enabledAds: number;
  syncedAt: Date | null;
  enabled: boolean;
  /** Реквизиты кабинетов из кэша /ads/accounts; null — кэш пуст или протух. */
  accounts: readonly AdAccountDetails[] | null;
}

const keyOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const msOfKey = (key: string): number => new Date(`${key}T00:00:00.000Z`).getTime();
const fmtCents = (cents: number): string => `${new Intl.NumberFormat("ru-RU").format(Math.round(cents / 100))} с.`;

const cabinetTimezonesOf = (accounts: readonly AdAccountDetails[] | null): string[] =>
  Array.from(new Set((accounts ?? []).map((a) => a.timezone).filter((t): t is string => !!t)));

/** Час суток (0–23) в поясе кабинета; null — название пояса не распознано (тогда его не учитываем, а не выдумываем). */
function cabinetHourOf(now: Date, timeZone: string): number | null {
  try {
    const h = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hourCycle: "h23" })
      .formatToParts(now)
      .find((p) => p.type === "hour")?.value;
    const n = h == null ? NaN : Number(h);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function summarizeAccount(
  d: AdAccountDetails,
  money: MoneyContext,
  usualDayCents: number
): AdPacingAccount {
  const toTjsOrNull = (n: number | null | undefined): number | null =>
    n == null ? null : roundMoney(toTjs(n, d.currency, money));
  const capLeftTjs =
    d.spendCap != null && d.spendCap > 0 && d.amountSpent != null
      ? Math.max(0, roundMoney(toTjs(d.spendCap - d.amountSpent, d.currency, money)))
      : null;
  return {
    id: d.id,
    name: d.name,
    currency: d.currency,
    fundingSource: d.fundingSource,
    balance: d.balance,
    balanceTjs: toTjsOrNull(d.balance),
    spendCap: d.spendCap,
    capLeftTjs,
    // «Дней до лимита» — только при живом темпе: на нулевом расходе делить не на что.
    daysToCap:
      capLeftTjs != null && usualDayCents > 0
        ? Math.round((capLeftTjs / fromCents(usualDayCents)) * 10) / 10
        : null,
    accountStatus: d.accountStatus ?? null,
    timezone: d.timezone,
  };
}

/** ЧИСТАЯ ФУНКЦИЯ: строки расхода → темп, прогноз и флаги. Без базы — проверяется на фикстурах. */
export function computePacing(input: PacingInput): AdPacingResponse {
  const { now, days, money } = input;
  const today = dushanbeDateString(now);
  const [y, m, d] = today.split("-").map(Number);
  const todayMs = msOfKey(today);
  const monthKey = today.slice(0, 7);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const remainingDays = daysInMonth - d;
  const rowsOf = (key: string): readonly DayRow[] => days.get(key) ?? [];

  // Сегодня.
  const todayCents = adSpendToTjsCents(rowsOf(today), money);

  // Обычный день: последние 7 полных дней (вчера и шесть до него), перешагивая границу месяца.
  const baselineKeys = Array.from({ length: PACING_BASELINE_DAYS }, (_, i) => keyOf(todayMs - (i + 1) * DAY_MS));
  const baselineKeysWithData = baselineKeys.filter((k) => days.has(k));
  const baselineDaily = baselineKeysWithData.map((k) => adSpendToTjsCents(rowsOf(k), money));
  const baselineDaysWithData = baselineKeysWithData.length;
  const baselineTotalCents = adSpendToTjsCents(
    baselineKeys.flatMap((k) => rowsOf(k)),
    money
  );
  // Делитель — дни от первого дня со строками Meta до вчера: молодая кампания не делится на семь.
  const firstDataMs = baselineKeysWithData.length > 0 ? Math.min(...baselineKeysWithData.map(msOfKey)) : todayMs;
  const baselineSpanDays = Math.max(1, Math.round((todayMs - firstDataMs) / DAY_MS));
  const usualCents = Math.round(baselineTotalCents / baselineSpanDays);

  // Месяц: с 1-го по сегодня без пропусков.
  const monthKeys = Array.from({ length: d }, (_, i) => keyOf(Date.UTC(y, m - 1, i + 1)));
  const monthSpentCents = adSpendToTjsCents(
    monthKeys.flatMap((k) => rowsOf(k)),
    money
  );
  const series = monthKeys.map((k) => ({ date: k, spendTjs: fromCents(adSpendToTjsCents(rowsOf(k), money)) }));

  // Прогноз.
  let forecastState: AdPacingForecastState;
  let forecast: AdPacingForecast | null = null;
  if (baselineDaysWithData < PACING_MIN_BASELINE_DAYS) {
    forecastState = "insufficient";
  } else if (baselineTotalCents === 0) {
    forecastState = "no_spend";
    const spent = fromCents(monthSpentCents);
    forecast = { expectedTjs: spent, lowTjs: spent, highTjs: spent, remainingDays };
  } else {
    forecastState = "ok";
    // Остаток СЕГОДНЯ: сутки не кончились, и если до обычного дня не дотянули — дотянут. Не
    // ушли ниже уже потраченного: отрицательного остатка не бывает.
    const projected = (dailyCents: number): number =>
      monthSpentCents + dailyCents * remainingDays + Math.max(0, dailyCents - todayCents);
    const expectedCents = Math.round(projected(usualCents));
    if (baselineDaysWithData < PACING_MIN_RANGE_DAYS) {
      // Мало дней — вилку не строим: только точечный прогноз (экран подписывает причину).
      forecast = {
        expectedTjs: fromCents(expectedCents),
        lowTjs: fromCents(expectedCents),
        highTjs: fromCents(expectedCents),
        remainingDays,
        rangeState: "too_few_days",
      };
    } else {
      const sortedDaily = [...baselineDaily].sort((a, b) => a - b);
      // «Обычный день» делится на весь промежуток (дни без строк входят нулями), а перцентили
      // считаются по дням со строками, поэтому край мог бы оказаться по ту сторону прогноза.
      // Прогноз всегда лежит внутри своей вилки: края за него не заходят.
      const lowCents = Math.min(
        expectedCents,
        Math.round(projected(percentile(sortedDaily, PACING_RANGE_LOW_PERCENTILE)))
      );
      const highCents = Math.max(
        expectedCents,
        Math.round(projected(percentile(sortedDaily, PACING_RANGE_HIGH_PERCENTILE)))
      );
      forecast = {
        expectedTjs: fromCents(expectedCents),
        lowTjs: fromCents(lowCents),
        highTjs: fromCents(highCents),
        remainingDays,
        rangeState: "percentile",
      };
    }
  }

  // Флаги.
  const flags: AdPacingFlag[] = [];
  const usualTjs = fromCents(usualCents);
  const ratioToUsual = usualCents > 0 ? Math.round((todayCents / usualCents) * 100) / 100 : null;
  if (
    baselineDaysWithData >= PACING_MIN_BASELINE_DAYS &&
    usualTjs >= PACING_MIN_USUAL_TJS &&
    todayCents > usualCents * PACING_DOUBLE_FACTOR
  ) {
    flags.push({
      kind: "SPEND_DOUBLE",
      text: `Сегодня потрачено ${fmtCents(todayCents)} — вдвое больше обычного дня (${fmtCents(usualCents)}). Проверьте бюджеты кампаний.`,
    });
  }
  const syncedMs = input.syncedAt?.getTime() ?? null;
  const dataStale = syncedMs == null || now.getTime() - syncedMs > PACING_FRESH_MS;
  const hour = dushanbeWallClock(now).getUTCHours();
  // Строки «сегодня» режет пояс КАБИНЕТА: у кабинета в Америке в полдень по Душанбе там ещё ночь, и пустое
  // «сегодня» — норма. Флаг только когда рабочий час (PACING_NO_SPEND_CABINET_FROM_HOUR) наступил и по часам каждого известного кабинета.
  const cabinetHours = cabinetTimezonesOf(input.accounts).map((tz) => cabinetHourOf(now, tz));
  const cabinetDayStarted = cabinetHours.every((h) => h == null || h >= PACING_NO_SPEND_CABINET_FROM_HOUR);
  if (todayCents === 0 && input.enabledAds > 0 && hour >= PACING_NO_SPEND_FROM_HOUR && cabinetDayStarted && !dataStale) {
    flags.push({
      kind: "NO_SPEND_TODAY",
      text: `Сегодня расхода нет, хотя включено объявлений: ${input.enabledAds}. Возможно, кончился бюджет, не прошла оплата или реклама на проверке.`,
    });
  }

  // Кабинеты: реквизиты, долг, лимит — и тревоги тем же правилом, что у уведомлений (adAlerts.ts).
  let accounts: AdPacingAccount[] | null = null;
  if (input.accounts) {
    accounts = input.accounts.map((a) => summarizeAccount(a, money, usualCents));
    for (const a of input.accounts) {
      const debtTjs = a.balance != null ? roundMoney(toTjs(a.balance, a.currency, money)) : null;
      for (const alert of evaluateAccountAlerts(a, debtTjs)) {
        flags.push({ kind: "ACCOUNT_DEBT", text: alert.body });
      }
    }
  }

  const cabinetTimezones = cabinetTimezonesOf(input.accounts);
  const timezoneNote =
    (cabinetTimezones.length > 0
      ? `Данные Meta идут по часовому поясу кабинета (${cabinetTimezones.join(", ")}). `
      : "Данные Meta идут по часовому поясу рекламного кабинета (в CRM он пока не загружен). ") +
    "Сутки и месяц здесь — по Душанбе (UTC+5), поэтому на границе суток цифры могут съехать.";

  return {
    today,
    todayTjs: fromCents(todayCents),
    usualDayTjs: usualTjs,
    baselineDaysWithData,
    ratioToUsual,
    month: monthKey,
    monthSpentTjs: fromCents(monthSpentCents),
    daysInMonth,
    dayOfMonth: d,
    series,
    forecastState,
    forecast,
    flags,
    accounts,
    cabinetTimezones,
    timezoneNote,
    dataStale,
    syncedAt: input.syncedAt ? input.syncedAt.toISOString() : null,
    enabled: input.enabled,
  };
}

/**
 * Темп расхода из базы: ОДИН запрос строк (дата × валюта, уже схлопнутых базой) на
 * месяц и неделю назад, плюс состояние объявлений (adDelivery) и настройки. Meta не
 * зовётся вовсе: реквизиты кабинета приходят готовыми из кэша /ads/accounts.
 */
export async function buildAdPacing(options: {
  now?: Date;
  accounts: readonly AdAccountDetails[] | null;
}): Promise<AdPacingResponse> {
  const now = options.now ?? new Date();
  const today = dushanbeDateString(now);
  const [y, m] = today.split("-").map(Number);
  const monthStart = Date.UTC(y, m - 1, 1);
  const from = new Date(Math.min(monthStart, msOfKey(today) - PACING_BASELINE_DAYS * DAY_MS));
  const to = new Date(msOfKey(today));

  const [rows, counts, settings, money] = await Promise.all([
    prisma.adSpendDaily.groupBy({
      by: ["date", "currency"],
      where: { date: { gte: from, lte: to }, ad: { excluded: false } },
      _sum: { spend: true },
      orderBy: { date: "asc" },
      take: MAX_DAY_ROWS,
    }),
    deliveryCounts(),
    prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { metaAdsSyncedAt: true, metaAdsEnabled: true },
    }),
    loadMoneyContext(),
  ]);

  const days = new Map<string, DayRow[]>();
  for (const r of rows) {
    const key = r.date.toISOString().slice(0, 10);
    const list = days.get(key) ?? [];
    list.push({ spend: Number(r._sum.spend ?? 0), currency: r.currency });
    days.set(key, list);
  }

  return computePacing({
    now,
    days,
    money,
    enabledAds: counts.RUNNING + counts.STALLED,
    syncedAt: settings?.metaAdsSyncedAt ?? null,
    enabled: !!settings?.metaAdsEnabled,
    accounts: options.accounts,
  });
}
