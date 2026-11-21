/**
 * ДАТА, МЕСЯЦ И ВРЕМЯ ПО-РУССКИ — ЧИСТЫЕ ФУНКЦИИ (20.11.2026, класс К01/К17 аудита).
 *
 * На iPhone родное поле `type=date|month|time|datetime-local` рисует значение на
 * языке телефона («November 2026», «2:30 PM»). Язык страница задать не может, поэтому
 * видимый текст собирается здесь, а поле остаётся родным (его нажатие открывает
 * системный выбор). Значения полей — «стенные часы» без пояса (как у самих полей);
 * в Душанбе их превращают `dushanbeInputToIso`/`toLocalDateTimeInput` из `lib/date.ts`,
 * здесь пояс не нужен: ничего не пересчитываем, только пишем слова.
 *
 * Одно место для всех экранов: ранее здесь жил `ui/RuMonthText` (#336), теперь он —
 * `ruMonthLabel` отсюда.
 */
export type RuFieldKind = "date" | "month" | "time" | "datetime-local";

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** «2026-11» → «Ноябрь 2026». Кривое значение возвращается как есть. */
export function ruMonthLabel(month: string): string {
  if (!MONTH_RE.test(month)) return month;
  const text = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${month}-15T12:00:00Z`))
    .replace(/\s*г\.?$/, "");
  return capitalize(text);
}

/** «2026-11-20» → «20 ноября 2026». */
export function ruDateLabel(date: string): string {
  const m = DATE_RE.exec(date);
  if (!m) return date;
  const probe = new Date(`${date}T12:00:00Z`);
  // 31 февраля и подобное: Date молча переедет на март, а поле такого не отдаёт — не рисуем выдумку.
  if (Number.isNaN(probe.getTime()) || probe.getUTCDate() !== Number(m[3])) return date;
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(probe)
    .replace(/\s*г\.?$/, "");
}

/** «14:30:00» → «14:30» (24 часа, как в остальном CRM). */
export function ruTimeLabel(time: string): string {
  const m = TIME_RE.exec(time);
  return m ? `${m[1]}:${m[2]}` : time;
}

/** «2026-11-20T14:30» → «20 ноября 2026, 14:30». */
export function ruDateTimeLabel(value: string): string {
  const [date, time] = value.split("T");
  if (!date || !time) return value;
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) return value;
  return `${ruDateLabel(date)}, ${ruTimeLabel(time)}`;
}

const PLACEHOLDER: Record<RuFieldKind, string> = {
  date: "Выберите дату",
  month: "Выберите месяц",
  time: "Выберите время",
  "datetime-local": "Выберите дату и время",
};

/** Подсказка пустого поля. */
export function ruFieldPlaceholder(kind: RuFieldKind): string {
  return PLACEHOLDER[kind];
}

/** Подсказка формата для браузера без родного поля (поле становится обычным текстовым). */
const FORMAT_HINT: Record<RuFieldKind, string> = {
  date: "ГГГГ-ММ-ДД, например 2026-11-20",
  month: "ГГГГ-ММ, например 2026-11",
  time: "ЧЧ:ММ, например 14:30",
  "datetime-local": "ГГГГ-ММ-ДДTЧЧ:ММ",
};
export function ruFieldFormatHint(kind: RuFieldKind): string {
  return FORMAT_HINT[kind];
}

/** Что показать поверх поля: значение по-русски или подсказку. `empty` — для приглушённого цвета. */
export function ruFieldText(kind: RuFieldKind, value: string | undefined | null): { text: string; empty: boolean } {
  const v = (value ?? "").trim();
  if (!v) return { text: ruFieldPlaceholder(kind), empty: true };
  const text = kind === "date" ? ruDateLabel(v) : kind === "month" ? ruMonthLabel(v) : kind === "time" ? ruTimeLabel(v) : ruDateTimeLabel(v);
  return { text, empty: false };
}

/** Поддерживает ли браузер родное поле этого вида (Safari на Mac / старый Firefox — нет: type=month станет text). */
export function supportsNativeField(kind: RuFieldKind, doc: Document | undefined = typeof document === "undefined" ? undefined : document): boolean {
  if (!doc) return true;
  try {
    const probe = doc.createElement("input");
    probe.setAttribute("type", kind);
    return probe.type === kind;
  } catch {
    return false;
  }
}

/**
 * Нужна ли подпись поверх поля. На телефоне и планшете выбор идёт колесом/окном и печатать
 * в поле нечем — прячем язык телефона. На компьютере значение набирают клавиатурой по частям,
 * и невидимые части мешают, поэтому там поле остаётся родным (с `lang="ru"`).
 */
export function wantsRuOverlay(win: Pick<Window, "matchMedia" | "navigator"> | undefined = typeof window === "undefined" ? undefined : window): boolean {
  if (!win) return false;
  const ua = win.navigator?.userAgent ?? "";
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  try {
    return Boolean(win.matchMedia?.("(pointer: coarse)").matches);
  } catch {
    return false;
  }
}
