import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

/**
 * Слой 3, задача 2/6 (08.09.2026): `properties.viewAll` разбит на
 * `properties.viewOwners` (чтение контакта собственника) и
 * `properties.editForeign` (правка чужой карточки объекта, включая
 * переназначение ответственного и смену интейк-агента). Пресеты по
 * `docs/pult/theme-2026/layer-3-plan.md` §2.1:
 *  - SECURITY — только viewOwners (видит контакт, чужую карточку сохранить
 *    не может);
 *  - EDITOR — только editForeign (правит чужую карточку/файлы для монтажа —
 *    включая «Готово»/complete-editing, — но контакт собственника ему не
 *    нужен, roles-check.md §2.2);
 *  - MANAGER/DIRECTOR/ADMIN — оба права (полный доступ, как и раньше);
 *  - AGENT — ни одного (видит и правит только свою карточку).
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let ownerAgentId: string; // интейкер/ответственный чужого объекта
let foreignPropertyId: string;
let foreignPropertyShortId: number; // GET /:id роутится по shortId, не по cuid
let buyerClientId: string; // чужой покупатель с показом по объекту (ночная проверка 24.09.2026)

let securityId: string;
let securityToken: string;
let editorId: string;
let editorToken: string;
let managerId: string;
let managerToken: string;
let agentId: string;
let agentToken: string;

const agentIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-owner-perm-${runId}` } })).id;

  ownerAgentId = (
    await prisma.agent.create({
      data: { fullName: "Ответственный (owner-perm)", phone: `+992971${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentIds.push(ownerAgentId);

  securityId = (
    await prisma.agent.create({
      data: { fullName: "Секьюрити (owner-perm)", phone: `+992972${runId}`, role: "SECURITY", passwordHash },
    })
  ).id;
  agentIds.push(securityId);

  editorId = (
    await prisma.agent.create({
      data: { fullName: "Монтажёр (owner-perm)", phone: `+992973${runId}`, role: "EDITOR", passwordHash },
    })
  ).id;
  agentIds.push(editorId);

  managerId = (
    await prisma.agent.create({
      data: { fullName: "Менеджер (owner-perm)", phone: `+992974${runId}`, role: "MANAGER", passwordHash },
    })
  ).id;
  agentIds.push(managerId);

  agentId = (
    await prisma.agent.create({
      data: { fullName: "Рядовой агент (owner-perm)", phone: `+992975${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentIds.push(agentId);

  securityToken = await login(`+992972${runId}`);
  editorToken = await login(`+992973${runId}`);
  managerToken = await login(`+992974${runId}`);
  agentToken = await login(`+992975${runId}`);

  const property = await prisma.property.create({
    data: {
      title: `Объект owner-perm ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая owner-perm, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: ownerAgentId,
      createdById: ownerAgentId,
      assignedAgentId: ownerAgentId,
      ownerContact: "+992900000099 Собственник",
    } as never,
  });
  foreignPropertyId = property.id;
  foreignPropertyShortId = property.shortId;

  // Показ чужого покупателя по этому объекту — с заметками и расшифровкой, которые
  // никому, кроме ведущего клиента, в карточке объекта видеть не положено.
  buyerClientId = (
    await prisma.client.create({
      data: {
        fullName: `Покупатель owner-perm ${runId}`,
        phone: `+992976${runId}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: ownerAgentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  await prisma.interaction.create({
    data: {
      clientId: buyerClientId,
      agentId: ownerAgentId,
      type: "SHOWING",
      propertyId: foreignPropertyId,
      notes: "СЕКРЕТ-ПОКАЗА: покупатель готов торговаться до 38000",
      transcript: "СЕКРЕТ-РАСШИФРОВКИ: обсуждали ипотеку и сроки",
    },
  });
});

afterAll(async () => {
  // Только при заведённом покупателе: упавший beforeAll оставил бы buyerClientId
  // пустым, а deleteMany с undefined в where — это удаление ВСЕХ строк таблицы.
  if (buyerClientId) {
    await prisma.interaction.deleteMany({ where: { clientId: buyerClientId } });
    await prisma.client.deleteMany({ where: { id: buyerClientId } });
  }
  await prisma.property.deleteMany({ where: { id: foreignPropertyId } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("properties.viewOwners — чтение контакта собственника чужого объекта", () => {
  // GET /:id роутится по числовому shortId, не по cuid-id (см. list.ts).
  it("SECURITY видит контакт собственника (200, ownerContact не скрыт)", async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${foreignPropertyShortId}`)
      .set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ownerContact).toBe("+992900000099 Собственник");
  });

  it("EDITOR не видит контакт чужого объекта (200, ownerContact скрыт/null) — не нужен по работе, roles-check.md §2.2", async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${foreignPropertyShortId}`)
      .set("Authorization", `Bearer ${editorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ownerContact).toBeFalsy();
  });

  it("MANAGER видит контакт собственника (200, ownerContact не скрыт)", async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${foreignPropertyShortId}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ownerContact).toBe("+992900000099 Собственник");
  });

  it("рядовой АГЕНТ не видит контакт чужого объекта (200, ownerContact скрыт/null)", async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${foreignPropertyShortId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ownerContact).toBeFalsy();
  });
});

describe("properties.editForeign — правка чужой карточки объекта", () => {
  it("SECURITY получает 403 при попытке сохранить чужую карточку", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${foreignPropertyId}`)
      .set("Authorization", `Bearer ${securityToken}`)
      .send({ price: 41000 });
    expect(res.status).toBe(403);
  });

  it("EDITOR сохраняет чужую карточку (200) — editForeign нужен для монтажа/complete-editing, но ответ PATCH не выдаёт ownerContact (21.09.2026: PATCH/POST отдавали Property как есть, в обход stripOwnerContact — единственный маршрут, где editForeign без viewOwners реально утекал телефон)", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${foreignPropertyId}`)
      .set("Authorization", `Bearer ${editorToken}`)
      .send({ price: 41000 });
    expect(res.status).toBe(200);
    expect(res.body.ownerContact).toBeFalsy();
    expect(res.body.ownerContactHidden).toBe(true);
  });

  it("рядовой АГЕНТ получает 403 при попытке сохранить чужую карточку", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${foreignPropertyId}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ price: 41000 });
    expect(res.status).toBe(403);
  });

  it("MANAGER может сохранить чужую карточку (200)", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${foreignPropertyId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ price: 42000 });
    expect(res.status).toBe(200);
    expect(Number(res.body.price)).toBe(42000);
  });
});

/**
 * Ночная проверка 24.09.2026: GET /properties/:id подмешивал `interactions`
 * (показы) целиком — notes, liveNote, transcript, voiceNoteUrl, recordingUrl и
 * clientId чужих покупателей уходили любому, кому открыта карточка объекта, а
 * сайт это поле не читал нигде. Теперь поля в ответе нет ни у кого.
 */
