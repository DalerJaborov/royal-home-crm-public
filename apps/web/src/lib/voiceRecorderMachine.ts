/**
 * Состояния записи голосового «как в WhatsApp» (27.11.2026, просьба владельца: точная копия).
 *
 * Чистая логика без браузера: фазы, переходы и жест удержания. MediaRecorder, микрофон и
 * указатель живут в hooks/useVoiceRecorderSession.ts — он только вызывает эти функции,
 * поэтому правила жеста и переходы проверяются тестом без DOM.
 *
 *   idle ──нажал──▶ requesting ──разрешили──▶ holding ──влево──▶ (отмена, idle)
 *                         │                      │──вверх──▶ locked ⇄ paused (прослушивание)
 *                         └─ мышь: сразу locked  └─отпустил──▶ sending
 *   locked/paused ──«Отправить»──▶ sending ──ok──▶ idle
 *                                          └─сбой──▶ paused + finished (запись цела, можно отправить снова)
 */

export type VoicePhase = "idle" | "requesting" | "holding" | "locked" | "paused" | "sending";

export interface VoiceState {
  phase: VoicePhase;
  /** Сдвиг пальца от точки нажатия, px (только пока holding). */
  dx: number;
  dy: number;
  /** Запись уже остановлена (отправка не удалась): продолжить нельзя, отправить заново — можно. */
  finished: boolean;
}

export type VoiceEvent =
  | { type: "press" }
  | { type: "granted"; locked: boolean }
  | { type: "denied" }
  | { type: "move"; dx: number; dy: number }
  | { type: "lock" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "send" }
  | { type: "sent" }
  | { type: "failed" }
  | { type: "cancel" };

export const VOICE_INITIAL: VoiceState = { phase: "idle", dx: 0, dy: 0, finished: false };

/** Сдвиг влево, при котором запись отменяется (WhatsApp ~ 100 px на экране 390). */
export const CANCEL_DISTANCE_PX = 90;
/** Сдвиг вверх, при котором запись встаёт на замок. */
export const LOCK_DISTANCE_PX = 70;
/** Короче этого, отпущенное на удержании, — случайное касание: запись выбрасывается с подсказкой. */
export const HOLD_MIN_MS = 500;

export type HoldGesture = "cancel" | "lock" | null;

/** Что значит текущий сдвиг пальца. Побеждает та ось, куда ушли дальше. */
export function gestureFromMove(dx: number, dy: number): HoldGesture {
  const left = -dx;
  const up = -dy;
  const cancel = left >= CANCEL_DISTANCE_PX;
  const lock = up >= LOCK_DISTANCE_PX;
  if (cancel && lock) return left / CANCEL_DISTANCE_PX >= up / LOCK_DISTANCE_PX ? "cancel" : "lock";
  if (cancel) return "cancel";
  if (lock) return "lock";
  return null;
}

/** Прозрачность подписи «Влево — отмена»: гаснет по мере движения к порогу. */
export function cancelHintOpacity(dx: number): number {
  const progress = Math.min(1, Math.max(0, -dx / CANCEL_DISTANCE_PX));
  return 1 - progress * 0.85;
}

export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case "press":
      return state.phase === "idle" ? { ...VOICE_INITIAL, phase: "requesting" } : state;
    case "granted":
      return state.phase === "requesting" ? { ...VOICE_INITIAL, phase: event.locked ? "locked" : "holding" } : state;
    case "denied":
      return VOICE_INITIAL;
    case "move":
      return state.phase === "holding" ? { ...state, dx: Math.min(0, event.dx), dy: Math.min(0, event.dy) } : state;
    case "lock":
      return state.phase === "holding" ? { ...VOICE_INITIAL, phase: "locked" } : state;
    case "pause":
      return state.phase === "locked" ? { ...state, phase: "paused" } : state;
    case "resume":
      return state.phase === "paused" && !state.finished ? { ...state, phase: "locked" } : state;
    case "send":
      return state.phase === "holding" || state.phase === "locked" || state.phase === "paused"
        ? { ...state, phase: "sending", dx: 0, dy: 0 }
        : state;
    case "sent":
      return VOICE_INITIAL;
    case "failed":
      return state.phase === "sending" ? { ...VOICE_INITIAL, phase: "paused", finished: true } : state;
    case "cancel":
      return VOICE_INITIAL;
    default:
      return state;
  }
}

/** Идёт ли сейчас что-то, из-за чего строка ввода занята (запись, прослушивание, отправка). */
export function isVoiceBusy(state: VoiceState): boolean {
  return state.phase !== "idle";
}

/** Сколько миллисекунд записано: накопленное до паузы плюс текущий отрезок. */
export function recordedMs(baseMs: number, segmentStartedAt: number | null, now: number): number {
  return baseMs + (segmentStartedAt === null ? 0 : Math.max(0, now - segmentStartedAt));
}

/** Свести уровни звука к ровно `count` столбикам для волны (максимум в каждой корзине). */
export function downsampleLevels(levels: number[], count: number): number[] {
  if (count <= 0) return [];
  if (levels.length === 0) return Array.from({ length: count }, () => 0);
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i * levels.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / count));
    let peak = 0;
    for (let j = from; j < to && j < levels.length; j++) peak = Math.max(peak, levels[j]);
    return peak;
  });
}
