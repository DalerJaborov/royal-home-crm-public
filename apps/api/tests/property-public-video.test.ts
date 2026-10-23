import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { videoHandoffDir } from "../src/upload.js";
import {
  isPropertyVideoPublic,
  propertyPublicVideoUrl,
  type PublicVideoFacts,
} from "../src/lib/propertyPublicVideo.js";
import {
  buildProductVideoRows,
  renderProductVideoCsv,
  resetMetaProductVideoFeedCacheForTests,
} from "../src/lib/metaProductVideoFeed.js";
import { resetMetaCatalogFeedCacheForTests, type CatalogProperty } from "../src/lib/metaCatalogFeed.js";
import { hasPublishedPostId } from "../src/lib/publishedRawVideoRetention.js";

/**
 * Постоянная публичная ссылка на готовый ролик объекта (23.10.2026): правило
 * публичности, адрес с ?v=, товарный фид Meta с видео и сам роут отдачи mp4.
 */

const SITE_BASE = "https://royalhome.tj";
const CRM_BASE = "https://crm.example.tj";

function facts(overrides: Partial<PublicVideoFacts> = {}): PublicVideoFacts {
  return {
    shortId: 4242,
    status: "AVAILABLE",
    deletedAt: null,
    publishedOnSite: true,
    offSite: false,
    videoHandoffFinalPath: "handoff/final-a.mp4",
    publishedChannels: ["INSTAGRAM"],
    publishedPostIds: { INSTAGRAM: "17900000000" },
    ...overrides,
  };
}

describe("hasPublishedPostId — общее правило «ролик реально вышел»", () => {
  it("нужен непустой id у канала из списка каналов", () => {
    expect(hasPublishedPostId(["INSTAGRAM"], { INSTAGRAM: "1" })).toBe(true);
    expect(hasPublishedPostId(["INSTAGRAM"], { INSTAGRAM: "" })).toBe(false);
    expect(hasPublishedPostId(["INSTAGRAM"], { TELEGRAM: "1" })).toBe(false);
    expect(hasPublishedPostId([], { INSTAGRAM: "1" })).toBe(false);
    expect(hasPublishedPostId(["INSTAGRAM"], null)).toBe(false);
    expect(hasPublishedPostId(["INSTAGRAM"], ["INSTAGRAM"])).toBe(false);
  });
});

describe("isPropertyVideoPublic — каждое условие отказа", () => {
  it("всё на месте — публичен", () => {
    expect(isPropertyVideoPublic(facts())).toBe(true);
    expect(isPropertyVideoPublic(facts({ status: "RESERVED" }))).toBe(true);
    expect(isPropertyVideoPublic(facts({ status: "SOLD" }))).toBe(true);
  });

  it.each([
    ["удалён", { deletedAt: new Date() }],
    ["не на сайте", { publishedOnSite: false }],
    ["offSite", { offSite: true }],
    ["статус WITHDRAWN", { status: "WITHDRAWN" }],
    ["нет готового файла", { videoHandoffFinalPath: null }],
    ["нет каналов", { publishedChannels: [] }],
    ["id поста пуст", { publishedPostIds: { INSTAGRAM: "" } }],
    ["id поста другого канала", { publishedPostIds: { TELEGRAM: "5" } }],
    ["publishedPostIds не объект", { publishedPostIds: null }],
  ])("%s — не публичен", (_name, override) => {
    expect(isPropertyVideoPublic(facts(override as Partial<PublicVideoFacts>))).toBe(false);
  });
});

describe("propertyPublicVideoUrl", () => {
  it("адрес вида <crm>/api/v1/public/property-video/<shortId>.mp4?v=<хэш>", () => {
    const url = propertyPublicVideoUrl(facts(), CRM_BASE)!;
    expect(url).toMatch(/^https:\/\/crm\.example\.tj\/api\/v1\/public\/property-video\/4242\.mp4\?v=[0-9a-f]{10}$/);
  });

  it("?v= меняется при смене файла (перемонтаж) и не зависит от папки", () => {
    const a = propertyPublicVideoUrl(facts({ videoHandoffFinalPath: "handoff/final-a.mp4" }), CRM_BASE);
    const b = propertyPublicVideoUrl(facts({ videoHandoffFinalPath: "handoff/final-b.mp4" }), CRM_BASE);
    const aElsewhere = propertyPublicVideoUrl(facts({ videoHandoffFinalPath: "/other/dir/final-a.mp4" }), CRM_BASE);
    expect(a).not.toBe(b);
    expect(a).toBe(aElsewhere);
  });

  it("нет адреса CRM или ролик не публичен — undefined", () => {
    expect(propertyPublicVideoUrl(facts(), undefined)).toBeUndefined();
    expect(propertyPublicVideoUrl(facts({ publishedChannels: [] }), CRM_BASE)).toBeUndefined();
  });
});

