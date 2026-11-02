import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ source: vi.fn(), process: vi.fn(), save: vi.fn(), logError: vi.fn() }));
vi.mock("../src/lib/somonLeads/sourceClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/somonLeads/sourceClient.js")>()),
  fetchSomon: mocks.source,
}));
vi.mock("../src/lib/somonLeads/processPending.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/somonLeads/processPending.js")>()),
  processSomonPending: mocks.process,
}));
vi.mock("../src/lib/market/marketStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/market/marketStore.js")>()),
  saveListings: mocks.save,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: mocks.logError,
}));

import { prisma } from "../src/db.js";
import { ingestMarketPage, runSomonMonitorTick } from "../src/lib/somonLeads/monitor.js";
import { somonKeyFingerprint } from "../src/lib/somonLeads/contactIdentity.js";

const ids = ["987653001", "987653002"];
let oldMonitor: Awaited<ReturnType<typeof prisma.somonMonitor.findUnique>> = null;

function html(adIds: string[]) {
  const ads = adIds.map((id) => ({ id: Number(id), title: "2-комн. квартира, 50 м², 3/9 этаж", url: `/adv/${id}_stand/`, ad_type: { type: "regular" } }));
  const data = JSON.stringify({ next_page: `?page=2&page_size=${adIds.length}`, rubric: { slug: "prodazha-kvartir" }, location_ids: [1], adverts: ads });
  return `<a href="?page=2">2</a><script>self.__next_f.push([1,${JSON.stringify(data)}]);</script>`;
}

async function resetBaseline() {
  await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ids } } });
  await prisma.somonMonitor.update({
    where: { id: "singleton" },
    data: { enabled: true, activatedAt: null, baselineAt: null, baselineNextPage: 1, baselineLastPage: null, nextScanAt: null, scanPage: 1, scanRegularPage: null, scanLeaseToken: null, scanLeaseUntil: null, sourceStopped: false, blockedUntil: null },
  });
}

describe("рыночный каталог не влияет на лиды", () => {
  beforeAll(async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "1".repeat(64));
    oldMonitor = await prisma.somonMonitor.findUnique({ where: { id: "singleton" } });
    await prisma.somonMonitor.upsert({ where: { id: "singleton" }, create: { id: "singleton", enabled: true }, update: { enabled: true } });
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { contactKeyFingerprint: somonKeyFingerprint() } });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ids } } });
    if (oldMonitor) await prisma.somonMonitor.update({ where: { id: "singleton" }, data: oldMonitor });
    else await prisma.somonMonitor.deleteMany({ where: { id: "singleton" } });
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.logError.mockResolvedValue(undefined);
    mocks.process.mockResolvedValue("sent");
    mocks.source.mockImplementation(async (path: string) => new Response(html(path.includes("page=2") ? [ids[1]] : [ids[0]])));
    await resetBaseline();
  });

  it("ошибка saveListings не ломает тик лидов: разметка завершена, ошибка рынка только в журнале", async () => {
    mocks.save.mockRejectedValue(new Error("market db exploded"));
    await expect(runSomonMonitorTick(async () => {})).resolves.toBeUndefined();
    expect((await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } })).baselineAt).not.toBeNull();
    expect((await prisma.somonSeenAdvert.findUnique({ where: { advertId: ids[0] } }))?.baseline).toBe(true);
    // Каждая скачанная страница отдана рынку (без второго запроса к Somon).
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalled());
    expect(mocks.save.mock.calls[0][0]).toBe("somon.tj");
    expect(mocks.source).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(mocks.logError).toHaveBeenCalled());
    expect(String(mocks.logError.mock.calls[0][1])).not.toContain("market db exploded");
  });

  it("медленная запись в рынок не задерживает тик лидов, а пока она идёт — следующая страница пропускается", async () => {
    let release!: () => void;
    mocks.save.mockImplementation(() => new Promise((resolve) => (release = () => resolve({ created: 0, updated: 0, priceChanges: 0, skipped: 0 }))));
    const started = Date.now();
    await runSomonMonitorTick(async () => {});
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } })).baselineAt).not.toBeNull();
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    await ingestMarketPage(html([ids[0]])); // пропущено сразу: прошлая запись ещё идёт, ждать нечего
    expect(mocks.save).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(async () => {
      mocks.save.mockResolvedValue({ created: 0, updated: 0, priceChanges: 0, skipped: 0 });
      await ingestMarketPage(html([ids[0]]));
      expect(mocks.save.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("лиды выключены — парсер ничего не качает и рынку нечего отдавать", async () => {
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { enabled: false } });
    await runSomonMonitorTick(async () => {});
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
