/**
 * Г3 (docs/architecture-blueprint.md §1.3, §3): файл распилен на routes/properties/*
 * по сюжетам (list, crud, moderation, photos, videos, shareLinks, matching; общие
 * хелперы — shared.ts, сборка — index.ts).
 *
 * Этот модуль остался БАРРЕЛЕМ, чтобы импортёры не менялись в коммите переноса
 * (правило §1: «баррель, импортёр не меняется»). Перевод импортов на прямые
 * пути и удаление барреля — отдельный шаг Г4.
 *
 * Единственный внешний потребитель файла — app.ts (propertiesRouter); других
 * экспортов наружу у исходного файла не было (проверено grep по репозиторию
 * при распиле).
 */
export { propertiesRouter } from "./properties/index.js";
