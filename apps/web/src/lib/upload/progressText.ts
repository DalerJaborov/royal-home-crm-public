import { computeSpeedBps, formatEtaSeconds, formatSpeedBps, formatUploadSize, type ProgressSample } from "../uploadFormat";
import type { ReadFailReason } from "./readProbe";

/**
 * ОДНА СТРОКА ПРОГРЕССА НА ВСЕ ЗАГРУЗКИ (25.11.2026, владелец: «человек ВСЕГДА видит
 * сколько МБ из скольки, скорость, оставшееся время, что случилось и ПОЧЕМУ»).
 *
 * До этого лучшей была строка очереди карточки (UploadTaskRow), у мастера — проценты и МБ,
 * у короткого ролика, монтажёра, чата и соцсетей — только «N %». Здесь — чистые функции
 * (тестируются без браузера), рисует их components/UploadProgressLine.tsx.
 */

/**
 * preparing — проверяем/готовим файл; uploading — байты идут; processing — всё ушло,
 * сервер собирает/сжимает; waiting-online — нет интернета, ждём; waiting-retry — пауза
 * перед повтором; failed — остановились, нужен человек; done — готово.
 */
export type UploadPhase = "preparing" | "uploading" | "processing" | "waiting-online" | "waiting-retry" | "failed" | "done";

export interface UploadLive {
  phase: UploadPhase;
  loaded: number;
  total: number;
  /** Причина паузы или отказа — уже человеческими словами. */
  error?: string | null;
  /** Когда следующая попытка (waiting-retry). */
  nextAttemptAt?: number | null;
}

export const IDLE_UPLOAD: UploadLive = { phase: "preparing", loaded: 0, total: 0 };

/** «42,1 МБ из 271 МБ». */
export function formatLoadedOfTotal(loaded: number, total: number): string {
  return `${formatUploadSize(Math.max(0, Math.min(loaded, total || loaded)))} из ${formatUploadSize(Math.max(0, total))}`;
}

function secondsUntil(ts: number, now: number): number {
  return Math.max(1, Math.ceil((ts - now) / 1000));
}

/**
 * Текст строки. `speedBps` — скользящая скорость (null, пока не набралась).
 * Примеры: «42,1 МБ из 271 МБ · 1,2 МБ/с · осталось ~3 мин»,
 * «Нет интернета — продолжим сами, когда появится связь · ушло 42,1 МБ из 271 МБ».
 */
export function formatUploadLive(live: UploadLive, speedBps: number | null, now: number = Date.now()): string {
  const fraction = formatLoadedOfTotal(live.loaded, live.total);
  switch (live.phase) {
    case "preparing":
      return live.total > 0 ? `${formatUploadSize(live.total)} · готовим файл…` : "Готовим файл…";
    case "uploading": {
      if (speedBps == null || speedBps <= 0) return `${fraction} · считаем скорость…`;
      const eta = formatEtaSeconds(Math.max(0, live.total - live.loaded) / speedBps);
      return `${fraction} · ${formatSpeedBps(speedBps)} · осталось ${eta}`;
    }
    case "processing":
      return `${formatUploadSize(live.total)} ушло целиком — сервер обрабатывает файл…`;
    case "waiting-online":
      return `${live.error || OFFLINE_TEXT} · ушло ${fraction}`;
    case "waiting-retry": {
      const when = live.nextAttemptAt ? ` · повтор через ${secondsUntil(live.nextAttemptAt, now)} с` : "";
      return `${live.error || "Связь прервалась"}${when} · ушло ${fraction}`;
    }
    case "failed":
      return live.error || "Не загрузилось. Нажмите «Повторить».";
    case "done":
      return `${formatUploadSize(live.total)} — загружено`;
  }
}

/** Процент для полосы (0..100). У «обрабатывает» и «готово» полоса полная. */
export function livePercent(live: UploadLive): number {
  if (live.phase === "processing" || live.phase === "done") return 100;
  if (live.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((live.loaded / live.total) * 100)));
}

