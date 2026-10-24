import { ShellOwnHeader } from "../components/rh2/ShellOwnHeader";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import {
  dushanbeDate,
  dushanbeDateTime,
  dushanbeDayKey,
  dushanbeTime,
  dushanbeTodayKey,
  toLocalDateInput,
} from "../lib/date";
import { useNavigate, useSearchParams } from "react-router-dom";
import { dushanbeLocalToIso, isoToDushanbeLocal } from "@royal-home/shared";
import { useGoBack } from "../hooks/useGoBack";
import { useCalendarTasks, useCancelShowing, useCompleteTask, useRescheduleShowing } from "../hooks/useCalendar";
import { CallClientButton } from "../components/CallClientButton";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useMobileUx } from "../hooks/useMobileUx";
import { useCleanShell } from "../hooks/useCleanShell";
import { useShellClaim } from "../store/shell";
import { chipTone, MobileMonthCard, MobileTaskCard } from "../components/mobile/MobileCalendar";
import type { CSSProperties } from "react";

/** Область во всю ширину — те же значения, что MH_HOST в MhScreen.tsx. */
const MH_HOST: CSSProperties = {
  margin: "0 -16px calc(-96px - env(safe-area-inset-bottom, 0px))",
  paddingBottom: "calc(96px + env(safe-area-inset-bottom, 0px))",
  minHeight: "calc(100dvh - 16px - env(safe-area-inset-top, 0px))",
  display: "flex",
  flexDirection: "column",
};
import { useMarkSectionSeen } from "../hooks/useCounters";
import { INTERACTION_TYPE_LABELS, showingConfirmationBadge } from "../lib/clientFormat";
import type { Interaction } from "../types";
import { scrollableRegion } from "../lib/a11y";
import { anchorOutsideGrid, shiftedAnchor, weekDays } from "../lib/calendarWeek";

const WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

/**
 * КЛЕТКА СЕТКИ и ЗАДАЧА раскладываются по одному правилу — по суткам ДУШАНБЕ.
 *
 * Прежние startOfDay + toDateString считали сутки по часам устройства. Для агента
 * в Душанбе это одно и то же, а владелец, открывший CRM из Стамбула (UTC+3), видел
 * показ, назначенный на 00:30 4 августа, в клетке 3-го — при том что подпись рядом
 * честно писала «4 авг», она уже шла через часовой пояс. Два разных числа про одну
 * встречу на одном экране.
 *
 * У клетки ключ строится из её собственных цифр: клетка — это календарный день,
 * который человек видит нарисованным, переводить его через пояс нечего и незачем.
 * У задачи — из момента времени, приведённого к Душанбе.
 */
function cellKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function taskKey(value: string | Date): string {
  return dushanbeDayKey(value);
}

