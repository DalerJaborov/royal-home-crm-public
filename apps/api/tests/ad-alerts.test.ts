import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { checkAdAlerts } from "../src/lib/ads/adAlerts.js";

/**
 * СИГНАЛЫ РЕКЛАМЫ: до 25.09.2026 до этого файла не дотягивался ни один тест.
 *
 * `lib/ads/adAlerts.ts` — из списка файлов сервера без тестов (CLAUDE.md,
 * замер 22.09.2026). Он шлёт руководству два сигнала (обращение подорожало
 * вдвое; объявление тратит без отдачи) и делает это молча: сигнал, который
 * перестал приходить, ничем себя не выдаёт.
 *
 * ПОЧЕМУ ЧАСЫ УВЕДЕНЫ В 2031 ГОД, А НЕ ПОДСАЖЕНЫ ДАННЫЕ.
 *
 * Обе проверки считаются по ВСЕЙ таблице `adSpendDaily` за последние 7 и 14
 * дней, а в ту же таблицу пишут `ads-routes.test.ts` и
 * `ad-spend-matching.test.ts`. Тест на пороги («меньше $10 — молчим») зависел
 * бы от чужих строк — ровно тот класс хрупкости, из-за которого 25.09 уже
 * чинили `calls-section.test.ts`. Удалять чужое нельзя, и не нужно: `toFake:
 * ["Date"]` уводит «сейчас» на пять лет вперёд, и в семидневку попадают только
 * собственные строки этого файла — чужие (август-июль 2026 и «сегодня»)
 * остаются далеко за окном. Фальшивые только часы: таймеры настоящие, база и
 * Prisma работают как обычно.
 *
 * Второй побочный эффект тех же часов приятный: дедуп «раз в сутки на сигнал»
 * держится в памяти модуля по ДНЮ ДУШАНБЕ, поэтому каждый сценарий живёт в
 * своём собственном дне, а сам дедуп проверяется отдельно.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Первый день выдуманного окна: далеко и от «сегодня», и от дат чужих тестов. */
let clock = Date.UTC(2031, 4, 10, 6, 0, 0);

/** Следующий сценарий — следующие сутки: суточный дедуп сигналов сбрасывается сам. */
function nextDay(): Date {
  clock += DAY_MS;
  const now = new Date(clock);
  vi.setSystemTime(now);
  return now;
}

const runId = Date.now();
const adIds: string[] = [];
/** Строки очереди алармов, созданные ЭТИМ файлом: чужие не читаем и не трогаем. */
const seenAlertIds = new Set<string>();

async function makeAd(extra: Record<string, unknown> = {}) {
  const ad = await prisma.ad.create({
    data: {
      platform: "META",
      externalId: `ad-alerts-${runId}-${adIds.length}`,
      name: `Объявление ${adIds.length}`,
      campaignName: `Кампания-${runId}-${adIds.length}`,
      ...extra,
    },
  });
  adIds.push(ad.id);
  return ad;
}

/** Дневная строка расхода: `daysAgo` отсчитывается от выдуманного «сейчас». */
async function spend(adId: string, daysAgo: number, usd: number, conversations: number) {
  await prisma.adSpendDaily.create({
    data: {
      adId,
      date: new Date(clock - daysAgo * DAY_MS),
      spend: usd,
      currency: "USD",
      conversations,
    },
  });
}

/** Вызов проверки + только те строки очереди, которые появились из-за него. */
async function run(): Promise<{ sent: number; alerts: { title: string; body: string; url: string | null; recipientRoles: string[]; tag: string | null }[] }> {
  const sent = await checkAdAlerts();
  const rows = await prisma.pendingDirectorAlert.findMany({
    where: { tag: "ads-alert", id: { notIn: [...seenAlertIds] } },
  });
  for (const r of rows) seenAlertIds.add(r.id);
  return { sent, alerts: rows };
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(clock));
});

beforeEach(async () => {
  // Каждому сценарию — чистое окно из СВОИХ объявлений (чужие строки за окном).
  await prisma.adSpendDaily.deleteMany({ where: { adId: { in: adIds } } });
});

afterAll(async () => {
  await prisma.adSpendDaily.deleteMany({ where: { adId: { in: adIds } } });
  await prisma.ad.deleteMany({ where: { id: { in: adIds } } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { id: { in: [...seenAlertIds] } } });
  vi.useRealTimers();
  await prisma.$disconnect();
});

