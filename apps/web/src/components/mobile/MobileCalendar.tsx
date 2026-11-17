import { Fragment, type ReactNode } from "react";
import { INTERACTION_TYPE_LABELS, showingConfirmationBadge } from "../../lib/clientFormat";
import type { Interaction } from "../../types";

/**
 * Мобильный «Календарь» — подкомпоненты экрана из эталона темы «Royal Home 2026»
 * (screens/calendar.html). Сетка месяца — тот же `.cal`, что на десктопе: на
 * ширине ≤820 CSS эталона сам превращает подписи событий `.ev` в цветные точки,
 * поэтому отдельной «мобильной» разметки клеток не требуется.
 *
 * Здесь только разметка: состояние месяца, выбранного дня и все мутации живут в
 * pages/Calendar.tsx — тот же принцип, что у доски сделок (MobileDeals.tsx),
 * чтобы душанбинская логика суток не существовала в двух экземплярах.
 */

/**
 * Тон чипа подтверждения показа в языке эталона: у прототипа три состояния
 * чипа (.ok, .warn, .crit), у CRM — те же три, но названы классами Tailwind.
 * Живёт здесь, а не в lib/clientFormat.ts: тот файл читают ещё три экрана,
 * которые к эталону пока не переносились, и трогать его этой задачей нельзя.
 * Оба облика календаря берут перевод отсюда, копии нет.
 */
export function chipTone(className: string): string {
  if (className.includes("red")) return "chip crit";
  if (className.includes("green")) return "chip ok";
  if (className.includes("amber")) return "chip warn";
  return "chip mute";
}

/** Клетка сетки — pages/Calendar.tsx готовит их из своей сетки 6×7. */
export type MonthCell = {
  /** Ключ суток «2026-08-13» — тот же, каким Calendar группирует задачи. */
  key: string;
  day: number;
  inMonth: boolean;
  /** Сколько в этот день показов и сколько прочих задач: две подписи `.ev`. */
  showings: number;
  others: number;
};

