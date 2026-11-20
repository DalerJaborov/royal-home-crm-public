import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * «РЕКЛАМА» ОТКРЫТА МАРКЕТИНГУ, ДЕНЬГИ КОМПАНИИ — НЕТ (ревью PR #336, 20.11.2026).
 *
 * /ads/board, /ads/report и /ads/property/:id доступны роли MARKETING и праву
 * marketing.access без finance.view. Расход на рекламу им виден (это их работа), а
 * доля компании в комиссии, окупаемость к ней и «прибыль по объекту» — деньги
 * компании: без finance.view сервер отдаёт null. Директору — числа.
 */
const runId = Date.now();
const sfx = String(runId).slice(-7);
const ids: string[] = [];
let marketingToken = "";
let directorToken = "";

beforeAll(async () => {
  const marketing = await prisma.agent.create({ data: { fullName: `Маркетинг деньги ${runId}`, phone: `+992936${sfx}`, role: "MARKETING", passwordHash: "x" } });
  const director = await prisma.agent.create({ data: { fullName: `Директор деньги ${runId}`, phone: `+992937${sfx}`, role: "DIRECTOR", passwordHash: "x" } });
  ids.push(marketing.id, director.id);
  marketingToken = signAccessToken({ sub: marketing.id, role: "MARKETING" });
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
});

describe("комиссия и окупаемость рекламы — только с finance.view", () => {
  it("доска: маркетолог видит расход, но не комиссию и окупаемость; директор — видит", async () => {
    const mk = await request(app).get("/api/v1/ads/board?preset=30d").set("Authorization", `Bearer ${marketingToken}`);
    expect(mk.status).toBe(200);
    expect(typeof mk.body.totals.periodTjs).toBe("number");
    const stats = mk.body.totals.leadStats;
    expect(stats).toBeTruthy();
    expect(stats.commissionTjs).toBeNull();
    expect(stats.romi).toBeNull();
    for (const row of mk.body.rows as { leadStats?: { commissionTjs: unknown; romi: unknown } }[]) {
      if (row.leadStats) {
        expect(row.leadStats.commissionTjs).toBeNull();
        expect(row.leadStats.romi).toBeNull();
      }
    }
    const dir = await request(app).get("/api/v1/ads/board?preset=30d").set("Authorization", `Bearer ${directorToken}`);
    expect(dir.status).toBe(200);
    expect(typeof dir.body.totals.leadStats.commissionTjs).toBe("number");
  });

  it("отчёт по объектам: у маркетолога нет прибыли и комиссии по проданному объекту", async () => {
    const mk = await request(app).get("/api/v1/ads/report?preset=all").set("Authorization", `Bearer ${marketingToken}`);
    expect(mk.status).toBe(200);
    for (const row of mk.body.rows as { profitTjs: unknown; commissionTjs: unknown }[]) {
      expect(row.profitTjs).toBeNull();
      expect(row.commissionTjs).toBeNull();
    }
  });
});
