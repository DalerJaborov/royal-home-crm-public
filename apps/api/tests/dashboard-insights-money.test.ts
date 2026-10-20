import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * «ПРОГНОЗ ПЛАНА» В /dashboard/insights — ДЕНЬГИ КОМПАНИИ, ТОЛЬКО С finance.view
 * (28.09.2026).
 *
 * Роут открыт правом dashboard.analytics, которое есть и у менеджера. Комиссия
 * по месяцам в соседнем /dashboard/charts уже закрыта finance.view, а прогноз
 * плана (комиссия месяца, план, прогноз к концу месяца) уходил по сети всем с
 * аналитикой. Теперь менеджер без денег получает `planForecast: null`, а
 * остальные три виджета — как прежде.
 */

const runId = String(Date.now()).slice(-7);
let directorToken = "";
let managerToken = "";
const agentIds: string[] = [];

beforeAll(async () => {
  await prisma.agent.deleteMany({ where: { phone: { in: [`+99281${runId}`, `+99282${runId}`] } } });
  const director = await prisma.agent.create({
    data: { fullName: `Директор прогноз ${runId}`, phone: `+99281${runId}`, role: "DIRECTOR", passwordHash: "x" },
  });
  const manager = await prisma.agent.create({
    data: { fullName: `Менеджер прогноз ${runId}`, phone: `+99282${runId}`, role: "MANAGER", passwordHash: "x" },
  });
  agentIds.push(director.id, manager.id);
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
  managerToken = signAccessToken({ sub: manager.id, role: "MANAGER" });
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

function insights(token: string) {
  return request(app).get("/api/v1/dashboard/insights").set("Authorization", `Bearer ${token}`);
}

describe("GET /dashboard/insights — прогноз плана под finance.view", () => {
  it("директору приходит прогноз плана с числами", async () => {
    const res = await insights(directorToken);
    expect(res.status).toBe(200);
    expect(res.body.planForecast).not.toBeNull();
    expect(typeof res.body.planForecast.commissionMonth).toBe("number");
    expect(typeof res.body.planForecast.plan).toBe("number");
    expect(typeof res.body.planForecast.forecastEndOfMonth).toBe("number");
  });

  it("менеджеру без finance.view прогноз не уходит (null), остальное — как прежде", async () => {
    const res = await insights(managerToken);
    expect(res.status).toBe(200);
    expect(res.body.planForecast).toBeNull();
    expect(Array.isArray(res.body.stalledStages)).toBe(true);
    expect(Array.isArray(res.body.workload)).toBe(true);
    expect("weakLink" in res.body).toBe(true);
  });
});
