/**
 * РАССТАНОВКА ПУБЛИКАЦИЙ ПО ВРЕМЕНИ (21.09.2026, владелец: «монтажёр отправит
 * 10 готовых роликов — пусть не идёт всё так быстро»).
 *
 * Раньше `receiveEditedVideo` ставила публикацию сразу на текущий момент —
 * пачка из десяти принятых роликов уходила в соцсети практически одним залпом.
 * Здесь — чистая арифметика следующего слота, без похода в БД: тот же приём,
 * что и у `planStorySegments` (lib/instagramStories.ts), проверяется без сети
 * и без времени выполнения теста.
 *
 * СЕТКА ЖИВЁТ В НАСТРОЙКАХ, А ЧАСЫ — В ТЕПЛОВОЙ КАРТЕ (23.09.2026, владелец:
 * «чтобы ролики уже по расписанию выходили по карте», и чтобы этим управлял он
 * сам). Числа ниже остались ровно теми же, но теперь это ДЕФОЛТЫ полей
 * `Settings.publishSchedule*`, а приоритетные часы по умолчанию берутся из
 * реальных обращений клиентов (`lib/audienceHeatmap.ts`), а не из постоянных
 * окон. Постоянные окна — запасной вариант: карта может быть пуста (новый
 * аккаунт, мало событий), и тогда расстановка честно говорит об этом в причине
 * слота, а не делает вид, что посчитала по данным.
 *
 * КАЖДЫЙ СЛОТ ОБЪЯСНЯЕТ СЕБЯ. `nextPublishSlot` возвращает не только время, но
 * и человеческую причину — её видно в карточке объекта и в разделе
 * «Расписание» кабинета маркетинга. Без неё «почему этот ролик выйдет завтра в
 * 12:40» не восстановить никак, а спрашивают об этом первым делом.
 */
import { DUSHANBE_OFFSET_MS } from "./dushanbeTime.js";

/** Начало и конец рабочего окна публикаций, минуты от полуночи по Душанбе. */
export const PUBLISH_WINDOW_START_MIN = 9 * 60;
export const PUBLISH_WINDOW_END_MIN = 21 * 60;
/** Минимальный промежуток между двумя публикациями. */
export const MIN_GAP_MIN = 90;
/** Приоритетные часы — куда садится первая публикация свежей пачки, минуты от полуночи. */
export const PRIORITY_WINDOWS_MIN: readonly [number, number][] = [
  [12 * 60, 14 * 60],
  [19 * 60, 21 * 60],
];

const DAY_MIN = 24 * 60;

/** Минуты от полуночи по Душанбе для момента `at`. */
function dushanbeMinutesOfDay(at: Date): number {
  const wall = new Date(at.getTime() + DUSHANBE_OFFSET_MS);
  return wall.getUTCHours() * 60 + wall.getUTCMinutes();
}

/** Начало суток по Душанбе, которым принадлежит `at`, как момент времени. */
function dushanbeStartOfDay(at: Date): Date {
  const wall = new Date(at.getTime() + DUSHANBE_OFFSET_MS);
  const startWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  return new Date(startWall - DUSHANBE_OFFSET_MS);
}

/** Правила расстановки — то, что приходит из `Settings.publishSchedule*`. */
export interface PublishScheduleRules {
  /** Расставлять вообще. Выключено — публикуем сразу по приёму ролика. */
  enabled: boolean;
  windowStartMin: number;
  windowEndMin: number;
  minGapMin: number;
  /**
   * Приоритетные часы (минуты от полуночи), куда метит первая публикация
   * свежей пачки. Отрезки "начало-конец", уже отсортированные.
   */
  priorityWindows: readonly (readonly [number, number])[];
  /**
   * Свои приоритетные окна на каждый день недели (индекс 0 — воскресенье, как
   * getUTCDay по часам Душанбе). Есть только у статистики Instagram: она мерит
   * каждый день отдельно, и пик воскресенья (18–23) — не пик вторника (18–21).
   * Дня нет в списке или он пуст — берутся общие `priorityWindows`.
   */
  priorityWindowsByDow?: readonly (readonly (readonly [number, number])[] | undefined)[];
  /**
   * Вес каждого часа суток (24 числа) — насколько живая аудитория, если ролик
   * выйдет в этот час (уже со сдвигом «за N часов до пика»). По нему выбирается
   * ЛУЧШИЙ свободный час, когда живые часы заняты. Нет — все часы равны.
   */
  hourWeights?: readonly number[];
  /** То же по дням недели (индекс 0 — воскресенье), у статистики Instagram. */
  hourWeightsByDow?: readonly (readonly number[] | undefined)[];
  /** Откуда взялись приоритетные часы — только для объяснения слота:
   *  карта наших обращений, статистика Instagram «подписчики в сети» или
   *  постоянные окна из Настроек. */
  prioritySource: "heatmap" | "instagram" | "fixed";
}

