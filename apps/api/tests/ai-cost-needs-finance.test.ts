import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * СТОИМОСТЬ ГЕНЕРАЦИИ И РАСХОД НА ИИ — ТОЛЬКО С finance.view
 * (аудит Codex 04.10.2026, ACCESS-05).
 *
 * Так было: настройки обложек (settings.manage) отдавали costUsd последних
 * генераций и пробной обложки, а пульт (dashboard.analytics) отдавал расход ИИ за
 * день по всей компании — обоим хватало права, не связанного с финансами. Рядом
 * цена звонка робота уже закрыта finance.view (routes/settings.ts).
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { COVER_IMAGE_ENDPOINT } = await import("../src/lib/video/coverOpenAi.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const agentIds: string[] = [];
const logIds: string[] = [];
let blindToken = "";
let seeingToken = "";

beforeAll(async () => {
  const mk = async (phone: string, permissions: unknown) =>
    (
      await prisma.agent.create({
        data: { fullName: `Стоимость ${phone}`, phone, role: "MANAGER", passwordHash: "x", permissions: permissions as never },
      })
    ).id;
  const blind = await mk(`+99241${tail}`, { granted: ["settings.manage", "dashboard.analytics"], revoked: ["finance.view"] });
  const seeing = await mk(`+99242${tail}`, { granted: ["settings.manage", "dashboard.analytics", "finance.view"], revoked: [] });
  agentIds.push(blind, seeing);
  blindToken = signAccessToken({ sub: blind, role: "MANAGER" });
  seeingToken = signAccessToken({ sub: seeing, role: "MANAGER" });
  const row = await prisma.aiLog.create({
    data: { endpoint: COVER_IMAGE_ENDPOINT, model: "test-model", ok: true, ms: 1000, costUsd: 0.24 } as never,
  });
  logIds.push(row.id);
});

afterAll(async () => {
  await prisma.aiLog.deleteMany({ where: { id: { in: logIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);

describe("настройки обложек ChatGPT", () => {
  it("без finance.view стоимость последних генераций скрыта", async () => {
    const res = await get("/api/v1/settings/cover-templates/openai", blindToken);
    expect(res.status).toBe(200);
    const mine = (res.body.recent as Array<{ id: string; costUsd: number | null }>).find((r) => r.id === logIds[0]);
    expect(mine).toBeTruthy();
    expect(mine!.costUsd).toBeNull();
  });

  it("с finance.view стоимость на месте", async () => {
    const res = await get("/api/v1/settings/cover-templates/openai", seeingToken);
    const mine = (res.body.recent as Array<{ id: string; costUsd: number | null }>).find((r) => r.id === logIds[0]);
    expect(mine!.costUsd).toBeCloseTo(0.24, 5);
  });

  it("пробная обложка: цена в ответе только с finance.view", async () => {
    const blind = await request(app)
      .post("/api/v1/settings/cover-templates/openai-test")
      .set("Authorization", `Bearer ${blindToken}`)
      .send({ propertyId: "no-such-property" });
    expect(blind.status).toBe(422);
    expect(blind.body.costUsd).toBeNull();
    const seeing = await request(app)
      .post("/api/v1/settings/cover-templates/openai-test")
      .set("Authorization", `Bearer ${seeingToken}`)
      .send({ propertyId: "no-such-property" });
    expect(seeing.status).toBe(422);
    expect(typeof seeing.body.costUsd).toBe("number");
  });
});

describe("пульт: расход ИИ за день", () => {
  it("без finance.view null, с ним число", async () => {
    const blind = await get("/api/v1/dashboard/mission-control", blindToken);
    expect(blind.status).toBe(200);
    expect(blind.body.bot.ai.costUsdToday).toBeNull();
    const seeing = await get("/api/v1/dashboard/mission-control", seeingToken);
    expect(typeof seeing.body.bot.ai.costUsdToday).toBe("number");
  });
});
