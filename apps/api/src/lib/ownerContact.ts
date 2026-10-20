/**
 * Контакт собственника — самая ценная часть базы, и отдаётся он не всем.
 *
 * Правило одно на всю CRM: телефон владельца видит руководитель (право
 * `properties.viewAll`) и тот, кто ведёт этот объект сам — риелтор по сделке,
 * принявший объект интейкер или создатель карточки. Всем остальным поле приходит
 * пустым.
 *
 * ОТДЕЛЬНЫМ МОДУЛЕМ, а не функцией внутри routes/properties.ts. Пока правило жило
 * там, любой другой маршрут, отдающий объекты, обходил его молча — и один такой
 * нашёлся: подбор объектов под клиента (`GET /clients/:id/match`) возвращал карточки
 * целиком, вместе с ownerContact. Рядовому агенту хватало собственного клиента с
 * широким бюджетом, чтобы пачками вытаскивать телефоны владельцев чужих объектов.
 * Общий модуль здесь нужен именно затем, чтобы следующий такой маршрут не появился:
 * правило одно, и импортируется оно из одного места.
 */

import type { Request } from "express";
import { can } from "../auth/middleware.js";

/**
 * Семантический вектор карточки (Property.embedding, 768 float ≈ 15 КБ JSON) —
 * внутренняя инфраструктура подбора, браузеру он не нужен ни в одном ответе.
 * Пока роуты отдают объекты через include (все скаляры разом), вектор уезжал в
 * каждый список и карточку — страница каталога тяжелела на сотни КБ (26.08.2026).
 * Тот же принцип «общий модуль, а не функция в одном роуте», что у stripOwnerContact.
 */
export function stripEmbedding<T extends { embedding?: unknown }>(property: T): Omit<T, "embedding"> {
  const { embedding: _embedding, ...rest } = property;
  return rest;
}

/**
 * `ownerContactHidden` (docs/TASKS.md, «дашборд агента против ТЗ» 07.09.2026):
 * `ownerContact: null` само по себе неоднозначно — то же самое значение
 * означает и «телефон правда не заполнен», и «скрыт правом». Карточка объекта
 * раньше решала это гадая по своему собственному `can("properties.viewOwners")`
 * на клиенте, а он не знает про исключение «свой объект виден и без права»
 * (isOwner ниже) — агент на СВОЁМ объекте видел «скрыто», хотя сервер как раз
 * отдавал ему настоящий контакт. Честный флаг убирает гадание: сервер уже
 * знает, замаскировал он поле или нет, а не заставляет фронт пересчитывать
 * то же правило второй раз и неизбежно расходиться с ним.
 */
export function stripOwnerContact<
  T extends {
    ownerContact?: string | null;
    assignedAgentId?: string | null;
    intakeAgentId?: string | null;
    createdById?: string | null;
  }
>(property: T, agentId: string, isSupervisor: boolean): T & { ownerContactHidden: boolean } {
  const isOwner =
    property.assignedAgentId === agentId || property.intakeAgentId === agentId || property.createdById === agentId;
  if (isSupervisor || isOwner) return { ...property, ownerContactHidden: false };
  return { ...property, ownerContact: null, ownerContactHidden: true };
}

/**
 * Единая точка выхода объекта наружу — stripEmbedding + stripOwnerContact вместе,
 * читая право прямо из req (21.09.2026, дыра с записью на прод: PATCH /:id, POST /
 * и POST /:id/complete-editing отдавали `prisma.property.update`/`.create` как есть,
 * в обход этой пары. GET-маршруты (список, карточка, экспорт, подбор) правило
 * соблюдали — писали `stripEmbedding(stripOwnerContact(...))` руками в каждом месте,
 * а роуты, отдающие объект ПОСЛЕ записи, следующие такой же карточкой, эту пару
 * не звали вовсе. Роль EDITOR (монтажёр) имеет `properties.editForeign` без
 * `properties.viewOwners` ИМЕННО для того, чтобы объект править, а телефон
 * собственника не видеть (см. packages/shared/permissions.ts) — ответ PATCH на
 * чужом объекте у него всё равно нёс настоящий ownerContact, и на карточке в
 * браузере это читалось как «не скрыто» (ownerContactHidden была не выставлена
 * вовсе, а не `false`). Новые точки, отдающие Property целиком, обязаны звать
 * ИМЕННО эту функцию, а не заново собирать пару — тот же урок, что в шапке файла.
 */
export function presentProperty<
  T extends {
    embedding?: unknown;
    ownerContact?: string | null;
    assignedAgentId?: string | null;
    intakeAgentId?: string | null;
    createdById?: string | null;
  }
>(property: T, req: Request): Omit<T, "embedding"> & { ownerContactHidden: boolean } {
  return stripEmbedding(stripOwnerContact(property, req.agent!.id, can(req, "properties.viewOwners")));
}