describe("сигнал «обращения подорожали вдвое»", () => {
  it("цена выросла с $1 до $10 за обращение — аларм с обеими цифрами", async () => {
    nextDay();
    const ad = await makeAd();
    await spend(ad.id, 10, 10, 10); // предыдущая семидневка: $1 за обращение
    await spend(ad.id, 2, 40, 4); // последняя семидневка: $10 за обращение

    const { sent, alerts } = await run();
    expect(sent).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe("Обращения из рекламы подорожали вдвое");
    expect(alerts[0].body).toContain("$1.00");
    expect(alerts[0].body).toContain("$10.00");
  });

  it("выросла, но не вдвое — молчим", async () => {
    nextDay();
    const ad = await makeAd();
    await spend(ad.id, 10, 10, 10); // $1.00
    await spend(ad.id, 2, 19, 10); // $1.90 — меньше двукратного
    expect(await run()).toMatchObject({ sent: 0, alerts: [] });
  });

  it("за неделю потрачено меньше $10 — молчим, даже если подорожало вдевятеро", async () => {
    nextDay();
    const ad = await makeAd();
    await spend(ad.id, 10, 1, 1); // $1.00
    await spend(ad.id, 2, 9, 1); // $9.00 — но вся неделя дешевле порога
    expect(await run()).toMatchObject({ sent: 0, alerts: [] });
  });

  it("в прошлой семидневке обращений не было — сравнивать не с чем, молчим", async () => {
    nextDay();
    const ad = await makeAd();
    await spend(ad.id, 10, 20, 0);
    await spend(ad.id, 2, 40, 4);
    const { alerts } = await run();
    expect(alerts.map((a) => a.title)).not.toContain("Обращения из рекламы подорожали вдвое");
  });
});

describe("сигнал «реклама тратит без отдачи»", () => {
  it("$20 за неделю и ни одного обращения — аларм называет кампанию", async () => {
    nextDay();
    const ad = await makeAd();
    await spend(ad.id, 3, 20, 0);

    const { sent, alerts } = await run();
    expect(sent).toBe(1);
    expect(alerts[0].title).toBe("Реклама тратит без отдачи");
    expect(alerts[0].body).toContain("1 объявл.");
    expect(alerts[0].body).toContain(ad.campaignName!);
  });

  it("$14 без отдачи — ниже порога, молчим", async () => {
    nextDay();
    const ad = await makeAd();
    await spend(ad.id, 3, 14, 0);
    expect(await run()).toMatchObject({ sent: 0, alerts: [] });
  });

  it("потратило много, но обращения есть — молчим", async () => {
    nextDay();
    const ad = await makeAd();
    await spend(ad.id, 3, 50, 2);
    await spend(ad.id, 10, 50, 2); // цена обращения та же — второй сигнал тоже молчит
    expect(await run()).toMatchObject({ sent: 0, alerts: [] });
  });

  it("объявление помечено «исключено» — в счёт не идёт", async () => {
    nextDay();
    const ad = await makeAd({ excluded: true });
    await spend(ad.id, 3, 50, 0);
    expect(await run()).toMatchObject({ sent: 0, alerts: [] });
  });

  it("строка старше недели — за окном, молчим", async () => {
    nextDay();
    const ad = await makeAd();
    await spend(ad.id, 9, 50, 0);
    expect(await run()).toMatchObject({ sent: 0, alerts: [] });
  });
});

describe("доставка и дедуп", () => {
  it("аларм уходит в очередь руководству, а не пушем в ночь", async () => {
    nextDay();
    const ad = await makeAd();
    await spend(ad.id, 3, 20, 0);

    const { alerts } = await run();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].url).toBe("/ads");
    expect(alerts[0].tag).toBe("ads-alert");
    expect([...alerts[0].recipientRoles].sort()).toEqual(["ADMIN", "DIRECTOR", "MARKETING"]);
  });

  it("второй вызов в тот же день душанбинских суток ничего не шлёт", async () => {
    nextDay();
    const ad = await makeAd();
    await spend(ad.id, 3, 20, 0);

    expect((await run()).sent).toBe(1);
    const second = await run();
    expect(second.sent).toBe(0);
    expect(second.alerts).toEqual([]);
  });

  it("на следующие сутки сигнал приходит снова", async () => {
    nextDay();
    const ad = await makeAd();
    await spend(ad.id, 3, 20, 0);
    expect((await run()).sent).toBe(1);

    // Те же данные, но сутки новые: строки переставляем относительно нового «сейчас».
    nextDay();
    await prisma.adSpendDaily.deleteMany({ where: { adId: ad.id } });
    await spend(ad.id, 3, 20, 0);
    expect((await run()).sent).toBe(1);
  });
});