/** Карточка месяца — `.card` эталона с заголовком секции, легендой и сеткой `.cal`. */
export function MobileMonthCard({
  monthLabel,
  cells,
  selectedKey,
  todayKey,
  legend,
  onSelectDay,
  onPrevMonth,
  onNextMonth,
  onToday,
}: {
  monthLabel: string;
  cells: MonthCell[];
  /** null — выбран режим «просрочено», выделенной клетки нет. */
  selectedKey: string | null;
  todayKey: string;
  /** Легенда «показ / задача» — собрана в Calendar.tsx, одна на оба облика. */
  legend: ReactNode;
  onSelectDay: (key: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
}) {
  return (
    <div className="card">
      <div className="sec-h">
        <h2>{monthLabel}</h2>
        {legend}
      </div>
      {/* Ряд «‹ Сегодня ›»: `.wrap` здесь рисуется внутри `.rh2 .mh` (не `.scr`),
          где это блочная обёртка лендинга (theme-2026-proto.css:47/168), а не
          ряд с зазором, — три пилюли наползали друг на друга тенями (ночная
          проверка 24.09.2026, находка №7). `.cal-nav` — правило рядом,
          в theme-2026-mobile-shell.css (рукописный, не генерируется). */}
      <div className="wrap cal-nav" style={{ marginBottom: "var(--s3)" }}>
        <button className="pill ghost icon" type="button" aria-label="Предыдущий месяц" onClick={onPrevMonth}>
          <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <button className="pill ghost sm" type="button" onClick={onToday}>
          Сегодня
        </button>
        <button className="pill ghost icon" type="button" aria-label="Следующий месяц" onClick={onNextMonth}>
          <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
      </div>
      <div className="cal">
        {["пн", "вт", "ср", "чт", "пт", "сб", "вс"].map((w) => (
          <span className="hd" key={w}>
            {w}
          </span>
        ))}
        {cells.map((c) => {
          const sel = c.key === selectedKey;
          return (
            <button
              key={c.key}
              type="button"
              aria-current={sel ? "date" : undefined}
              onClick={() => onSelectDay(c.key)}
              className={`d${c.inMonth ? "" : " out"}${c.key === todayKey ? " today" : ""}`}
              // Выбранного дня в статичном макете нет, а функция выбора обязана
              // остаться видимой: заливаем клетку токенами активной пилюли.
              style={sel ? { background: "var(--pill)" } : undefined}
            >
              <span className="n" style={sel ? { color: "var(--pill-ink)" } : undefined}>
                {c.day}
              </span>
              {c.showings > 0 && <span className="ev">{c.showings === 1 ? "показ" : `${c.showings} показа`}</span>}
              {c.others > 0 && <span className="ev task">{c.others === 1 ? "задача" : `${c.others} задачи`}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Строка задачи дня на телефоне — та же `.row` эталона, что на десктопе:
 * чип времени, имя и подпись, чип подтверждения, решения одной кнопкой.
 * На ширине ≤820 CSS эталона сам переносит блок `.act` на свою строку.
 *
 * ЧЕГО НЕТ В МАКЕТЕ, НО ОБЯЗАНО ЖИТЬ: перенос и отмена показа с обязательной
 * причиной (решение владельца 16.08.2026) раскрываются под строкой — теми же
 * полями `.inp`, что и на десктопе, и теми же обработчиками от Calendar.
 */
export function MobileTaskCard({
  task,
  rightLabel,
  overdue = false,
  onOpen,
  onComplete,
  call,
  rescheduleValue,
  rescheduleReason,
  onRescheduleStart,
  onRescheduleChange,
  onRescheduleReasonChange,
  onRescheduleClose,
  onRescheduleSubmit,
  onCancelStart,
  busy,
}: {
  task: Interaction;
  /** Правый край строки: время «15:00» в списке дня, дата «15 авг.» в «Ближайших». */
  rightLabel: string;
  /** Просроченная: чип времени красный, как счётчик в шапке. */
  overdue?: boolean;
  onOpen: () => void;
  onComplete?: () => void;
  /** Кнопка звонка (CallClientButton) — приходит готовой, чтобы правило
   *  «сначала через CRM» жило в одном компоненте, а не в копиях. */
  call?: ReactNode;
  rescheduleValue?: string | null;
  rescheduleReason?: string;
  onRescheduleStart?: () => void;
  onRescheduleChange?: (value: string) => void;
  onRescheduleReasonChange?: (value: string) => void;
  onRescheduleClose?: () => void;
  onRescheduleSubmit?: (value: string, reason: string) => void;
  onCancelStart?: () => void;
  busy?: boolean;
}) {
  const confirmation = showingConfirmationBadge(task);
  const isShowing = task.type === "SHOWING" && !!task.nextActionDate && !!onCancelStart;
  const typeLabel = INTERACTION_TYPE_LABELS[task.type] ?? "Задача";
  const clientName = task.client?.fullName ?? "Клиент";

  return (
    <Fragment>
      <div className="row calendar-task-row" title={typeLabel}>
        <span className={overdue ? "chip crit" : "chip mute"} style={{ minWidth: "64px", justifyContent: "center" }}>
          {rightLabel}
        </span>
        <div className="t">
          <b>
            <button className="lk" type="button" onClick={onOpen}>
              {task.property?.title ? `${typeLabel}: ${task.property.title}` : `${typeLabel}: ${clientName}`}
            </button>
          </b>
          <span>{task.property?.title ? `${clientName}${task.nextAction ? `. ${task.nextAction}` : ""}` : task.nextAction ?? ""}</span>
        </div>
        {confirmation ? <span className={chipTone(confirmation.className)}>{confirmation.label}</span> : null}
        <div className="act">
          {onComplete && <button className="pill ghost sm" type="button" onClick={onComplete} title="Отметить выполненной">
            Сделано
          </button>}
          {isShowing && rescheduleValue === null && (
            <>
              <button className="pill ghost sm" type="button" onClick={onRescheduleStart}>
                Перенести
              </button>
              <button className="lnk" type="button" onClick={onCancelStart}>
                Отменить
              </button>
            </>
          )}
          {call}
        </div>
      </div>

      {isShowing && rescheduleValue !== null && rescheduleValue !== undefined && (
        <form
          className="wrap"
          style={{ padding: "var(--s2) 0 var(--s3)" }}
          onSubmit={(e) => {
            e.preventDefault();
            const reason = (rescheduleReason ?? "").trim();
            if (reason.length < 3) return;
            onRescheduleSubmit?.(rescheduleValue, reason);
          }}
        >
          <input
            className="inp"
            type="datetime-local"
            value={rescheduleValue}
            onChange={(e) => onRescheduleChange?.(e.target.value)}
            aria-label="Новое время показа"
          />
          {/* Причина обязательна (владелец 16.08.2026) — как в десктопной форме. */}
          <input
            className="inp"
            type="text"
            value={rescheduleReason ?? ""}
            onChange={(e) => onRescheduleReasonChange?.(e.target.value)}
            placeholder="Причина переноса (обязательно)"
            aria-label="Причина переноса"
          />
          <button className="pill sm" type="submit" disabled={busy || !rescheduleValue || (rescheduleReason ?? "").trim().length < 3}>
            Сохранить
          </button>
          <button className="pill ghost sm" type="button" onClick={onRescheduleClose}>
            Отмена
          </button>
        </form>
      )}
    </Fragment>
  );
}
