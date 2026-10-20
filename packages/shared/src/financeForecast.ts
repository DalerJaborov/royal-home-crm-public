import { z } from "zod";

/**
 * ПРОГНОЗ ДЕНЕГ К КОНЦУ МЕСЯЦА.
 *
 * Блок «Деньги» до сих пор отвечал только на «сколько уже собрали» и давал
 * линейную экстраполяцию темпа (lib/dashboardInsights.ts, computePlanForecast):
 * факт делится на прошедшие дни и умножается на длину месяца. Такой прогноз
 * ничего не знает о том, что УЖЕ лежит в воронке, и в начале месяца врёт в разы
 * — одна крупная сделка 2-го числа «прогнозирует» пятикратный план.
 *
 * Здесь прогноз собирается из трёх независимых слагаемых, каждое из которых
 * можно объяснить словами владельцу:
 *   факт    — закрытые сделки месяца, это не оценка;
 *   воронка — открытые сделки × вероятность их стадии;
 *   темп    — средняя комиссия за рабочий день последних трёх месяцев ×
 *             оставшиеся рабочие дни (только на верхнюю оценку).
 *
 * Схема живёт в @royal-home/shared, потому что одну и ту же форму читают
 * маршрут `GET /api/v1/finance/forecast` и два экрана (пульт и «Деньги»).
 */

/** Стадии сделки, которые ещё могут превратиться в деньги этого месяца. */
export const OPEN_DEAL_STAGES = [
  "NEGOTIATION",
  "AGREEMENT_PENDING",
  "CONTRACT_SIGNED",
  "PENDING_APPROVAL",
] as const;
export type OpenDealStage = (typeof OPEN_DEAL_STAGES)[number];

/**
 * ВЕРОЯТНОСТЬ ЗАКРЫТИЯ ПО СТАДИИ — значения по умолчанию.
 *
 * Истории переходов по стадиям в базе нет (у Deal только stage, startedAt и
 * closedAt), поэтому вывести эти веса из данных нечем — это экспертная оценка,
 * а не измерение, и потому она вынесена в Настройки
 * (`Settings.dealStageWinProbability`), где владелец правит её сам.
 *
 * Соответствие стадий словам задания: договор = AGREEMENT_PENDING (0.2 —
 * переговоры ещё до него, NEGOTIATION), задаток = CONTRACT_SIGNED,
 * сделка/выплата = PENDING_APPROVAL (агент уже назвал цену и комиссию,
 * осталось решение руководителя).
 */
export const DEAL_STAGE_WIN_PROBABILITY_DEFAULT: Record<OpenDealStage, number> = {
  NEGOTIATION: 0.2,
  AGREEMENT_PENDING: 0.5,
  CONTRACT_SIGNED: 0.8,
  PENDING_APPROVAL: 0.95,
};

/** Веса стадий в Настройках: те же ключи, доля от 0 до 1. */
export const dealStageWinProbabilitySchema = z.record(
  z.enum(OPEN_DEAL_STAGES),
  z.number().min(0).max(1),
);
export type DealStageWinProbability = z.infer<typeof dealStageWinProbabilitySchema>;

/** Нормализация того, что лежит в Json-колонке: чужие ключи и мусор отбрасываются. */
export function resolveStageWinProbability(raw: unknown): Record<OpenDealStage, number> {
  const parsed = dealStageWinProbabilitySchema.safeParse(raw);
  if (!parsed.success) return { ...DEAL_STAGE_WIN_PROBABILITY_DEFAULT };
  return { ...DEAL_STAGE_WIN_PROBABILITY_DEFAULT, ...parsed.data };
}

/** Вклад одной стадии в воронку — из него собираются причины словами. */
export const commissionForecastStageSchema = z.object({
  stage: z.enum(OPEN_DEAL_STAGES),
  /** Сколько открытых сделок этой стадии попало в прогноз месяца. */
  count: z.number().int().nonnegative(),
  /** Их полная комиссия в сомони, без множителя вероятности. */
  amountTjs: z.number().nonnegative(),
  /** Применённая вероятность стадии (из Настроек либо значение по умолчанию). */
  probability: z.number().min(0).max(1),
  /** amountTjs × probability — то, что реально попадает в ожидаемую оценку. */
  weightedTjs: z.number().nonnegative(),
});
export type CommissionForecastStage = z.infer<typeof commissionForecastStageSchema>;

export const commissionForecastSchema = z.object({
  /** «2026-09» — месяц по Душанбе, за который посчитано. */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  /** Закрытые сделки месяца. Не оценка — деньги уже получены. */
  factTjs: z.number().nonnegative(),
  /** Нижняя оценка: факт + воронка со стадий с вероятностью не ниже 0.8. */
  lowTjs: z.number().nonnegative(),
  /** Ожидаемая: факт + вся воронка, взвешенная вероятностями стадий. */
  expectedTjs: z.number().nonnegative(),
  /** Верхняя: ожидаемая + половина того, что даёт темп за оставшиеся дни. */
  highTjs: z.number().nonnegative(),
  /**
   * Доля компании в ожидаемой оценке. Сами оценки выше — ВАЛОВАЯ комиссия
   * (то же, что показывает блок «Деньги» и с чем сравнивается план месяца);
   * здесь та же сумма в пересчёте на долю компании из Настроек.
   */
  expectedCompanyTjs: z.number().nonnegative(),
  /** План месяца из Настроек (Settings.monthlyCommissionPlan). */
  planTjs: z.number().nonnegative(),
  /** Ожидаемая в процентах плана. 0, если плана нет. */
  percentOfPlan: z.number().int().nonnegative(),
  /** Разбивка воронки по стадиям — только те стадии, где что-то есть. */
  stages: z.array(commissionForecastStageSchema),
  /** Вклад темпа в верхнюю оценку (уже с множителем 0.5). null — темп не считали. */
  paceTjs: z.number().nonnegative().nullable(),
  /** Оставшиеся рабочие дни месяца (пн-пт по Душанбе). */
  workdaysLeft: z.number().int().nonnegative(),
  /**
   * Истории меньше месяца — темп честно не посчитан. Экран говорит об этом
   * тихой строкой, а не подставляет ноль как «прогноз».
   */
  lowHistory: z.boolean(),
  /** Три короткие причины словами: «3 сделки на стадии задатка на 12 000 с.». */
  reasons: z.array(z.string()).max(3),
});
export type CommissionForecast = z.infer<typeof commissionForecastSchema>;
