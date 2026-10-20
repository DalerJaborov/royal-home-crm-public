/**
 * Г2 (docs/architecture-blueprint.md §1.2, §3): файл распилен на routes/clients/*
 * по сюжетам (list, duplicates, card, lifecycle, interactions, suggestions,
 * communications, matching; общие хелперы — shared.ts, сборка — index.ts).
 *
 * Этот модуль остался БАРРЕЛЕМ, чтобы импортёры не менялись в коммите переноса
 * (правило §1: «баррель, импортёр не меняется»). Перевод импортов на прямые
 * пути и удаление барреля — отдельный шаг Г4.
 *
 * originateCallToClient живёт в routes/clients/communications.ts; экспорт отсюда
 * сохранён — это внешний контракт файла (см. карту §1.2).
 */
export { clientsRouter } from "./clients/index.js";
export { originateCallToClient } from "./clients/communications.js";