/** Слот и человеческая причина, почему он такой. */
export interface PublishSlot {
  at: Date;
  reason: string;
}

export const DEFAULT_PUBLISH_SCHEDULE_RULES: PublishScheduleRules = {
  enabled: true,
  windowStartMin: PUBLISH_WINDOW_START_MIN,
  windowEndMin: PUBLISH_WINDOW_END_MIN,
  minGapMin: MIN_GAP_MIN,
  priorityWindows: PRIORITY_WINDOWS_MIN,
  prioritySource: "fixed",
};

/**
 * СКОЛЬКО СОБЫТИЙ ДЕЛАЮТ КАРТУ ПРИГОДНОЙ ДЛЯ РАССТАНОВКИ.
 *
 * На двух десятках обращений «час пик» — это шум: одна активная переписка
 * сдвинет всю сетку публикаций агентства. Порог низкий (агентство небольшое,
 * ждать тысяч событий нельзя), но он есть, и ниже него расстановка честно
 * падает на постоянные окна и пишет об этом в причине слота.
 */
export const HEATMAP_MIN_EVENTS = 200;

/**
 * СКОЛЬКО СУТОК СТАТИСТИКИ INSTAGRAM НУЖНО, ЧТОБЫ ЕЙ ВЕРИТЬ. Неделя — чтобы в
 * карте был каждый день недели хотя бы раз: по двум суткам «час пик» — это
 * час пик одного вторника. Меньше недели — часы берутся из наших обращений.
 */
export const INSTAGRAM_ONLINE_MIN_DAYS = 7;

/** Часы (0-23) в отрезки минут: час пик 19 — это окно 19:00-20:00. */
export function priorityWindowsFromHours(hours: readonly number[]): [number, number][] {
  return [...new Set(hours)]
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    .sort((a, b) => a - b)
    .map((h) => [h * 60, (h + 1) * 60] as [number, number]);
}

