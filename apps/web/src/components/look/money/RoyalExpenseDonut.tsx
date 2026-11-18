/**
 * «НОВЫЙ ВИД» раздела «Деньги»: кольцо «на что ушли деньги» во вкладке «Расходы».
 *
 * Та же диаграмма, что полоса `.cef-bar` прежнего вида (ClaudeExpenseFeed), только
 * кольцом: те же категории, те же доли (`total / всего`), та же подпись
 * «Категория: сумма» — строки сумм приходят уже отформатированными тем же
 * `claudeMoney`, компонент ничего не считает, кроме длины дуги. Подсказка — по
 * наведению (`<title>`) и с клавиатуры (сегмент в порядке Tab), а суммы всех
 * категорий видны рядом в легенде — на телефоне касание ничего не прячет.
 */
export interface RoyalDonutPart {
  key: string;
  /** Тон категории прежнего вида (office/ads/salary/other) — цвет дуги. */
  tone: string;
  /** Сумма категории в сомони — только для длины дуги. */
  value: number;
  /** «Категория: сумма» — та же строка, что title у полосы прежнего вида. */
  title: string;
}

const R = 52;
const C = 2 * Math.PI * R;

export function RoyalExpenseDonut({ parts, total, center, caption, selected }: {
  parts: RoyalDonutPart[];
  /** Знаменатель долей — тот же `total`, что делит полосу прежнего вида. */
  total: number;
  /** Сумма в центре (уже отформатирована). */
  center: string;
  caption: string;
  /** Выбранная в легенде категория — её дуга ярче, остальные приглушены. */
  selected?: string;
}) {
  const shown = parts.filter((p) => p.value > 0);
  let offset = 0;
  return (
    <figure className="ry-donut" data-selected={selected || undefined}>
      <svg viewBox="0 0 128 128" role="img" aria-label="Распределение расходов">
        <circle className="ry-donut-track" cx="64" cy="64" r={R} />
        {total > 0 && shown.map((p) => {
          const length = (p.value / total) * C;
          const seg = (
            <circle
              key={p.key}
              className={`ry-donut-seg cef-${p.tone}`}
              data-active={selected === p.key || undefined}
              cx="64" cy="64" r={R}
              strokeDasharray={`${Math.max(0, length - (shown.length > 1 ? 2 : 0))} ${C}`}
              strokeDashoffset={-offset}
              tabIndex={0}
            >
              <title>{p.title}</title>
            </circle>
          );
          offset += length;
          return seg;
        })}
      </svg>
      <figcaption className="ry-donut-center">
        <strong className="ry-num">{center}</strong>
        <span>{caption}</span>
      </figcaption>
    </figure>
  );
}
