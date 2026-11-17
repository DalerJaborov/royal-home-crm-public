/**
 * ПРАВИЛА РАССТАНОВКИ ПУБЛИКАЦИЙ — ИЗ НАСТРОЕК И ИЗ ТЕПЛОВОЙ КАРТЫ (23.09.2026,
 * владелец: «чтобы ролики уже по расписанию выходили по карте», и чтобы этим
 * можно было управлять самому).
 *
 * Отдельный файл, потому что `lib/publishSchedule.ts` — чистая арифметика без
 * базы (её и проверяет тест, без сети и без времени выполнения). Всё, что
 * ходит в Postgres, живёт здесь: поля `Settings.publishSchedule*` и часы пик из
 * `lib/audienceHeatmap.ts`.
 *
 * ОДНА ТОЧКА ПРАВДЫ. И расстановка при приёме ролика (`lib/videoHandoff.ts`), и
 * раздел «Расписание» в кабинете маркетинга (`routes/marketing.ts`) берут
 * правила ОТСЮДА. Копии этой логики не заводить: расхождение между тем, как
 * слот считается, и тем, как он объясняется на экране, — ровно тот класс
 * «одно правило написано дважды», за которым в этом репозитории уже ходили.
 */
import { prisma } from "../db.js";
import { PUBLISH_SCHEDULE_TUNING } from "./settingsConstants.js";
import { logSystemError } from "./systemError.js";
import {
  instagramOnlineDaysCollected,
  loadHeatmapCells,
  summarizeHeatmap,
} from "./audienceHeatmap.js";
import {
  DEFAULT_PUBLISH_SCHEDULE_RULES,
  HEATMAP_MIN_EVENTS,
  INSTAGRAM_ONLINE_MIN_DAYS,
  priorityWindowsFromHours,
  type PublishScheduleRules,
} from "./publishSchedule.js";

export interface LoadedPublishScheduleRules {
  rules: PublishScheduleRules;
  /** Часы (0-23), в которые метит первая публикация пачки — для экрана. */
  priorityHours: number[];
  /** Сколько событий легло в основу карты; 0 — карту не спрашивали или она пуста. */
  heatmapEvents: number;
  /** Карта включена в настройках, но данных мало — считаем по постоянным окнам. */
  heatmapTooSparse: boolean;
  /** За сколько дней считалась карта. */
  heatmapDays: number;
  /** Тумблер «часы по статистике Instagram» включён в Настройках И действует —
   *  то есть включена и сама тепловая карта (иначе он ни на что не влияет). */
  instagramOnlineEnabled: boolean;
  /** Сколько суток статистики Instagram собрано в окне карты. */
  instagramOnlineDays: number;
  /** Свои часы выхода на каждый день недели (0 — воскресенье), только у
   *  статистики Instagram; у остальных источников — null. */
  priorityHoursByDow: number[][] | null;
}

/**
 * Прочитать правила. Отказ тепловой карты — не отказ расстановки: карта здесь
 * улучшение, а не условие, поэтому при любой её беде (пустая база, ошибка
 * запроса) остаются постоянные окна из настроек, и это видно в ответе.
 */
/**
 * Вес часа ВЫХОДА: активность часа, наступающего через `leadHours` после
 * него (публикуем заранее, чтобы пост успел разойтись к пику). По весу
 * расстановка выбирает лучший свободный час, когда живые часы заняты.
 */
export function hourWeightsFromCells(cells: { hour: number; count: number }[], leadHours: number): number[] {
  const byHour = new Array<number>(24).fill(0);
  for (const c of cells) byHour[c.hour] += c.count;
  return byHour.map((_, h) => byHour[(h + leadHours) % 24]);
}

