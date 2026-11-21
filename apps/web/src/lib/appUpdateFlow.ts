import { useAppUpdateStore } from "../store/appUpdate";
import { ATTEMPT_WINDOW_MS, type GiveUpReporter, reportUpdateGiveUpOnce, UNKNOWN_TARGET, updateAttemptGate } from "./appUpdateReload";

/**
 * ОДИН ШАГ РЕШЕНИЯ «подменять сборку сейчас?» — без React и без таймеров
 * (21.11.2026). Жил внутри UpdatePrompt.tsx, и проверить его было нечем: тот
 * тянет виртуальный модуль vite-plugin-pwa, которого в vitest нет. Компонент
 * теперь только зовёт этот шаг и заводит таймер на `retryInMs`.
 *
 * Порядок проверок — от самой жёсткой к самой мягкой:
 *  1. счётчик попыток (lib/appUpdateReload.ts): исчерпан — плашка
 *     «Есть обновление · Обновить» и повтор, когда окно освободится;
 *  2. долгая работа (lib/workGuard.ts): ждём, но не дольше MAX_WORK_DEFER_MS,
 *     дальше — досохранить (`flushWork`) и подменять;
 *  3. человек занят (печатает, запрос в полёте): ждём, переход между разделами
 *     и пять минут ожидания — разрешение (store/appUpdate.ts → requestApply).
 */

/** Как часто перепроверяем, освободился ли человек или работа. */
export const RETRY_WHILE_BUSY_MS = 2_000;

export interface UpdateStepInput {
  currentVersion: string;
  /** Сигнал пришёл вместе с переходом между разделами. */
  navigating?: boolean;
  /** Идёт долгая работа (lib/workGuard.ts → isBusy). */
  workBusy: boolean;
  /** Человек печатает / открыта форма (lib/isUserActivelyTyping.ts). */
  userTyping: () => boolean;
  /** Мутация в полёте (lib/isMutationInFlight.ts). */
  mutationInFlight: () => boolean;
  now?: number;
  /** Запись о сдаче в журнал (в тестах — подмена). */
  reportGiveUp?: GiveUpReporter;
}

export interface UpdateStep {
  /** Повторить шаг через столько мс; null — повторять не нужно. */
  retryInMs: number | null;
  /** Перед подменой дать долгой работе досохраниться (потолок ожидания вышел). */
  flushWork: boolean;
}

export function runUpdateStep(input: UpdateStepInput): UpdateStep {
  const now = input.now ?? Date.now();
  const store = useAppUpdateStore.getState();
  if (store.applying || (!store.needRefresh && !store.staleBuild)) {
    return { retryInMs: null, flushWork: false };
  }

  const target = store.serverVersion ?? UNKNOWN_TARGET;
  const gate = updateAttemptGate(input.currentVersion, target, now);
  if (!gate.allowed) {
    store.setBlocked(true);
    // Доклад о сдаче — ЗДЕСЬ (22.11.2026, ревью #381): при закрытом окне этот шаг
    // включает плашку и applyAppUpdate не зовёт, так что ветка «сдача» внутри неё
    // в браузере не случалась. Один раз на пару, отметка — после успешной отправки.
    reportUpdateGiveUpOnce(input.currentVersion, target, now, input.reportGiveUp);
    const retryAt = gate.retryAt ?? now + ATTEMPT_WINDOW_MS;
    return { retryInMs: Math.max(1_000, retryAt - now), flushWork: false };
  }

  const work = store.noteWorkBusy(input.workBusy, now);
  if (work.decision === "wait") return { retryInMs: RETRY_WHILE_BUSY_MS, flushWork: false };

  // Потолок по работе вышел — печатающего человека больше не ждём (форма с
  // полями держала бы вкладку дальше), а запрос в полёте — ждём: это секунды.
  const busy = input.mutationInFlight() || (!work.forced && input.userTyping());
  const deferred = store.requestApply(busy, { navigating: input.navigating, now });
  if (deferred) return { retryInMs: RETRY_WHILE_BUSY_MS, flushWork: false };
  return { retryInMs: null, flushWork: work.forced && useAppUpdateStore.getState().applying };
}
