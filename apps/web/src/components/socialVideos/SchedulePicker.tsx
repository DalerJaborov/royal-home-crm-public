import { useEffect, useId, useState } from "react";
import { AlertTriangle, CalendarClock, Send } from "lucide-react";
import { DUSHANBE_OFFSET_MS, SOCIAL_VIDEO_MIN_SCHEDULE_LEAD_MINUTES } from "@royal-home/shared";

/**
 * Когда публиковать: «сразу» или «по расписанию».
 *
 * ВРЕМЯ — ТОЛЬКО ПО ДУШАНБЕ (UTC+5). Часовой пояс браузера здесь нарочно не
 * используется: маркетолог может сидеть за ноутбуком в другой стране, а
 * публикация должна выйти в то время, которое он видит на экране. Поля даты и
 * времени хранят «настенное» душанбинское время, наружу уходит ISO в UTC.
 */
export interface SchedulePickerProps {
  mode: "NOW" | "SCHEDULE";
  onModeChange(m: "NOW" | "SCHEDULE"): void;
  /** ISO UTC. */
  scheduledAt: string | null;
  onScheduledAtChange(iso: string | null): void;
  disabled?: boolean;
}

const MONTHS_GENITIVE = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WEEKDAYS_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

/** Душанбинская «стена»: Date, у которого UTC-поля равны местному времени Душанбе. */
function toWall(ms: number): Date {
  return new Date(ms + DUSHANBE_OFFSET_MS);
}

function wallDate(ms: number): string {
  return toWall(ms).toISOString().slice(0, 10);
}

function wallTime(ms: number): string {
  return toWall(ms).toISOString().slice(11, 16);
}

/** «ГГГГ-ММ-ДД» + «ЧЧ:ММ» по Душанбе → ISO UTC; null, если поля не заполнены или неверны. */
function wallToIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const ms = Date.parse(`${date}T${time}:00.000Z`) - DUSHANBE_OFFSET_MS;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Дата `ГГГГ-ММ-ДД`, сдвинутая на `days` суток (в календаре Душанбе). */
function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function humanWhen(iso: string): string {
  const ms = Date.parse(iso);
  const w = toWall(ms);
  return `${w.getUTCDate()} ${MONTHS_GENITIVE[w.getUTCMonth()]}, ${WEEKDAYS_SHORT[w.getUTCDay()]}, ${wallTime(ms)}`;
}

const MODES: { value: "NOW" | "SCHEDULE"; label: string; hint: string; Icon: typeof Send }[] = [
  { value: "NOW", label: "Сразу", hint: "Уйдёт в выбранные сети сразу после подтверждения", Icon: Send },
  { value: "SCHEDULE", label: "По расписанию", hint: "Выберите дату и время по Душанбе", Icon: CalendarClock },
];

const QUICK_BUTTONS = [
  { label: "Сегодня 18:00", day: 0, time: "18:00" },
  { label: "Завтра 10:00", day: 1, time: "10:00" },
  { label: "Завтра 19:00", day: 1, time: "19:00" },
] as const;