/** «12:40» из минут от полуночи — для причины слота. */
function hhmm(minutesOfDay: number): string {
  const h = Math.floor(minutesOfDay / 60) % 24;
  const m = minutesOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** День недели суток Душанбе, начинающихся в `dayStart` (0 — воскресенье). */
function dushanbeDow(dayStart: Date): number {
  return new Date(dayStart.getTime() + DUSHANBE_OFFSET_MS).getUTCDay();
}

/**
 * Приоритетные окна конкретных суток, обрезанные рабочим окном: пик в 22:00
 * при окне до 21:00 — не слот, а ночная публикация, которую окно и запрещает.
 */
function windowsForDay(rules: PublishScheduleRules, dayStart: Date): [number, number][] {
  const own = rules.priorityWindowsByDow?.[dushanbeDow(dayStart)];
  const source = own && own.length > 0 ? own : rules.priorityWindows;
  return source
    .map(([a, b]) => [Math.max(a, rules.windowStartMin), Math.min(b, rules.windowEndMin)] as [number, number])
    .filter(([a, b]) => a < b)
    .sort((x, y) => x[0] - y[0]);
}

/** То же во множественном числе: «сегодня … уже прошли». */
function prioritySourcePluralText(rules: PublishScheduleRules): string {
  if (rules.prioritySource === "heatmap") return "часы пик по карте активности";
  if (rules.prioritySource === "instagram") return "часы, когда подписчики Instagram в сети,";
  return "приоритетные часы из настроек";
}

/** Откуда взялись приоритетные часы, словами для причины слота. */
function prioritySourceText(rules: PublishScheduleRules): string {
  if (rules.prioritySource === "heatmap") return "час пик по карте активности";
  if (rules.prioritySource === "instagram") return "час, когда подписчики Instagram в сети";
  return "приоритетный час из настроек";
}

/** Шаг сетки кандидатов внутри дня. */
const GRID_MIN = 15;

/** Максимум роликов в день при этих окне и промежутке — для экрана «Расписание». */
export function dailyPublishCapacity(rules: Pick<PublishScheduleRules, "windowStartMin" | "windowEndMin" | "minGapMin">): number {
  const span = rules.windowEndMin - rules.windowStartMin;
  if (span <= 0) return 0;
  return Math.floor((span - 1) / Math.max(1, rules.minGapMin)) + 1;
}

interface Candidate {
  at: Date;
  minuteOfDay: number;
  live: boolean;
  weight: number;
}

/** Лучший кандидат: самый живой, при равенстве — самый ранний. */
function best(list: Candidate[]): Candidate | null {
  let top: Candidate | null = null;
  for (const c of list) {
    if (!top || c.weight > top.weight || (c.weight === top.weight && c.at.getTime() < top.at.getTime())) top = c;
  }
  return top;
}

/**
 * Следующий свободный слот публикации и причина, почему он такой.
 *
 * `now` — момент, раньше которого публиковать нельзя (обычно факт приёма
 * ролика от монтажёра). `occupied` — уже расставленные публикации (одна или
 * список): новый слот обязан отстоять от КАЖДОЙ не меньше чем на промежуток.
 * Давние публикации ничего не держат.
 *
 * ЛУЧШИЕ ЧАСЫ — ПЕРВЫМИ (24.09.2026, владелец: «чтобы мы всегда попадали к
 * своей аудитории», и «у нас может выйти по 10 роликов в день», но «чтобы не
 * было ограничений таких жёстких»). До этого дня в приоритетный час метила только
 * ПЕРВАЯ публикация пачки, а остальные шли подряд через промежуток — третий
 * ролик вечера уезжал на завтрашнее 09:00, самый пустой час. Теперь по порядку:
 *
 *   1. свободный живой час сегодня (приоритетное окно, у статистики Instagram —
 *      своё на каждый день недели), самый живой из свободных;
 *   2. живые часы прошли или заняты — самый активный из свободных часов
 *      СЕГОДНЯ. Ролик не ждёт завтрашнего пика, пока сегодня есть место
 *      (владелец, 24.09.2026: «чтобы не было ограничений таких жёстких»);
 *   3. сегодня места нет совсем — следующие дни, сначала живые часы.
 *
 * Слот вне рабочего окна не ставится никогда: ночная публикация статистически
 * мертва. Кому ждать некогда — кнопка «Опубликовать сейчас» в очереди.
 */
export function nextPublishSlot(
  now: Date,
  occupied: Date | readonly Date[] | null,
  rules: PublishScheduleRules = DEFAULT_PUBLISH_SCHEDULE_RULES
): PublishSlot {
  if (!rules.enabled) {
    return { at: now, reason: "Расписание публикаций выключено в настройках — ролик выходит сразу по приёму." };
  }

  const gapMs = rules.minGapMin * 60_000;
  // Держат очередь только публикации ближе промежутка к «сейчас» или впереди:
  // от вчерашней отступать нельзя — это давало слот в прошлом.
  const occ = (occupied === null ? [] : Array.isArray(occupied) ? occupied : [occupied as Date])
    .map((o) => o.getTime())
    .filter((t) => t + gapMs > now.getTime());
  const isFree = (t: number) => t >= now.getTime() && occ.every((o) => Math.abs(t - o) >= gapMs);

  const firstDay = dushanbeStartOfDay(now);
  const source = prioritySourceText(rules);

  const candidatesOf = (dayIndex: number): Candidate[] => {
    const dayStart = new Date(firstDay.getTime() + dayIndex * DAY_MIN * 60_000);
    const dayEnd = dayStart.getTime() + DAY_MIN * 60_000;
    const windows = windowsForDay(rules, dayStart);
    const weights = rules.hourWeightsByDow?.[dushanbeDow(dayStart)] ?? rules.hourWeights;
    const times = new Set<number>();
    for (let m = rules.windowStartMin; m < rules.windowEndMin; m += GRID_MIN) times.add(dayStart.getTime() + m * 60_000);
    // Сам момент приёма и «сразу после соседней публикации» — чтобы не терять
    // минуты между клетками сетки: ролик в 13:07 внутри окна выходит в 13:07.
    times.add(now.getTime());
    for (const o of occ) times.add(o + gapMs);
    const out: Candidate[] = [];
    for (const t of times) {
      if (t < dayStart.getTime() || t >= dayEnd || !isFree(t)) continue;
      const minuteOfDay = Math.round((t - dayStart.getTime()) / 60_000);
      if (minuteOfDay < rules.windowStartMin || minuteOfDay >= rules.windowEndMin) continue;
      const live = windows.some(([a, b]) => minuteOfDay >= a && minuteOfDay < b);
      out.push({ at: new Date(t), minuteOfDay, live, weight: (live ? 1_000_000 : 0) + (weights?.[Math.floor(minuteOfDay / 60)] ?? 0) });
    }
    return out;
  };

  const today = candidatesOf(0);
  const todayLive = best(today.filter((c) => c.live));
  if (todayLive) {
    return {
      at: todayLive.at,
      reason:
        todayLive.at.getTime() === now.getTime()
          ? `Сейчас ${source} — выходит без задержки.`
          : dushanbeMinutesOfDay(now) < rules.windowStartMin
            ? `Ролик принят до открытия окна публикаций (${hhmm(rules.windowStartMin)}) — ближайший свободный ${source}, ${hhmm(todayLive.minuteOfDay)}.`
            : `Ближайший свободный ${source} — ${hhmm(todayLive.minuteOfDay)}.`,
    };
  }
  const todayAny = best(today);
  if (todayAny) {
    const anyLiveAtAll = [0, 1, 2, 3, 4, 5, 6].some(
      (i) => windowsForDay(rules, new Date(firstDay.getTime() + i * DAY_MIN * 60_000)).length > 0
    );
    return {
      at: todayAny.at,
      reason: !anyLiveAtAll
        ? todayAny.at.getTime() === now.getTime()
          ? "Приоритетных часов нет — выходит в окне публикаций без задержки."
          : `Выходит в ${hhmm(todayAny.minuteOfDay)} — ближайший свободный момент в окне публикаций.`
        : `Сегодня ${prioritySourcePluralText(rules)} уже прошли или заняты — выходит сегодня в ${hhmm(todayAny.minuteOfDay)}, в самый активный из свободных часов.`,
    };
  }
  for (let i = 1; i < 14; i++) {
    const list = candidatesOf(i);
    const pick = best(list.filter((c) => c.live)) ?? best(list);
    if (pick) {
      return {
        at: pick.at,
        reason: pick.live
          ? `Сегодня свободного времени в окне публикаций не осталось — ${dayWord(i)}, ${hhmm(pick.minuteOfDay)} (${source}).`
          : `Окно публикаций на сегодня закрылось (${hhmm(rules.windowEndMin)}) — перенесено на ${dayWord(i)}, ${hhmm(pick.minuteOfDay)}: ночью пост не увидят.`,
      };
    }
  }

  // Сюда не дойти при любом непустом рабочем окне. Но слот обязан быть.
  return { at: now, reason: "Подходящего часа на две недели вперёд не нашлось — выходит сразу." };
}

/** «завтра», «послезавтра», «через 3 дня» — для причины слота. */
function dayWord(daysAhead: number): string {
  if (daysAhead === 1) return "завтра";
  if (daysAhead === 2) return "послезавтра";
  return `через ${daysAhead} ${daysAhead < 5 ? "дня" : "дней"}`;
}
