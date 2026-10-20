import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { prisma } from "../src/db.js";

/**
 * Подпись под Reels — начало и конец пишет Gemini заново на каждый объект,
 * факты (район/адрес/цена/...) детерминированы (решение владельца 16.09.2026,
 * заменило прежнее «по шаблону, а не через ИИ» от 04.08.2026). Откажет
 * ИИ (сеть, лимит, пустой ответ) — прежний бесплатный шаблон, см.
 * ai/reelsCaptionAi.ts. Генерируется автоматически при создании объекта и
 * перегенерируется по кнопке актуальными данными карточки.
 *
 * callGemini подменён здесь намеренно: реальный сетевой вызов на каждый тест —
 * это и медленно, и по умолчанию красный (в тестовой среде нет настоящего
 * ключа Gemini), из-за чего эти тесты ДО этой правки молча проверяли только
 * путь отказа ИИ, ни разу не путь успеха.
 */

const { callGemini } = vi.hoisted(() => ({
  callGemini: vi.fn(async () => null as { hook?: string; closing?: string } | null),
}));
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  callGemini,
}));

const { app } = await import("../src/app.js");

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let adminId: string;
let adminToken: string;
let intakeAgentId: string;
const propertyIds: string[] = [];

async function createViaApi(overrides: Record<string, unknown> = {}) {
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
      price: 400000,
      currency: "TJS",
      districtId,
      address: `Тестовая подпись, ${propertyIds.length}`,
      condition: "GOOD",
      ownerContact: `+992937${runId.toString().slice(-6)}`, // не сидовый номер (staffPhoneGuard, 17.09.2026)
      // intakeAgentId должен указывать на действующего сотрудника с ролью AGENT
      // (assignableAgentError, shared.ts) — сам ADMIN не годится.
      intakeAgentId: intakeAgentId,
      ...overrides,
    });
  if (res.body?.id) propertyIds.push(res.body.id);
  return res;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-подпись-${runId}` } })).id;
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ подписи", phone: `+992955${runId.toString().slice(-6)}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ phone: `+992955${runId.toString().slice(-6)}`, password });
  adminToken = res.body.accessToken;

  const intakeAgent = await prisma.agent.create({
    data: { fullName: "Интейк-агент подписи", phone: `+992956${runId.toString().slice(-6)}`, role: "AGENT", passwordHash },
  });
  intakeAgentId = intakeAgent.id;
});

beforeEach(() => {
  // По умолчанию — «ИИ недоступен»: большинство тестов ниже проверяют именно
  // шаблонный запасной путь, и не должны молча начать проверять успех ИИ
  // только потому, что предыдущий тест замокал hook/closing.
  callGemini.mockReset();
  callGemini.mockResolvedValue(null);
});

afterEach(async () => {
  // Настройка шаблонов — singleton на всю тестовую базу; восстанавливаем явным
  // null (не undefined — Prisma пропускает undefined-поля при update, и правка
  // осталась бы навсегда для соседних файлов тестов).
  await prisma.settings.update({ where: { id: "singleton" }, data: { reelsCaptionTemplates: null } });
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, intakeAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Подпись генерируется при создании объекта", () => {
  it("ИИ недоступен — сохраняется непустая подпись шаблоном, объект не остаётся без текста", async () => {
    const res = await createViaApi();
    expect(res.status).toBe(201);
    expect(res.body.reelsCaption).toBeTruthy();
    expect(res.body.reelsCaption).toContain(res.body.district.name);
  });

  it("ИИ ответил — hook и closing от Gemini собраны вокруг детерминированных фактов", async () => {
    // mockResolvedValue (не Once): callGemini дёргает не только подпись — то же
    // создание объекта зовёт и generateSeoFields (SEO-описание), у которого
    // callAiText в этой среде тоже уходит через callGeminiText/callGemini
    // (A/B-провайдер, ai/client.ts). Тот вызов получит тот же объект и просто
    // не найдёт в нём своих полей (description и т.д.), откатится на свой
    // шаблон — нам это не мешает, важен только вызов из reelsCaptionAi.ts.
    callGemini.mockResolvedValue({
      hook: "Такие планировки в этом районе уходят за неделю.",
      closing: "Пишите в директ, если готовы посмотреть уже сегодня.",
    });
    const res = await createViaApi();
    expect(res.status).toBe(201);
    expect(res.body.reelsCaption).toContain("Такие планировки в этом районе уходят за неделю.");
    expect(res.body.reelsCaption).toContain("Пишите в директ, если готовы посмотреть уже сегодня.");
    // Факты — из карточки, не из ответа ИИ: район/цена присутствуют независимо
    // от того, что вернул мок (мок вообще не упоминает ни того, ни другого).
    expect(res.body.reelsCaption).toContain(`Район: ${res.body.district.name}`);
    expect(res.body.reelsCaption).toContain("+992 44 650-14-14");
  });

  it("подпись публикует один фиксированный номер агентства, а не личный телефон интейкера", async () => {
    const res = await createViaApi();
    expect(res.status).toBe(201);
    const agent = await prisma.agent.findUnique({ where: { id: intakeAgentId }, select: { phone: true } });
    expect(res.body.reelsCaption).toContain("+992 44 650-14-14");
    // WhatsApp-номер убран из подписей 20.09.2026 (решение владельца). В текстах
    // бота он остался — там это рабочий адрес, куда зовут прислать резюме.
    expect(res.body.reelsCaption).not.toContain("777-60-01");
    expect(res.body.reelsCaption).not.toContain(agent!.phone);
  });

  it("свой шаблон из Настроек используется вместо зашитого", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { reelsCaptionTemplates: "Только один шаблон: {{type}} в {{district}}" },
    });
    const res = await createViaApi();
    expect(res.status).toBe(201);
    expect(res.body.reelsCaption).toContain("Только один шаблон");
  });
});

describe("POST /properties/:id/regenerate-caption", () => {
  it("перегенерирует подпись и сохраняет её в карточке", async () => {
    const created = await createViaApi();
    const propertyId = created.body.id;

    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/regenerate-caption`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.reelsCaption).toBeTruthy();

    const stored = await prisma.property.findUnique({ where: { id: propertyId }, select: { reelsCaption: true } });
    expect(stored?.reelsCaption).toBe(res.body.reelsCaption);
  });

  it("после смены цены перегенерированная подпись отражает новую цену, а не старую", async () => {
    const created = await createViaApi({ price: 100000 });
    const propertyId = created.body.id;

    // Свой единственный шаблон — чтобы точно проверить конкретное число, а не
    // гадать, какой из четырёх случайных выпал.
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { reelsCaptionTemplates: "Цена: {{price}}" },
    });

    await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ price: 250000 });

    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/regenerate-caption`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.reelsCaption).toContain("250");
    expect(res.body.reelsCaption).not.toContain("100 000");
  });
});

describe("Ручная правка сохраняется через обычный PATCH", () => {
  it("PATCH reelsCaption перезаписывает текст", async () => {
    const created = await createViaApi();
    const propertyId = created.body.id;

    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reelsCaption: "Ручной текст монтажёра" });
    expect(res.status).toBe(200);
    expect(res.body.reelsCaption).toBe("Ручной текст монтажёра");
  });
});