export function SchedulePicker({ mode, onModeChange, scheduledAt, onScheduledAtChange, disabled = false }: SchedulePickerProps) {
  const uid = useId();
  const [date, setDate] = useState(() => (scheduledAt ? wallDate(Date.parse(scheduledAt)) : ""));
  const [time, setTime] = useState(() => (scheduledAt ? wallTime(Date.parse(scheduledAt)) : ""));
  const [now, setNow] = useState(() => Date.now());

  // Значение пришло снаружи (черновик загрузился, нажата быстрая кнопка) — подтягиваем поля.
  useEffect(() => {
    if (scheduledAt && wallToIso(date, time) !== scheduledAt) {
      const ms = Date.parse(scheduledAt);
      if (Number.isFinite(ms)) {
        setDate(wallDate(ms));
        setTime(wallTime(ms));
      }
    }
    // Поля намеренно не в зависимостях: иначе набор «ЧЧ:ММ» по цифре перезаписывался бы.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduledAt]);

  // «Сейчас» нужно для проверки отступа; обновляем раз в полминуты, пока выбрано расписание.
  useEffect(() => {
    if (mode !== "SCHEDULE") return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [mode]);

  const minMs = now + SOCIAL_VIDEO_MIN_SCHEDULE_LEAD_MINUTES * 60_000;
  const today = wallDate(now);

  function commit(nextDate: string, nextTime: string) {
    setDate(nextDate);
    setTime(nextTime);
    onScheduledAtChange(wallToIso(nextDate, nextTime));
  }

  function quick(dayOffset: number, hhmm: string) {
    commit(shiftDate(today, dayOffset), hhmm);
  }

  function pickMode(next: "NOW" | "SCHEDULE") {
    if (next === mode) return;
    onModeChange(next);
    // Пустое расписание — не лучшее первое впечатление: подставляем «завтра 10:00».
    if (next === "SCHEDULE" && !scheduledAt) quick(1, "10:00");
  }

  const selectedMs = scheduledAt ? Date.parse(scheduledAt) : null;
  const tooSoon = selectedMs !== null && selectedMs < minMs;
  const incomplete = mode === "SCHEDULE" && scheduledAt === null;

  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Когда публиковать" className="grid gap-2 sm:grid-cols-2">
        {MODES.map(({ value, label, hint, Icon }) => {
          const active = mode === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => pickMode(value)}
              className={`flex! min-h-[64px]! items-center! gap-3! rounded-card! border! px-3.5! py-3! text-left! transition-colors! disabled:cursor-not-allowed! disabled:opacity-60! ${
                active ? "border-blue! bg-blue/10!" : "border-line! bg-card-solid! hover:bg-hover-tint!"
              }`}
            >
              <span
                className={`inline-grid h-9 w-9 shrink-0 place-items-center rounded-[11px] ${active ? "bg-blue text-on-accent" : "bg-ink/5 text-gray-600"}`}
              >
                <Icon size={18} aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] font-semibold text-gray-800">{label}</span>
                <span className="block text-[13px] leading-snug text-gray-500">{hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      {mode === "SCHEDULE" && (
        <div className="flex flex-col gap-3 rounded-card border border-line bg-card-solid p-3.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${uid}-date`} className="text-[13px] font-semibold text-gray-600">
                Дата
              </label>
              <input
                id={`${uid}-date`}
                type="date"
                value={date}
                min={today}
                disabled={disabled}
                onChange={(e) => commit(e.target.value, time)}
                className="min-h-[44px] rounded-control border border-line bg-card-solid px-3 text-[15px] text-gray-800 disabled:opacity-60"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${uid}-time`} className="text-[13px] font-semibold text-gray-600">
                Время (Душанбе, UTC+5)
              </label>
              <input
                id={`${uid}-time`}
                type="time"
                value={time}
                disabled={disabled}
                onChange={(e) => commit(date, e.target.value)}
                className="min-h-[44px] rounded-control border border-line bg-card-solid px-3 text-[15px] text-gray-800 disabled:opacity-60"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2" role="group" aria-label="Быстрый выбор времени">
            {QUICK_BUTTONS.map((q) => {
              const iso = wallToIso(shiftDate(today, q.day), q.time);
              const past = iso !== null && Date.parse(iso) < minMs;
              const active = iso !== null && iso === scheduledAt;
              return (
                <button
                  key={q.label}
                  type="button"
                  disabled={disabled || past}
                  aria-pressed={active}
                  onClick={() => quick(q.day, q.time)}
                  className={`min-h-[40px]! rounded-full! border! px-3.5! text-[14px]! font-semibold! transition-colors! disabled:cursor-not-allowed! disabled:opacity-45! ${
                    active ? "border-blue! bg-blue/10! text-blue!" : "border-line! bg-card-solid! text-gray-700! hover:bg-hover-tint!"
                  }`}
                >
                  {q.label}
                </button>
              );
            })}
          </div>

          {tooSoon && (
            <p role="alert" className="m-0 flex items-start gap-2 rounded-lg bg-red-bg px-3 py-2 text-[14px] font-semibold text-red">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              Выберите время не раньше чем через {SOCIAL_VIDEO_MIN_SCHEDULE_LEAD_MINUTES} мин от сейчас (сейчас в Душанбе {wallTime(now)}).
            </p>
          )}
          {incomplete && !tooSoon && <p className="m-0 text-[14px] text-gray-500">Укажите дату и время, чтобы запланировать публикацию.</p>}
          {scheduledAt && !tooSoon && (
            <p className="m-0 flex items-center gap-2 text-[14px] font-semibold text-gray-800">
              <CalendarClock size={16} className="shrink-0 text-blue" aria-hidden="true" />
              Выйдет {humanWhen(scheduledAt)} по Душанбе
            </p>
          )}
        </div>
      )}
    </div>
  );
}
