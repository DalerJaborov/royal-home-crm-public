import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { checkAdAlerts } from "../src/lib/ads/adAlerts.js";
import { loadMoneyContext } from "../src/lib/money.js";

/**
 * CHANNEL-NEW-17 (аудит 04.10.2026): сигналы рекламы складывали AdSpendDaily.spend
 * без учёта валюты и сравнивали с долларовыми порогами. Кабинет в сомони с 20
 * сомони и нулём обращений получал «потратили от $15». Часы уведены в 2033 год,
 * как в ad-alerts.test.ts: окно содержит только собственные строки файла.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
let clock = Date.UTC(2033, 4, 10, 6, 0, 0);
function nextDay() {
  clock += DAY_MS;
  vi.setSystemTime(new Date(clock));
}
const runId = Date.now();
const adIds: string[] = [];
const seenAlertIds = new Set<string>();

async function makeAd() {
  const ad = await prisma.ad.create({
    data: { platform: "META", externalId: `a2-alerts-cur-${runId}-${adIds.length}`, name: `Объявление ${adIds.length}`, campaignName: `Кампания-${runId}-${adIds.length}` },
  });
  adIds.push(ad.id);
  return ad;
}
async function spend(adId: string, daysAgo: number, amount: number, currency: "USD" | "TJS", conversations: number) {
  await prisma.adSpendDaily.create({ data: { adId, date: new Date(clock - daysAgo * DAY_MS), spend: amount, currency, conversations } });
}
async function run() {
  const sent = await checkAdAlerts();
  const rows = await prisma.pendingDirectorAlert.findMany({ where: { tag: "ads-alert", id: { notIn: [...seenAlertIds] } } });
  for (const r of rows) seenAlertIds.add(r.id);
  return { sent, alerts: rows };
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(clock));
});
beforeEach(async () => {
  await prisma.adSpendDaily.deleteMany({ where: { adId: { in: adIds } } });
});
afterAll(async () => {
  await prisma.adSpendDaily.deleteMany({ where: { adId: { in: adIds } } });
  await prisma.ad.deleteMany({ where: { id: { in: adIds } } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { id: { in: [...seenAlertIds] } } });
  vi.useRealTimers();
  await prisma.$disconnect();
});

describe("сигналы рекламы считают деньги в одной валюте (CHANNEL-NEW-17)", () => {
  it("кабинет в сомони: 20 сомони без обращений это около 2 долларов, «без отдачи» молчит", async () => {
    nextDay();
    const ad = await makeAd();
    await spend(ad.id, 2, 20, "TJS", 0);
    expect(await run()).toMatchObject({ sent: 0, alerts: [] });
  });

  it("сомони и доллары вперемешку: цена обращения считается в долларах", async () => {
    nextDay();
    const { usdToTjs } = await loadMoneyContext();
    const ad = await makeAd();
    // Прошлая неделя: 10 обращений на сумму в сомони, равную $10, то есть $1 за обращение.
    await spend(ad.id, 10, 10 * usdToTjs, "TJS", 10);
    // Эта неделя: $40 на 4 обращения, то есть $10 за обращение.
    await spend(ad.id, 2, 40, "USD", 4);
    const { sent, alerts } = await run();
    expect(sent).toBe(1);
    expect(alerts[0]?.title).toBe("Обращения из рекламы подорожали вдвое");
    expect(alerts[0]?.body).toContain("$1.00");
    expect(alerts[0]?.body).toContain("$10.00");
  });

  it("настоящий перерасход в долларах по-прежнему сигналит", async () => {
    nextDay();
    const ad = await makeAd();
    await spend(ad.id, 2, 20, "USD", 0);
    const { alerts } = await run();
    expect(alerts.map((a) => a.title)).toContain("Реклама тратит без отдачи");
  });
});