export async function loadPublishScheduleRules(): Promise<LoadedPublishScheduleRules> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      publishScheduleEnabled: true,
      publishScheduleWindowStartMin: true,
      publishScheduleWindowEndMin: true,
      publishScheduleMinGapMin: true,
    },
  });

  const d = DEFAULT_PUBLISH_SCHEDULE_RULES;
  const enabled = settings?.publishScheduleEnabled ?? d.enabled;
  const windowStartMin = settings?.publishScheduleWindowStartMin ?? d.windowStartMin;
  const windowEndMin = settings?.publishScheduleWindowEndMin ?? d.windowEndMin;
  const minGapMin = settings?.publishScheduleMinGapMin ?? d.minGapMin;
  // Источник часов, окна, глубина карты и опережение — константы с 01.11.2026
  // (lib/settingsConstants.ts, значения прода); колонки Settings не читаются.
  const tuning = PUBLISH_SCHEDULE_TUNING;
  const heatmapDays = tuning.heatmapDays;
  const leadHours = tuning.leadHours;
  const instagramOnlineEnabled = tuning.useHeatmap && tuning.useInstagramOnline;
  let instagramOnlineDays = 0;

  // Постоянные окна хранятся плоским списком пар — разворачиваем и отбрасываем
  // мусор: настройка правится человеком, и нечётный хвост здесь не должен
  // валить расстановку.
  const flat = tuning.priorityWindows;
  const fixedWindows: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (flat[i] < flat[i + 1]) fixedWindows.push([flat[i], flat[i + 1]]);
  }
  const fixed = fixedWindows.length > 0 ? fixedWindows : [...d.priorityWindows];

  const base = { enabled, windowStartMin, windowEndMin, minGapMin };
  const asFixed = (heatmapEvents: number, tooSparse: boolean): LoadedPublishScheduleRules => ({
    rules: { ...base, priorityWindows: fixed, prioritySource: "fixed" },
    priorityHours: fixed.map(([start]) => Math.floor(start / 60)),
    heatmapEvents,
    heatmapTooSparse: tooSparse,
    heatmapDays,
    instagramOnlineEnabled,
    instagramOnlineDays,
    priorityHoursByDow: null,
  });

  // Карта как источник часов выключена (константа, как было на проде) —
  // расстановка идёт по постоянным окнам.
  if (!tuning.useHeatmap) return asFixed(0, false);

  try {
    // ПРЯМОЙ ИСТОЧНИК ПЕРВЫМ: статистика самого Instagram — сколько наших
    // подписчиков в сети в каждый час. Ей верим только с недели сбора
    // (INSTAGRAM_ONLINE_MIN_DAYS); до того — наши обращения, как раньше.
    if (instagramOnlineEnabled) {
      instagramOnlineDays = await instagramOnlineDaysCollected(heatmapDays);
      if (instagramOnlineDays >= INSTAGRAM_ONLINE_MIN_DAYS) {
        const onlineCells = await loadHeatmapCells({ signal: "followers", channel: "ALL", days: heatmapDays });
        const online = summarizeHeatmap(onlineCells, leadHours);
        if (online.publishHours.length > 0) {
          // У статистики Instagram каждый день недели свой: пик воскресенья
          // (18–23) — не пик вторника (18–21). Окна и веса — на каждый день.
          const byDow = [0, 1, 2, 3, 4, 5, 6].map((dow) => onlineCells.filter((c) => c.dow === dow));
          return {
            rules: {
              ...base,
              priorityWindows: priorityWindowsFromHours(online.publishHours),
              priorityWindowsByDow: byDow.map((cells) => priorityWindowsFromHours(summarizeHeatmap(cells, leadHours).publishHours)),
              hourWeights: hourWeightsFromCells(onlineCells, leadHours),
              hourWeightsByDow: byDow.map((cells) => (cells.length > 0 ? hourWeightsFromCells(cells, leadHours) : undefined)),
              prioritySource: "instagram",
            },
            priorityHours: online.publishHours,
            heatmapEvents: 0,
            heatmapTooSparse: false,
            heatmapDays,
            instagramOnlineEnabled,
            instagramOnlineDays,
            priorityHoursByDow: byDow.map((cells) => summarizeHeatmap(cells, leadHours).publishHours),
          };
        }
      }
    }

    // Тот же сигнал и канал, что показывает блок «Когда аудитория активна» без
    // фильтров: расписание должно совпадать с тем, что владелец видит глазами.
    const cells = await loadHeatmapCells({ signal: "all", channel: "ALL", days: heatmapDays });
    const summary = summarizeHeatmap(cells, leadHours);
    if (summary.total < HEATMAP_MIN_EVENTS || summary.publishHours.length === 0) {
      return asFixed(summary.total, summary.total > 0);
    }
    const windows = priorityWindowsFromHours(summary.publishHours);
    return {
      rules: { ...base, priorityWindows: windows, hourWeights: hourWeightsFromCells(cells, leadHours), prioritySource: "heatmap" },
      priorityHours: summary.publishHours,
      heatmapEvents: summary.total,
      heatmapTooSparse: false,
      heatmapDays,
      instagramOnlineEnabled,
      instagramOnlineDays,
      priorityHoursByDow: null,
    };
  } catch (err) {
    // Карта не посчиталась — расстановка обязана продолжать работать. Но молча
    // уходить на постоянные окна нельзя: ролики поедут не в те часы, а на
    // экране «Расписание» это выглядело бы как «карта ещё пустая».
    void logSystemError(
      "video-handoff",
      `Тепловая карта для расписания роликов не посчиталась, ролики идут по постоянным часам: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { dedupKey: "publish-schedule-heatmap-failed" }
    );
    return asFixed(0, false);
  }
}

/**
 * Параметры совета под картой на /sources («публиковать в …»). Берутся из тех
 * же полей Настроек, что и расстановка выше: до 23.09.2026 экран считал всегда
 * за 90 дней и «за час до всплеска», а расписание — по Настройкам, и после
 * правки любого из двух чисел совет под картой и настоящие часы выхода роликов
 * молча расходились.
 */
export async function loadHeatmapAdviceSettings(): Promise<{ days: number; leadHours: number }> {
  // Те же константы, что у расстановки (с 01.11.2026, lib/settingsConstants.ts).
  return { days: PUBLISH_SCHEDULE_TUNING.heatmapDays, leadHours: PUBLISH_SCHEDULE_TUNING.leadHours };
}
