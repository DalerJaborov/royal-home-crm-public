import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { budgetFromText, notesAlreadyHave, searchLineFromSummary, suggestRequirements } from "../src/lib/requirementsFromSummary.js";

/**
 * «Взять из разговора» (20.11.2026, ревью #338): сводка «Ищет: дом/участок, 3-4 сотки, район Назди Сомон» при пустом запросе
 * покупателя превращается в предложение. GET говорит только подписи, пишет по нажатию отдельный POST …/apply (чужому и без
 * права — отказ), заметки дописываются к ТЕКУЩИМ из базы, номера в ответах не появляются.
 */
const empty = { desiredType: null, desiredRooms: null, budgetMin: null, budgetMax: null, desiredDistrictId: null, hasDesiredPlaces: false, requirementsNotes: null };
const districts = [{ id: "d1", name: "Исмоили Сомони" }, { id: "d2", name: "Шохмансур" }, { id: "d3", name: "Фирдавси" }];
const ask = (line: string, current = empty) => suggestRequirements(`Ищет: ${line}`, current, districts);

describe("разбор строки «Ищет:» из сводки", () => {
  it("кадр владельца: дом/участок неоднозначно — типа нет, слова и район вне справочника уходят в «Пожелания»", () => {
    const s = suggestRequirements("Ищет: дом/участок, 3-4 сотки, район Назди Сомон\nВедёт: Умед", empty, districts)!;
    expect(s.fields.desiredType).toBeUndefined();
    expect(s.fields.desiredDistrictId).toBeUndefined();
    expect(s.notesLine).toBe("дом/участок, 3-4 сотки, район Назди Сомон");
    expect(s.labels).toEqual(["Назди Сомон"]);
  });
  it("квартира, комнаты, бюджет и район из справочника", () => {
    const s = ask("3-комн квартиру в Шохмансуре до 800 тыс сомони")!;
    expect(s.fields).toMatchObject({ desiredType: "APARTMENT", desiredRooms: 3, budgetMax: 800000, currency: "TJS", desiredDistrictId: "d2" });
    expect(s.labels).toEqual(["Шохмансур", "квартира", "3 комн.", "до 800 000 с."]);
  });
  it("ложный бюджет: этаж, километры, «еще», район с «Сомони» бюджетом не становятся", () => {
    expect(ask("квартиру в Исмоили Сомони, до 5 этажа")!.fields.budgetMax).toBeUndefined();
    expect(ask("квартиру в Исмоили Сомони, до 5 этажа")!.fields.currency).toBeUndefined();
    expect(ask("квартиру до 3 км от центра")!.fields.budgetMax).toBeUndefined();
    expect(ask("квартиру еще 2 комнаты")!.fields.currency).toBeUndefined();
    expect(ask("квартиру еще 2 комнаты")!.fields.budgetMax).toBeUndefined();
    expect(ask("квартиру, 60 м², 5 этаж")!.fields.budgetMax).toBeUndefined();
  });
  it("бюджет: порог, диапазон, дробное число, доллары", () => {
    expect(ask("квартиру до 5000 сомони")!.fields.budgetMax).toBeUndefined();
    expect(budgetFromText("до 500 тыс сомони")).toEqual({ max: 500000, currency: "TJS" });
    expect(budgetFromText("от 300 до 400 тысяч сомони")).toEqual({ min: 300000, max: 400000, currency: "TJS" });
    expect(budgetFromText("до 1,5 млн сомони")).toEqual({ max: 1500000, currency: "TJS" });
    expect(budgetFromText("до $60000")).toEqual({ max: 60000, currency: "USD" });
    expect(budgetFromText("от 50 000 долларов")).toEqual({ min: 50000, currency: "USD" });
    expect(budgetFromText("3-4 сотки, 2 этаж")).toBeNull();
  });
  it("отрицание и «рядом с …» пожеланием не считаются; район — по позиции в тексте, не по порядку справочника", () => {
    expect(ask("квартиру не в Шохмансуре")!.fields.desiredDistrictId).toBeUndefined();
    expect(ask("квартиру не в Шохмансуре, лучше Исмоили Сомони")!.fields.desiredDistrictId).toBe("d1");
    expect(ask("квартиру в Фирдавси или Исмоили Сомони")!.fields.desiredDistrictId).toBe("d3");
    expect(ask("квартиру рядом с Шохмансур")!.fields.desiredDistrictId).toBeUndefined();
    expect(ask("квартиру рядом с офисом")!.fields.desiredType).toBe("APARTMENT");
    expect(ask("рядом с магазином, дом")!.fields.desiredType).toBe("HOUSE");
  });
  it("комнаты: «3-4 комнаты» — от 3, «3к» и «3 к» — три, «до 3 км» — не комнаты", () => {
    expect(ask("квартиру 3-4 комнаты")!.fields.desiredRooms).toBe(3);
    expect(ask("квартиру 3к")!.fields.desiredRooms).toBe(3);
    expect(ask("квартиру 3 к")!.fields.desiredRooms).toBe(3);
    expect(ask("квартиру до 3 км")!.fields.desiredRooms).toBeUndefined();
  });
  it("тип: два разных типа — не предлагаем; один — предлагаем; офис — коммерческая", () => {
    expect(ask("дом/участок")?.fields.desiredType).toBeUndefined();
    expect(ask("дом, 3 сотки")?.fields.desiredType).toBeUndefined();
    expect(ask("участок 6 соток")!.fields.desiredType).toBe("LAND");
    expect(ask("офис под бизнес")!.fields.desiredType).toBe("COMMERCIAL");
  });
  it("уже заполненное не затирается; нечего предложить — null", () => {
    const filled = { ...empty, desiredType: "HOUSE" as const, desiredDistrictId: "d1", budgetMax: 5, desiredRooms: 2, requirementsNotes: "дом, 2 комнаты, Шохмансур" };
    expect(suggestRequirements("Ищет: дом, 2 комнаты, Шохмансур", filled, districts)).toBeNull();
    expect(suggestRequirements("Ведёт: Умед", empty, districts)).toBeNull();
    expect(suggestRequirements(null, empty, districts)).toBeNull();
  });
  it("после пересчёта сводки то же самое повторно не предлагается", () => {
    const notes = "Ищет дом, район Назди Сомон";
    expect(notesAlreadyHave(notes, "дом, район Назди Сомон")).toBe(true);
    expect(suggestRequirements("Ищет: дом, район Назди Сомон", { ...empty, desiredType: "HOUSE", requirementsNotes: notes }, districts)).toBeNull();
    expect(notesAlreadyHave(notes, "квартира в Фирдавси, 3 комнаты")).toBe(false);
    expect(searchLineFromSummary("Откуда: Instagram")).toBeNull();
  });
});

