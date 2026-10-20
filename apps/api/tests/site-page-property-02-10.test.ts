/**
 * Страница сайта → объект (ревизия бота 02.10.2026): номер берётся только из
 * последнего сегмента пути, блог и новости объектом не считаются.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { resolvePropertyFromPageUrl } from "../src/lib/resolvePropertyFromPageUrl.js";

const LISTING = 1_900_000_000 + (Date.now() % 1_000_000);
let propertyId = "";

beforeAll(async () => {
  const district = await prisma.district.findFirst({ select: { id: true } });
  const p = await prisma.property.create({
    data: {
      title: `Ревизия 02.10 ${LISTING}`,
      districtId: district?.id,
      address: "Тестовая, 25",
      condition: "GOOD",
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 54,
      price: 41000,
      currency: "USD",
      siteListingId: LISTING,
      publishedOnSite: true,
    },
  });
  propertyId = p.id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: propertyId } });
});

describe("страница сайта → объект", () => {
  it("/listing/<n> и ЧПУ с номером в конце — объект", async () => {
    expect(await resolvePropertyFromPageUrl(`https://royalhome.tj/listing/${LISTING}`)).toBe(propertyId);
    expect(await resolvePropertyFromPageUrl(`https://royalhome.tj/kvartiry/2-komn-sino-${LISTING}?utm=x`)).toBe(propertyId);
  });
  it("номер не в конце пути или блог — не объект", async () => {
    expect(await resolvePropertyFromPageUrl(`https://royalhome.tj/blog/${LISTING}`)).toBeNull();
    expect(await resolvePropertyFromPageUrl(`https://royalhome.tj/listing/${LISTING}/photos`)).toBeNull();
    expect(await resolvePropertyFromPageUrl(`https://royalhome.tj/${LISTING}-sovetov/kak-kupit`)).toBeNull();
  });
});

import { extractMentionedPropertyNumber } from "../src/ai/propertyMentionGuard.js";

describe("номер объекта в словах клиента", () => {
  it.each([
    ["ОБ-000118", "118"],
    ["объект ОБ-000118", "118"],
    ["объекти рақами 118", "118"],
    ["объект под номером 118", "118"],
    ["Хочу №7 посмотреть", "7"],
  ])("«%s» → %s", (text, n) => {
    expect(extractMentionedPropertyNumber(text)).toBe(n);
  });
  it.each(["дом №5, кв 3", "ул. Рудаки 45, кв. №12", "продаю квартиру в доме №25", "расскажите об 3-комнатной"])(
    "«%s» — адрес или предлог, не объект",
    (text) => {
      expect(extractMentionedPropertyNumber(text)).toBeNull();
    }
  );
});
