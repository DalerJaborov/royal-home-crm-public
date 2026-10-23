/**
 * Лёгкий мост «событие → сбросить кэш секций пульта» (пачка B пульта, 23.10.2026).
 *
 * Листовой модуль без импортов: livePublish.ts (кто публикует) и
 * missionControlCache.ts (кто хранит кэш) иначе зависели бы друг от друга
 * кольцом. Кэш регистрирует здесь свой сброс при загрузке; процесс, где кэша
 * нет (worker), вызывает пустышку.
 *
 * "live" — только быстрые секции (TTL 15 с), "all" — и зоны (TTL 60 с).
 */
export type PultDropScope = "live" | "all";

let dropper: ((scope: PultDropScope) => void) | null = null;

export function registerPultCacheDropper(fn: (scope: PultDropScope) => void): void {
  dropper = fn;
}

/** Сбросить кэш секций БЕЗ повторной публикации (цикла события→сброс→событие нет). */
export function dropMissionControlSections(scope: PultDropScope = "all"): void {
  try {
    dropper?.(scope);
  } catch {
    /* сброс — оптимизация свежести, не бизнес-операция */
  }
}

let snapshotPublisher: (() => void) | null = null;

/** livePublish.ts регистрирует тут троттлированный publishPultSnapshot. */
export function registerPultSnapshotPublisher(fn: () => void): void {
  snapshotPublisher = fn;
}

/**
 * Источник сообщает «на пульте что-то изменилось» (ошибка в журнале, статус
 * ролика, комментарий, запрос перезвонить). Листовой модуль без импортов —
 * звать можно из любого места без риска цикла (systemError.ts, videoHandoff.ts…).
 */
export function requestPultSnapshot(): void {
  try {
    snapshotPublisher?.();
  } catch {
    /* живость — удобство поверх опроса */
  }
}