const tag = randomUUID();
const ids = { agents: [] as string[], clients: [] as string[] };
const token: Record<string, string> = {};
let clientId = "";
const PHONE_DIGITS = "901234567";
beforeAll(async () => {
  for (const role of ["AGENT", "ADMIN", "SHAREHOLDER"] as const) {
    const a = await prisma.agent.create({ data: { fullName: `test-reqsug-${role}`, phone: `test-reqsug-${tag}-${role}`, role, passwordHash: "test-unused" } });
    ids.agents.push(a.id); token[role] = signAccessToken({ sub: a.id, role });
  }
  const other = await prisma.agent.create({ data: { fullName: "test-reqsug-other", phone: `test-reqsug-${tag}-other`, role: "AGENT", passwordHash: "test-unused" } });
  ids.agents.push(other.id); token.OTHER = signAccessToken({ sub: other.id, role: "AGENT" });
  const c = await prisma.client.create({ data: { fullName: "test-reqsug-client", phone: `test-reqsug-c-${tag}`, source: "PHONE_CALL", kind: "BUYER", assignedAgentId: ids.agents[0], acceptedAt: new Date(),
    requirementsNotes: `Звонить после шести, второй номер +992${PHONE_DIGITS}`,
    aiInsight: `Ищет: квартиру в Шохмансуре, 3 комнаты, до 800 тыс сомони, связь +992${PHONE_DIGITS}\nВедёт: Умед` } });
  clientId = c.id; ids.clients.push(c.id);
});
afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: ids.clients } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: ids.clients } } });
  await prisma.client.deleteMany({ where: { id: { in: ids.clients } } });
  await prisma.agent.deleteMany({ where: { id: { in: ids.agents } } });
});
const url = () => `/api/v1/clients/${clientId}/requirements-suggestion`;
const get = (role: string) => request(app).get(url()).set("Authorization", `Bearer ${token[role]}`);
const apply = (role: string) => request(app).post(`${url()}/apply`).set("Authorization", `Bearer ${token[role]}`).send({});

describe("маршруты предложения и записи", () => {
  let districtId = "";
  beforeAll(async () => {
    const d = await prisma.district.upsert({ where: { name: "Шохмансур" }, update: {}, create: { name: "Шохмансур" } });
    districtId = d.id;
  });
  it("GET: ответственный агент получает только подписи; ни полей, ни заметок, ни цифр номера в ответе нет; ничего не записано", async () => {
    const r = await get("AGENT");
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(true);
    expect(Object.keys(r.body).sort()).toEqual(["available", "labels"]);
    expect(r.body.labels.join(" ")).toContain("квартира");
    expect(JSON.stringify(r.body)).not.toContain(PHONE_DIGITS);
    const row = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(row.desiredType).toBeNull();
    expect(row.requirementsNotes).toContain(PHONE_DIGITS);
  });
  it("чужой агент, наблюдатель и без входа — отказ на чтении и на записи", async () => {
    expect((await get("OTHER")).status).toBe(403);
    expect((await get("SHAREHOLDER")).status).toBe(403);
    expect((await request(app).get(url())).status).toBe(401);
    expect((await apply("OTHER")).status).toBe(403);
    expect((await apply("SHAREHOLDER")).status).toBe(403);
    expect((await request(app).post(`${url()}/apply`).send({})).status).toBe(401);
  });
  it("POST apply: пишет по нажатию, заметки дописываются к ТЕКУЩИМ из базы, в ответе номер замаскирован", async () => {
    // Пока экран думал, кто-то записал свежую заметку: она не должна пропасть.
    await prisma.client.update({ where: { id: clientId }, data: { requirementsNotes: `Свежая заметка: нужен лифт, номер +992${PHONE_DIGITS}` } });
    const r = await apply("AGENT");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(PHONE_DIGITS);
    const row = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(row.desiredType).toBe("APARTMENT");
    expect(row.desiredRooms).toBe(3);
    expect(Number(row.budgetMax)).toBe(800000);
    expect(row.desiredDistrictId).toBe(districtId);
    expect(row.requirementsNotes).toContain("Свежая заметка: нужен лифт");
    expect(row.requirementsNotes).toContain("квартиру в Шохмансуре");
    expect(row.requirementsFieldsKind).toBe("BUYER");
  });
  it("после записи предложения больше нет, а повторная запись — 409 и ничего не дублирует", async () => {
    expect((await get("AGENT")).body).toEqual({ available: false, labels: [] });
    const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect((await apply("AGENT")).status).toBe(409);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).requirementsNotes).toBe(before.requirementsNotes);
  });
});
