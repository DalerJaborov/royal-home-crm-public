import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { recordBaselinePage, recordNewObservations, rekeySellerPage } from "../src/lib/somonLeads/discoveryStore.js";
import { countSomonSellerAdverts } from "../src/lib/somonLeads/sellerCount.js";
import { cleanupSomonReceipts } from "../src/lib/somonLeads/deliveryStore.js";
import { readFileSync } from "node:fs";
import { somonKeyFingerprint, somonSellerKey } from "../src/lib/somonLeads/contactIdentity.js";

// Счёт объявлений автора в категории «Квартиры, продажа, Душанбе» по нашим записям выдачи.
const ids = ["987653001", "987653002", "987653003", "987653004", "987653005", "987653006"];
let previousMonitor: Awaited<ReturnType<typeof prisma.somonMonitor.findUnique>> = null;
const start = new Date("2026-11-01T10:00:00Z"), later = new Date("2026-11-01T10:00:01Z");
describe("Somon seller advert count in the category", () => {
  beforeAll(async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "1".repeat(64));
    previousMonitor = await prisma.somonMonitor.findUnique({ where: { id: "singleton" } });
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ids } } });
    await prisma.somonMonitor.upsert({ where: { id: "singleton" }, create: { id: "singleton", enabled: true }, update: { enabled: true, baselineAt: null, activatedAt: null, baselineNextPage: 1, baselineLastPage: null } });
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { contactKeyFingerprint: somonKeyFingerprint() } });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ids } } });
    if (previousMonitor) await prisma.somonMonitor.update({ where: { id: "singleton" }, data: previousMonitor });
    else await prisma.somonMonitor.deleteMany({ where: { id: "singleton" } });
  });
  it("stores only a keyed author fingerprint and counts baseline adverts too", async () => {
    // Старое объявление автора 7101 попало в baseline, новое — в обычный проход.
    expect(await recordBaselinePage(1, 1, [{ id: ids[0], sellerId: "7101" }, { id: ids[1], sellerId: "7102" }], start)).toBe("complete");
    expect(await recordNewObservations([{ id: ids[2], slug: `${ids[2]}_stand`, sellerId: "7101" }, { id: ids[3], slug: `${ids[3]}_stand`, sellerId: "7103" }], later)).toBe(2);
    const row = await prisma.somonSeenAdvert.findUniqueOrThrow({ where: { advertId: ids[0] } });
    expect(row.sellerKey).toBe(somonSellerKey("7101"));
    expect(row.sellerKey).not.toContain("7101");
    expect(await countSomonSellerAdverts(somonSellerKey("7101"))).toBe(2);
    expect(await countSomonSellerAdverts(somonSellerKey("7103"))).toBe(1);
  });
  it("does not count an advert confirmed gone", async () => {
    await prisma.somonSeenAdvert.update({ where: { advertId: ids[0] }, data: { status: "UNAVAILABLE" } });
    expect(await countSomonSellerAdverts(somonSellerKey("7101"))).toBe(1);
    await prisma.somonSeenAdvert.update({ where: { advertId: ids[0] }, data: { status: "BASELINE" } });
  });
  it("keeps the count per author: a record without an author does not poison others", async () => {
    expect(await countSomonSellerAdverts(null)).toBeNull();
    expect(await recordNewObservations([{ id: ids[4], slug: `${ids[4]}_stand`, sellerId: null }], later)).toBe(1);
    await prisma.somonSeenAdvert.create({ data: { advertId: ids[5], baseline: true, status: "BASELINE" } });
    expect(await countSomonSellerAdverts(somonSellerKey("7103"))).toBe(1);
    expect(await countSomonSellerAdverts(somonSellerKey("7101"))).toBe(2);
  });
  it("fills the author key of an older unkeyed record and requeues a deferred advert", async () => {
    await prisma.somonSeenAdvert.update({ where: { advertId: ids[4] }, data: { status: "SELLER_UNKNOWN", seenAt: later } });
    expect(await recordNewObservations([{ id: ids[4], slug: `${ids[4]}_stand`, sellerId: "7104" }, { id: ids[5], slug: `${ids[5]}_stand`, sellerId: "7103" }], new Date(later.getTime() + 1000))).toBe(0);
    const deferred = await prisma.somonSeenAdvert.findUniqueOrThrow({ where: { advertId: ids[4] } });
    expect(deferred.sellerKey).toBe(somonSellerKey("7104"));
    expect(deferred.status).toBe("PENDING");
    expect((await prisma.somonSeenAdvert.findUniqueOrThrow({ where: { advertId: ids[5] } })).status).toBe("BASELINE");
    expect(await countSomonSellerAdverts(somonSellerKey("7103"))).toBe(2);
  });
  it("expires a deferred advert whose author never appears", async () => {
    await prisma.somonSeenAdvert.update({ where: { advertId: ids[4] }, data: { status: "SELLER_UNKNOWN", seenAt: new Date("2026-10-01T00:00:00Z") } });
    await cleanupSomonReceipts(new Date("2026-11-01T10:00:00Z"));
    const row = await prisma.somonSeenAdvert.findUniqueOrThrow({ where: { advertId: ids[4] } });
    expect(row.status).toBe("EXPIRED");
    expect(row.slug).toBeNull();
  });
  it("migration keeps the active baseline and schedules a soft author-key rekey instead", async () => {
    const sql = readFileSync(new URL("../prisma/migrations/20261101190000_somon_seller_key/migration.sql", import.meta.url), "utf8");
    const code = sql.replace(/--[^\n]*\n/g, "\n");
    // Сброса baseline нет: рассылка на проде не останавливается.
    expect(code).not.toMatch(/"baselineAt"\s*=\s*NULL|"activatedAt"\s*=\s*NULL|'EXPIRED'/);
    const updates = code.split(";").map(x => x.trim()).filter(x => x.startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    await prisma.somonSeenAdvert.update({ where: { advertId: ids[3] }, data: { status: "PENDING", slug: `${ids[3]}_stand` } });
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { baselineAt: start, activatedAt: start, baselineNextPage: 5, baselineLastPage: 4, sellerKeyRekeyPage: null } });
    await prisma.$executeRawUnsafe(updates[0]);
    const state = await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(state.baselineAt).toEqual(start); expect(state.activatedAt).toEqual(start); expect(state.sellerKeyRekeyPage).toBe(1);
    expect((await prisma.somonSeenAdvert.findUniqueOrThrow({ where: { advertId: ids[3] } })).status).toBe("PENDING");
    // Проход дозаписи: ключ старой записи без автора, новых записей не создаёт.
    await prisma.somonSeenAdvert.update({ where: { advertId: ids[5] }, data: { sellerKey: null } });
    expect(await rekeySellerPage(1, 2, [{ id: ids[5], sellerId: "7105" }, { id: "987653099", sellerId: "7199" }], later)).toBe("saved");
    expect((await prisma.somonSeenAdvert.findUniqueOrThrow({ where: { advertId: ids[5] } })).sellerKey).toBe(somonSellerKey("7105"));
    expect(await prisma.somonSeenAdvert.findUnique({ where: { advertId: "987653099" } })).toBeNull();
    expect(await rekeySellerPage(1, 2, [], later)).toBe("stale");
    expect(await rekeySellerPage(2, 2, [], later)).toBe("complete");
    expect((await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } })).sellerKeyRekeyPage).toBeNull();
  });
});
