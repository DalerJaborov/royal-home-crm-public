import { afterAll, describe, expect, it } from "vitest";
import {
  checkAdAccountAlerts,
  checkAdDisapprovedAlerts,
  DEBT_ALERT_TJS,
  debtStep,
  disapprovedAlertText,
  evaluateAccountAlerts,
} from "../src/lib/ads/adAlerts.js";
import { prisma } from "../src/db.js";
import type { AdAccountDetails, MetaAdsCredentials } from "../src/lib/ads/metaAdsApi.js";

/**
 * ТРЕВОГИ ДИРЕКТОРУ, ВОЛНА 1 «РЕКЛАМА» (03.10.2026): отклонённое объявление, не прошедший
 * платёж / растущий долг, деньги кончились. Чистая логика порогов + устойчивая к
 * рестарту дедупликация (shouldAlert по tag в базе, а не переменная процесса).
 */

const runId = Date.now();
const accountId = `act_alerts_${runId}`;

const account = (extra: Partial<AdAccountDetails> = {}): AdAccountDetails => ({
  id: accountId,
  name: "Кабинет теста",
  currency: "USD",
  fundingSource: "Visa •• 4242",
  balance: 0,
  spendCap: null,
  timezone: "Asia/Dushanbe",
  amountSpent: 0,
  accountStatus: 1,
  disableReason: 0,
  ...extra,
});

describe("debtStep — «растущий долг» без хранения истории", () => {
  it("ниже порога — null; на пороге — 0; на каждом удвоении — следующая ступень", () => {
    expect(debtStep(null)).toBeNull();
    expect(debtStep(DEBT_ALERT_TJS - 1)).toBeNull();
    expect(debtStep(DEBT_ALERT_TJS)).toBe(0);
    expect(debtStep(DEBT_ALERT_TJS * 1.99)).toBe(0);
    expect(debtStep(DEBT_ALERT_TJS * 2)).toBe(1);
    expect(debtStep(DEBT_ALERT_TJS * 4.5)).toBe(2);
    expect(debtStep(Number.NaN)).toBeNull();
  });
});

