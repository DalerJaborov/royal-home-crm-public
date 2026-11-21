/**
 * Контакт собственника — самая ценная часть базы, и отдаётся он не всем.
 *
 * Правило одно на всю CRM (владелец 18.11.2026: «кроме директора, ни у кого вообще
 * не будет доступа к номерам телефона вообще»): телефон владельца видит только тот,
 * у кого право `properties.viewOwners` (по умолчанию — директор). Исключения «свой
 * объект» больше НЕТ: до 18.11.2026 риелтор по сделке, интейкер и создатель
 * карточки видели номер целиком, и агент уносил продавца в личный телефон. Связь с
 * продавцом у агента — кнопки «Позвонить» / «Написать», номер набирает сервер.
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
import { maskClientPhone, maskPhoneRun } from "./clientPhone.js";

/**
 * Семантический вектор карточки (Property.embedding, 768 float ≈ 15 КБ JSON) —
 * внутренняя инфраструктура подбора, браузеру он не нужен ни в одном ответе.
 * Пока роуты отдают объекты через include (все скаляры разом), вектор уезжал в
 * каждый список и карточку — страница каталога тяжелела на сотни КБ (26.08.2026).
 * Тот же принцип «общий модуль, а не функция в одном роуте», что у stripOwnerContact.
 */
// С 17.11.2026 вектор скрыт ещё и глобальным omit (src/db.ts), поэтому у строк из базы поля
// обычно нет вовсе — функция принимает любой объект и остаётся второй стеной (сырой SQL,
// явный select, объект, собранный руками).
export function stripEmbedding<T extends object>(property: T): Omit<T, "embedding"> {
  const rest = { ...property };
  Reflect.deleteProperty(rest, "embedding");
  return rest;
}

/**
 * `ownerContactHidden` (docs/TASKS.md, «дашборд агента против ТЗ» 07.09.2026):
 * `ownerContact: null` само по себе неоднозначно — то же самое значение
 * означает и «телефон правда не заполнен», и «скрыт правом». Карточка объекта
 * раньше решала это гадая по своему собственному `can("properties.viewOwners")`
 * на клиенте. Честный флаг убирает гадание: сервер уже
 * знает, замаскировал он поле или нет, а не заставляет фронт пересчитывать
 * то же правило второй раз и неизбежно расходиться с ним.
 */
export function stripOwnerContact<T extends { ownerContact?: string | null }>(
  property: T,
  canViewOwners: boolean
): T & { ownerContactHidden: boolean } {
  if (canViewOwners) return { ...property, ownerContactHidden: false };
  return { ...property, ownerContact: null, ownerContactHidden: true };
}

/**
 * КОНТАКТ ВЛАДЕЛЬЦА МАСКОЙ — тому, кто ведёт объект, но номера не видит (18.11.2026).
 *
 * Агенту на своём объекте нужно видеть, что номер у продавца есть и какой из
 * них (хвост), и звонить кнопкой — набирает станция. Сам номер — нет. Каждый
 * номер из поля приводим к `+9929300••456`: «как записан» маскировать нельзя —
 * у номера без плюса маска клиента оставила бы начало («9000••057»).
 */
export function maskOwnerContact(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const masked: string[] = [];
  for (const chunk of raw.split(/(?=\+)|[^\d\s\-().+]+/u)) {
    const digits = chunk.replace(/\D/g, "");
    if (digits.length < 9) continue;
    // Границы номера известны только у трёх записей: девять цифр, ноль и девять, 992 и
    // девять. Всё прочее (за номером дописаны цифры, другая страна) — осторожной маской:
    // иначе «две цифры в середине» закрыли бы не те цифры (lib/clientPhone.ts, maskPhoneRun).
    const local = digits.length === 9 || (digits.length === 10 && digits.startsWith("0")) || (digits.length === 12 && digits.startsWith("992"));
    masked.push(local ? maskClientPhone(`+992${digits.slice(-9)}`) : maskPhoneRun(digits, chunk.trimStart().startsWith("+")));
  }
  return masked.length > 0 ? [...new Set(masked)].join(", ") : "номер записан";
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
export function presentProperty<T extends { embedding?: unknown; ownerContact?: string | null }>(
  property: T,
  req: Pick<Request, "agent">
): Omit<T, "embedding"> & { ownerContactHidden: boolean } {
  return stripEmbedding(stripOwnerContact(property, can(req, "properties.viewOwners")));
}
