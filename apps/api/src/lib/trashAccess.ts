import type { PermissionId } from "@royal-home/shared";

/**
 * КОРЗИНА: КТО ЧТО ВИДИТ И КТО ВОССТАНАВЛИВАЕТ — ОДНО ПРАВИЛО (07.11.2026, решение владельца).
 *
 * Владелец: «Корзина объектов — видна ВСЕМ агентам как справка (объекты общие). Восстановить
 * может только директор, администратор и хозяин (агент объекта). Клиенты в Корзине — только
 * хозяину карточки (и директору/админу). Права проверять на сервере.»
 *
 * Новых прав не заводим, опираемся на существующие:
 *  - руководство = `archive.view` (экран «Архив», по умолчанию директор, админ, акционер);
 *  - восстанавливать объект = `properties.delete` (та же кнопка «Восстановить» на экране Корзины,
 *    по умолчанию директор и админ) ИЛИ хозяин объекта — ведущий или приёмщик. Создатель карточки,
 *    передавший объект коллеге, хозяином не считается: то же правило, что у удаления своего
 *    объекта помощником (ai/assistant/tools/deletePropertyTool.ts) — кто мог удалить, тот и вернёт;
 *  - хозяин клиента = `Client.assignedAgentId` (при уходе в Корзину не стирается, lib/trashClient.ts).
 *
 * Общая группа Telegram — чужие глаза: клиентов из Корзины там не показываем никому (решение
 * 07.11.2026, PR #127, остаётся в силе). Объекты из Корзины — справка для всех, в группе тоже.
 *
 * Сюда ходят и REST (POST /properties/:id/restore), и помощник; вторую копию условия не писать.
 */
export interface TrashActor {
  agentId: string;
  can: (permission: PermissionId) => boolean;
  /** Канал помощника: в общей группе Telegram клиентов Корзины не показываем. */
  surface?: "crm-private" | "telegram-private" | "telegram-group";
}

/** Удалённые объекты как справка (что это было, кто и когда удалил) — всем сотрудникам. */
export function canSeeTrashedProperties(_actor: TrashActor): boolean {
  return true;
}

/**
 * Открыть СТРАНИЦУ удалённого объекта (/properties/:номер) может только руководство с правом
 * «Архив» — так отвечает REST (routes/properties/list.ts, GET по номеру, зовёт эту же функцию).
 * Остальным справка о Корзине приходит словами, без ссылки: ссылка на закрытую страницу — тупик
 * «Объект не найден».
 */
export function canOpenTrashedPropertyPage(actor: TrashActor): boolean {
  return actor.can("archive.view");
}

/** Хозяин объекта для Корзины: ведущий или приёмщик. */
export function ownsTrashedProperty(
  agentId: string,
  property: { assignedAgentId?: string | null; intakeAgentId?: string | null },
): boolean {
  return property.assignedAgentId === agentId || property.intakeAgentId === agentId;
}

/** Восстановить объект из Корзины: директор/админ (`properties.delete`) или хозяин объекта. */
export function canRestorePropertyAs(
  actor: TrashActor,
  property: { assignedAgentId?: string | null; intakeAgentId?: string | null },
): boolean {
  return actor.can("properties.delete") || ownsTrashedProperty(actor.agentId, property);
}

export const PROPERTY_RESTORE_DENIED =
  "Восстановить объект из Корзины может директор, администратор или агент этого объекта.";

/**
 * Какая часть Корзины клиентов открыта:
 *  - all  — вся (руководство, право «Архив»), кроме общей группы;
 *  - own  — только карточки, закреплённые за самим сотрудником;
 *  - none — никакая (общая группа Telegram).
 */
export type ClientTrashScope = "all" | "own" | "none";

export function clientTrashScopeFor(actor: TrashActor): ClientTrashScope {
  if (actor.surface === "telegram-group") return "none";
  return actor.can("archive.view") ? "all" : "own";
}

/** Можно ли показать ЭТУ удалённую карточку клиента (например, продавца удалённого объекта). */
export function canSeeTrashedClient(actor: TrashActor, client: { assignedAgentId: string | null }): boolean {
  const scope = clientTrashScopeFor(actor);
  return scope === "all" || (scope === "own" && client.assignedAgentId === actor.agentId);
}

/**
 * Контакты УДАЛЁННОГО клиента (телефон, адрес, номера внутри имени и заметок) — только руководству
 * с правом «Архив» (и при этом с правом на телефон). Хозяин-агент видит свою удалённую карточку без
 * контактов. Решение владельца 07.11.2026, дословно: «агенту не показывать телефон удаленного
 * клиента». REST отдаёт удалённых клиентов только через GET /clients/trash с тем же правом «Архив».
 */
export function canSeeTrashedClientContacts(actor: TrashActor): boolean {
  return actor.can("archive.view");
}