describe("GET /properties/:id не выдаёт показы чужих покупателей", () => {
  it("рядовой АГЕНТ открывает чужой объект — в ответе нет interactions и нет текста заметок/расшифровки", async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${foreignPropertyShortId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.interactions).toBeUndefined();
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("СЕКРЕТ-ПОКАЗА");
    expect(raw).not.toContain("СЕКРЕТ-РАСШИФРОВКИ");
    expect(raw).not.toContain(buyerClientId);
  });

  it("MANAGER — тоже без interactions: показы по объекту берутся отдельным запросом со своей проверкой прав", async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${foreignPropertyShortId}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.interactions).toBeUndefined();
  });
});

/**
 * Ночная проверка 24.09.2026: clientId — поле только создания (в POST уходит в
 * sellerClientId), но propertyUpdateSchema наследовал его из propertyBaseSchema,
 * и PATCH с clientId в теле доезжал до Prisma как есть — 500 вместо ответа.
 */
describe("PATCH /properties/:id с clientId в теле", () => {
  it("MANAGER шлёт clientId вместе с ценой — 200, цена сохранена, сервер не падает", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${foreignPropertyId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ price: 43000, clientId: buyerClientId });
    expect(res.status).toBe(200);
    expect(Number(res.body.price)).toBe(43000);
  });
});
