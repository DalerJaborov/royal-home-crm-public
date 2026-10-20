/**
 * ЧИП ПРИРОСТА — «+12 %» рядом с числом плитки.
 *
 * Livento-кейс из брифа (docs/archive/agent-briefs/color-layer.md): у каждого показателя
 * дашборда стоит маленькая пастельная пилюля со стрелкой. Оформление — в
 * theme-2026-color-layer.css (`.chip.delta.up|dn|eq`), здесь только правило,
 * КОГДА чип вообще имеет право появиться.
 *
 * ГЛАВНОЕ ПРАВИЛО: НИЧЕГО НЕ ВЫДУМЫВАТЬ. Чип рисуется, только когда прошлое
 * значение реально пришло в ответе API. Нет прошлого периода (первый месяц
 * работы, показатель «на сейчас», отказ запроса) — компонент возвращает `null`,
 * а не «0 %» и не прочерк: пустое место честнее выдуманной стабильности.
 * Прошлое значение, равное нулю, — тоже отсутствие сравнения: рост «с нуля» в
 * процентах не выражается.
 *
 * ЗНАК И ЦВЕТ РАЗВЕДЕНЫ. Рост не всегда хорош: у расходов и у потерь клиентов
 * плюс — это плохо. Поэтому цвет выбирает `positiveIsGood`, а не знак числа.
 */

/** Стрелки нарисованы значком, а не символом «↗»: в гарнитуре интерфейса
 *  стрелки разной ширины, и в ряду плиток числа переставали стоять столбиком. */
function ArrowUp() {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}

function ArrowDown() {
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 7l10 10M17 9v8H9" />
    </svg>
  );
}

export function Rh2DeltaChip({
  value,
  previous,
  positiveIsGood = true,
  periodLabel,
}: {
  /** Значение за текущий период. */
  value: number;
  /** Значение за прошлый период такой же длины. `null`/`undefined` — сравнения
   *  нет, чип не рисуется. */
  previous: number | null | undefined;
  /** Рост — это хорошо? У расходов и потерь — нет. */
  positiveIsGood?: boolean;
  /** Чем период назван в подсказке: «против прошлого месяца». */
  periodLabel: string;
}) {
  if (previous === null || previous === undefined || previous === 0) return null;

  const percent = Math.round(((value - previous) / Math.abs(previous)) * 100);
  if (percent === 0) {
    return (
      <span className="chip delta eq" title={`Столько же, что и ${periodLabel}`}>
        0 %
      </span>
    );
  }

  const grew = percent > 0;
  const good = grew === positiveIsGood;
  const sign = grew ? "+" : "−";
  return (
    <span
      className={`chip delta ${good ? "up" : "dn"}`}
      title={`${grew ? "Больше" : "Меньше"} на ${Math.abs(percent)} %, чем ${periodLabel}`}
    >
      {grew ? <ArrowUp /> : <ArrowDown />}
      {sign}
      {Math.abs(percent)} %
    </span>
  );
}
