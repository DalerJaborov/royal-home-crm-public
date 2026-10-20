/**
 * ТЕМП РАСХОДА И ПРОГНОЗ БЮДЖЕТА (03.10.2026, GET /ads/pacing).
 *
 * Сколько потрачено сегодня против обычного дня, прогноз до конца месяца с
 * диапазоном, долг и карта кабинета, красные флаги.
 *
 * ЧАСОВОЙ ПОЯС. «Сегодня» и «месяц» считаются по календарю Душанбе, как весь учёт
 * в CRM, а статистику Meta нарезает по часовому поясу КАБИНЕТА (AdSpendDaily.date).
 * Если пояса не совпадают, сутки на границе могут съехать — поэтому ответ несёт
 * `timezoneNote` и `cabinetTimezones`, а экран подписывает это рядом с цифрами.
 */

/**
 * «Вдвое выше обычного» не поднимаем (и красный столбик графика не рисуем), пока обычный день
 * меньше 10 сомони (≈ доллар): при таком базисе «вдвое» — несколько дирамов, шум, а не событие.
 * Один порог для сервера (флаг SPEND_DOUBLE) и экрана (столбик), чтобы они не расходились.
 */
export const PACING_MIN_USUAL_TJS = 10;

/**
 * Меньше стольких дней со строками Meta за последние 7 — вилку «от–до» не строим, остаётся
 * точечный прогноз: перцентили по трём-четырём точкам — это снова «самый тихий и самый
 * дорогой день», то есть та же слишком широкая вилка. Один порог для сервера и подписи на экране.
 */
export const PACING_MIN_RANGE_DAYS = 5;

export type AdPacingFlagKind =
  /** Сегодня потрачено вдвое больше обычного дня. */
  | "SPEND_DOUBLE"
  /** Включённые объявления есть, а сегодня расхода нет. */
  | "NO_SPEND_TODAY"
  /** Кабинет не оплачен / отключён / есть долг по карте. */
  | "ACCOUNT_DEBT";

export interface AdPacingFlag {
  kind: AdPacingFlagKind;
  text: string;
}

export interface AdPacingDayPoint {
  /** ГГГГ-ММ-ДД. */
  date: string;
  spendTjs: number;
}

/**
 * Как построена вилка прогноза:
 *  percentile    — по 25-му и 75-му перцентилям дневных расходов последних 7 дней
 *                  (типичные дни; самый тихий и самый дорогой день отбрасываются);
 *  too_few_days  — дней со строками Meta меньше PACING_MIN_RANGE_DAYS: вилки нет,
 *                  low = high = expected, остаётся точечный прогноз.
 */
export type AdPacingRangeState = "percentile" | "too_few_days";

/** Прогноз до конца месяца: ожидаемое и вилка «от–до» по типичным дням недели (25–75 %). */
export interface AdPacingForecast {
  /** Ожидаемый расход за весь месяц, сомони (потрачено + текущий темп × остаток). */
  expectedTjs: number;
  /** Нижняя граница: остаток месяца идёт по 25-му перцентилю дневных расходов последних 7 дней (не выше ожидаемого). */
  lowTjs: number;
  /** Верхняя граница: то же по 75-му перцентилю (не ниже ожидаемого). */
  highTjs: number;
  /**
   * Как построена вилка. Необязательно: ответ старой версии API поля не несёт, и тогда
   * экран ведёт себя как раньше (вилка есть, если low ≠ high).
   */
  rangeState?: AdPacingRangeState;
  /** Сколько дней месяца ещё впереди (без сегодняшнего). */
  remainingDays: number;
}

/**
 * Состояние прогноза:
 *  ok           — посчитан;
 *  no_spend     — за последние 7 дней расхода не было: прогноз равен уже потраченному;
 *  insufficient — данных за последние 7 дней слишком мало (прогноз не делаем, а не выдумываем).
 */
export type AdPacingForecastState = "ok" | "no_spend" | "insufficient";

/** Кабинет глазами темпа: чем платят и сколько должны. */
export interface AdPacingAccount {
  id: string;
  name: string | null;
  currency: string;
  fundingSource: string | null;
  /** Долг кабинета в валюте кабинета; null — Meta не отдала. */
  balance: number | null;
  /** То же в сомони (единый курс CRM); null — долга не видно. */
  balanceTjs: number | null;
  /** Лимит кабинета в его валюте; null — лимита нет. */
  spendCap: number | null;
  /** Сколько ещё можно потратить до лимита, сомони; null — лимита или «потрачено» нет. */
  capLeftTjs: number | null;
  /** Через сколько дней при обычном темпе упрёмся в лимит; null — не посчитать. */
  daysToCap: number | null;
  /** account_status Meta: 1 активен, 3 не оплачен, 2 отключён и т.д. */
  accountStatus: number | null;
  timezone: string | null;
}

export interface AdPacingResponse {
  /** Сегодняшний день по Душанбе, ГГГГ-ММ-ДД. */
  today: string;
  /** Расход за сегодня (по строкам Meta с этой датой), сомони. */
  todayTjs: number;
  /** Среднее за последние 7 ПОЛНЫХ дней (без сегодня), сомони в день. */
  usualDayTjs: number;
  /** Сколько из этих 7 дней вообще пришли строки от Meta. */
  baselineDaysWithData: number;
  /** Сегодня / обычный день; null — обычного дня нет (нулевой или нет данных). */
  ratioToUsual: number | null;
  /** Текущий месяц по Душанбе: ГГГГ-ММ. */
  month: string;
  monthSpentTjs: number;
  daysInMonth: number;
  /** Номер сегодняшнего дня в месяце (1..31). */
  dayOfMonth: number;
  /** Расход по дням с 1-го числа по сегодня, без пропусков (нули — нулями). */
  series: AdPacingDayPoint[];
  forecastState: AdPacingForecastState;
  forecast: AdPacingForecast | null;
  flags: AdPacingFlag[];
  /** null — реквизиты кабинета ещё не загружены (кэш пуст); этот роут Meta не зовёт. */
  accounts: AdPacingAccount[] | null;
  /** Часовые пояса кабинетов (для подписи «данные Meta идут по поясу …»). */
  cabinetTimezones: string[];
  /** Готовая подпись про часовые пояса — показывается рядом с цифрами. */
  timezoneNote: string;
  /** true — данные Meta старше порога свежести: флаг «нет расхода сегодня» не поднимается. */
  dataStale: boolean;
  syncedAt: string | null;
  enabled: boolean;
}
