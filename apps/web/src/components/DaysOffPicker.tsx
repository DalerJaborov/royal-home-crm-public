import { WEEKDAYS_MON_FIRST, WEEKDAY_NAMES_RU, WEEKDAY_SHORT_RU, normalizeDaysOff } from "@royal-home/shared";

/**
 * ВЫБОР ВЫХОДНЫХ ДНЕЙ — семь переключателей Пн…Вс (владелец 11.10.2026). Один компонент
 * на оба места: «Выходные компании» в Настройках и «Выходные дни» в карточке сотрудника.
 * Значение — дни недели по Душанбе (0 — воскресенье), как в packages/shared/src/daysOff.ts.
 * Все выключены — выходных нет. Седьмой день выключить нельзя: хотя бы один день рабочий
 * (то же правило проверяет сервер).
 */
export function DaysOffPicker({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: readonly number[] | null | undefined;
  onChange: (next: number[]) => void;
  /** Подпись группы для экранного диктора: «Выходные компании», «Выходные дни». */
  label: string;
  disabled?: boolean;
}) {
  const days = normalizeDaysOff(value);
  function toggle(day: number) {
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
    onChange(normalizeDaysOff(next));
  }
  return (
    <div className="seg" role="group" aria-label={label}>
      {WEEKDAYS_MON_FIRST.map((day) => {
        const on = days.includes(day);
        // Последний рабочий день не превращается в выходной: семь выходных — это не график.
        const lastWorking = !on && days.length >= 6;
        return (
          <button
            key={day}
            type="button"
            aria-pressed={on}
            aria-label={`${WEEKDAY_NAMES_RU[day]} — ${on ? "выходной" : "рабочий"}`}
            title={lastWorking ? "Хотя бы один день в неделю должен быть рабочим" : WEEKDAY_NAMES_RU[day]}
            disabled={disabled || lastWorking}
            onClick={() => toggle(day)}
          >
            {WEEKDAY_SHORT_RU[day]}
          </button>
        );
      })}
    </div>
  );
}
