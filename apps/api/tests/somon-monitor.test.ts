import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ source: vi.fn(), process: vi.fn() }));
vi.mock("../src/lib/somonLeads/sourceClient.js", () => ({ fetchSomon: mocks.source, SomonSourceUnavailable: class SomonSourceUnavailable extends Error { reason = "not_ready"; } }));
vi.mock("../src/lib/somonLeads/processPending.js", () => ({ processSomonPending: mocks.process }));
import { prisma } from "../src/db.js";
import { clearlyOlderThanTenMinutes, runSomonMonitorTick } from "../src/lib/somonLeads/monitor.js";
import { somonKeyFingerprint, somonSellerKey } from "../src/lib/somonLeads/contactIdentity.js";
const ids = ["987652001", "987652002", "987652003"];
let oldMonitor: Awaited<ReturnType<typeof prisma.somonMonitor.findUnique>> = null;
function html(adIds: string[]) {
  const ads = adIds.map(id => ({ id: Number(id), title: "Квартира", url: `/adv/${id}_stand/`, ad_type: { type: "regular" }, user: { id: 7000 + Number(id.slice(-1)) } }));
  const data = JSON.stringify({ next_page: `?page=2&page_size=${adIds.length}`, rubric: { slug: "prodazha-kvartir" }, location_ids: [1], adverts: ads });
  return `<a href="?page=2">2</a><script>self.__next_f.push([1,${JSON.stringify(data)}]);</script>`;
}
describe("Somon monitor baseline", () => {
  beforeAll(async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "1".repeat(64));
    oldMonitor = await prisma.somonMonitor.findUnique({ where: { id: "singleton" } });
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ids } } });
    await prisma.somonMonitor.upsert({ where: { id: "singleton" }, create: { id: "singleton", enabled: true }, update: { enabled: true, activatedAt: null, baselineAt: null, baselineNextPage: 1, baselineLastPage: null, nextScanAt: null, scanPage: 1, scanRegularPage: null, scanLeaseToken: null, scanLeaseUntil: null, sourceStopped: false, blockedUntil: null } });
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { contactKeyFingerprint: somonKeyFingerprint() } });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ids } } });
    if (oldMonitor) await prisma.somonMonitor.update({ where: { id: "singleton" }, data: oldMonitor });
    else await prisma.somonMonitor.deleteMany({ where: { id: "singleton" } });
  });
  it("marks existing ads without delivery then queues only a later observation", async () => {
    mocks.source.mockImplementation(async (path: string) => new Response(html(path.includes("page=2") ? [ids[1]] : [ids[0]])));
    mocks.process.mockResolvedValue("sent");
    await runSomonMonitorTick(async () => {});
    expect(mocks.process).not.toHaveBeenCalled();
    expect((await prisma.somonSeenAdvert.findUnique({ where: { advertId: ids[0] } }))?.baseline).toBe(true);
    // Ключ автора пишется и в baseline — иначе счёт объявлений продавца был бы занижен.
    expect((await prisma.somonSeenAdvert.findUnique({ where: { advertId: ids[0] } }))?.sellerKey).toBe(somonSellerKey("7001"));
    await new Promise(resolve => setTimeout(resolve, 5));
    mocks.source.mockImplementation(async (path: string) => new Response(html(path.includes("page=2") ? [ids[1]] : [ids[0], ids[2]])));
    await runSomonMonitorTick(async () => {});
    expect(mocks.process).toHaveBeenCalledTimes(1);
    expect(mocks.process.mock.calls[0][0]).toBe(ids[2]);
    expect((await prisma.somonSeenAdvert.findUniqueOrThrow({ where: { advertId: ids[2] } })).lastCheckedAt).not.toBeNull();
  });
  it("does not treat an ambiguous 'today' as an old timestamp", () => {
    expect(clearlyOlderThanTenMinutes("Сегодня")).toBe(false);
    expect(clearlyOlderThanTenMinutes("9 минут назад")).toBe(false);
    expect(clearlyOlderThanTenMinutes("11 минут назад")).toBe(true);
    expect(clearlyOlderThanTenMinutes("2 часа назад")).toBe(true);
  });
  it("confirms a shrinking end before completing an empty baseline page", async () => {
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { enabled: true, baselineAt: null, activatedAt: null, baselineNextPage: 2, baselineLastPage: 2, blockedUntil: null, sourceStopped: false } });
    mocks.source.mockImplementation(async (path: string) => new Response(path.includes("page=2") ? html([]) : html([ids[0]]).replaceAll('?page=2', '?page=1')));
    await runSomonMonitorTick(async () => {});
    expect((await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } })).baselineAt).not.toBeNull();
  });
});