/** Скользящая скорость по точкам прогресса (тот же расчёт, что у очереди карточки). */
export function createSpeedMeter() {
  let samples: ProgressSample[] = [];
  return {
    push(loaded: number, t: number = Date.now()) {
      const last = samples[samples.length - 1];
      // Байты пошли назад (новый заход с середины) — старая история скорости не про этот заход.
      if (last && loaded < last.loaded) samples = [];
      samples.push({ t, loaded });
      if (samples.length > 200) samples = samples.slice(-100);
    },
    speed(now: number = Date.now()): number | null {
      return computeSpeedBps(samples, now);
    },
    reset() {
      samples = [];
    },
  };
}

// ─────────────────────────── почему остановилось — словами ───────────────────────────

export const OFFLINE_TEXT = "Нет интернета — продолжим сами, когда появится связь";

/**
 * Отчего запрос кончился без ответа сервера (статус 0). Раньше всё это было одним
 * «Нет связи», и по журналу нельзя было отличить свёрнутое приложение от мёртвого канала.
 */
export type ZeroCause = "network" | "stall" | "abort" | "deadline" | "session-changed" | "offline" | "unreadable";

export function zeroCauseMessage(cause: ZeroCause | undefined): string {
  switch (cause) {
    case "offline":
      return OFFLINE_TEXT;
    case "stall":
      return "Связь замолчала больше минуты — пробуем ещё раз";
    case "abort":
      return "Отправку оборвал телефон (свернули приложение или сменилась сеть) — продолжим сами";
    case "deadline":
      return "Сервер не ответил вовремя — пробуем ещё раз";
    case "session-changed":
      return "Вошёл другой сотрудник — файл уйдёт, когда войдёт его автор";
    case "unreadable":
      return "Телефон не отдаёт файл";
    case "network":
    default:
      return "Нет связи с сервером — пробуем ещё раз";
  }
}

/** Короткая метка причины для журнала (латиница не нужна — отчёт читает директор). */
export function zeroCauseLabel(cause: ZeroCause | undefined): string {
  switch (cause) {
    case "offline":
      return "нет сети";
    case "stall":
      return "тишина в канале";
    case "abort":
      return "обрыв браузером";
    case "deadline":
      return "предел ожидания";
    case "session-changed":
      return "сменился сотрудник";
    case "unreadable":
      return "файл не читается";
    case "network":
      return "сеть";
    default:
      return "неизвестно";
  }
}

/**
 * Окончательный отказ после всех автоматических попыток — текст ПО ПРИЧИНЕ (находка 13):
 * раньше и обрыв сети, и 502 сервера заканчивались словами «файл мог повредиться при
 * сохранении», хотя файл был цел и виновата была сеть.
 */
export function giveUpMessage(status: number, attempts: number, cause?: ZeroCause): string {
  if (status === 0) {
    if (cause === "session-changed") return zeroCauseMessage(cause);
    return `Связь так и не наладилась (${attempts} попыток). Проверьте интернет и нажмите «Повторить» — уже ушедшие части второй раз не грузятся.`;
  }
  if (status === 429) return `Сервер просит подождать (${attempts} попыток). Нажмите «Повторить» через пару минут.`;
  if (status >= 500) return `Сервер не принял файл ${attempts} раз подряд. Нажмите «Повторить» через пару минут — о сбое мы уже знаем.`;
  return `Не ушло за ${attempts} попыток. Нажмите «Повторить».`;
}

/** Причина нечитаемого файла — короткая метка для журнала. */
export function readReasonLabel(reason: ReadFailReason): string {
  return reason === "not-found"
    ? "файла нет"
    : reason === "not-readable"
      ? "не отдаёт"
      : reason === "quota"
        ? "нет места"
        : reason === "security"
          ? "запрет"
          : "другое";
}
