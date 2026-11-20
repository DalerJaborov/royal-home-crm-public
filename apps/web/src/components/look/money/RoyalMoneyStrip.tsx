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
        delta={previous ? profitDelta(current.profit, previous.profit, prevLabel) : null}
        unsigned={current.profit < 0}
        hint="доход минус расходы"
      />
    </section>
  );
}

/**
 * Сравнение итога месяца (ревью PR 336): при убытке «▲ больше» про отрицательные числа
 * читалось наоборот. Здесь — словами по модулю, цвет по смыслу: убыток уменьшился —
 * хорошо; сменился знак — так и пишем, без арифметики через ноль.
 */
export function profitDelta(value: number, previous: number, prevLabel: string): { text: string; good: boolean | null } {
  const cur = Math.round(value);
  const prev = Math.round(previous);
  if (cur === prev) return { text: `столько же, сколько ${prevLabel}`, good: null };
  if (cur < 0 && prev < 0) {
    const d = Math.abs(cur) - Math.abs(prev);
    return d < 0
      ? { text: `▼ убыток меньше на ${nums(-d)} с., чем ${prevLabel}`, good: true }
      : { text: `▲ убыток больше на ${nums(d)} с., чем ${prevLabel}`, good: false };
  }
  if (cur < 0) return { text: prev > 0 ? `${prevLabel} была прибыль ${nums(prev)} с.` : `${prevLabel} было в ноль`, good: false };
  if (prev < 0) return { text: `${prevLabel} был убыток ${nums(-prev)} с.`, good: true };
  const d = cur - prev;
  return { text: `${d > 0 ? "▲" : "▼"} на ${nums(Math.abs(d))} с. ${d > 0 ? "больше" : "меньше"}, чем ${prevLabel}`, good: d > 0 };
}

function Cell({ label, value, previous, prevLabel, hint, tone, growthIsBad = false, unsigned = false, delta }: {
  label: string; value: number; previous?: number; prevLabel: string; hint: string; tone?: "ok" | "crit"; growthIsBad?: boolean;
  /** Знак уже сказан словом («Убыток») — число без минуса. */
  unsigned?: boolean;
  /** Готовое сравнение (итог месяца) вместо простой разницы. */
  delta?: { text: string; good: boolean | null } | null;
}) {
  const diff = previous === undefined ? null : Math.round(value) - Math.round(previous);
  const simple = diff === null ? null : {
    text: diff === 0 ? `столько же, сколько ${prevLabel}` : `${diff > 0 ? "▲" : "▼"} на ${nums(Math.abs(diff))} с. ${diff > 0 ? "больше" : "меньше"}, чем ${prevLabel}`,
    good: diff === 0 ? null : growthIsBad ? diff < 0 : diff > 0,
  };
  const shownDelta = delta !== undefined ? delta : simple;
  return (
    <div className="ry-money-strip-cell" data-tone={tone}>
      <span className="ry-money-strip-label">{label}</span>
      <strong className="ry-money-strip-value ry-num">{nums(unsigned ? Math.abs(value) : value)}{"\u00a0"}с.</strong>
      {shownDelta && (
        <span className="ry-money-strip-delta" data-good={shownDelta.good === null ? undefined : String(shownDelta.good)}>
          {shownDelta.text}
        </span>
      )}
      <span className="ry-money-strip-hint">{hint}</span>
    </div>
  );
}
