import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import {
  buildHomeListingRows,
  renderHomeListingCsv,
  resetMetaCatalogFeedCacheForTests,
  type CatalogProperty,
  type HomeListingRow,
} from "../src/lib/metaCatalogFeed.js";

/**
 * Фид каталога Meta для рекламы (28.09.2026, docs/agent-briefs/meta-catalog-feed-28-09.md).
 *
 * Два независимых блока: чистые функции (без БД, без стенда) и сам публичный
 * роут (нужен стенд — читает Settings из базы).
 */

const SITE_BASE = "https://royalhome.tj";
const CRM_BASE = "https://crm.example.tj";

/** Минимальный набор полей, которые реально читает buildHomeListingRows —
 *  остальные скаляры Property функции не нужны, приводим типом. */
function catalogProperty(overrides: Record<string, unknown>): CatalogProperty {
  return {
    id: "prop-1",
    shortId: 1001,
    title: "Тестовая квартира",
    description: "Просторная, светлая",
    type: "APARTMENT",
    rooms: 2,
    price: 450000,
    currency: "TJS",
    status: "AVAILABLE",
    siteListingId: null,
    lat: null,
    lng: null,
    socialCoverSquareUrl: null,
    district: { name: "Сино", city: "Душанбе", lat: 38.55, lng: 68.78 },
    photos: [{ url: "/uploads/a.jpg" }, { url: "/uploads/b.jpg" }],
    ...overrides,
  } as unknown as CatalogProperty;
}

describe("buildHomeListingRows — чистая функция", () => {
  it("AVAILABLE и RESERVED дают for_sale, SOLD — sold", () => {
    const rows = buildHomeListingRows(
      [
        catalogProperty({ id: "a", status: "AVAILABLE" }),
        catalogProperty({ id: "b", status: "RESERVED" }),
        catalogProperty({ id: "c", status: "SOLD" }),
      ],
      { siteBase: SITE_BASE, crmBase: CRM_BASE, usdToTjsRate: 11 }
    );
    expect(rows.map((r) => r.availability)).toEqual(["for_sale", "for_sale", "sold"]);
  });

  it("объект без своих координат берёт координаты района", () => {
    const [row] = buildHomeListingRows(
      [catalogProperty({ lat: null, lng: null, district: { name: "Сино", city: "Душанбе", lat: 38.55, lng: 68.78 } })],
      { siteBase: SITE_BASE, crmBase: CRM_BASE, usdToTjsRate: 11 }
    );
    expect(row.latitude).toBe("38.55");
    expect(row.longitude).toBe("68.78");
  });

  it("свои координаты объекта побеждают координаты района", () => {
    const [row] = buildHomeListingRows(
      [catalogProperty({ lat: 38.6, lng: 68.8, district: { name: "Сино", city: "Душанбе", lat: 38.55, lng: 68.78 } })],
      { siteBase: SITE_BASE, crmBase: CRM_BASE, usdToTjsRate: 11 }
    );
    expect(row.latitude).toBe("38.6");
    expect(row.longitude).toBe("68.8");
  });

  it("нет координат ни у объекта, ни у района — объект исключён из фида", () => {
    const rows = buildHomeListingRows([catalogProperty({ lat: null, lng: null, district: null })], {
      siteBase: SITE_BASE,
      crmBase: CRM_BASE,
      usdToTjsRate: 11,
    });
    expect(rows).toHaveLength(0);
  });

  it("цена всегда в TJS: доллары пересчитываются по курсу, сомони — как есть", () => {
    const [usd] = buildHomeListingRows([catalogProperty({ currency: "USD", price: 40000 })], {
      siteBase: SITE_BASE,
      crmBase: CRM_BASE,
      usdToTjsRate: 11,
    });
    expect(usd.price).toBe("440000 TJS");

    const [tjs] = buildHomeListingRows([catalogProperty({ currency: "TJS", price: 450000 })], {
      siteBase: SITE_BASE,
      crmBase: CRM_BASE,
      usdToTjsRate: 11,
    });
    expect(tjs.price).toBe("450000 TJS");
  });

  it("до 20 картинок, обложка первой", () => {
    const photos = Array.from({ length: 25 }, (_, i) => ({ url: `/uploads/${i}.jpg` }));
    const [row] = buildHomeListingRows(
      [catalogProperty({ photos, socialCoverSquareUrl: "/uploads/cover.jpg" })],
      { siteBase: SITE_BASE, crmBase: CRM_BASE, usdToTjsRate: 11 }
    );
    expect(row.images).toHaveLength(20);
    expect(row.images[0]).toBe(`${CRM_BASE}/uploads/cover.jpg`);
    expect(row.images[1]).toBe(`${CRM_BASE}/uploads/0.jpg`);
  });

  it("addr1 и neighborhood — название района, не адрес (точный адрес на публичные поверхности не выдаётся)", () => {
    const [row] = buildHomeListingRows(
      [catalogProperty({ district: { name: "Испечак", city: "Душанбе", lat: 38.5, lng: 68.7 } })],
      { siteBase: SITE_BASE, crmBase: CRM_BASE, usdToTjsRate: 11 }
    );
    expect(row.addr1).toBe("Испечак");
    expect(row.neighborhood).toBe("Испечак");
    expect(row.custom_label_0).toBe("Испечак");
  });

  it("без CRM_PUBLIC_URL (crmBase не задан) — ни одной картинки, объект исключён", () => {
    const rows = buildHomeListingRows([catalogProperty({})], {
      siteBase: SITE_BASE,
      crmBase: undefined,
      usdToTjsRate: 11,
    });
    expect(rows).toHaveLength(0);
  });

  it("ссылка на объект: по siteListingId, если он есть, иначе универсальный редирект by-crm", () => {
    const [withListingId] = buildHomeListingRows([catalogProperty({ siteListingId: 77 })], {
      siteBase: SITE_BASE,
      crmBase: CRM_BASE,
      usdToTjsRate: 11,
    });
    expect(withListingId.url).toBe(`${SITE_BASE}/listing/77`);

    const [byId] = buildHomeListingRows([catalogProperty({ id: "abc-123", siteListingId: null })], {
      siteBase: SITE_BASE,
      crmBase: CRM_BASE,
      usdToTjsRate: 11,
    });
    expect(byId.url).toBe(`${SITE_BASE}/listing/by-crm/abc-123`);
  });
});

