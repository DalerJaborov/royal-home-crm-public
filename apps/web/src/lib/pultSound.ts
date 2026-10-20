import { useEffect, useRef } from "react";
import { playSoftTick } from "./aiSounds";

/**
 * Гейты и троттлинг звука пульта директора — spec-pult-v8-07-09.md §7:
 * «Озвучиваются только: новая строка «ждёт вас» ... и новый «вопрос ко мне».
 * Всё остальное — никогда... Не чаще раза в 3 минуты ... в час — не более 8.
 * Не играть: если вкладка скрыта (document.hidden), если
 * prefers-reduced-motion: reduce».
 *
 * Логика троттлинга вынесена в чистый класс `PultSoundThrottle`, не зависящий
 * от DOM/React — юнит-тест гоняет его через vitest fake timers без jsdom
 * (apps/web/vitest.config.ts: environment "node", как у `undoToast.ts`).
 */

export const PULT_SOUND_MIN_GAP_MS = 3 * 60 * 1000;
export const PULT_SOUND_MAX_PER_HOUR = 8;
const HOUR_MS = 60 * 60 * 1000;

export class PultSoundThrottle {
  private lastPlayedAt: number | null = null;
  private playedAt: number[] = [];

  /** true, если сейчас (мс, обычно Date.now()) можно сыграть звук по правилам §7. */
  canPlay(now: number): boolean {
    if (this.lastPlayedAt !== null && now - this.lastPlayedAt < PULT_SOUND_MIN_GAP_MS) return false;
    this.playedAt = this.playedAt.filter((t) => now - t < HOUR_MS);
    return this.playedAt.length < PULT_SOUND_MAX_PER_HOUR;
  }

  /** Отметить, что звук реально сыграл в момент `now`. */
  record(now: number): void {
    this.lastPlayedAt = now;
    this.playedAt.push(now);
  }

  /** Только для тестов — сбросить состояние. */
  reset(): void {
    this.lastPlayedAt = null;
    this.playedAt = [];
  }
}

/** Единственный вид события пульта, на который вообще может звучать сигнал (§7). */
export type PultSoundworthyKind = "awaitsYou" | "question";

export function isPultSoundworthyKind(kind: string): kind is PultSoundworthyKind {
  return kind === "awaitsYou" || kind === "question";
}

/** `document.hidden` и `prefers-reduced-motion: reduce` блокируют звук (§7). Безопасно
 *  вызывать вне браузера (SSR/тесты) — тогда ничего не блокирует само окружение. */
export function pultSoundEnvironmentAllows(): boolean {
  if (typeof document !== "undefined" && document.hidden) return false;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    } catch {
      // matchMedia недоступен/бросил — не блокируем звук из-за этого
    }
  }
  return true;
}

/** Один троттл на всё приложение: правило «не чаще 8/час» — глобальное для
 *  пульта, а не per-instance хука (иначе размонтирование/монтирование ленты
 *  сбрасывало бы счётчик). */
const appThrottle = new PultSoundThrottle();

/** Только для тестов/сторибука — обнулить общий троттл между сценариями. */
export function __resetPultSoundThrottleForTests(): void {
  appThrottle.reset();
}

export interface PultSoundEvent {
  id: string;
  kind: string;
}

/**
 * Следит за списком событий ленты и проигрывает `playSoftTick`, когда среди
 * НОВЫХ (появившихся с прошлого рендера) элементов есть хотя бы один
 * soundworthy-вида — при условии, что тумблер `sound` включён, вкладка видна,
 * reduced-motion не запрошен и троттлинг §7 это позволяет.
 *
 * На самый первый рендер список считается «уже виденным» — звук не играет на
 * загрузку страницы, только на настоящие новые события.
 */
export function usePultEventSound(events: PultSoundEvent[], enabled: boolean): void {
  const seenIds = useRef<Set<string> | null>(null);

  useEffect(() => {
    const ids = new Set(events.map((e) => e.id));
    const prev = seenIds.current;
    seenIds.current = ids;
    if (prev === null) return; // первый маунт — не звучим на то, что уже было

    if (!enabled) return;
    const hasNewSoundworthy = events.some((e) => !prev.has(e.id) && isPultSoundworthyKind(e.kind));
    if (!hasNewSoundworthy) return;
    if (!pultSoundEnvironmentAllows()) return;

    const now = Date.now();
    if (!appThrottle.canPlay(now)) return;
    appThrottle.record(now);
    playSoftTick();
    // events — новый массив на каждый polling-тик; сравниваем по id внутри, не по ссылке.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, enabled]);
}
