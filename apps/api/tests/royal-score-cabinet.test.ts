import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { buildRoyalScoreView } from "../src/lib/royalScore.js";
import { dushanbeStartOfToday } from "../src/lib/dushanbeTime.js";

/**
 * Кабинет Royal Score (спецификация владельца, «Личный кабинет агента»): два
 * места («в компании» и «среди активных агентов») и динамика за день/неделю/месяц.
 * Плюс TOP AGENTS — сделки/конверсия/активные клиенты за месяц, наружу.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let targetId: string; // тот, для кого считаем кабинет
let targetToken: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-кабинет-${runId}` } })).id;

  targetId = (
    await prisma.agent.create({
      // kpi 100, а не 70: /top-agents отдаёт первую сотню по убыванию KPI, и на
      // общей базе, где учёток от прошлых прогонов больше сотни, агент с
      // серединным KPI в выдачу не попадал — тест падал на исправном коде
      // (поймано 10.09.2026 локально; на чистой базе CI проходил всегда).
      // На проверяемые поля KPI не влияет: сделок, конверсии и активных клиентов
      // у свежего агента всё равно нет.
      data: { fullName: "Целевой агент", phone: `+992971${runId}`, role: "AGENT", passwordHash, kpi: 100 },
    })
  ).id;
  targetToken = await login(`+992971${runId}`);

  const startOfToday = dushanbeStartOfToday();
  const daysAgo = (n: number) => new Date(startOfToday.getTime() - n * 24 * 60 * 60 * 1000);
  await prisma.kpiDailyScore.createMany({
    data: [
      { agentId: targetId, date: daysAgo(1), score: 60 },
      { agentId: targetId, date: daysAgo(8), score: 55 },
      { agentId: targetId, date: daysAgo(32), score: 40 },
    ],
  });
});

afterAll(async () => {
  await prisma.kpiDailyScore.deleteMany({ where: { agentId: targetId } });
  await prisma.agent.deleteMany({ where: { id: targetId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Кабинет: два места", () => {
  /**
   * В базе тестов уже живут другие агенты (сиды, соседние файлы) — точное место
   * или общее число заранее не предсказать. Проверяем не абсолютные цифры, а
   * РАЗНИЦУ до/после: агент, поставленный на паузу (isActive: false), обязан
   * пропасть из «среди активных», но остаться «в компании» — это и есть весь
   * смысл двух мест.
   */
  it("«среди активных» не считает приостановленного, «в компании» — считает", async () => {
    const before = await buildRoyalScoreView(targetId);
    expect(before).not.toBeNull();

    const pausedId = (
      await prisma.agent.create({
        data: {
          fullName: "Приостановленный агент",
          phone: `+992972${runId}`,
          role: "AGENT",
          passwordHash: "x",
          kpi: 50,
          isActive: false,
        },
      })
    ).id;
    try {
      const after = await buildRoyalScoreView(targetId);
      expect(after!.totalAgents).toBe(before!.totalAgents);
      expect(after!.rank).toBe(before!.rank);
      expect(after!.totalCompanyAgents).toBe(before!.totalCompanyAgents + 1);
      // Ниже целевого (50 < 70) — место в компании у целевого агента не меняется.
      expect(after!.companyRank).toBe(before!.companyRank);
    } finally {
      await prisma.agent.deleteMany({ where: { id: pausedId } });
    }
  });
});

describe("Кабинет: динамика за день/неделю/месяц", () => {
  it("считает разницу с ближайшей записью истории на нужную глубину", async () => {
    const view = await buildRoyalScoreView(targetId);
    // Без единого события в журнале computeRoyalScore даёт стартовый балл (100
    // по умолчанию, см. scoreJournal.ts) — тот же живой счёт, что и в дельтах ниже.
    expect(view!.liveScore).toBe(100);
    expect(view!.dynamics.day).toBe(100 - 60);
    expect(view!.dynamics.week).toBe(100 - 55);
    expect(view!.dynamics.month).toBe(100 - 40);
  });

  it("глубина без данных даёт null, а не ноль", async () => {
    const fresh = (
      await prisma.agent.create({
        data: { fullName: "Агент без истории", phone: `+992973${runId}`, role: "AGENT", passwordHash: "x", kpi: 80 },
      })
    ).id;
    const view = await buildRoyalScoreView(fresh);
    expect(view!.dynamics.day).toBeNull();
    expect(view!.dynamics.week).toBeNull();
    expect(view!.dynamics.month).toBeNull();
    await prisma.agent.deleteMany({ where: { id: fresh } });
  });
});

describe("TOP AGENTS: сделки/конверсия/активные клиенты", () => {
  it("отдаёт три коммерческих поля по спецификации владельца", async () => {
    const res = await request(app)
      .get("/api/v1/hall-of-fame/top-agents")
      .set("Authorization", `Bearer ${targetToken}`);
    expect(res.status).toBe(200);
    const mine = (res.body.agents as { id: string; dealsCount: number; conversion: number | null; activeClients: number }[]).find(
      (a) => a.id === targetId
    );
    expect(mine).toBeDefined();
    expect(mine!.dealsCount).toBe(0);
    expect(mine!.conversion).toBeNull();
    expect(mine!.activeClients).toBe(0);
  });
});
