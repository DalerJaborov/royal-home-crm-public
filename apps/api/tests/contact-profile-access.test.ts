import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { identitiesForMessengerChannel, resolveContactProfile } from "../src/lib/contactProfiles.js";

/**
 * ДОСЬЕ НЕ ШИРЕ ПЕРЕПИСКИ.
 *
 * Права на маршруте `GET /contacts/:id` проверялись, а выдача не сужалась: агент,
 * которому в инбоксе видны только свои переписки, мог открыть по id любое досье
 * агентства и прочитать чужой бюджет, район, цену чужого объекта, код карточки и
 * имя закреплённого за ней агента. Заголовок самого файла маршрутов называет это
 * обходом запрета — обходом оно и было (найдено 22.09.2026).
 *
 * Проверяется ровно граница: чужое — не отдаётся, своё — отдаётся, ушедшее в
 * Корзину перестаёт быть своим.
 */

const runId = Date.now();
const digits6 = String(runId).slice(-6);
const WA_MINE = `992913${digits6.slice(0, 3)}`;
const WA_ALIEN = `992914${digits6.slice(0, 3)}`;
const password = "testpass123";

let directorToken = "";
let agentToken = "";
let agentId = "";
let mineProfileId = "";
let alienProfileId = "";
let mineClientId = "";
let alienClientId = "";
const agentIds: string[] = [];
const conversationIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function cleanup(): Promise<void> {
  if (conversationIds.length > 0) {
    await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  }
  const profiles = [mineProfileId, alienProfileId].filter(Boolean);
  if (profiles.length > 0) {
    await prisma.contactIdentity.deleteMany({ where: { profileId: { in: profiles } } });
    await prisma.contactProfile.deleteMany({ where: { id: { in: profiles } } });
  }
  const clients = [mineClientId, alienClientId].filter(Boolean);
  if (clients.length > 0) await prisma.client.deleteMany({ where: { id: { in: clients } } });
  if (agentIds.length > 0) await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
}

beforeAll(async () => {
  await cleanup();
  const passwordHash = await bcrypt.hash(password, 10);
  const director = await prisma.agent.create({
    data: { fullName: `Директор доступа ${runId}`, phone: `+992966${digits6}`, role: "DIRECTOR", passwordHash },
  });
  const agent = await prisma.agent.create({
    data: { fullName: `Агент доступа ${runId}`, phone: `+992967${digits6}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  agentIds.push(director.id, agent.id);
  directorToken = await login(`+992966${digits6}`);
  agentToken = await login(`+992967${digits6}`);

  // Свой клиент: карточка принята и закреплена за этим агентом.
  const mine = await prisma.client.create({
    data: {
      fullName: `Свой клиент ${runId}`,
      phone: `+${WA_MINE}`,
      source: "WHATSAPP",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
    select: { id: true },
  });
  mineClientId = mine.id;

  // Чужой клиент: закреплён за директором.
  const alien = await prisma.client.create({
    data: {
      fullName: `Чужой клиент ${runId}`,
      phone: `+${WA_ALIEN}`,
      source: "WHATSAPP",
      assignedAgentId: director.id,
      acceptedAt: new Date(),
    },
    select: { id: true },
  });
  alienClientId = alien.id;

  const mineProfile = await resolveContactProfile({
    identities: identitiesForMessengerChannel("WHATSAPP", WA_MINE),
  });
  mineProfileId = mineProfile!.profileId;
  const alienProfile = await resolveContactProfile({
    identities: identitiesForMessengerChannel("WHATSAPP", WA_ALIEN),
  });
  alienProfileId = alienProfile!.profileId;

  // Связь досье с карточкой — через переписку, как это и бывает в жизни.
  for (const [profileId, clientId, subscriberId] of [
    [mineProfileId, mineClientId, WA_MINE],
    [alienProfileId, alienClientId, WA_ALIEN],
  ] as const) {
    const conv = await prisma.botConversation.create({
      data: { channel: "WHATSAPP", subscriberId, contactProfileId: profileId, clientId },
      select: { id: true },
    });
    conversationIds.push(conv.id);
  }
});

afterAll(cleanup);

describe("досье открывается не шире, чем сама переписка", () => {
  it("тот, кто видит все переписки, видит любое досье", async () => {
    for (const id of [mineProfileId, alienProfileId]) {
      const res = await request(app).get(`/api/v1/contacts/${id}`).set("Authorization", `Bearer ${directorToken}`);
      expect(res.status).toBe(200);
      expect(res.body.contact.id).toBe(id);
    }
  });

  it("агент видит досье своего клиента", async () => {
    const res = await request(app)
      .get(`/api/v1/contacts/${mineProfileId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.contact.id).toBe(mineProfileId);
  });

  it("чужое досье агенту не отдаётся — и по коду ответа не отличить от несуществующего", async () => {
    const res = await request(app)
      .get(`/api/v1/contacts/${alienProfileId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
    // Ни фактов, ни карточки, ни имени закреплённого агента.
    expect(res.body.contact).toBeUndefined();
  });

  it("карточка ушла в Корзину — досье перестаёт быть своим", async () => {
    await prisma.client.update({ where: { id: mineClientId }, data: { deletedAt: new Date() } });
    try {
      const res = await request(app)
        .get(`/api/v1/contacts/${mineProfileId}`)
        .set("Authorization", `Bearer ${agentToken}`);
      expect(res.status).toBe(404);
    } finally {
      await prisma.client.update({ where: { id: mineClientId }, data: { deletedAt: null } });
    }
  });
});
