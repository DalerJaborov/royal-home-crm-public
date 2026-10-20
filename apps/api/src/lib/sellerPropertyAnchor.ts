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
    select: { sellerClientId: true, address: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  const result = new Map<string, string>();
  for (const row of rows) {
    if (!row.sellerClientId || !row.address) continue;
    // Строки уже идут от новых к старым — первое совпадение на clientId и есть
    // самый свежий объект, дальнейшие для того же продавца просто пропускаем.
    if (!result.has(row.sellerClientId)) result.set(row.sellerClientId, row.address);
  }
  return result;
}

/** Тот же поиск для ОДНОГО клиента — карточка (GET /clients/:id), где батч не нужен. */
export async function loadSellerPropertyAddress(clientId: string): Promise<string | null> {
  const map = await loadSellerPropertyAddresses([clientId]);
  return map.get(clientId) ?? null;
}