describe("evaluateAccountAlerts — пороги по одному кабинету", () => {
  it("здоровый кабинет — тишина", () => {
    expect(evaluateAccountAlerts(account(), 0)).toEqual([]);
  });

  it("не прошёл платёж (UNSETTLED) — одна тревога по статусу, не две", () => {
    const alerts = evaluateAccountAlerts(account({ accountStatus: 3 }), 0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe("status:3");
    expect(alerts[0].title).toMatch(/платёж/i);
  });

  it("отключён — в тексте код причины; любой неактивный статус даёт тревогу", () => {
    const [alert] = evaluateAccountAlerts(account({ accountStatus: 2, disableReason: 3 }), 0);
    expect(alert.key).toBe("status:2");
    expect(alert.body).toContain("код причины 3");
    expect(evaluateAccountAlerts(account({ accountStatus: 999 }), 0)[0].key).toBe("status:999");
  });

  it("лимит расхода достигнут: потрачено ≥ лимита; без лимита (0 или null) тревоги нет", () => {
    expect(evaluateAccountAlerts(account({ spendCap: 100, amountSpent: 100 }), 0)[0].key).toBe("cap");
    expect(evaluateAccountAlerts(account({ spendCap: 100, amountSpent: 99.99 }), 0)).toEqual([]);
    expect(evaluateAccountAlerts(account({ spendCap: null, amountSpent: 5000 }), 0)).toEqual([]);
    expect(evaluateAccountAlerts(account({ spendCap: 0, amountSpent: 5000 }), 0)).toEqual([]);
  });

  it("долг: новая ступень — новый ключ (другой tag, поэтому дедуп не глушит рост)", () => {
    const first = evaluateAccountAlerts(account({ balance: 120 }), DEBT_ALERT_TJS)[0];
    const grown = evaluateAccountAlerts(account({ balance: 260 }), DEBT_ALERT_TJS * 2.1)[0];
    expect(first.key).toBe("debt:0");
    expect(grown.key).toBe("debt:1");
    expect(grown.title).toMatch(/растёт/);
    expect(evaluateAccountAlerts(account({ balance: 5 }), 50)).toEqual([]);
  });

  it("три повода сразу — три разные тревоги", () => {
    const alerts = evaluateAccountAlerts(
      account({ accountStatus: 9, spendCap: 10, amountSpent: 10, balance: 500 }),
      DEBT_ALERT_TJS * 3
    );
    expect(alerts.map((a) => a.key)).toEqual(["status:9", "cap", "debt:1"]);
  });
});

describe("disapprovedAlertText", () => {
  it("называет объявление и причину по-русски", () => {
    const t = disapprovedAlertText("№107+№55", "DISAPPROVED");
    expect(t.title).toBe("Объявление отклонено Meta");
    expect(t.body).toContain("№107+№55");
    expect(t.body).toContain("отклонено модерацией");
    expect(disapprovedAlertText("x", "WITH_ISSUES").body).toContain("проблемы");
  });
});

const creds: MetaAdsCredentials = { enabled: true, token: "t", adAccountIds: [accountId] };
const queued = (tagPrefix: string) =>
  prisma.pendingDirectorAlert.findMany({ where: { tag: { startsWith: tagPrefix } }, orderBy: { createdAt: "asc" } });

const adIds: string[] = [];
afterAll(async () => {
  await prisma.pendingDirectorAlert.deleteMany({
    where: { OR: [{ tag: { startsWith: `ads-account:${accountId}` } }, { tag: { in: adIds.map((id) => `ads-disapproved:${id}`) } }] },
  });
  await prisma.ad.deleteMany({ where: { id: { in: adIds } } });
  await prisma.$disconnect();
});

describe("checkAdAccountAlerts — дедупликация переживает рестарт", () => {
  const deps = (details: AdAccountDetails | null) => ({
    credentials: async () => creds,
    details: async () => details,
  });

  it("кабинет не подключён — ноль, в Meta не ходим", async () => {
    let called = false;
    const sent = await checkAdAccountAlerts(new Date(), {
      credentials: async () => ({ enabled: false, token: null, adAccountIds: [] }),
      details: async () => {
        called = true;
        return null;
      },
    });
    expect(sent).toBe(0);
    expect(called).toBe(false);
  });

  it("кабинет не ответил (null) — тишина: ложное «деньги кончились» хуже пропуска", async () => {
    expect(await checkAdAccountAlerts(new Date(), deps(null))).toBe(0);
  });

  it("повторный запуск того же состояния не дублирует уведомление; рост долга — новое", async () => {
    const t0 = new Date();
    // Состояние: платёж не прошёл. «Рестарт» — это просто второй вызов: в процессе нет флага,
    // который мог бы потеряться, дедуп целиком в базе.
    const unsettled = account({ accountStatus: 3 });
    expect(await checkAdAccountAlerts(t0, deps(unsettled))).toBe(1);
    expect(await checkAdAccountAlerts(t0, deps(unsettled))).toBe(0);
    expect(await queued(`ads-account:${accountId}:status:3`)).toHaveLength(1);

    // Через сутки причина всё ещё стоит — напоминаем (окно 20 часов), но не чаще.
    const nextDay = new Date(t0.getTime() + 24 * 3_600_000);
    expect(await checkAdAccountAlerts(nextDay, deps(unsettled))).toBe(1);

    // Долг дорос до порога и потом удвоился: каждая ступень — своё уведомление один раз.
    // Курс из Настроек в тестовой базе может быть любым, поэтому баланс берём с запасом: 1e6 долларов.
    const debt = account({ balance: 1_000_000 });
    const first = await checkAdAccountAlerts(t0, deps(debt));
    expect(first).toBe(1);
    expect(await checkAdAccountAlerts(t0, deps(debt))).toBe(0);
    const grown = await checkAdAccountAlerts(t0, deps(account({ balance: 4_000_000 })));
    expect(grown).toBe(1);
    const debtRows = (await queued(`ads-account:${accountId}:debt:`)).map((r) => r.tag);
    expect(new Set(debtRows).size).toBe(2);
  });

  it("тревога уходит директору, маркетингу и админу со ссылкой на /ads", async () => {
    const rows = await queued(`ads-account:${accountId}:status:3`);
    expect(rows[0].url).toBe("/ads");
    expect(rows[0].recipientRoles.sort()).toEqual(["ADMIN", "DIRECTOR", "MARKETING"]);
  });
});

describe("checkAdDisapprovedAlerts — одно уведомление на объявление", () => {
  it("отклонённое свежее объявление — один раз; старое без трат и не отклонённое — молчим", async () => {
    const base = { platform: "META" as const, adAccountId: "act_alerts", lastSyncedAt: new Date() };
    const fresh = await prisma.ad.create({
      data: { ...base, externalId: `alerts-fresh-${runId}`, name: `Тест-отклонено ${runId}`, status: "DISAPPROVED", createdTime: new Date() },
    });
    const stale = await prisma.ad.create({
      data: {
        ...base,
        externalId: `alerts-stale-${runId}`,
        name: `Тест-старое ${runId}`,
        status: "DISAPPROVED",
        createdTime: new Date(Date.now() - 200 * 86_400_000),
      },
    });
    const fine = await prisma.ad.create({
      data: { ...base, externalId: `alerts-fine-${runId}`, name: `Тест-живое ${runId}`, status: "ACTIVE", createdTime: new Date() },
    });
    adIds.push(fresh.id, stale.id, fine.id);

    const first = await checkAdDisapprovedAlerts();
    expect(first).toBeGreaterThanOrEqual(1);
    const again = await checkAdDisapprovedAlerts();
    expect(again).toBe(0);

    expect(await queued(`ads-disapproved:${fresh.id}`)).toHaveLength(1);
    expect(await queued(`ads-disapproved:${stale.id}`)).toHaveLength(0);
    expect(await queued(`ads-disapproved:${fine.id}`)).toHaveLength(0);
    const [row] = await queued(`ads-disapproved:${fresh.id}`);
    expect(row.url).toBe("/ads");
    expect(row.body).toContain(`Тест-отклонено ${runId}`);
  });

  it("отправленные не вытесняют новые: 35 отклонённых доходят все, хотя за проход берётся не больше 30 кандидатов", async () => {
    const base = { platform: "META" as const, adAccountId: "act_alerts", lastSyncedAt: new Date() };
    const now = Date.now();
    const mine: string[] = [];
    for (let i = 0; i < 35; i++) {
      const ad = await prisma.ad.create({
        data: {
          ...base,
          externalId: `alerts-many-${runId}-${i}`,
          name: `Тест-много-${runId}-${i}`,
          status: "DISAPPROVED",
          // Старые по времени создания идут в выборке позже: после трёх проходов (3 × 10 отправлено)
          // в «первых 30» остались бы только уже отправленные, а хвост не доходил бы никогда.
          createdTime: new Date(now - i * 1000),
        },
      });
      mine.push(ad.id);
      adIds.push(ad.id);
    }
    for (let pass = 0; pass < 12; pass++) {
      if ((await checkAdDisapprovedAlerts()) === 0) break;
    }
    for (const id of mine) {
      expect(await queued(`ads-disapproved:${id}`), id).toHaveLength(1);
    }
  });
});
