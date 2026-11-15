import bcrypt from "bcrypt";
import { prisma } from "../../src/db.js";
import { catalogRaw } from "./somonPage.js";

/**
 * Общие заготовки тестов «рынок везде» (14.11.2026): район с набором объявлений, из которого честно
 * собирается сегмент (порог 8, без склейки дублей), и агент. Всё с уникальными именами прогона и своей
 * уборкой в тесте: каталог и база общие с другими тестами.
 */

/** Цена за м² растёт на 100 с номером, площадь на 2 м²: объявления не склеиваются в дубли (ни площадью, ни ценой, ни этажом). */
export function segmentListingSpec(i: number, base = { perSqm: 10_000, area: 50 }) {
  const areaSqm = base.area + 2 * i;
  const pricePerSqm = base.perSqm + 100 * i;
  return { areaSqm, pricePerSqm, priceTjs: areaSqm * pricePerSqm, floor: 1 + (i % 9) };
}

/** Медиана по готовым числам (для сверки с серверной). */
export function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = (s.length - 1) / 2;
  return (s[Math.floor(mid)] + s[Math.ceil(mid)]) / 2;
}

export async function seedMarketListings(
  runId: string,
  districtName: string,
  rooms: number,
  count: number,
  over: Record<string, unknown> = {},
  tag = "seg"
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const s = segmentListingSpec(i);
    const l = await prisma.marketListing.create({
      data: {
        source: "somon.tj",
        sourceId: `${runId}-${tag}-${districtName}-${rooms}-${i}`,
        sourceUrl: `https://somon.tj/adv/${runId}-${tag}-${rooms}-${i}`,
        dealType: "SALE",
        propertyType: "APARTMENT",
        city: "Душанбе",
        districtName,
        rooms,
        areaSqm: s.areaSqm,
        floor: s.floor,
        price: s.priceTjs,
        currency: "TJS",
        priceTjs: s.priceTjs,
        pricePerSqmTjs: s.pricePerSqm,
        title: `Объявление ${tag} ${i}`,
        isActive: true,
        lastSeenAt: new Date(),
        raw: catalogRaw({}),
        ...over,
      },
    });
    ids.push(l.id);
  }
  return ids;
}

/** Агент для теста; телефон уникален по прогону. */
export async function makeAgent(runId: string, prefix: string, role: "AGENT" | "ADMIN" | "DIRECTOR" = "AGENT") {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  return prisma.agent.create({
    data: { fullName: `Агент ${prefix} ${runId}`, phone: `+99298${prefix}${runId.slice(-7)}`, role, passwordHash },
  });
}
