/**
 * «Кусок сборки не загрузился» — признак того, что страница старше сервера (после
 * выката старые файлы с хешем в имени исчезают). Формулировки браузеров:
 * Chrome — «Failed to fetch dynamically imported module», Firefox — «error loading
 * dynamically imported module», Safari — «Importing a module script failed».
 *
 * Модуль без зависимостей: его читает и ErrorBoundary (последний рубеж, должен
 * грузиться всегда), и lazyWithReload.
 */
export function isChunkLoadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk \S+ failed/i.test(message);
}
