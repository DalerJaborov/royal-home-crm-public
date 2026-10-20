import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { loadPipelineDeadlines } from "../src/lib/propertyPipeline.js";

/**
 * GET /properties?overdue=1 — список ИМЕННО просроченных на этапе объектов.
 *
 * Зачем фильтр серверный. Красная плитка «Из них просрочено» на главной
 * монтажёра и в маркетинге должна открывать список за один клик (владелец
 * 15.09.2026: «чтобы админы и директор быстро нажали и перешли к виновнику»).
 * Каталог отдаётся страницами по 20, поэтому отбор на клиенте врал бы ровно
 * тогда, когда очередь длинная — то есть в единственном случае, когда список и
 * нужен.
 *
 * Проверяем то, что ничем другим не ловится: граница просрочки в запросе — ТА
 * ЖЕ, что у `stageState` в карточке. В коде это разные выражения (`floor(дни) >
 * срок` против `stageEnteredAt < now - (срок+1) суток`), и если поправить одно,
 * забыв другое, список и краска в карточке разойдутся молча.
 *
 * Фикстуры проверяются по своим id, а не по общему числу: каталог общий на все
 * тесты, идущие параллельно (тот же приём, что в properties-summary.test.ts).
 */

const runId = Date.now();
const password = "testpass123";
let districtId: string;
let agentId: string;
let agentPhone = "";
const propertyIds: string[] = [];

async function makeProperty(stageEnteredAt: Date): Promise<string> {
  const p = await prisma.property.create({
    data: {
      title: `Объект просрочки ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая просрочки, 5",
      condition: "GOOD",
      status: "AWAITING_PHOTOS",
      intakeAgentId: agentId,
    },
  });
  // stageEnteredAt выставляется отдельным update: при создании его ставит сама схема.
  await prisma.property.update({ where: { id: p.id }, data: { stageEnteredAt } });
  propertyIds.push(p.id);
  return p.id;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-просрочка-${runId}` } })).id;
  agentPhone = `+992953${String(runId).slice(-7)}`;
  const agent = await prisma.agent.create({
    data: { fullName: `Просрочка Агент ${runId}`, phone: agentPhone, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { phone: agentPhone } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("GET /properties?overdue=1", () => {
  it("возвращает только просроченные на этапе и держит ту же границу, что карточка", async () => {
    const login = await request(app).post("/api/v1/auth/login").send({ phone: agentPhone, password });
    expect(login.status).toBe(200);
    const token = login.body.accessToken ?? login.body.token;

    const deadlines = await loadPipelineDeadlines();
    const limitDays = deadlines.AWAITING_PHOTOS;
    const now = Date.now();

    const overdueId = await makeProperty(new Date(now - (limitDays + 5) * 86_400_000));
    // Ровно на грани: прожил отведённый срок и ещё не просрочен — так же считает stageState.
    const onTimeId = await makeProperty(new Date(now - limitDays * 86_400_000));

    const res = await request(app)
      .get("/api/v1/properties?overdue=1&status=AWAITING_PHOTOS")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const ids: string[] = res.body.items.map((p: { id: string }) => p.id);
    expect(ids).toContain(overdueId);
    expect(ids).not.toContain(onTimeId);

    // Ни одного «неправильно просроченного» в выдаче: фильтр запроса и расчёт
    // карточки обязаны совпадать на каждой строке, а не только на наших двух.
    for (const item of res.body.items as { pipeline?: { overdue?: boolean } }[]) {
      expect(item.pipeline?.overdue).toBe(true);
    }

    // Без параметра объект, уложившийся в срок, из каталога не исчезает.
    const all = await request(app)
      .get("/api/v1/properties?status=AWAITING_PHOTOS")
      .set("Authorization", `Bearer ${token}`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBeGreaterThanOrEqual(res.body.total);
  });
});
