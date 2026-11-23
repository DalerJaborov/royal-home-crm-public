import { Rh2BarChart, type Rh2BarChartItem } from "../../rh2/Rh2BarChart";
import { Rh2Bars, type Rh2Bar } from "../../rh2/Rh2Bars";
import { Rh2Inline } from "../../rh2/Rh2Scope";

/**
 * ГРАФИКИ ГЛАВНОЙ «НОВОГО ВИДА» (home-core, 20.11.2026).
 *
 * Без новых библиотек: те же общие `Rh2BarChart` (столбики по месяцам/дням) и
 * `Rh2Bars` (полосы долей), что у «Графиков по команде» (components/home/TeamCharts.tsx),
 * в той же карточке `.ry-home-chart`. Анимация появления — только в слое
 * theme-look-royal-home.css (transform, `prefers-reduced-motion` её выключает):
 * столбики растут от оси, полосы — от левого края, один раз при появлении блока,
 * а не при каждом обновлении данных (элементы те же, React их не пересоздаёт).
 */

export const num = (n: number) => n.toLocaleString("ru-RU");

/** Столбики (по месяцам или дням): подпись итога сверху, лента листается внутри карточки. */
export function HomeColumns({ items, ariaLabel, lastValueLabel, note }: {
  items: Rh2BarChartItem[]; ariaLabel: string; lastValueLabel?: string; note?: string;
}) {
  return (
    <div className="ry-home-chart" data-chart="columns">
      {note && <p className="ry-home-chart-note">{note}</p>}
      <Rh2Inline><Rh2BarChart items={items} ariaLabel={ariaLabel} lastValueLabel={lastValueLabel} /></Rh2Inline>
    </div>
  );
}

/** Полосы долей: название, полоса, число — всё на виду, название переносится. */
export function HomeBars({ items, note }: { items: Rh2Bar[]; note?: string }) {
  return (
    <div className="ry-home-chart" data-chart="bars">
      {note && <p className="ry-home-chart-note">{note}</p>}
      <Rh2Inline><Rh2Bars items={items} /></Rh2Inline>
    </div>
  );
}