/** Ключ суток, сдвинутых на `days` от сегодняшних по Душанбе. */
function dayKeyShifted(days: number): string {
  const base = new Date(`${dushanbeTodayKey()}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * Сегодняшний день по Душанбе, как обычный локальный Date (для месяца сетки).
 *
 * `new Date()` даёт «сегодня» устройства: у зрителя за пределами Душанбе рядом с
 * границей месяца это уже другое число — сетка открывалась бы не на том месяце,
 * а кнопка «Сегодня» не находила бы клетку, чтобы её выделить.
 */
function dushanbeTodayAsLocalDate(): Date {
  const [y, m, d] = dushanbeTodayKey().split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Понедельник-первая сетка 6×7, покрывающая весь месяц + хвосты соседних месяцев. */
function buildMonthGrid(viewDate: Date): Date[] {
  const firstOfMonth = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
  const firstWeekday = (firstOfMonth.getDay() + 6) % 7; // 0=Пн
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(firstOfMonth.getDate() - firstWeekday);

  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_PARAM_VALUES = ["SHOWING", "MEETING"] as const;
type TypeParam = (typeof TYPE_PARAM_VALUES)[number];

/**
 * `?date=` из адреса → ключ суток Душанбе или режим «overdue». `today` и
 * пустое/незнакомое значение не должны ронять экран (пункт задания «неизвестное
 * значение — ведём себя как без параметра») — падаем на сегодня по умолчанию.
 */
function resolveDateParam(raw: string | null): { mode: "day"; key: string } | { mode: "overdue" } {
  if (raw === "overdue") return { mode: "overdue" };
  if (raw === "today" || !raw) return { mode: "day", key: dushanbeTodayKey() };
  if (DATE_KEY_RE.test(raw)) return { mode: "day", key: raw };
  return { mode: "day", key: dushanbeTodayKey() };
}

function resolveTypeParam(raw: string | null): TypeParam | null {
  return (TYPE_PARAM_VALUES as readonly string[]).includes(raw ?? "") ? (raw as TypeParam) : null;
}

/** Листание недель: у режима «Неделя» своей навигации не было, она жила только в «Месяце». */
function WeekNav({ onPrev, onNext, onToday }: { onPrev: () => void; onNext: () => void; onToday: () => void }) {
  const chevron = (d: string) => (
    <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
  return (
    <div className="wrap" style={{ gap: 6 }}>
      <button className="pill ghost sm icon" type="button" aria-label="Предыдущая неделя" onClick={onPrev}>
        {chevron("m14 6-6 6 6 6")}
      </button>
      <button className="pill ghost sm" type="button" onClick={onToday}>
        Сегодня
      </button>
      <button className="pill ghost sm icon" type="button" aria-label="Следующая неделя" onClick={onNext}>
        {chevron("m10 6 6 6-6 6")}
      </button>
    </div>
  );
}

export function Calendar() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialSelected = useMemo(() => resolveDateParam(searchParams.get("date")), []); // eslint-disable-line react-hooks/exhaustive-deps
  const typeFilter = resolveTypeParam(searchParams.get("type"));
  const [viewDate, setViewDate] = useState(() =>
    initialSelected.mode === "day" ? new Date(`${initialSelected.key}T12:00:00Z`) : dushanbeTodayAsLocalDate()
  );
  const [selected, setSelected] = useState<{ mode: "day"; key: string } | { mode: "overdue" }>(initialSelected);

  /** Пишет выбор обратно в адрес — ссылку можно переслать, «назад» работает. */
  function selectDay(key: string) {
    setSelected({ mode: "day", key });
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("date", key === dushanbeTodayKey() ? "today" : key);
        return next;
      },
      { replace: true }
    );
  }

  function selectOverdue() {
    setSelected({ mode: "overdue" });
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("date", "overdue");
        return next;
      },
      { replace: true }
    );
  }
  // Переключатель «День / Неделя / Месяц» — по эталону (`.seg` в шапке). Данные
  // одни и те же (месячный запрос уже покрывает любую видимую неделю и день),
  // переключается только раскладка ниже.
  const [view, setView] = useState<"day" | "week" | "month">("month");
  const navigate = useNavigate();
  // «Назад» экрана: запасной путь — «Ещё», откуда календарь и открывают.
  const goBack = useGoBack("/more");
  const mobile = useMobileUx();
  const clean = useCleanShell();
  // Открытие раздела гасит красный счётчик в сайдбаре (у текущего агента).
  useMarkSectionSeen("calendar");
  const complete = useCompleteTask();
  const cancelShowing = useCancelShowing();
  const rescheduleShowing = useRescheduleShowing();
  // Какой показ агент сейчас переносит и какой собирается отменить. Держим здесь,
  // а не в строке списка: открытых форм переноса должно быть не больше одной,
  // иначе агент правит две встречи сразу и путается, какую сохранил.
  // reason — обязательное поле обоих действий (владелец 16.08.2026): «Отменить»
  // без причины теряло её след в карточке клиента, а «часто нужен перенос»
  // становился незаметен без объяснения, почему время не подошло.
  const [rescheduling, setRescheduling] = useState<{ id: string; at: string; reason: string } | null>(null);
  const [cancelling, setCancelling] = useState<Interaction | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const grid = useMemo(() => buildMonthGrid(viewDate), [viewDate]);
  const rangeFrom = grid[0];
  const rangeTo = grid[grid.length - 1];

  // toISOString() переводит локальную полночь в UTC и в Душанбе (UTC+5) сдвигает
  // дату на день назад: задачи последней клетки сетки просто не приходили.
  const { data: rawTasks, isLoading, error } = useCalendarTasks({
    from: toLocalDateInput(rangeFrom),
    to: toLocalDateInput(rangeTo),
  });

  // `?type=SHOWING|MEETING` из адреса — сервер отдаёт диапазон целиком, фильтр
  // клиентский, как и остальная раскладка календаря.
  const tasks = useMemo(
    () => (typeFilter ? (rawTasks ?? []).filter((t) => t.type === typeFilter) : rawTasks),
    [rawTasks, typeFilter]
  );

  // «Сегодня» — по Душанбе: компания работает в одном городе, и день у неё один,
  // независимо от того, откуда открыли CRM.
  const todayKey = dushanbeTodayKey();

  const { tasksByDay, overdueTasks } = useMemo(() => {
    const byDay = new Map<string, Interaction[]>();
    const overdue: Interaction[] = [];
    (tasks ?? []).forEach((task) => {
      if (!task.nextActionDate) return;
      const key = taskKey(task.nextActionDate);
      // Ключи вида «2026-08-03» сравниваются как строки — это и есть сравнение
      // календарных дней, без моментов времени и без пояса.
      if (key < todayKey) {
        overdue.push(task);
        return;
      }
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(task);
    });
    return { tasksByDay: byDay, overdueTasks: overdue };
  }, [tasks, todayKey]);

  const visibleTasks =
    selected.mode === "overdue" ? overdueTasks : tasksByDay.get(selected.key) ?? [];

  // Ближайшие задачи (от сегодня вперёд) — показываем, когда у выбранного дня задач нет,
  // чтобы пустой день не выглядел «ничего нет» и было видно, что ждёт впереди.
  const upcomingTasks = useMemo(() => {
    return (tasks ?? [])
      .filter((t) => t.nextActionDate && taskKey(t.nextActionDate) >= todayKey)
      .sort((a, b) => new Date(a.nextActionDate!).getTime() - new Date(b.nextActionDate!).getTime())
      .slice(0, 12);
  }, [tasks, todayKey]);

  // Неделя тоже по суткам Душанбе: сравнение моментов времени сдвигало границу окна
  // на часы устройства, и задача последнего дня то попадала в счётчик, то нет.
  const weekEndKey = dayKeyShifted(7);
  const thisWeekCount = (tasks ?? []).filter((t) => {
    if (!t.nextActionDate) return false;
    const key = taskKey(t.nextActionDate);
    return key >= todayKey && key < weekEndKey;
  }).length;
  const todayCount = tasksByDay.get(todayKey)?.length ?? 0;

  // Панель «Неделя» — строка на каждый день, показы и задачи честно из тех же
  // данных, что и сетка месяца. Столбца «Свободных окон» из шаблона здесь нет:
  // в CRM нет понятия рабочего расписания агента, откуда бы это число взялось
  // (21.09.2026 колонка-прочерк убрана совсем, см. таблицу ниже).
  const weekRows = useMemo(() => {
    // Неделя выбранного дня, а не месяца, на котором открыли экран (WEB-PAGES19).
    return weekDays(selected, viewDate).map((d) => {
      const key = cellKey(d);
      const dayTasks = tasksByDay.get(key) ?? [];
      const showings = dayTasks.filter((t) => t.type === "SHOWING");
      const others = dayTasks.filter((t) => t.type !== "SHOWING");
      return { key, date: d, showings, others };
    });
  }, [selected, viewDate, tasksByDay]);

  function changeMonth(delta: number) {
    setViewDate((d) => new Date(d.getFullYear(), d.getMonth() + delta, 1));
  }

  /** Неделя вперёд/назад от выбранного дня; месяц переключается, если якорь ушёл из сетки. */
  function shiftWeek(delta: number) {
    const anchor = shiftedAnchor(selected, viewDate, delta);
    if (anchorOutsideGrid(anchor, rangeFrom, rangeTo)) {
      setViewDate(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    }
    selectDay(cellKey(anchor));
  }

  function goToday() {
    setViewDate(dushanbeTodayAsLocalDate());
    selectDay(dushanbeTodayKey());
  }

  // Диалог отмены показа — ОДИН на оба облика: причина обязательна (владелец
  // 16.08.2026), и телефон не имеет права спрашивать её иначе, чем десктоп.
  const cancelDialog = cancelling && (
    <ConfirmDialog
      title="Отменить показ?"
      description={
        `${cancelling.client?.fullName ?? "Клиент"}${cancelling.property ? ` · ${cancelling.property.title}` : ""}, ` +
        `${dushanbeDateTime(cancelling.nextActionDate!)}. ` +
        "Встреча уйдёт из календаря и из отчётов, запись об отмене и причине останется в карточке клиента."
      }
      confirmLabel="Отменить показ"
      confirmDisabled={cancelReason.trim().length < 3}
      onCancel={() => {
        setCancelling(null);
        setCancelReason("");
      }}
      onConfirm={() => {
        cancelShowing.mutate({ interactionId: cancelling.id, reason: cancelReason.trim() });
        setCancelling(null);
        setCancelReason("");
      }}
    >
      {/* Поле эталона (`.fld` → `.lab` + textarea). Шторка подтверждения сама
          открывает `.rh2` в корне портала (ConfirmDialog → Rh2Sheet), поэтому
          классы макета здесь действуют. */}
      <label className="fld">
        <span className="lab">
          Причина отмены <span style={{ color: "var(--crit)" }}>*</span>
        </span>
        <textarea
          autoFocus
          value={cancelReason}
          onChange={(e) => setCancelReason(e.target.value)}
          placeholder="Например: клиент заболел, попросил перенести на другую дату…"
          rows={2}
        />
      </label>
    </ConfirmDialog>
  );

  /** Тихая строка отказа мутации — эталонный .quiet.crit вместо цветной плашки. */
  const mutationNote = (
    <>
      {complete.isError && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">
            {complete.error instanceof Error ? complete.error.message : "Не удалось отметить задачу выполненной"}
          </span>
          <button className="lnk" type="button" onClick={() => complete.reset()}>
            Понятно
          </button>
        </div>
      )}
      {cancelShowing.isError && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">
            {cancelShowing.error instanceof Error ? cancelShowing.error.message : "Не удалось отменить показ"}
          </span>
          <button className="lnk" type="button" onClick={() => cancelShowing.reset()}>
            Понятно
          </button>
        </div>
      )}
      {rescheduleShowing.isError && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">
            {rescheduleShowing.error instanceof Error ? rescheduleShowing.error.message : "Не удалось перенести показ"}
          </span>
          <button className="lnk" type="button" onClick={() => rescheduleShowing.reset()}>
            Понятно
          </button>
        </div>
      )}
    </>
  );

  const dayTitle =
    selected.mode === "overdue"
      ? "Просроченные"
      : selected.key === todayKey
        ? "Сегодня"
        : // Ключ «2026-08-13» — уже календарный день Душанбе; читаем его как
          // полдень UTC, чтобы подпись не съехала на соседний день.
          new Date(`${selected.key}T12:00:00Z`).toLocaleDateString("ru-RU", {
            day: "numeric",
            month: "long",
            weekday: "short",
            timeZone: "UTC",
          });

  /** Общий на оба облика набор обработчиков одной строки задачи. */
  const taskHandlers = (task: Interaction) => ({
    onOpen: () => task.client?.shortId && navigate(`/clients/${task.client.shortId}`),
    onComplete: () => complete.mutate(task.id),
    rescheduleValue: rescheduling?.id === task.id ? rescheduling.at : null,
    rescheduleReason: rescheduling?.id === task.id ? rescheduling.reason : "",
    // Поле и отправка — в часах Душанбе, как весь экран (F5, 02.10.2026): раньше
    // оба шага брали пояс устройства, и из Стамбула показ в 16:00 стоял в поле
    // как 14:00, а вписанные 16:00 уезжали клиенту как 18:00.
    onRescheduleStart: () =>
      setRescheduling({ id: task.id, at: isoToDushanbeLocal(task.nextActionDate!), reason: "" }),
    onRescheduleChange: (at: string) => setRescheduling((r) => (r ? { ...r, at } : r)),
    onRescheduleReasonChange: (reason: string) => setRescheduling((r) => (r ? { ...r, reason } : r)),
    onRescheduleClose: () => setRescheduling(null),
    onRescheduleSubmit: (at: string, reason: string) => {
      const iso = dushanbeLocalToIso(at);
      if (!iso) return;
      rescheduleShowing.mutate(
        { interactionId: task.id, at: new Date(iso).toISOString(), reason },
        { onSuccess: () => setRescheduling(null) }
      );
    },
    onCancelStart: () => setCancelling(task),
    busy: rescheduleShowing.isPending || cancelShowing.isPending,
  });

  /** Кнопка звонка строки — правило «сначала через CRM» живёт в одном компоненте. */
  const taskCall = (task: Interaction): ReactNode =>
    task.client?.phone ? (
      <CallClientButton clientId={task.clientId} phone={task.client.phone} variant="icon" className="call" title="Позвонить через CRM" />
    ) : null;

  const legend = (
    <span className="note">
      <span className="chip" style={{ background: "var(--sky)", color: "var(--sky-ink)", borderColor: "transparent" }}>
        показ
      </span>{" "}
      <span className="chip" style={{ background: "var(--lav)", color: "var(--lav-ink)", borderColor: "transparent" }}>
        задача
      </span>
    </span>
  );

  const overdueQuiet = overdueTasks.length > 0 && (
    <div className="card tight">
      <div className="quiet warn">
        <span className="dot warn" />
        <span className="txt">
          Просрочено задач: {overdueTasks.length}. Молчание клиента не отказ, половина возвращается после звонка.
        </span>
        <button className="lnk" type="button" onClick={() => selectOverdue()}>
          Показать
        </button>
      </div>
    </div>
  );

  /**
   * «Между встречами» УБРАН 21.09.2026 по требованию владельца («убрать между
   * встречами, зачем он там»).
   *
   * Блок пришёл из шаблона и не запрашивал данных вовсе: при любом состоянии
   * календаря он печатал одну и ту же строку «Нет данных: календарь не хранит
   * очередь…» со ссылкой в другой раздел. То есть занимал первый экран телефона
   * — выше самого календаря — ради объяснения, почему он пуст. Очередь «что
   * сделать в свободном окне» и правда живёт в «Клиентах» («Решить сейчас»), и
   * там она с настоящими данными; дубля-заглушки в календаре быть не должно.
   */

  const loadingState = isLoading && (
    <div className="state">
      <span className="sk w28" />
      <span className="sk w22" /> Загружаем календарь
    </div>
  );

  const errorState = error && (
    <div className="card tight">
      <div className="state err">
        <span className="dot crit" />{" "}
        {error instanceof Error ? error.message : "Календарь не загрузился."}
      </div>
    </div>
  );

  // ---------- Мобильный облик ----------
  if (mobile) {
    const selectedKey = selected.mode === "day" ? selected.key : null;
    const cells = grid.map((d) => {
      const key = cellKey(d);
      const dayTasks = tasksByDay.get(key) ?? [];
      return {
        key,
        day: d.getDate(),
        inMonth: d.getMonth() === viewDate.getMonth(),
        showings: dayTasks.filter((t) => t.type === "SHOWING").length,
        others: dayTasks.filter((t) => t.type !== "SHOWING").length,
      };
    });
    // «Ближайшие» стоят под списком дня всегда — показываем всё будущее, кроме
    // уже развёрнутого выбранного дня (иначе строки задвоятся).
    const upcomingOther = upcomingTasks.filter(
      (t) => selectedKey === null || taskKey(t.nextActionDate!) !== selectedKey
    );

    return (
      // Экран переодет в область мобильного макета (15.09.2026, владелец:
      // «ничего из ПК я не хочу на телефоне»). Своего экрана-календаря в
      // артефакте c99db05f нет, поэтому шапка и списки взяты по общему шаблону
      // второго уровня, а сетка месяца перенесена в область `.mh` правилами
      // блока 7.6 theme-2026-mobile-shell.css — без неё она осталась бы вовсе
      // без стилей: класс `.cal` описан только для области пульта.
      <div className={clean ? "rh2 clean-calendar-page" : "rh2"} style={clean ? undefined : MH_HOST}>
        <div className="mh">
          {clean ? <CleanCalendarShellTitle /> : <ShellOwnHeader />}
          <div className="top" aria-hidden={clean || undefined}>
            <button
              type="button"
              className="ico"
              aria-label="Назад"
              onClick={goBack}
            >
              <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 6l-6 6 6 6" />
              </svg>
            </button>
            <div className="grow">
              {/* role="heading" вместо <h1>: класс `.greet` описан для div в
                  эталоне темы, смена тега утащила бы за собой отступы и кегль.
                  Название экрана обязано быть заголовком — без него телефонная
                  версия «Календаря» вообще не имела заголовка, и проверка
                  экранов (smoke.spec) падала именно на этом. 19.09.2026. */}
              <div className="greet" style={{ fontSize: 24 }} role="heading" aria-level={1}>
                Календарь
              </div>
              {/* textTransform снимаем: у `.date` в макете стоит capitalize —
                  он нужен названию дня недели на главной, а здесь превращал
                  подпись в «Сегодня 5, За 7 Дней 6» (кадр проверки 15.09). */}
              <div className="date" style={{ textTransform: "none" }}>
                Сегодня {todayCount}, за 7 дней {thisWeekCount}
                {overdueTasks.length > 0 ? `, просрочено ${overdueTasks.length}` : ""}
              </div>
            </div>
            {/* КНОПКИ «+» В ШАПКЕ БОЛЬШЕ НЕТ (21.09.2026). Владелец: «неправильно
                кнопки в календаре, „Назначить показ“ стоит ещё в календаре,
                зачем». Значок «плюс» обещает форму показа прямо здесь, а её
                нет: показ в CRM назначается из карточки клиента
                (AddInteractionModal), и «плюс» просто уводил в список клиентов
                без единого слова о том, почему. Понятная кнопка с подписью
                осталась ровно одна — внизу карточки дня. */}
          </div>
          <div className="body">

          {clean && <p className="clean-calendar-summary">Сегодня {todayCount} · за 7 дней {thisWeekCount}{overdueTasks.length > 0 ? ` · просрочено ${overdueTasks.length}` : ""}</p>}

          {overdueQuiet}
          {errorState}

          {/* ДЕНЬ · НЕДЕЛЯ · МЕСЯЦ НА ТЕЛЕФОНЕ (21.09.2026). На широком экране
              переключатель был с самого начала, на телефоне — нет: календарь
              открывался только месяцем, и чтобы понять, что на неделе, его
              приходилось щёлкать по клеткам день за днём. Состояние `view` и
              данные те же, что у широкого экрана (месячный запрос покрывает и
              неделю, и день), — новых запросов к серверу переключатель не
              делает. */}
          <div className="lane" role="tablist" aria-label="Что показывать в календаре">
            <button type="button" className="f" role="tab" aria-selected={view === "day"} onClick={() => setView("day")}>
              День
            </button>
            <button type="button" className="f" role="tab" aria-selected={view === "week"} onClick={() => setView("week")}>
              Неделя
            </button>
            <button type="button" className="f" role="tab" aria-selected={view === "month"} onClick={() => setView("month")}>
              Месяц
            </button>
          </div>

          {view === "week" && (
            <div className="card tight">
              <div className="sec-h">
                <h2>
                  с {weekRows[0].date.getDate()} по {weekRows[6].date.getDate()}{" "}
                  {MONTH_NAMES[weekRows[6].date.getMonth()].toLowerCase()}
                </h2>
                <span className="note">
                  {weekRows.reduce((n, r) => n + r.showings.length, 0)} показов,{" "}
                  {weekRows.reduce((n, r) => n + r.others.length, 0)} задач
                </span>
                <WeekNav onPrev={() => shiftWeek(-1)} onNext={() => shiftWeek(1)} onToday={goToday} />
              </div>
              {/* Строки, а не таблица: таблица на 390 px уезжает вбок. Нажатие
                  выбирает день — список этого дня стоит карточкой ниже. */}
              <div className="list">
                {weekRows.map((row) => (
                  <button
                    key={row.key}
                    type="button"
                    className="row"
                    onClick={() => selectDay(row.key)}
                    aria-current={selectedKey === row.key ? "true" : undefined}
                  >
                    <span className="t" style={{ textAlign: "left" }}>
                      <span className="n">
                        {WEEKDAYS[(row.date.getDay() + 6) % 7]}, {row.date.getDate()}
                      </span>
                      <span className="s">
                        {row.showings.length === 0 && row.others.length === 0
                          ? "Пока пусто"
                          : [
                              row.showings.length > 0 ? `${row.showings.length} показ(ов)` : null,
                              row.others.length > 0 ? `${row.others.length} задач(и)` : null,
                            ]
                              .filter(Boolean)
                              .join(", ")}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {view === "month" && (
          <MobileMonthCard
            monthLabel={`${MONTH_NAMES[viewDate.getMonth()]} ${viewDate.getFullYear()}`}
            cells={cells}
            selectedKey={selectedKey}
            todayKey={todayKey}
            legend={legend}
            onSelectDay={(key) => selectDay(key)}
            onPrevMonth={() => changeMonth(-1)}
            onNextMonth={() => changeMonth(1)}
            onToday={goToday}
          />
          )}

          <div className="card tight">
            <div className="sec-h">
              <h2>{dayTitle}</h2>
              <span className="note">{visibleTasks.length}</span>
            </div>
            {mutationNote}
            {loadingState}
            <div className="list">
              {visibleTasks.map((task) => (
                <MobileTaskCard
                  key={task.id}
                  task={task}
                  overdue={selected.mode === "overdue"}
                  rightLabel={
                    selected.mode === "overdue"
                      ? // У просроченной время дня уже не важно, важна дата.
                        dushanbeDate(task.nextActionDate!, { day: "numeric", month: "short" })
                      : dushanbeTime(task.nextActionDate!)
                  }
                  call={taskCall(task)}
                  {...taskHandlers(task)}
                />
              ))}
            </div>
            {visibleTasks.length === 0 && !isLoading && (
              <div className="empty">
                <span className="ic">
                  <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="5" width="18" height="16" rx="3" />
                    <path d="M8 3v4M16 3v4M3 11h18" />
                  </svg>
                </span>
                <p>На этот день ничего не назначено.</p>
              </div>
            )}
            {/* ЕДИНСТВЕННАЯ КНОПКА НАЗНАЧЕНИЯ — ЗДЕСЬ (21.09.2026). Раньше их
                было две и в разных местах: значок «плюс» в шапке (убран) и эта
                же кнопка, но только когда день пуст, — то есть в занятый день
                назначить с календаря было нельзя вовсе. Теперь одна, всегда, с
                подписью, куда она ведёт: своей формы показа у календаря нет,
                показ заводится из карточки клиента. */}
            <button
              className="pill ghost"
              type="button"
              style={{ marginTop: "var(--s3)" }}
              onClick={() => navigate("/clients")}
            >
              Назначить показ — выбрать клиента
            </button>
          </div>

          {upcomingOther.length > 0 && (
            <div className="card tight">
              <div className="sec-h">
                <h2>Ближайшие</h2>
                <span className="note">{upcomingOther.length}</span>
              </div>
              <div className="list">
                {/* Перенос и отмена живут только в списке выбранного дня: агент не
                    должен править встречу, которую сейчас не смотрит. */}
                {upcomingOther.map((task) => (
                  <MobileTaskCard
                    key={task.id}
                    task={task}
                    rightLabel={dushanbeDate(task.nextActionDate!, { day: "numeric", month: "short" })}
                    onOpen={() => task.client?.shortId && navigate(`/clients/${task.client.shortId}`)}
                    onComplete={() => complete.mutate(task.id)}
                    call={taskCall(task)}
                  />
                ))}
              </div>
            </div>
          )}

          {cancelDialog}
          </div>
        </div>
      </div>
    );
  }

  // ---------- Десктоп ----------
  return (
    <div className={clean ? "rh2 screens clean-calendar-page" : "rh2 screens"}>
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Календарь</h1>
            <p className="sub">
              Сегодня {todayCount}, за 7 дней {thisWeekCount}
              {overdueTasks.length > 0 ? `, просрочено ${overdueTasks.length}` : ""}. Нажатие по дню открывает его
              список.
            </p>
          </div>
          <div className="acts">
            <div className="seg" role="tablist" aria-label="Вид календаря">
              <button type="button" role="tab" aria-selected={view === "day"} onClick={() => setView("day")}>
                День
              </button>
              <button type="button" role="tab" aria-selected={view === "week"} onClick={() => setView("week")}>
                Неделя
              </button>
              <button type="button" role="tab" aria-selected={view === "month"} onClick={() => setView("month")}>
                Месяц
              </button>
            </div>
            {/* Показ в CRM назначается из карточки клиента (AddInteractionModal),
                своей формы у календаря нет — кнопка ведёт к выбору клиента, как на
                узком экране. */}
            <button className="pill" type="button" onClick={() => navigate("/clients")}>
              <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Назначить показ
            </button>
          </div>
        </div>

        {overdueQuiet}
        {errorState}

        {/* Сетка месяца и панель дня — в одном ряду на широком экране (`.cols2`,
            theme-royal-home-2026.css). Раньше они шли друг под другом, и на
            мониторе 1440 половина ряда пустовала, а до списка дня приходилось
            прокручивать весь месяц. При виде «Неделя» в обёртке остаётся один
            блок — таблица, ей нужна вся ширина (`cols2-wide`); при виде «День»
            тоже один, и auto-fit сам отдаёт ему всю ширину. Ниже 1280 px
            обёртка — обычный блок, порядок прежний. */}
        <div className="cols2 cols2-side">
        {view === "month" && (
          <div className="card">
            <div className="sec-h">
              <h2>
                {MONTH_NAMES[viewDate.getMonth()]} {viewDate.getFullYear()}
              </h2>
              {legend}
            </div>
            <div className="wrap" style={{ marginBottom: "var(--s3)" }}>
              <button className="pill ghost icon" type="button" aria-label="Предыдущий месяц" onClick={() => changeMonth(-1)}>
                <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
              <button className="pill ghost sm" type="button" onClick={goToday}>
                Сегодня
              </button>
              <button className="pill ghost icon" type="button" aria-label="Следующий месяц" onClick={() => changeMonth(1)}>
                <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </div>
            <div className="cal">
              {WEEKDAYS.map((w) => (
                <span className="hd" key={w}>
                  {w}
                </span>
              ))}
              {grid.map((d) => {
                const key = cellKey(d);
                const inMonth = d.getMonth() === viewDate.getMonth();
                const isToday = key === todayKey;
                const isSelected = selected.mode === "day" && key === selected.key;
                const dayTasks = tasksByDay.get(key) ?? [];
                const showings = dayTasks.filter((t) => t.type === "SHOWING").length;
                const others = dayTasks.length - showings;

                return (
                  <button
                    key={key}
                    type="button"
                    aria-current={isSelected ? "date" : undefined}
                    onClick={() => selectDay(key)}
                    className={`d${inMonth ? "" : " out"}${isToday ? " today" : ""}`}
                    // Выбранного дня в статичном макете нет (там нарисован один
                    // «сегодня»), а функция выбора обязана остаться видимой:
                    // заливаем клетку теми же токенами, что и активную пилюлю.
                    style={isSelected ? { background: "var(--pill)" } : undefined}
                  >
                    <span className="n" style={isSelected ? { color: "var(--pill-ink)" } : undefined}>
                      {d.getDate()}
                    </span>
                    {showings > 0 && <span className="ev">{showings === 1 ? "показ" : `${showings} показа`}</span>}
                    {others > 0 && <span className="ev task">{others === 1 ? "задача" : `${others} задачи`}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {view === "week" && (
          <div className="card cols2-wide">
            <div className="sec-h">
              <h2>
                с {weekRows[0].date.getDate()} по {weekRows[6].date.getDate()}{" "}
                {MONTH_NAMES[weekRows[6].date.getMonth()].toLowerCase()}
              </h2>
              <span className="note">
                {weekRows.reduce((n, r) => n + r.showings.length, 0)} показов,{" "}
                {weekRows.reduce((n, r) => n + r.others.length, 0)} задач
              </span>
              <WeekNav onPrev={() => shiftWeek(-1)} onNext={() => shiftWeek(1)} onToday={goToday} />
            </div>
            <div className="tbl-wrap" {...scrollableRegion("Неделя: показы и задачи по дням")}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>День</th>
                    <th>Показы</th>
                    <th>Задачи</th>
                  </tr>
                </thead>
                <tbody>
                  {weekRows.map((row) => (
                    <tr key={row.key}>
                      <td>
                        {WEEKDAYS[(row.date.getDay() + 6) % 7]}, {row.date.getDate()}
                      </td>
                      <td>
                        {row.showings.length === 0
                          ? "пока пусто"
                          : row.showings
                              .map((t) => `${t.property?.title ?? "показ"} ${dushanbeTime(t.nextActionDate!)}`)
                              .join(", ")}
                      </td>
                      <td>{row.others.length === 0 ? "пока пусто" : row.others.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* КОЛОНКА «СВОБОДНЫХ ОКОН» УБРАНА (21.09.2026). Она стояла с
                прочерком во всех семи строках и с пояснением под таблицей, что
                данных нет и взяться им неоткуда: рабочего расписания агента в
                CRM не существует. Колонка-прочерк и абзац про неё занимали
                место и заставляли каждый раз перечитывать, почему там пусто.
                Появится расписание — вернётся и колонка. */}
          </div>
        )}

        {/* Панель дня — сама по себе при виде «День», и как раскрытие выбранной
            клетки при виде «Месяц» (эталон переключает панели целиком, у нас день
            остаётся под сеткой — теряется меньше кликов). При «Неделе» не нужна:
            там уже стоит таблица по дням. */}
        {view !== "week" && (
          // При виде «День» панель — единственный блок ряда, ей вся ширина;
          // при виде «Месяц» она правая половина пары (см. `.cols2-side`).
          <div className={view === "day" ? "card cols2-wide" : "card"}>
            <div className="sec-h">
              <h2>{dayTitle}</h2>
              <span className="note">{visibleTasks.length}</span>
            </div>
            {mutationNote}
            {loadingState}
            <div className="list">
              {visibleTasks.map((task) => (
                <TaskRow key={task.id} task={task} timeLabel={dushanbeTime(task.nextActionDate!)} call={taskCall(task)} {...taskHandlers(task)} />
              ))}
              {/* Пустой выбранный день — показываем ближайшие задачи вместо «ничего нет». */}
              {visibleTasks.length === 0 && !isLoading && selected.mode === "day" && upcomingTasks.length > 0 && (
                <>
                  <p className="state">На этот день задач нет, вот ближайшие.</p>
                  {upcomingTasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      // Список-подсказка: перенос и отмена живут в самом дне, иначе
                      // агент правит встречу, которую сейчас даже не смотрит.
                      timeLabel={dushanbeDate(task.nextActionDate!, { day: "numeric", month: "short" })}
                      onOpen={() => task.client?.shortId && navigate(`/clients/${task.client.shortId}`)}
                      onComplete={() => complete.mutate(task.id)}
                      call={taskCall(task)}
                    />
                  ))}
                </>
              )}
            </div>
            {visibleTasks.length === 0 && !isLoading && (selected.mode !== "day" || upcomingTasks.length === 0) && (
              <div className="empty">
                <span className="ic">
                  <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="5" width="18" height="16" rx="3" />
                    <path d="M8 3v4M16 3v4M3 11h18" />
                  </svg>
                </span>
                <p>На этот день ничего не назначено. Показ назначается из карточки клиента.</p>
                <button className="pill ghost" type="button" onClick={() => navigate("/clients")}>
                  Назначить показ
                </button>
              </div>
            )}
          </div>
        )}
        </div>

        {/* Отмена — действие, которое клиент увидит (встреча пропадёт), поэтому
            спрашиваем «точно?», а не снимаем показ по одному промаху пальцем.
            Сам диалог собран один раз выше (cancelDialog) — на оба облика. */}
        {cancelDialog}
      </div>
    </div>
  );
}

/**
 * Строка задачи в списке дня — `.row` эталона (screens/calendar.html, панель
 * «День»): чип времени слева, имя и подпись, чип подтверждения, решения одной
 * кнопкой в самой строке.
 *
 * Отдельным компонентом, потому что таких списков на экране два (выбранный день и
 * подсказка «ближайшие»), и раньше они были копией друг друга — плашка
 * подтверждения показа, добавленная в один, во втором отсутствовала.
 *
 * Перенос и отмена показа живут ЗДЕСЬ, а не в хронологии карточки клиента: в
 * карточке лента — это история, действия над будущим в ней читаются как правка
 * прошлого.
 */
function CleanCalendarShellTitle() {
  useShellClaim({ title: "Календарь", back: "/more" });
  return <h1 className="sr-only">Календарь</h1>;
}

function TaskRow({
  task,
  timeLabel,
  call,
  onOpen,
  onComplete,
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
  timeLabel: string;
  call?: ReactNode;
  onOpen: () => void;
  onComplete: () => void;
  /** Значение поля времени, если эту встречу сейчас переносят. null — форма закрыта. */
  rescheduleValue?: string | null;
  /** Причина переноса — обязательна на сервере (владелец 16.08.2026). */
  rescheduleReason?: string;
  onRescheduleStart?: () => void;
  onRescheduleChange?: (value: string) => void;
  onRescheduleReasonChange?: (value: string) => void;
  onRescheduleClose?: () => void;
  onRescheduleSubmit?: (value: string, reason: string) => void;
  onCancelStart?: () => void;
  busy?: boolean;
}) {
  // Подтвердил ли клиент показ — видно прямо в дне, по которому агент планирует
  // выезды. «Ждём подтверждения» здесь означает «позвони», а не «отменено»:
  // молчание клиента отказом не считается.
  const confirmation = showingConfirmationBadge(task);
  // Двигать и снимать можно только показ с назначенным временем: у задачи вида
  // «перезвонить в четверг» ни отмены, ни переноса в этом смысле нет.
  const isShowing = task.type === "SHOWING" && !!task.nextActionDate && !!onCancelStart;
  const typeLabel = INTERACTION_TYPE_LABELS[task.type] ?? "Задача";
  const clientName = task.client?.fullName ?? "Клиент";

  return (
    <Fragment>
      <div className="row" title={typeLabel}>
        <span className="chip mute" style={{ minWidth: "64px", justifyContent: "center" }}>
          {timeLabel}
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
          <button className="pill ghost sm" type="button" onClick={onComplete} title="Отметить выполненной">
            Сделано
          </button>
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
          {/* Причина переноса — обязательна (владелец 16.08.2026): без неё в
              карточке клиента остаётся только «было и стало», а не почему. */}
          <input
            className="inp"
            type="text"
            value={rescheduleReason ?? ""}
            onChange={(e) => onRescheduleReasonChange?.(e.target.value)}
            placeholder="Причина переноса (обязательно)"
            aria-label="Причина переноса"
          />
          <button
            className="pill sm"
            type="submit"
            disabled={busy || !rescheduleValue || (rescheduleReason ?? "").trim().length < 3}
          >
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
