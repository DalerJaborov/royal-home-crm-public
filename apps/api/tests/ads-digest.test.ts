import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compareCostPerLead,
  formatAdsDigestLine,
  loadAdsYesterdaySummary,
  MIN_LEADS_FOR_TREND,
} from "../src/lib/ads/adsDigest.js";
import { prisma } from "../src/db.js";
import { dushanbeDateString, dushanbeInputToDate } from "../src/lib/dushanbeTime.js";
import { loadMorningNumbers } from "../src/lib/morningNumbers.js";
import { centsToTjs, fromCents, loadMoneyContext, toCents } from "../src/lib/money.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * РЕКЛАМА В УТРЕННЕЙ СВОДКЕ ДИРЕКТОРУ (волна 1, 03.10.2026): строка «потрачено / обращения /
 * клиенты в CRM / цена клиента» с отметкой тренда. Печатается, только когда кабинет
 * подключён и вчера были траты; тренд молчит, пока данных мало.
 */

describe("compareCostPerLead — тренд цены клиента", () => {
  it("данных мало (меньше клиентов, чем порог) — null, а не выдуманный тренд", () => {
    expect(compareCostPerLead({ spendCents: 1000, leads: MIN_LEADS_FOR_TREND - 1 }, { spendCents: 1000, leads: 10 })).toBeNull();
    expect(compareCostPerLead({ spendCents: 1000, leads: 10 }, { spendCents: 1000, leads: 0 })).toBeNull();
    expect(compareCostPerLead({ spendCents: 0, leads: 10 }, { spendCents: 1000, leads: 10 })).toBeNull();
  });

  it("дороже / дешевле / как раньше", () => {
    // Было 100 за клиента, стало 150 → +50 %.
    expect(compareCostPerLead({ spendCents: 1500, leads: 10 }, { spendCents: 1000, leads: 10 })).toEqual({ trend: "up", pct: 50 });
    expect(compareCostPerLead({ spendCents: 700, leads: 10 }, { spendCents: 1000, leads: 10 })).toEqual({ trend: "down", pct: 30 });
    expect(compareCostPerLead({ spendCents: 1050, leads: 10 }, { spendCents: 1000, leads: 10 })).toEqual({ trend: "flat", pct: 5 });
  });
});

describe("formatAdsDigestLine", () => {
  const base = { spendTjs: 1234, conversations: 12, leads: 4, costPerLeadTjs: 308.5, trend: null, trendPct: null } as const;

  it("полная строка с ростом цены", () => {
    const line = formatAdsDigestLine({ ...base, trend: "up", trendPct: 18 });
    expect(line).toContain("Реклама вчера");
    expect(line).toContain("потрачено 1 234 с.");
    expect(line).toContain("12 обращений по Meta");
    expect(line).toContain("клиентов в CRM 4");
    expect(line).toMatch(/цена клиента 30[89]/);
    expect(line).toContain("дороже на 18% к прошлой неделе");
  });

  it("клиентов нет — честно «клиентов в CRM нет», цены клиента в строке нет", () => {
    const line = formatAdsDigestLine({ ...base, leads: 0, costPerLeadTjs: null });
    expect(line).toContain("клиентов в CRM нет");
    expect(line).not.toContain("цена клиента");
    expect(line).not.toContain("недел");
  });

  it("дешевле и «как на прошлой неделе»; один обращение склоняется", () => {
    expect(formatAdsDigestLine({ ...base, trend: "down", trendPct: 25 })).toContain("дешевле на 25%");
    expect(formatAdsDigestLine({ ...base, trend: "flat", trendPct: 3 })).toContain("как на прошлой неделе");
    expect(formatAdsDigestLine({ ...base, conversations: 1 })).toContain("1 обращение по Meta");
  });
});

describe("loadAdsYesterdaySummary — на базе", () => {
  const runId = Date.now();
  const yesterdayIso = dushanbeDateString(new Date(Date.now() - 86_400_000));
  const agentIds: string[] = [];
  const clientIds: string[] = [];
  const adIds: string[] = [];
  let savedEnabled = false;
  let expectedCents = 0;

  beforeAll(async () => {
    const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
    savedEnabled = settings.metaAdsEnabled;
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaAdsEnabled: true } });

    const agent = await prisma.agent.create({
      data: { fullName: "Агент сводка-реклама", phone: `+992977${runId}`, role: "AGENT", passwordHash: "x" },
    });
    agentIds.push(agent.id);

    const ad = await prisma.ad.create({
      data: {
        platform: "META",
        externalId: `digest-${runId}`,
        name: `Тест-сводка ${runId}`,
        adAccountId: "act_digest",
        status: "ACTIVE",
        lastSyncedAt: new Date(),
      },
    });
    adIds.push(ad.id);
    await prisma.adSpendDaily.create({
      data: {
        adId: ad.id,
        date: new Date(`${yesterdayIso}T00:00:00.000Z`),
        spend: 40,
        currency: "USD",
        impressions: 100,
        clicks: 5,
        conversations: 6,
      },
    });
    expectedCents = centsToTjs(toCents(40), "USD", await loadMoneyContext());

    // Два клиента вчера (по Душанбе), один из Корзины — не считается.
    for (let i = 0; i < 3; i++) {
      const c = await prisma.client.create({
        data: {
          fullName: `Тест-сводка-клиент-${runId}-${i}`,
          phone: `+992978${runId}${i}`,
          source: "INSTAGRAM",
          kind: "BUYER",
          currency: "TJS",
          assignedAgentId: agent.id,
          sourceAdId: ad.externalId,
          createdAt: dushanbeInputToDate(yesterdayIso, "12:00"),
          ...(i === 2 ? { deletedAt: new Date() } : {}),
        },
      });
      clientIds.push(c.id);
    }
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.adSpendDaily.deleteMany({ where: { adId: { in: adIds } } });
    await prisma.ad.deleteMany({ where: { id: { in: adIds } } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaAdsEnabled: savedEnabled } });
    await deleteAgentsWithTraces(agentIds);
    await prisma.$disconnect();
  });

  it("траты вчера + клиенты вчера: цифры сходятся с фикстурой, тренда нет (мало клиентов)", async () => {
    const summary = await loadAdsYesterdaySummary();
    expect(summary).not.toBeNull();
    expect(summary!.spendTjs).toBe(fromCents(expectedCents));
    expect(summary!.conversations).toBe(6);
    expect(summary!.leads).toBe(2);
    expect(summary!.costPerLeadTjs).toBe(fromCents(Math.round(expectedCents / 2)));
    expect(summary!.trend).toBeNull();
  });

  it("кабинет не подключён — рекламы в сводке нет вовсе", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaAdsEnabled: false } });
    expect(await loadAdsYesterdaySummary()).toBeNull();
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaAdsEnabled: true } });
  });

  it("вчера трат не было — строки нет", async () => {
    // Смотрим из «будущего»: «вчера» относительно now+10 дней — день без строк расхода.
    expect(await loadAdsYesterdaySummary(new Date(Date.now() + 10 * 86_400_000))).toBeNull();
  });

  it("loadMorningNumbers: рекламу считает только по просьбе — прежние читатели не платят запросами", async () => {
    const without = await loadMorningNumbers();
    expect(without.adsYesterday ?? null).toBeNull();
    const withAds = await loadMorningNumbers({ ads: true });
    expect(withAds.adsYesterday?.leads).toBe(2);
  });
});
