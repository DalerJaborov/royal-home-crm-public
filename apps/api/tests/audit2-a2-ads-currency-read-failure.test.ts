import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * ADS-ROOT02 (аудит 04.10.2026): временный сбой чтения валюты кабинета
 * (`fields=currency`) возвращал «USD», и синхронизация переписывала уже
 * сохранённый расход 600 TJS как 600 USD. Теперь отказ чтения не подставляет
 * доллар: берётся последняя сохранённая валюта кабинета, а если её нет, расход
 * кабинета в этом тике не пишется.
 *
 * Мокается всё, кроме самого чтения валюты: оно идёт через настоящий
 * fetchAdAccountCurrency и подставной fetch.
 */
const state = vi.hoisted(() => ({
  account: "",
  externalId: "",
  day: "2031-06-15",
  currencyReply: "fail" as "fail" | "TJS" | "USD",
}));

vi.mock("../src/lib/ads/metaAdsApi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ads/metaAdsApi.js")>()),
  loadMetaAdsCredentials: vi.fn(async () => ({ enabled: true, token: "t", adAccountIds: [state.account] })),
  isMetaAdsConfigured: () => true,
  fetchMetaAds: vi.fn(async () => []),
  fetchMetaAdSets: vi.fn(async () => ({ byId: new Map(), partial: false })),
  fetchMetaAdDailyStats: vi.fn(async () => [
    { adId: state.externalId, adName: "x", date: state.day, spend: 600, impressions: 10, reach: 9, clicks: 1, conversations: 0 },
  ]),
  fetchAccountSpendTotal: vi.fn(async () => 0),
}));

const { syncMetaAds } = await import("../src/lib/ads/syncMetaAds.js");

const runId = Date.now().toString(36);
const externalIds: string[] = [];

function stubGraph() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("fields=currency")) {
        if (state.currencyReply === "fail") {
          return new Response(JSON.stringify({ error: { code: 100, message: "temporary" } }), { status: 400 });
        }
        return new Response(JSON.stringify({ currency: state.currencyReply }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    })
  );
}

async function makeAdWithRow(account: string, currency: "USD" | "TJS" | null) {
  const externalId = `a2cur-${runId}-${externalIds.length}`;
  externalIds.push(externalId);
  const ad = await prisma.ad.create({
    data: { platform: "META", externalId, adAccountId: account, name: `Тест валюты ${externalId}`, excluded: false },
  });
  if (currency) {
    await prisma.adSpendDaily.create({
      data: { adId: ad.id, date: new Date(`${state.day}T00:00:00.000Z`), spend: 500, currency },
    });
  }
  return { ad, externalId };
}

beforeEach(() => stubGraph());
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await prisma.adSpendDaily.deleteMany({ where: { ad: { externalId: { in: externalIds } } } });
  await prisma.ad.deleteMany({ where: { externalId: { in: externalIds } } });
});

describe("синхронизация расходов: отказ чтения валюты кабинета (ADS-ROOT02)", () => {
  it("сбой чтения валюты не превращает сохранённые сомони в доллары", async () => {
    state.account = `act_a2${runId}1`;
    const { ad, externalId } = await makeAdWithRow(state.account, "TJS");
    state.externalId = externalId;
    state.currencyReply = "fail";

    await syncMetaAds(1);

    const row = await prisma.adSpendDaily.findFirstOrThrow({ where: { adId: ad.id } });
    expect(row.currency).toBe("TJS");
    expect(Number(row.spend)).toBe(600);
  });

  it("сбой чтения валюты без сохранённой истории: расход кабинета не пишется", async () => {
    state.account = `act_a2${runId}2`;
    const { ad, externalId } = await makeAdWithRow(state.account, null);
    state.externalId = externalId;
    state.currencyReply = "fail";

    await syncMetaAds(1);

    expect(await prisma.adSpendDaily.count({ where: { adId: ad.id } })).toBe(0);
  });

  it("успешное чтение валюты: поведение прежнее, пишется валюта кабинета", async () => {
    state.account = `act_a2${runId}3`;
    const { ad, externalId } = await makeAdWithRow(state.account, "USD");
    state.externalId = externalId;
    state.currencyReply = "TJS";

    await syncMetaAds(1);

    const row = await prisma.adSpendDaily.findFirstOrThrow({ where: { adId: ad.id } });
    expect(row.currency).toBe("TJS");
  });
});