function catalogProperty(overrides: Record<string, unknown>): CatalogProperty {
  return {
    id: "prop-1",
    ...facts(),
    title: "Квартира, \"люкс\"",
    description: "Просторная",
    type: "APARTMENT",
    rooms: 2,
    price: 450000,
    currency: "TJS",
    siteListingId: null,
    lat: null,
    lng: null,
    socialCoverSquareUrl: null,
    district: { name: "Сино", city: "Душанбе", lat: 38.55, lng: 68.78 },
    photos: [{ url: "/uploads/a.jpg" }, { url: "/uploads/b.jpg" }],
    ...overrides,
  } as unknown as CatalogProperty;
}

describe("buildProductVideoRows / renderProductVideoCsv", () => {
  const opts = { siteBase: SITE_BASE, crmBase: CRM_BASE, usdToTjsRate: 11 };

  it("в фид попадают только объекты с публичным роликом", () => {
    const rows = buildProductVideoRows(
      [
        catalogProperty({ id: "a", shortId: 1 }),
        catalogProperty({ id: "b", shortId: 2, publishedChannels: [] }),
        catalogProperty({ id: "c", shortId: 3, videoHandoffFinalPath: null }),
      ],
      opts
    );
    expect(rows.map((r) => r.id)).toEqual(["1"]);
  });

  it("поля строки: id=shortId, цена в TJS, ссылка, первая картинка, бренд, видео, район", () => {
    const [row] = buildProductVideoRows([catalogProperty({ shortId: 77, siteListingId: 9 })], opts);
    expect(row.id).toBe("77");
    expect(row.condition).toBe("new");
    expect(row.availability).toBe("in stock");
    expect(row.price).toBe("450000 TJS");
    expect(row.link).toBe(`${SITE_BASE}/listing/9`);
    expect(row.image_link).toBe(`${CRM_BASE}/uploads/a.jpg`);
    expect(row.brand).toBe("Royal Home");
    expect(row["video[0].url"]).toMatch(/\/api\/v1\/public\/property-video\/77\.mp4\?v=[0-9a-f]{10}$/);
    expect(row.custom_label_0).toBe("Сино");
  });

  it("доллары пересчитываются по курсу как в home-listings; SOLD — out of stock", () => {
    const [row] = buildProductVideoRows([catalogProperty({ currency: "USD", price: 40000, status: "SOLD" })], opts);
    expect(row.price).toBe("440000 TJS");
    expect(row.availability).toBe("out of stock");
  });

  it("пустое описание заменяется названием; нет фото или адреса CRM — объекта нет", () => {
    const [row] = buildProductVideoRows([catalogProperty({ description: "  " })], opts);
    expect(row.description).toBe(row.title);
    expect(buildProductVideoRows([catalogProperty({ photos: [] })], opts)).toHaveLength(0);
    expect(buildProductVideoRows([catalogProperty({})], { ...opts, crmBase: undefined })).toHaveLength(0);
  });

  it("CSV: заголовок колонок Meta, экранирование кавычек, \\r\\n", () => {
    const csv = renderProductVideoCsv(buildProductVideoRows([catalogProperty({})], opts));
    const [header, line] = csv.split("\r\n");
    expect(header).toBe(
      ["id", "title", "description", "availability", "condition", "price", "link", "image_link", "brand", "video[0].url", "custom_label_0"]
        .map((h) => `"${h}"`)
        .join(",")
    );
    expect(line).toContain('"Квартира, ""люкс"""');
    expect(renderProductVideoCsv([]).split("\r\n")).toHaveLength(1);
  });
});

