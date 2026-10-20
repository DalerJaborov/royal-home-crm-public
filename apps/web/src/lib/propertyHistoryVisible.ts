import type { PermissionId } from "@royal-home/shared";

/**
 * КТО ВИДИТ «ИСТОРИЮ ОБЪЕКТА» — то же правило, что у сервера
 * (apps/api/src/routes/auditLog.ts, ветка entityType = Property): общий журнал
 * (`auditLog.view`), тот, кто ведёт объект (`isResponsible`), либо тот, кому
 * открыты все объекты — `properties.viewOwners` (маркетинг) или
 * `properties.editForeign` (монтажёр, конвейер). Сайт был уже сервера и прятал
 * историю от маркетинга и монтажёра, хотя сервер им её отдаёт (находка №147,
 * ночная проверка 24.09.2026). Номер собственника в истории прячет сам сервер.
 */
export function canViewPropertyHistory(can: (permission: PermissionId) => boolean, isResponsible: boolean): boolean {
  return (
    can("auditLog.view") || can("properties.viewOwners") || can("properties.editForeign") || isResponsible
  );
}
