import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { prisma } from "../src/db.js";

/**
 * Владелец, 16.09.2026: «у нас так много таких ошибок» — siteSync.ts отказывает
 * публиковать ЛЮБОЙ объект, чей `description` упоминает "$"/USD/доллар (гейт
 * против устаревшего текста после смены валюты). Но для объекта, у которого
 * currency=USD, ИИ-описание ПРАВИЛЬНО пишет цену как "$40 000" (правило
 * ai/seoGenerator.ts::buildSystemPrompt) — то есть гейт срабатывал не на
 * редком сбое, а на КАЖДОМ USD-объекте с сгенерированным текстом, и ручная
 * кнопка «Сгенерировать описание (ИИ)» чинила это тем же способом ту же беду.
 *
 * Фикс: ai/seoGenerator.ts и routes/ai.ts::generate-listing получают цену уже
 * пересчитанной в сомони (lib/money.ts::toTjs), независимо от реальной валюты
 * сделки, — сайт всё равно показывает только сомони (siteSync.ts::toSitePayload).
 * property.price/currency сами не трогаются, конвертация только для текста.
 */

const { callAiText } = vi.hoisted(() => ({ callAiText: vi.fn(async () => null as unknown) }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText }));

const { app } = await import("../src/app.js");

const runId = Date.now();
const password = "testpass123";
let districtId: string;
let adminId: string;
let adminToken: string;
let intakeAgentId: string;
const propertyIds: string[] = [];

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-валюта-${runId}` } })).id;
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ валюты", phone: `+992957${runId.toString().slice(-6)}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ phone: `+992957${runId.toString().slice(-6)}`, password });
  adminToken = res.body.accessToken;
  const intakeAgent = await prisma.agent.create({
    data: { fullName: "Интейк валюты", phone: `+992958${runId.toString().slice(-6)}`, role: "AGENT", passwordHash },
  });
  intakeAgentId = intakeAgent.id;
});

beforeEach(() => {
  callAiText.mockReset();
  callAiText.mockResolvedValue(null); // ИИ недоступен — проверяем именно шаблонный запасной путь
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, intakeAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Описание объекта в USD — текст всегда на сомони", () => {
  it("создание объекта в USD: description без '$'/USD/доллар, с 'с.'", async () => {
    const res = await request(app)
      .post("/api/v1/properties")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "APARTMENT",
        areaSqm: 60,
        rooms: 2,
        floor: 3,
        totalFloors: 9,
        windowCount: 3,
        price: 40000,
        currency: "USD",
        districtId,
        address: `Тест-валюта, ${propertyIds.length}`,
        condition: "GOOD",
        ownerContact: `+992937${runId.toString().slice(-6)}`, // не сидовый номер (staffPhoneGuard, 17.09.2026)
        intakeAgentId,
      });
    expect(res.status).toBe(201);
    if (res.body?.id) propertyIds.push(res.body.id);

    expect(res.body.description).toBeTruthy();
    expect(res.body.description).not.toMatch(/\$|\bUSD\b|доллар/i);
    expect(res.body.description).toContain("с.");
    // Сама валюта объекта не подменяется — это только про текст описания.
    expect(res.body.currency).toBe("USD");
    expect(Number(res.body.price)).toBe(40000);
  });
});