describe("публичные роуты ролика и фида (стенд)", () => {
  const runId = Date.now();
  const KEY = `test-video-feed-key-${runId}`;
  const fileName = `public-video-test-${runId}.mp4`;
  const filePath = path.join(videoHandoffDir, fileName);
  const bytes = Buffer.from("0123456789abcdef-fake-mp4-bytes");
  let districtId: string;
  let publicId: string;
  let publicShortId: number;
  let hiddenShortId: number;
  const createdIds: string[] = [];
  let savedSettings: { metaCatalogFeedEnabled: boolean; metaCatalogFeedKey: string | null } | null = null;

  async function makeProperty(extra: Record<string, unknown>) {
    const property = await prisma.property.create({
      data: {
        title: `Объект ролика ${runId}`,
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
        ...extra,
      } as never,
    });
    createdIds.push(property.id);
    await prisma.propertyPhoto.create({
      data: { propertyId: property.id, url: "/uploads/test-video.jpg", thumbUrl: "/uploads/test-video.jpg", order: 0 },
    });
    return property;
  }

  const savedCrmUrl = process.env.CRM_PUBLIC_URL;

  beforeAll(async () => {
    process.env.CRM_PUBLIC_URL = CRM_BASE;
    fs.mkdirSync(videoHandoffDir, { recursive: true });
    fs.writeFileSync(filePath, bytes);

    const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
    savedSettings = { metaCatalogFeedEnabled: settings.metaCatalogFeedEnabled, metaCatalogFeedKey: settings.metaCatalogFeedKey };
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaCatalogFeedEnabled: true, metaCatalogFeedKey: KEY } });

    districtId = (await prisma.district.create({ data: { name: `Тест-район-видео-${runId}`, lat: 38.55, lng: 68.78 } })).id;

    const published = await makeProperty({
      videoHandoffFinalPath: path.join(videoHandoffDir, fileName),
      publishedChannels: ["INSTAGRAM"],
      publishedPostIds: { INSTAGRAM: "17900000001" },
    });
    publicId = published.id;
    publicShortId = published.shortId;

    // Файл есть, но ролик ещё не опубликован ни в одном канале.
    const hidden = await makeProperty({ videoHandoffFinalPath: path.join(videoHandoffDir, fileName) });
    hiddenShortId = hidden.shortId;

    resetMetaCatalogFeedCacheForTests();
    resetMetaProductVideoFeedCacheForTests();
  });

  afterAll(async () => {
    await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: createdIds } } }).catch(() => {});
    await prisma.property.deleteMany({ where: { id: { in: createdIds } } }).catch(() => {});
    await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
    if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings }).catch(() => {});
    fs.rmSync(filePath, { force: true });
    if (savedCrmUrl === undefined) delete process.env.CRM_PUBLIC_URL;
    else process.env.CRM_PUBLIC_URL = savedCrmUrl;
    resetMetaProductVideoFeedCacheForTests();
  });

  it("публичный ролик: 200, video/mp4, кэш на сутки, Range отдаёт кусок", async () => {
    const res = await request(app).get(`/api/v1/public/property-video/${publicShortId}.mp4`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("video/mp4");
    expect(res.headers["cache-control"]).toContain("max-age=86400");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect((res.body as Buffer).equals(bytes)).toBe(true);

    const part = await request(app).get(`/api/v1/public/property-video/${publicShortId}.mp4`).set("Range", "bytes=0-9");
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 0-9/${bytes.length}`);
  });

  it("ролик не опубликован — 404; несуществующий объект и кривой адрес — 404", async () => {
    expect((await request(app).get(`/api/v1/public/property-video/${hiddenShortId}.mp4`)).status).toBe(404);
    expect((await request(app).get("/api/v1/public/property-video/999999999.mp4")).status).toBe(404);
    expect((await request(app).get(`/api/v1/public/property-video/${publicShortId}.mov`)).status).toBe(404);
    expect((await request(app).get("/api/v1/public/property-video/..%2F..%2Fetc.mp4")).status).toBe(404);
  });

  it("файла нет на диске — 404 без подробностей", async () => {
    await prisma.property.update({ where: { id: publicId }, data: { videoHandoffFinalPath: `missing-${runId}.mp4` } });
    const res = await request(app).get(`/api/v1/public/property-video/${publicShortId}.mp4`);
    expect(res.status).toBe(404);
    expect(res.text).toBe("");
    await prisma.property.update({ where: { id: publicId }, data: { videoHandoffFinalPath: path.join(videoHandoffDir, fileName) } });
  });

  it("products-video.csv: без ключа и с неверным ключом — 404", async () => {
    expect((await request(app).get("/api/v1/public/meta-catalog/products-video.csv")).status).toBe(404);
    expect((await request(app).get("/api/v1/public/meta-catalog/products-video.csv?key=wrong")).status).toBe(404);
  });

  it("products-video.csv с ключом: только объект с опубликованным роликом", async () => {
    resetMetaProductVideoFeedCacheForTests();
    const res = await request(app).get(`/api/v1/public/meta-catalog/products-video.csv?key=${KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.text.split("\r\n");
    expect(lines[0]).toContain('"video[0].url"');
    expect(res.text).toContain(`"${publicShortId}"`);
    expect(res.text).not.toContain(`"${hiddenShortId}","`);
  });

  it("products-video.csv: тумблер выключен — 404", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaCatalogFeedEnabled: false } });
    const res = await request(app).get(`/api/v1/public/meta-catalog/products-video.csv?key=${KEY}`);
    expect(res.status).toBe(404);
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaCatalogFeedEnabled: true } });
  });
});
