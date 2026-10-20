import { prisma } from "../db.js";
import { clientNamePhoneSafe } from "./clientPhone.js";

/**
 * ЖИВОЙ ТИКЕР СОБЫТИЙ (mission-control, фаза 3, план §6 п.6 / §2 «Ярус 4»):
 * единая хронологическая лента компании — «14:32 Сделка → Показ · 14:31 новый
 * лид Instagram · 14:30 звонок Умед↔ПК-000231».
 *
 * ТРИ ИСТОЧНИКА, СВЕДЁННЫЕ ПО ВРЕМЕНИ (план §2: «AuditLog + interactions +
 * звонки, один запрос с курсором»):
 *  1. AuditLog — чувствительные действия (удаления/публикации/изменения),
 *     подписи те же, что в Архиве (apps/web/src/lib/audit.ts), только текст
 *     собирается на сервере — тикер отдаёт готовую строку, а не сырой action,
 *     потому что три разных источника (AuditLog/Interaction/Client) не могут
 *     жить по единому фронтовому форматтеру без раздельных веток на фронте.
 *  2. Interaction — звонки/сообщения/показы/встречи, тот же источник, что у
 *     /activity (useActivityFeed), тот же human label набор.
 *  3. Client — момент создания лида: НИ AuditLog, ни Interaction его не
 *     фиксируют (создание клиента нигде не проходит через logAudit), а
 *     «новый лид» — самое частое и самое желанное событие в реальном тикере
 *     по разбору жалобы владельца.
 *
 * КУРСОР, А НЕ СТРАНИЦЫ. Три источника с разными id — обычная постраничная
 * пагинация (skip=N на каждый) рассинхронизирует слияние на второй же
 * странице (у источников разная плотность событий). Курсор — это `before`
 * (ISO-момент), общий для всех трёх: каждый источник берёт `limit` строк
 * СТРОГО раньше курсора, слияние сортируется и обрезается по limit, следующий
 * курсор — время последней отданной строки. Так слияние остаётся верным на
 * любой глубине пролистывания, а не только на первой странице.
 */

export type TickerKind = "audit" | "interaction" | "lead";

export interface TickerItem {
  id: string;
  kind: TickerKind;
  createdAt: string;
  text: string;
  href: string | null;
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  CREATE: "создание",
  PROPERTY_CREATED: "создание",
  CLIENT_CREATE: "создание",
  AGENT_CREATE: "создание",
  DELETE: "удаление",
  CLIENT_DELETE: "удаление",
  TRASH: "удаление (в корзину)",
  DELETE_REQUEST: "заявка на удаление",
  DELETE_REQUEST_REJECT: "заявка на удаление отклонена",
  PERMANENT_DELETE: "удаление навсегда",
  UPDATE: "изменение",
  RESTORE: "восстановление",
  PUBLISH: "публикация",
  UNPUBLISH: "снятие с публикации",
  PROPERTY_EDITING_DONE: "монтаж завершён",
  // Справочник ориентиров ведут агенты (блок J, docs/geo-match-plan-12-09.md).
  LANDMARK_CREATE: "ориентир добавлен",
  LANDMARK_UPDATE: "ориентир изменён",
  LANDMARK_HIDE: "ориентир скрыт",
  LANDMARK_SHOW: "ориентир возвращён из скрытых",
  LANDMARK_DELETE: "ориентир удалён",
  LANDMARK_ALIAS_ADD: "синоним ориентира добавлен",
  LANDMARK_ALIAS_REMOVE: "синоним ориентира убран",
};

const AUDIT_ENTITY_LABELS: Record<string, string> = {
  Expense: "расход",
  Agent: "сотрудник",
  Property: "объект",
  Client: "клиент",
  Deal: "сделка",
  Settings: "настройки",
  Landmark: "ориентир",
};

const AUDIT_ENTITY_LINK: Record<string, (shortId: number) => string> = {
  Property: (id) => `/properties/${id}`,
  Client: (id) => `/clients/${id}`,
};

