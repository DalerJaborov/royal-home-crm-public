import { PROPERTY_PUBLISHED_ACTION_DENIED_MESSAGE, propertyEditLocked, type PermissionId } from "@royal-home/shared";

/**
 * КТО МОЖЕТ УПРАВЛЯТЬ ОБЪЕКТОМ — ОДНО ПРАВИЛО НА REST И НА ИИ-ПОМОЩНИКА
 * (31.10.2026, П3 «prop»). Раньше проверка жила в `routes/properties/shared.ts`
 * и принимала Express-запрос; помощнику запроса не от кого брать, и он писал бы
 * свою копию условия. Теперь тело здесь, а `canManageProperty(req, …)` лишь
 * достаёт из запроса сотрудника и его права.
 *
 * Руководитель (право `properties.editForeign`) — любым объектом; агент — своим
 * (ведущий, приёмщик или создатель карточки).
 */
export interface PropertyAccessActor {
  agentId: string;
  /** Роль сотрудника: нужна только там, где решает роль (снять из соцсетей — маркетинг/руководство). */
  role?: string;
  can: (permission: PermissionId) => boolean;
}

export function canManagePropertyAs(
  actor: PropertyAccessActor,
  property: { assignedAgentId?: string | null; intakeAgentId?: string | null; createdById?: string | null }
): boolean {
  if (actor.can("properties.editForeign")) return true;
  return [property.assignedAgentId, property.intakeAgentId, property.createdById].includes(actor.agentId);
}

/**
 * СВОЙ ОБЪЕКТ (ведущий, приёмщик или создатель карточки) — без права editForeign.
 * Решение владельца 03.11.2026: цену СВОЕГО опубликованного объекта агент меняет сам,
 * замок публикации (07.10.2026) на неё не действует; остальные поля по-прежнему заявкой.
 */
export function ownsProperty(
  agentId: string,
  property: { assignedAgentId?: string | null; intakeAgentId?: string | null; createdById?: string | null }
): boolean {
  return [property.assignedAgentId, property.intakeAgentId, property.createdById].includes(agentId);
}

/** Поля, которые замок публикации не держит для хозяина объекта. */
export const OWNER_OPEN_AFTER_PUBLISH_FIELDS: readonly string[] = ["price", "currency"];

/**
 * КНОПКИ ВИДЕО-ИСПРАВЛЕНИЙ ПОСЛЕ ПУБЛИКАЦИИ — только руководству (07.10.2026).
 * «Вернуть монтажёру», «Снова на монтаж» и соседи трогают то, что уже видно
 * подписчикам; агенту-владельцу они не доступны, он просит заявкой. Те же
 * критерии, что у замка правки (право properties.editForeign). Текст отказа 403
 * или null (можно). `publishedActionDeniedReason(req, …)` в routes/properties/
 * shared.ts — тонкая обёртка над этой функцией.
 */
export function publishedActionDeniedReasonAs(
  actor: PropertyAccessActor,
  property: { status: string; offSite?: boolean | null }
): string | null {
  return propertyEditLocked(property, actor.can("properties.editForeign")) ? PROPERTY_PUBLISHED_ACTION_DENIED_MESSAGE : null;
}

/**
 * СВОИ ДАННЫЕ МЕНЯЮТСЯ СРАЗУ — ОДНО ПРАВИЛО НА REST И НА ШАБНАМ (владелец 15.11.2026:
 * «через Шабнам и без неё можно менять любые свои данные»).
 *
 * Свой объект (ведущий, приёмщик или создатель карточки; руководство с `properties.editForeign`
 * — любой) меняет цену, данные карточки и просит перемонтаж БЕЗ ожидания чужого решения:
 * заявка создаётся и тут же принимается автором тем же исполнителем, что кнопка «Принять»
 * директора (routes/properties/changeRequestExecutor.ts) — журнал и эффекты те же.
 * Чужой объект и виды «убрать из соцсетей» / «Другое» — по-прежнему заявкой руководителю.
 * Объект в резерве (есть сделка): цена — по-прежнему руководству, она база комиссии.
 */
export const OWN_DIRECT_CHANGE_KINDS = ["PRICE_CHANGE", "CARD_DATA", "REMAKE_VIDEO"] as const;

export function canApplyChangeDirectly(
  actor: PropertyAccessActor,
  property: { status: string; assignedAgentId?: string | null; intakeAgentId?: string | null; createdById?: string | null },
  kind: string,
  options?: { removeFromSocial?: boolean }
): boolean {
  if (!(OWN_DIRECT_CHANGE_KINDS as readonly string[]).includes(kind)) return false;
  // Перемонтаж со снятием постов видят подписчики, вернуть нельзя: «сразу» только тем, кому
  // это доступно и в sendBackDenied (роль маркетинга/руководства), остальным — заявкой.
  if (kind === "REMAKE_VIDEO" && options?.removeFromSocial && !actor.can("marketing.access")) return false;
  if (kind === "PRICE_CHANGE" && property.status === "RESERVED" && !actor.can("properties.editForeign")) return false;
  return canManagePropertyAs(actor, property);
}

/**
 * ПЕРЕМОНТАЖ СВОЕГО ОБЪЕКТА — СРАЗУ, И ПОСЛЕ ПУБЛИКАЦИИ (владелец 15.11.2026, отменяет для
 * хозяина запрет 07.10.2026 на «Вернуть монтажёру» у вышедшего объекта). Чужой объект и
 * «снять из соцсетей» остаются за руководством/маркетингом: проверки по ним — в sendBackDenied.
 */
export function publishedSendBackDeniedReasonAs(
  actor: PropertyAccessActor,
  property: { status: string; offSite?: boolean | null; assignedAgentId?: string | null; intakeAgentId?: string | null; createdById?: string | null }
): string | null {
  if (canApplyChangeDirectly(actor, property, "REMAKE_VIDEO")) return null;
  return publishedActionDeniedReasonAs(actor, property);
}
