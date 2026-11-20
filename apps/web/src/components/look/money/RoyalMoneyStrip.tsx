import type { FinanceMonth } from "../../../hooks/useFinance";

/**
 * ДОХОД, РАСХОДЫ И ПРИБЫЛЬ ОДНОЙ СТРОКОЙ (разделы директора, 20.11.2026).
 *
 * На вкладке «Расходы» директор видел только «Потрачено 0 с.», а доход жил на
 * другой странице. Здесь три числа месяца рядом и сравнение с прошлым месяцем.
 * Числа — из той же сводки `/expenses/summary`, что и «Обзор» (сервер отдаёт её
 * только с правом finance.view); компонент ничего не пересчитывает, только
 * раскладывает и сравнивает с предыдущим месяцем из того же ответа.
 */
const MONTHS_PREP = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];
const nums = (v: number) => Math.round(v).toLocaleString("ru-RU");

export function RoyalMoneyStrip({ current, previous }: { current: FinanceMonth; previous?: FinanceMonth }) {
  const prevLabel = previous ? `в ${MONTHS_PREP[Number(previous.month.slice(5, 7)) - 1]}` : "";
  return (
    <section className="ry-money-strip" aria-label="Итог месяца: доход, расходы, прибыль">
      <Cell
        label="Доход компании"
        value={current.companyRevenue}
        previous={previous?.companyRevenue}
        prevLabel={prevLabel}
        hint={`комиссия ${nums(current.revenue)}\u00a0с. минус доли агентов`}
      />
      <Cell label="Расходы" value={current.operatingExpenses} previous={previous?.operatingExpenses} prevLabel={prevLabel} growthIsBad hint="реклама, зарплаты, офис" />
      <Cell
        label={current.profit < 0 ? "Убыток" : "Прибыль"}
        value={current.profit}
        previous={previous?.profit}
        prevLabel={prevLabel}
        tone={current.profit < 0 ? "crit" : current.profit > 0 ? "ok" : undefined}
        unsigned={current.profit < 0}
        hint="доход минус расходы"
      />
    </section>
  );
}

function Cell({ label, value, previous, prevLabel, hint, tone, growthIsBad = false, unsigned = false }: {
  label: string; value: number; previous?: number; prevLabel: string; hint: string; tone?: "ok" | "crit"; growthIsBad?: boolean;
  /** Знак уже сказан словом («Убыток») — число без минуса. */
  unsigned?: boolean;
}) {
  const diff = previous === undefined ? null : Math.round(value) - Math.round(previous);
  const good = diff === null || diff === 0 ? null : growthIsBad ? diff < 0 : diff > 0;
  return (
    <div className="ry-money-strip-cell" data-tone={tone}>
      <span className="ry-money-strip-label">{label}</span>
      <strong className="ry-money-strip-value ry-num">{nums(unsigned ? Math.abs(value) : value)}{"\u00a0"}с.</strong>
      {diff !== null && (
        <span className="ry-money-strip-delta" data-good={good === null ? undefined : String(good)}>
          {diff === 0 ? `столько же, сколько ${prevLabel}` : `${diff > 0 ? "▲" : "▼"} на ${nums(Math.abs(diff))}\u00a0с. ${diff > 0 ? "больше" : "меньше"}, чем ${prevLabel}`}
        </span>
      )}
      <span className="ry-money-strip-hint">{hint}</span>
    </div>
  );
}
