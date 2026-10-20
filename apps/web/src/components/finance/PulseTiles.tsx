import { useState, type ReactNode } from "react";
import { useFinancePulse, type PulseBucket, type PulsePeriod } from "../../hooks/useFinance";
import { Rh2Money } from "../rh2/Rh2Money";
import { Rh2DeltaChip } from "../rh2/Rh2DeltaChip";

/**
 * ПУЛЬС ДЕНЕГ — приход, расход и остаток за сегодня / неделю / месяц / год.
 *
 * Блока с таким названием в прототипе «Royal Home 2026» нет: он появился в CRM
 * раньше темы и остаётся, потому что отвечает на вопрос, которого нет ни у
 * одного другого блока «Денег» — сколько пришло и ушло ПРЯМО СЕЙЧАС, а не за
 * закрытый месяц. Одет он прототипными классами (`.sec` + `.card tight` +
 * `.seg` + `.trio`), чтобы не отличаться от остальных разделов экрана.
 *
 * Главное решение блока прежнее: цифра без сравнения не значит ничего, поэтому
 * рядом с каждым периодом стоит такой же прошлый.
 */

const PERIOD_LABEL: Record<PulsePeriod, string> = {
  today: "Сегодня",
  week: "Неделя",
  month: "Месяц",
  year: "Год",
};

const PREVIOUS_LABEL: Record<PulsePeriod, string> = {
  today: "вчера",
  week: "прошлая неделя",
  month: "прошлый месяц",
  year: "прошлый год",
};

function money(value: number): string {
  return `${Math.round(value).toLocaleString("ru-RU")} сомони`;
}

/** Тот же приём, что у плиток «Комиссия / Агентам / Доход / Расходы» на этом
 *  экране (Finance.tsx): плитка не маршрут, а якорь к разделу ниже. */
function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

type PulseTarget = "profit" | "expenses" | "balance";
export function PulseTiles({ compact = false, onOpen }: { compact?: boolean; onOpen?: (section: PulseTarget) => void } = {}) {
  const { data, isError, refetch } = useFinancePulse();
  const [period, setPeriod] = useState<PulsePeriod>("month");

  const bucket = data?.buckets.find((b) => b.period === period);

  return (
    <div className="sec">
      <div className="sec-h">
        <h2>Пульс денег</h2>
        <span className="note">доход компании минус учтённые расходы без долей агентов; это не остаток на банковском счёте</span>
      </div>
      <div className="card tight">
        <div className="hscroll">
          <div className="seg" role="tablist" aria-label="Срок пульса денег">
            {(Object.keys(PERIOD_LABEL) as PulsePeriod[]).map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={period === p}
                onClick={() => setPeriod(p)}
              >
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>
        </div>

        {bucket ? (
          <>
            {compact && <p className="note mt-3">{bucket.label} · текущий период пульса</p>}
            <PulseBody bucket={bucket} onOpen={onOpen} clearBalanceLabel={compact} />
          </>
        ) : isError ? (
          /* Раньше отказ показывал «Считаем…» ВЕЧНО — тот же класс, что чинили в
             MobileOversight и MobileArchive (аудит 22.08.2026, раунд 6). */
          <div className="state err">
            <span className="dot crit" /> Не удалось посчитать. Это сбой связи, а не нулевые деньги.
            <button className="lk" type="button" style={{ color: "inherit", textDecoration: "underline" }} onClick={() => refetch()}>
              Повторить
            </button>
          </div>
        ) : (
          <div className="state">
            <span className="sk w40" />
            <span className="sk w22" /> Считаем пульс
          </div>
        )}

        {data?.refreshing && <p className="state">Сверяемся с рекламным кабинетом, цифры ещё уточняются.</p>}
        <p className="quiet">Текущий период ещё не завершён; сравнение — с полным предыдущим периодом.</p>
      </div>
    </div>
  );
}

function PulseBody({ bucket, onOpen, clearBalanceLabel }: { bucket: PulseBucket; onOpen?: (section: PulseTarget) => void; clearBalanceLabel?: boolean }) {
  return (
    <div className="trio" style={{ marginTop: "var(--s3)" }}>
      <Cell
        value={bucket.incomeTjs}
        title="Приход"
        previous={`${PREVIOUS_LABEL[bucket.period]} ${money(bucket.previousIncomeTjs)}`}
        change={
          <Rh2DeltaChip
            value={bucket.incomeTjs}
            previous={bucket.previousIncomeTjs}
            periodLabel={PREVIOUS_LABEL[bucket.period]}
          />
        }
        // «Приход» пульса — доля компании (см. заголовок раздела), это тот же
        // показатель, что «Доход компании» плиткой выше — к графику прибыли.
        onOpen={() => onOpen ? onOpen("profit") : scrollToSection("profit-chart-section")}
      />
      <Cell
        value={bucket.expenseTjs}
        title="Расход"
        previous={`${PREVIOUS_LABEL[bucket.period]} ${money(bucket.previousExpenseTjs)}`}
        /* У расхода рост — плохо: цвет чипа перевёрнут, знак остаётся честным. */
        change={
          <Rh2DeltaChip
            value={bucket.expenseTjs}
            previous={bucket.previousExpenseTjs}
            positiveIsGood={false}
            periodLabel={PREVIOUS_LABEL[bucket.period]}
          />
        }
        onOpen={() => onOpen ? onOpen("expenses") : scrollToSection("expenses-workspace")}
      />
      <Cell
        value={bucket.balanceTjs}
        title={clearBalanceLabel ? "Доход минус расходы" : "Остаток"}
        /* Единственное место блока, где знак несёт смысл: минус помечается
           точкой, а не цветом числа — цветное число хуже читается в ночной теме.
           Чипа прироста здесь нет намеренно: остаток переходит через ноль, и
           процент «роста» от отрицательной базы читается наоборот. */
        alarm={bucket.balanceTjs < 0}
        previous={`${PREVIOUS_LABEL[bucket.period]} ${money(bucket.previousBalanceTjs)}`}
        change={null}
        // Итог месяца целиком — карточка «Прибыль за …» вверху экрана.
        onOpen={() => onOpen ? onOpen("balance") : scrollToSection("profit-hero-section")}
      />
    </div>
  );
}

function Cell({
  value,
  title,
  previous,
  change,
  alarm,
  onOpen,
}: {
  value: number;
  title: string;
  previous: string;
  /** Готовый чип прироста или `null`, если сравнивать не с чем. */
  change: ReactNode;
  alarm?: boolean;
  /** Ведёт к разделу этого же экрана, где цифра раскрыта (владелец, 15.09.2026). */
  onOpen?: () => void;
}) {
  return (
    <button
      type="button"
      className="n"
      onClick={onOpen}
      // Тема сбрасывает кнопки глобально (`.rh2 button{font:inherit;background:none;
      // border:0;padding:0}`), поэтому .n выглядит как прежде — тот же приём, что
      // StatTile использует для перехода «div → button» (components/ui/StatTile.tsx).
      style={{ display: "block", width: "100%", textAlign: "left" }}
    >
      {/* Сумма и чип в одну строку инлайн-стилем, а не новым классом: правило
          прототипа .rh2 .scr .trio .n b делает содержимое блочным, и чип падал
          на вторую строку (кадр 11.09). Своих имён классов тема не заводит. */}
      <b style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Rh2Money value={value} />
        {change}
      </b>
      <span>
        {alarm && <span className="dot crit" style={{ display: "inline-block", marginRight: 6 }} />}
        {title}
      </span>
      <span>{previous}</span>
    </button>
  );
}
