/**
 * Тепловая карта «когда пишут клиенты» — разметка прототипа
 * (`screens/sources.html`, блок `.heat-wrap > .heat`): 36 px под день недели и
 * 12 колонок по два часа, подписи часов через одну (`.hh` занимает две колонки).
 *
 * Цвет один: `--ink` с прозрачностью по плотности; пустой час — `--track`.
 * Цветового кодирования нет специально, поэтому карта одинаково читается
 * в светлой и в ночной теме.
 *
 * Данные — GET /dashboard/heatmap: `dow` по Postgres EXTRACT(DOW) (0 = воскресенье),
 * `hour` — НАСТОЯЩИЙ час 0-23 (с 21.09.2026 сервер считает почасово: по часам
 * выбирается время публикации в соцсетях). В двухчасовые отрезки прототипа их
 * сводит эта разметка — 24 колонки на телефоне неразличимы и не нажимаются,
 * а решение «ставить дежурного на вечер» одинаково при 19:00 и 20:00. Точный
 * час нужен не глазу, а совету под картой (`publishHours` в ответе).
 */
const ROW_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_LABELS: Record<number, string> = { 0: "Вс", 1: "Пн", 2: "Вт", 3: "Ср", 4: "Чт", 5: "Пт", 6: "Сб" };
const HOURS = Array.from({ length: 12 }, (_, i) => i * 2);
/** Подписи часов прототипа: 0:00, 4:00 … 20:00, каждая на две колонки. */
const HOUR_LABELS = [0, 4, 8, 12, 16, 20];

export interface Rh2HeatmapCell {
  dow: number;
  hour: number;
  count: number;
}

/**
 * `events` — события (звонки, сообщения): два часа складываются.
 * `online` — уровень «сколько подписчиков в сети»: складывать два часа нельзя
 * (те же люди посчитались бы дважды), берётся больший из двух.
 */
export type Rh2HeatmapKind = "events" | "online";

export function Rh2Heatmap({
  cells,
  days = 90,
  kind = "events",
}: {
  cells: Rh2HeatmapCell[];
  days?: number;
  kind?: Rh2HeatmapKind;
}) {
  // Почасовые клетки сервера — в двухчасовые отрезки сетки. Складывать здесь, а
  // не просить у сервера второй, огрублённый ответ: тот же счёт в двух местах
  // разъехался бы при первой же смене шага.
  const byKey = new Map<string, number>();
  for (const c of cells) {
    const key = `${c.dow}-${Math.floor(c.hour / 2) * 2}`;
    const prev = byKey.get(key) ?? 0;
    byKey.set(key, kind === "online" ? Math.max(prev, c.count) : prev + c.count);
  }
  const max = Math.max(...byKey.values(), 1);
  const total = cells.reduce((s, c) => s + c.count, 0);

  if (total === 0) {
    return (
      <p className="state">
        {kind === "online"
          ? "Статистики Instagram пока нет: сервер забирает её раз в сутки. Проверить доступ — Настройки → Каналы, «Проверить статистику»."
          : `За последние ${days} дней событий в этом срезе нет.`}
      </p>
    );
  }

  return (
    <div className="heat-wrap">
      <div className="heat">
        <span className="dd" aria-hidden="true" />
        {HOUR_LABELS.map((h) => (
          <span className="hh" key={h}>
            {h}:00
          </span>
        ))}
        {ROW_ORDER.map((dow) => (
          <RowCells key={dow} dow={dow} byKey={byKey} max={max} kind={kind} />
        ))}
      </div>
    </div>
  );
}

/** Фрагмент строки: подпись дня и 12 клеток — в той же сетке, без обёртки. */
function RowCells({
  dow,
  byKey,
  max,
  kind,
}: {
  dow: number;
  byKey: Map<string, number>;
  max: number;
  kind: Rh2HeatmapKind;
}) {
  const day = DAY_LABELS[dow];
  return (
    <>
      <span className="dd">{day}</span>
      {HOURS.map((hour) => {
        const count = byKey.get(`${dow}-${hour}`) ?? 0;
        const words =
          kind === "online"
            ? count
              ? `в сети до ${count} подписчиков`
              : "данных нет"
            : count
              ? `${count} событий`
              : "событий не было";
        return (
          // 22.09.2026: была <button> без onClick — выглядела и фокусировалась как
          // кнопка (курсор, обводка, остановка по Tab), а нажатие не делало ничего
          // (docs/breakage-audit-night-20-09.md, п.2). Клетка сама по себе не
          // действие, а подсказка — tabIndex сохранён нарочно: так же, как data-tip
          // в Rh2BarChart.tsx (<rect tabIndex={0}>), подсказка обязана открываться
          // и с клавиатуры (см. doc-comment Rh2Chart.tsx), просто не кнопкой.
          // role="img" — у <span> нет неявной ARIA-роли (была у <button>), а без
          // роли aria-label на нём невалиден (axe: aria-prohibited-attr, найдено
          // прогоном tests/e2e/a11y.spec.ts после этой правки). Клетка передаёт
          // значение как картинка: цветом плюс текстовой альтернативой.
          <span
            key={hour}
            className="cell"
            role="img"
            tabIndex={0}
            style={count > 0 ? { background: "var(--ink)", opacity: Math.max(0.16, count / max) } : { background: "var(--track)" }}
            data-tip={`${day}, ${hour}:00 до ${hour + 2}:00|${words}`}
            aria-label={`${day}, ${hour} часов: ${words}`}
          />
        );
      })}
    </>
  );
}
