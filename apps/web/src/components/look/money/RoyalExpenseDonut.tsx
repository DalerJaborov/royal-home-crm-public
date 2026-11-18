import { RoyalAmount } from "./RoyalAmount";

/**
 * «НОВЫЙ ВИД» раздела «Деньги»: кольцо «на что ушли деньги» во вкладке «Расходы».
 *
 * Та же диаграмма, что полоса `.cef-bar` прежнего вида (ClaudeExpenseFeed), только
 * кольцом: те же категории, те же доли (`сумма категории / всего`), та же подпись
 * «Категория: сумма» — строки сумм приходят уже отформатированными тем же
 * `claudeMoney`, компонент ничего не считает, кроме длины дуги и доли в подписи.
 * Кольцо — одна картинка (`role="img"`): экранный чтец получает весь перечень
 * «категория — сумма — доля» одной подписью, дуги в порядок Tab не попадают.
 * Наведение мышью показывает `<title>` дуги; суммы всех категорий и так видны
 * рядом в легенде, так что на телефоне касание ничего не прячет.
 */
export interface RoyalDonutPart {
  key: string;
  /** Тон категории прежнего вида (office/ads/salary/other) — цвет дуги. */
  tone: string;
  /** Сумма категории в сомони — для длины дуги и доли. */
  value: number;
  /** Название категории. */
  name: string;
  /** Сумма категории, уже отформатированная (`claudeMoney`). */
  amount: string;
}

/** Радиус и длина окружности кольца (viewBox 128×128). Экспорт — для теста долей. */
export const DONUT_R = 52;
export const DONUT_C = 2 * Math.PI * DONUT_R;
/** Просвет между соседними дугами — вычитается из длины каждой дуги, если дуг больше одной. */
export const DONUT_GAP = 2;

/** Доля в процентах для подписи: целое, как «Доля» в сводке таблицы. */
function percent(value: number, total: number): number {
  return Math.round((value / total) * 100);
}

export function donutLabel(parts: RoyalDonutPart[], total: number): string {
  const shown = parts.filter((p) => p.value > 0);
  if (!(total > 0) || !shown.length) return "Распределение расходов: расходов нет";
  return `Распределение расходов: ${shown.map((p) => `${p.name} — ${p.amount} — ${percent(p.value, total)} %`).join("; ")}`;
}

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
  const gap = shown.length > 1 ? DONUT_GAP : 0;
  let offset = 0;
  return (
    <figure className="ry-donut" data-selected={selected || undefined}>
      <svg viewBox="0 0 128 128" role="img" aria-label={donutLabel(parts, total)}>
        <circle className="ry-donut-track" cx="64" cy="64" r={DONUT_R} />
        {total > 0 && shown.map((p) => {
          const length = (p.value / total) * DONUT_C;
          const seg = (
            <circle
              key={p.key}
              className={`ry-donut-seg cef-${p.tone}`}
              data-active={selected === p.key || undefined}
              cx="64" cy="64" r={DONUT_R}
              strokeDasharray={`${Math.max(0, length - gap)} ${DONUT_C}`}
              strokeDashoffset={-offset}
            >
              <title>{`${p.name}: ${p.amount}`}</title>
            </circle>
          );
          offset += length;
          return seg;
        })}
      </svg>
      <figcaption className="ry-donut-center">
        <strong className="ry-num"><RoyalAmount text={center} /></strong>
        <span>{caption}</span>
      </figcaption>
    </figure>
  );
}