describe("renderHomeListingCsv — экранирование и формат", () => {
  function row(overrides: Partial<HomeListingRow>): HomeListingRow {
    return {
      home_listing_id: "1",
      name: "Квартира",
      description: "",
      availability: "for_sale",
      addr1: "Сино",
      city: "Душанбе",
      region: "",
      country: "TJ",
      postal_code: "",
      latitude: "38.5",
      longitude: "68.7",
      neighborhood: "Сино",
      images: ["https://crm.example.tj/uploads/a.jpg"],
      listing_type: "for_sale",
      price: "450000 TJS",
      url: "https://royalhome.tj/listing/1",
      num_beds: "2",
      num_baths: "",
      property_type: "apartment",
      year_built: "",
      custom_label_0: "Сино",
      ...overrides,
    };
  }

  it("кавычки и запятые в тексте экранируются, строки разделены \\r\\n", () => {
    const csv = renderHomeListingCsv([row({ name: 'Квартира, "люкс"' })]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toContain('"Квартира, ""люкс"""');
    expect(csv.includes("\n") && !csv.includes("\r\n")).toBe(false);
  });

  it("заголовок содержит все колонки Meta в заданном порядке, включая image[0].url", () => {
    const csv = renderHomeListingCsv([row({})]);
    const header = csv.split("\r\n")[0];
    expect(header).toBe(
      [
        "home_listing_id",
        "name",
        "description",
        "availability",
        "address.addr1",
        "address.city",
        "address.region",
        "address.country",
        "address.postal_code",
        "latitude",
        "longitude",
        "neighborhood[0]",
        "image[0].url",
        "listing_type",
        "price",
        "url",
        "num_beds",
        "num_baths",
        "property_type",
        "year_built",
        "custom_label_0",
      ]
        .map((h) => `"${h}"`)
        .join(",")
    );
  });

  it("пустой список строк — только заголовок, без image[N].url колонок", () => {
    const csv = renderHomeListingCsv([]);
    expect(csv.split("\r\n")).toHaveLength(1);
    expect(csv).not.toContain("image[0]");
  });
});

describe("GET /api/v1/public/meta-catalog/home-listings.csv (стенд)", () => {
  const runId = Date.now();
  const KEY = `test-catalog-key-${runId}`;
  let districtId: string;
  let propertyId: string;
  let savedSettings: { metaCatalogFeedEnabled: boolean; metaCatalogFeedKey: string | null } | null = null;

  beforeAll(async () => {
    const settings = await prisma.settings.upsert({
      where: { id: "singleton" },
      update: {},
      create: { id: "singleton" },
    });
    savedSettings = { metaCatalogFeedEnabled: settings.metaCatalogFeedEnabled, metaCatalogFeedKey: settings.metaCatalogFeedKey };
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { metaCatalogFeedEnabled: true, metaCatalogFeedKey: KEY },
    });

    const district = await prisma.district.create({
      data: { name: `Тест-район-фид-${runId}`, lat: 38.55, lng: 68.78 },
    });
    districtId = district.id;

    const property = await prisma.property.create({
      data: {
        title: `Объект фида ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        rooms: 2,
        price: 450000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        status: "AVAILABLE",
        publishedOnSite: true,
        offSite: false,
      } as never,
    });
    propertyId = property.id;
    await prisma.propertyPhoto.create({ data: { propertyId, url: "/uploads/test-feed.jpg", thumbUrl: "/uploads/test-feed.jpg", order: 0 } });

    resetMetaCatalogFeedCacheForTests();
  });

  afterAll(async () => {
    await prisma.propertyPhoto.deleteMany({ where: { propertyId } }).catch(() => {});
    await prisma.property.delete({ where: { id: propertyId } }).catch(() => {});
    await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
    if (savedSettings) {
      await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings }).catch(() => {});
    }
    resetMetaCatalogFeedCacheForTests();
  });

  it("без ключа — 404", async () => {
    const res = await request(app).get("/api/v1/public/meta-catalog/home-listings.csv");
    expect(res.status).toBe(404);
  });

  it("с неверным ключом — 404 (не 401, не подтверждаем существование маршрута)", async () => {
    const res = await request(app).get("/api/v1/public/meta-catalog/home-listings.csv?key=wrong-key");
    expect(res.status).toBe(404);
  });

  it("с верным ключом — 200 и CSV в заголовке ответа", async () => {
    const res = await request(app).get(`/api/v1/public/meta-catalog/home-listings.csv?key=${KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
  });

  it("тумблер выключен — 404 даже с верным ключом", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaCatalogFeedEnabled: false } });
    const res = await request(app).get(`/api/v1/public/meta-catalog/home-listings.csv?key=${KEY}`);
    expect(res.status).toBe(404);
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaCatalogFeedEnabled: true } });
  });
});
