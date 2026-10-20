/**
 * ПЕРЕХОДНЫЙ БАРРЕЛЬ (чертёж docs/architecture-blueprint.md, шаг Г1).
 *
 * Бывшее содержимое файла (2457 строк, пять независимых сюжетов) перенесено
 * verbatim в services/leads/* по карте §1.1 чертежа:
 *   selection.ts    — кто из агентов может взять лид (очереди, KPI, отсевы)
 *   assignment.ts   — назначение с причиной и отказ от лида
 *   firstCall.ts    — дисциплина первого звонка
 *   reassignment.ts — протухшие, вернувшиеся и ждущие лиды
 *   intake.ts       — создание лида из внешнего канала
 *
 * У файла 14 импортёров — ни один из них в коммите переноса не меняется.
 * Обновление импортов на прямые пути services/leads/* и удаление этого барреля —
 * отдельным финальным коммитом (шаг Г4 чертежа), когда всё зелёное.
 */
export * from "./services/leads/selection.js";
export * from "./services/leads/assignment.js";
export * from "./services/leads/firstCall.js";
export * from "./services/leads/reassignment.js";
export * from "./services/leads/intake.js";
