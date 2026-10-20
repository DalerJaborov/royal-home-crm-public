import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Пять находок аудита 12.08.2026 по API (docs/plan-2026-08-12-telephony-bot-design.md,
 * «Мелочи из аудита» → API, пункты Е, Ж, З, И, К). Ни одна не роняла прод, поэтому
 * без теста любая вернулась бы следующей же правкой соседнего кода.
 *
 * З. Номер страницы разбирался руками (`Math.max(Number(req.query.page) || 1, 1)`):
 *    минимум был, потолка не было, и `?page=100000000` уходил в базу как OFFSET 4e9 —
 *    таймаут вместо 400.
 * И. GET /settings/branding открыт без токена и делал upsert, то есть был
 *    НЕаутентифицированным путём записи, ещё и без лимитера.
 * К. Балл за закрытие задачи писался без await: ответ 200 уходил раньше записи.
 * Ж. PATCH клиента принимал этаж «от» больше этажа «до» (на создании проверка есть).
 * Е. Ключ вебхуков сайта сравнивался `!==`, а не за постоянное время.
 */

const runId = Date.now();
const password = "testpass123";
const API_KEY = "audit-nits-website-key";

let directorId = "";
let agentId = "";
let clientId = "";
let interactionId = "";
let directorToken = "";
let agentToken = "";

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  process.env.WEBSITE_LEAD_API_KEY = API_KEY;
  const passwordHash = await bcrypt.hash(password, 10);
  directorId = (
    await prisma.agent.create({
      data: { fullName: `Директор аудита ${runId}`, phone: `+992970${String(runId).slice(-7)}`, role: "DIRECTOR", passwordHash },
    })
  ).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент аудита ${runId}`, phone: `+992971${String(runId).slice(-7)}`, role: "AGENT", passwordHash },
    })
  ).id;
  directorToken = await login(`+992970${String(runId).slice(-7)}`);
  agentToken = await login(`+992971${String(runId).slice(-7)}`);

  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Клиент аудита ${runId}`,
        phone: `+992972${String(runId).slice(-7)}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
      },
    })
  ).id;
  interactionId = (
    await prisma.interaction.create({
      // CALL, а не SHOWING/MEETING: completionEventKind даёт для них свои виды
      // событий (и заводит «итог показа»), а здесь нужна обычная задача.
      data: { clientId, agentId, type: "CALL", notes: "Задача аудита", nextAction: "Перезвонить" },
    })
  ).id;
});

afterAll(async () => {
  delete process.env.WEBSITE_LEAD_API_KEY;
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
});

/** З. Все шесть маршрутов, разбиравших page руками, — через общую схему с потолком. */
describe("З. Номер страницы с верхней границей", () => {
  const routes = [
    "/api/v1/audit-log",
    "/api/v1/calls",
    "/api/v1/calls/incoming",
    "/api/v1/security/lost-clients",
    "/api/v1/security/lost-properties",
    "/api/v1/marketing/queue",
  ];

  for (const route of routes) {
    it(`${route}: обычная страница работает`, async () => {
      const res = await request(app).get(`${route}?page=1`).set("Authorization", `Bearer ${directorToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    it(`${route}: бессмысленно большой номер страницы — 400, а не OFFSET 4e9`, async () => {
      const res = await request(app).get(`${route}?page=100000000`).set("Authorization", `Bearer ${directorToken}`);
      expect(res.status).toBe(400);
    });

    it(`${route}: неразбираемый номер страницы — 400`, async () => {
      const res = await request(app).get(`${route}?page=abc`).set("Authorization", `Bearer ${directorToken}`);
      expect(res.status).toBe(400);
    });
  }
});

describe("И. Публичный брендинг только читает", () => {
  it("отдаётся без токена и ничего не пишет в базу", async () => {
    const upsert = vi.spyOn(prisma.settings, "upsert");
    const create = vi.spyOn(prisma.settings, "create");
    const update = vi.spyOn(prisma.settings, "update");
    try {
      const res = await request(app).get("/api/v1/settings/branding");
      expect(res.status).toBe(200);
      expect(typeof res.body.companyName).toBe("string");
      expect(res.body).not.toHaveProperty("anthropicApiKey");
      expect(upsert).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally {
      upsert.mockRestore();
      create.mockRestore();
      update.mockRestore();
    }
  });

  it("закрыт лимитером, как соседняя публичная лента", async () => {
    const res = await request(app).get("/api/v1/settings/branding");
    expect(res.headers["ratelimit-limit"]).toBeDefined();
  });
});

describe("К. Балл за закрытие задачи не теряется", () => {
  it("к моменту ответа 200 событие журнала уже записано", async () => {
    const res = await request(app)
      .patch(`/api/v1/interactions/${interactionId}/complete`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);

    // Именно СРАЗУ, без ожиданий и повторов: без await запись шла после ответа, и
    // падение процесса между ними теряло балл насовсем — повторный PATCH уже видит
    // completedAt и в ветку начисления не заходит.
    const event = await prisma.royalScoreEvent.findFirst({ where: { agentId, sourceId: interactionId } });
    expect(event).not.toBeNull();
    expect(event!.kind).toBe("task_on_time");
  });

  it("повторное закрытие не начисляет второй раз", async () => {
    const res = await request(app)
      .patch(`/api/v1/interactions/${interactionId}/complete`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const count = await prisma.royalScoreEvent.count({ where: { agentId, sourceId: interactionId } });
    expect(count).toBe(1);
  });
});

describe("Ж. Диапазон этажей проверяется и при редактировании", () => {
  function patch(body: Record<string, unknown>) {
    return request(app)
      .patch(`/api/v1/clients/${clientId}`)
      // Директором: у рядового агента правка чужой/непринятой карточки закрыта
      // правами, и 403 пришёл бы раньше проверки диапазона.
      .set("Authorization", `Bearer ${directorToken}`)
      .send(body);
  }

  it("этаж «от» больше этажа «до» — отказ", async () => {
    const res = await patch({ desiredFloorMin: 9, desiredFloorMax: 2 });
    expect(res.status).toBe(400);
  });

  it("корректный диапазон принимается", async () => {
    const res = await patch({ desiredFloorMin: 2, desiredFloorMax: 9 });
    expect(res.status).toBe(200);
  });

  it("очистка обеих границ через null по-прежнему работает", async () => {
    const res = await patch({ desiredFloorMin: null, desiredFloorMax: null });
    expect(res.status).toBe(200);
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    expect(client!.desiredFloorMin).toBeNull();
    expect(client!.desiredFloorMax).toBeNull();
  });
});

describe("Е. Ключ вебхука сравнивается за постоянное время", () => {
  function post(key: string | null) {
    const req = request(app).post("/api/v1/webhooks/website-lead");
    if (key !== null) req.set("X-Api-Key", key);
    return req.send({ fullName: "Ключ Тест", phone: `+992973${String(runId).slice(-7)}` });
  }

  // Длина сравниваемых буферов проверяется отдельно: timingSafeEqual на разной
  // длине БРОСАЕТ, и без этой проверки короткий ключ дал бы 500 вместо 401.
  it("ключ другой длины — 401, а не падение", async () => {
    expect((await post("x")).status).toBe(401);
  });

  it("ключ той же длины, но неверный — 401", async () => {
    const wrong = "a".repeat(API_KEY.length);
    expect(wrong.length).toBe(API_KEY.length);
    expect((await post(wrong)).status).toBe(401);
  });

  it("заголовка нет вовсе — 401", async () => {
    expect((await post(null)).status).toBe(401);
  });
});
