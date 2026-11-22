import { propertyAnchorText, type ClientDisplayNameFacts, type ClientKind } from "@royal-home/shared";
import { prisma } from "../db.js";

/**
 * ОРИЕНТИР ОБЪЕКТА ПРОДАВЦА — ПЕРВЫЙ ПРИОРИТЕТ ЯКОРЯ В `clientDisplayName`
 * (packages/shared/src/clientDisplayName.ts, владелец 21.09.2026: «Джахонгир ·
 * Маяковский» вместо ручной дописки агентом).
 *
 * `Property.sellerClientId` — строка БЕЗ внешнего ключа (см. комментарий у самого
 * поля в schema.prisma, тот же приём, что у `reservedForClientId`), поэтому обычный
 * Prisma `include` от Client до объекта не достаёт — нужен отдельный запрос. Берём
 * его здесь ОДНИМ батчем на весь список клиентов (`findMany` с `sellerClientId in
 * […]`), а не по клиенту за раз — иначе список из 20 продавцов стоил бы 20 лишних
 * запросов (N+1, запрещено стандартом проекта).
 */

const MAX_CLIENTS_PER_BATCH = 200;

/**
 * Адрес/ориентир САМОГО СВЕЖЕГО объекта каждого продавца из списка. Если продавец
 * успел выставить несколько объектов, для якоря годится любой один — берём
 * последний по дате создания, он вероятнее совпадает с тем, чем агент с этим
 * клиентом занимается сейчас.
 */
export async function loadSellerPropertyAddresses(clientIds: readonly string[]): Promise<Map<string, string>> {
  const ids = clientIds.filter(Boolean);
  if (ids.length === 0) return new Map();

  const rows = await prisma.property.findMany({
    where: { sellerClientId: { in: ids.slice(0, MAX_CLIENTS_PER_BATCH) } },
    select: {
      sellerClientId: true, address: true, landmark: true, rooms: true,
      district: { select: { name: true } }, createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const result = new Map<string, string>();
  for (const row of rows) {
    if (!row.sellerClientId) continue;
    const anchor = propertyAnchorText({
      landmark: row.landmark, address: row.address, districtName: row.district?.name, rooms: row.rooms,
    });
    if (!anchor) continue;
    // Строки уже идут от новых к старым — первое совпадение на clientId и есть
    // самый свежий объект, дальнейшие для того же продавца просто пропускаем.
    if (!result.has(row.sellerClientId)) result.set(row.sellerClientId, anchor);
  }
  return result;
}

/** Тот же поиск для ОДНОГО клиента — карточка (GET /clients/:id), где батч не нужен. */
export async function loadSellerPropertyAddress(clientId: string): Promise<string | null> {
  const map = await loadSellerPropertyAddresses([clientId]);
  return map.get(clientId) ?? null;
}

export interface AnchorSubject {
  id: string;
  kind: ClientKind | null;
  requestedPropertyId?: string | null;
  matchedPropertyId?: string | null;
}

/**
 * ФАКТЫ ДЛЯ ЯКОРЯ ИМЕНИ — ОДНА ДВЕРЬ (22.11.2026). Продавцу — объект, который он
 * выставил; покупателю — объект, на который он написал (запрошенный, иначе
 * подобранный). Два запроса на весь список, не по клиенту. Результат целиком идёт
 * вторым аргументом `clientDisplayName` / `clientNameParts` из @royal-home/shared.
 */
export async function loadClientAnchorFacts(subjects: readonly AnchorSubject[]): Promise<Map<string, ClientDisplayNameFacts>> {
  const result = new Map<string, ClientDisplayNameFacts>();
  if (subjects.length === 0) return result;

  const sellerIds = subjects.filter((c) => c.kind === "SELLER").map((c) => c.id);
  const sellerAnchors = sellerIds.length ? await loadSellerPropertyAddresses(sellerIds) : new Map<string, string>();
  for (const [id, anchor] of sellerAnchors) result.set(id, { propertyAddress: anchor });

  const interestOf = (c: AnchorSubject) => c.requestedPropertyId || c.matchedPropertyId || null;
  const buyers = subjects.filter((c) => c.kind !== "SELLER" && interestOf(c));
  if (buyers.length > 0) {
    const propIds = [...new Set(buyers.map((c) => interestOf(c) as string))].slice(0, MAX_CLIENTS_PER_BATCH);
    const props = await prisma.property.findMany({
      where: { id: { in: propIds } },
      select: { id: true, address: true, landmark: true, rooms: true, district: { select: { name: true } } },
    });
    const anchorByProp = new Map(
      props.map((p) => [p.id, propertyAnchorText({ landmark: p.landmark, address: p.address, districtName: p.district?.name, rooms: p.rooms })]),
    );
    for (const c of buyers) {
      const anchor = anchorByProp.get(interestOf(c) as string);
      if (anchor) result.set(c.id, { ...(result.get(c.id) ?? {}), interestAnchor: anchor });
    }
  }
  return result;
}
