/**
 * «У АГЕНТА ЕСТЬ НЕЗАВЕРШЁННЫЙ ЧЕРНОВИК ОБЪЕКТА» — один флаг на всё приложение
 * (07.10.2026, владелец: агент должен уметь закрыть мастер, пока файлы грузятся,
 * сходить за информацией и вернуться; а если забыл — плашка напомнит).
 *
 * Флаг держит крошечный стор без зависимостей, чтобы оболочка указателя
 * (components/WorkIndicator.tsx) жила в главном бандле и не тянула очередь
 * загрузки. Поднимают его: мастер (черновик сохранён на сервере), очередь
 * файлов (появились файлы), проверка при входе (draftUploadsResume.ts).
 * Сбрасывают: создание объекта, «Начать заново», выход сотрудника.
 */
let hasDraft = false;
const listeners = new Set<() => void>();

export function setDraftReminder(value: boolean): void {
  if (hasDraft === value) return;
  hasDraft = value;
  for (const l of [...listeners]) l();
}

export function getDraftReminder(): boolean {
  return hasDraft;
}

export function subscribeDraftReminder(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
