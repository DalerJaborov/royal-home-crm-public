import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { budgetFromText, searchLineFromSummary, suggestRequirements } from "../src/lib/requirementsFromSummary.js";

/**
 * «Взять из разговора» (20.11.2026): сводка «Ищет: дом/участок, 3-4 сотки, район Назди Сомон» при пустом запросе покупателя
 * превращается в предложение; пишет его только человек (обычный buyer-requirements), чужому и без права — отказ.
 */
const empty = { desiredType: null, desiredRooms: null, budgetMin: null, budgetMax: null, desiredDistrictId: null, hasDesiredPlaces: false, requirementsNotes: null };
const districts = [{ id: "d1", name: "Исмоили Сомони" }, { id: "d2", name: "Шохмансур" }];

describe("разбор строки «Ищет:» из сводки", () => {
  it("кадр владельца: дом/участок, сотки, район вне справочника — тип и слова, район остаётся словами", () => {
    const s = suggestRequirements("Ищет: дом/участок, 3-4 сотки, район Назди Сомон\nВедёт: Умед", empty, districts)!;
    expect(s.desiredType).toBe("HOUSE");
    expect(s.desiredDistrictId).toBeUndefined();
    expect(s.requirementsNotes).toBe("дом/участок, 3-4 сотки, район Назди Сомон");
    expect(s.labels).toEqual(["дом", "Назди Сомон"]);
  });
  it("квартира, комнаты, бюджет и район из справочника", () => {
    const s = suggestRequirements("Ищет: 3-комн квартиру в Шохмансуре до 800 тыс сомони", empty, districts)!;
    expect(s).toMatchObject({ desiredType: "APARTMENT", desiredRooms: 3, budgetMax: 800000, currency: "TJS", desiredDistrictId: "d2" });
  });
  it("уже заполненное не затирается; нечего предложить — null", () => {
    const filled = { ...empty, desiredType: "HOUSE" as const, desiredDistrictId: "d1", budgetMax: 5, desiredRooms: 2 };
    expect(suggestRequirements("Ищет: дом, 2 комнаты, Шохмансур", filled, districts)).toBeNull();
    expect(suggestRequirements("Ведёт: Умед", empty, districts)).toBeNull();
    expect(suggestRequirements(null, empty, districts)).toBeNull();
  });
  it("слова клиента не дублируются, если уже записаны", () => {
    const s = suggestRequirements("Ищет: квартира", { ...empty, requirementsNotes: "Ищет: квартира, нужен лифт" }, districts)!;
    expect(s.requirementsNotes).toBeUndefined();
  });
  it("бюджет: диапазон, доллары, без слов о деньгах числа бюджетом не считаются", () => {
    expect(budgetFromText("от 300 до 400 тысяч сомони")).toEqual({ min: 300000, max: 400000, currency: "TJS" });
    expect(budgetFromText("до $60000")).toEqual({ max: 60000, currency: "USD" });
    expect(budgetFromText("3-4 сотки, 2 этаж")).toBeNull();
    expect(searchLineFromSummary("Откуда: Instagram")).toBeNull();
  });
});

const tag = randomUUID();
const ids = { agents: [] as string[], clients: [] as string[] };
const token: Record<string, string> = {};
let clientId = "";
beforeAll(async () => {
  for (const role of ["AGENT", "ADMIN", "SHAREHOLDER"] as const) {
    const a = await prisma.agent.create({ data: { fullName: `test-reqsug-${role}`, phone: `test-reqsug-${tag}-${role}`, role, passwordHash: "test-unused" } });
    ids.agents.push(a.id); token[role] = signAccessToken({ sub: a.id, role });
  }
  // Второй агент — «чужой» для карточки первого.
  const other = await prisma.agent.create({ data: { fullName: "test-reqsug-other", phone: `test-reqsug-${tag}-other`, role: "AGENT", passwordHash: "test-unused" } });
  ids.agents.push(other.id); token.OTHER = signAccessToken({ sub: other.id, role: "AGENT" });
  const c = await prisma.client.create({ data: { fullName: "test-reqsug-client", phone: `test-reqsug-c-${tag}`, source: "PHONE_CALL", kind: "BUYER", assignedAgentId: ids.agents[0], acceptedAt: new Date(),
    aiInsight: "Ищет: дом/участок, 3-4 сотки, район Назди Сомон\nВедёт: Умед" } });
  clientId = c.id; ids.clients.push(c.id);
});
afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: ids.clients } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: ids.clients } } });
  await prisma.client.deleteMany({ where: { id: { in: ids.clients } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids.agents } } });
});
const get = (role: string) => request(app).get(`/api/v1/clients/${clientId}/requirements-suggestion`).set("Authorization", `Bearer ${token[role]}`);

describe("маршрут предложения и запись по нажатию", () => {
  it("ответственный агент получает предложение, ничего при этом не записывается", async () => {
    const r = await get("AGENT");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ available: true, fields: { desiredType: "HOUSE" } });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).desiredType).toBeNull();
  });
  it("чужой агент, наблюдатель без права правки и без входа — отказ", async () => {
    expect((await get("OTHER")).status).toBe(403);
    expect((await get("SHAREHOLDER")).status).toBe(403);
    expect((await request(app).get(`/api/v1/clients/${clientId}/requirements-suggestion`)).status).toBe(401);
  });
  it("нажатие = обычная запись через buyer-requirements; после неё предложения больше нет", async () => {
    const fields = (await get("AGENT")).body.fields;
    const save = await request(app).post(`/api/v1/clients/${clientId}/buyer-requirements`).set("Authorization", `Bearer ${token.AGENT}`).send(fields);
    expect(save.status).toBe(200);
    expect(save.body.desiredType).toBe("HOUSE");
    expect(save.body.requirementsNotes).toContain("Назди Сомон");
    expect((await get("AGENT")).body.available).toBe(false);
    // Чужой записать тем же маршрутом не может.
    const foreign = await request(app).post(`/api/v1/clients/${clientId}/buyer-requirements`).set("Authorization", `Bearer ${token.OTHER}`).send(fields);
    expect(foreign.status).toBe(403);
  });
});