function auditEntityName(meta: unknown): string | null {
  const m = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : null;
  if (!m) return null;
  for (const key of ["title", "name", "fullName", "targetName", "toAgentName", "category"]) {
    const v = m[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function auditEntityLink(entityType: string, meta: unknown): string | null {
  const m = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : null;
  const shortId = m && typeof m.shortId === "number" ? m.shortId : null;
  if (shortId == null) return null;
  return AUDIT_ENTITY_LINK[entityType]?.(shortId) ?? null;
}

const INTERACTION_TYPE_LABELS: Record<string, string> = {
  CALL: "звонок",
  MESSAGE: "сообщение",
  MEETING: "встреча",
  SHOWING: "показ",
  STATUS_CHANGE: "смена статуса",
  SYSTEM: "система",
};

/** Одна страница ленты: строго раньше `before` (если задан), не более `limit` штук,
 *  плюс курсор для следующей страницы (`null`, если источники исчерпаны). */
export async function loadMissionControlTicker(
  before: Date | null,
  limit: number,
  /** Право видеть телефоны клиентов (22.09.2026). Тикер живёт на пульте
   *  (dashboard.analytics, менеджер) и вплетает имена карточек в текст строки —
   *  а у карточек незнакомых звонивших номер лежит в имени (lib/clientPhone.ts).
   *  То же и для имени из AuditLog.meta. */
  canSeePhone: boolean
): Promise<{ items: TickerItem[]; nextCursor: string | null }> {
  const safeName = (name: string): string => (canSeePhone ? name : clientNamePhoneSafe(name, false));
  const createdAtFilter = before ? { lt: before } : undefined;

  const [auditRows, interactionRows, leadRows] = await Promise.all([
    prisma.auditLog.findMany({
      where: createdAtFilter ? { createdAt: createdAtFilter } : {},
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.interaction.findMany({
      where: createdAtFilter ? { createdAt: createdAtFilter } : {},
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        type: true,
        createdAt: true,
        notes: true,
        agent: { select: { fullName: true } },
        client: { select: { shortId: true, fullName: true } },
      },
    }),
    prisma.client.findMany({
      where: { deletedAt: null, ...(createdAtFilter ? { createdAt: createdAtFilter } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, shortId: true, fullName: true, source: true, kind: true, createdAt: true },
    }),
  ]);

  const items: TickerItem[] = [];

  for (const a of auditRows) {
    const name = auditEntityName(a.meta);
    const entityLabel = AUDIT_ENTITY_LABELS[a.entityType] ?? a.entityType;
    const actionLabel = AUDIT_ACTION_LABELS[a.action] ?? a.action.toLowerCase();
    items.push({
      id: `audit-${a.id}`,
      kind: "audit",
      createdAt: a.createdAt.toISOString(),
      // Имя сущности из AuditLog.meta — только у карточки клиента там бывает
      // телефон в имени; заголовок объекта его не несёт, но общая маска дат и
      // сумм не трогает, поэтому применяем ко всем именам без разбора типа.
      text: `${a.agentName} — ${actionLabel}: ${entityLabel}${name ? ` · ${safeName(name)}` : ""}`,
      href: auditEntityLink(a.entityType, a.meta),
    });
  }

  for (const it of interactionRows) {
    const typeLabel = INTERACTION_TYPE_LABELS[it.type] ?? it.type.toLowerCase();
    const client = it.client?.fullName ? safeName(it.client.fullName) : "клиент";
    items.push({
      id: `interaction-${it.id}`,
      kind: "interaction",
      createdAt: it.createdAt.toISOString(),
      text: `${it.agent?.fullName ?? "Агент"} — ${typeLabel}: ${client}`,
      href: it.client?.shortId ? `/clients/${it.client.shortId}` : null,
    });
  }

  for (const c of leadRows) {
    const kindLabel = c.kind === "SELLER" ? "продавец" : c.kind === "OTHER" ? "обращение" : "покупатель";
    items.push({
      id: `lead-${c.id}`,
      kind: "lead",
      createdAt: c.createdAt.toISOString(),
      text: `Новый ${kindLabel}: ${safeName(c.fullName)}`,
      href: `/clients/${c.shortId}`,
    });
  }

  items.sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
  const page = items.slice(0, limit);

  // Курсор дальше есть, только если хотя бы один источник отдал полный `limit» —
  // если все три вернули меньше, значит их запас исчерпан раньше limit-й строки.
  const sourcesExhausted = auditRows.length < limit && interactionRows.length < limit && leadRows.length < limit;
  const nextCursor = !sourcesExhausted && page.length > 0 ? page[page.length - 1]!.createdAt : null;

  return { items: page, nextCursor };
}
