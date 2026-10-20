/**
 * КРЮЧОК ВМЕСТО ИМПОРТА incomingCalls.js — ЛОМАЕТ ЦИКЛ ИМПОРТОВ.
 *
 * Тот же приём, что onNewSystemError в lib/systemError.ts (см. комментарий там).
 * qualifyIncoming.ts раньше брал liveIncomingByRecordId напрямую из
 * incomingCalls.ts — а incomingCalls.ts сам приходит в qualifyIncoming.ts
 * длинным путём (dutyRosterRouting/inboundRouting/kpiQueueRouting → callTracker
 * → callRecordings → autoLeadFromCall → qualifyIncoming), поэтому прямой импорт
 * назад замыкал цикл, который правило no-circular считает ошибкой (аудит
 * циклов 03.09.2026).
 *
 * incomingCalls.ts регистрирует настоящую функцию через
 * setLiveIncomingLookup один раз при старте (src/index.ts и src/worker.ts —
 * там встречаются оба модуля, без цикла); qualifyIncoming.ts знает только
 * форму функции (тип ниже), а не сам incomingCalls.ts.
 */

/** Минимум того, что нужно qualifyIncoming.ts от «живой» записи звонка. */
export interface LiveIncomingLike {
  clientId?: string;
  clientShortId?: number;
  clientName?: string;
}

let lookup: ((recordId: string) => LiveIncomingLike | undefined) | null = null;

export function setLiveIncomingLookup(fn: (recordId: string) => LiveIncomingLike | undefined): void {
  lookup = fn;
}

/** До регистрации (например, в модульном тесте, который не поднимает index.ts)
 *  возвращает undefined — вызывающий код уже готов к «живой записи нет». */
export function liveIncomingByRecordId(recordId: string): LiveIncomingLike | undefined {
  return lookup?.(recordId);
}
