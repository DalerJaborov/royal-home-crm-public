/**
 * МЕСЯЦ ПО-РУССКИ ПОВЕРХ РОДНОГО ПОЛЯ ВЫБОРА (20.11.2026, кадр владельца с iPhone).
 *
 * `<input type="month">` браузер рисует на языке телефона: на iPhone с английским
 * интерфейсом в «Деньгах» стояло «November 2026». Язык этого текста страница задать
 * не может (lang и Intl его не меняют), поэтому поле остаётся тем же — нажатие открывает
 * родной выбор месяца, — а его собственный текст прозрачный, и поверх стоит наша
 * подпись «Ноябрь 2026». Ставить внутрь обёртки с position: relative (см. MonthPicker
 * в ClaudeMoneyPage и мастере расхода).
 */
export function ruMonthLabel(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return month;
  const text = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${month}-15T12:00:00Z`))
    .replace(/\s*г\.?$/, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Стиль самого поля: текст браузера прозрачный, рамка, размер и нажатие — прежние. */
export const RU_MONTH_INPUT_STYLE = { color: "transparent", WebkitTextFillColor: "transparent" } as const;

/** Подпись поверх поля: не перехватывает нажатия, экранному чтецу не нужна (у поля своя подпись). */
export function RuMonthText({ month }: { month: string }) {
  return (
    <span
      aria-hidden="true"
      className="ru-month-text"
      style={{
        position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
        pointerEvents: "none", zIndex: 1, fontWeight: 600, whiteSpace: "nowrap", color: "var(--rh-ui-text, var(--ink, currentColor))",
      }}
    >
      {ruMonthLabel(month)}
    </span>
  );
}
