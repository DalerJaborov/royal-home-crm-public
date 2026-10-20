import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * ДОСЬЕ СОБЕСЕДНИКА — ТОЛЬКО ПО СВОИМ КЛИЕНТАМ (находка 5.1 сплошной проверки
 * бота 21.09.2026).
 *
 * Права на маршруте стояли (`messages.view`/`messages.viewOwn`), а сужения не
 * было: агент с правом «Чаты своих клиентов» перебором `GET /contacts/<uuid>`
 * получал по ЛЮБОМУ человеку агентства имя, категорию, факты (бюджет, район,
 * цену чужого объекта), код карточки и телефон. Инбокс тот же запрет соблюдал,
 * потому что сужение жило внутри `routes/conversations.ts`, — обход получался
 * из того, что правило было выписано в одном входе и забыто в другом.
 *
 * Проверяется ровно то, что можно потерять одной правкой:
 *  1. своё досье открывается;
 *  2. чужое — 404, а не 403 (существование чужих досье не подтверждаем);
 *  3. досье без карточки закрыто так же, как диалог из общей очереди;
 *  4. досье по НЕПРИНЯТОМУ лиду закрыто так же, как карточка до принятия;
 *  5. связь через диалог считается: карточка у агента, а `clientId` у досье пуст;
 *  6. надгробие слитого досье спрашивает права у ЖИВОЙ записи;
 *  7. руководителю по-прежнему видно всё.
 */

const runId = Date.now();
const password = "testpass123";

let agentId = "";
let otherAgentId = "";
let directorId = "";
let agentToken = "";
let directorToken = "";
const clientIds: string[] = [];
const convIds: string[] = [];
const profileIds: string[] = [];

let ownProfileId = "";
let foreignProfileId = "";
let orphanProfileId = "";
let notAcceptedProfileId = "";
let byConversationProfileId = "";
let tombstoneProfileId = "";

async function makeAgent(name: string, role: "AGENT" | "DIRECTOR", suffix: string) {
  const passwordHash = await bcrypt.hash(password, 10);
  const phone = `+9927${suffix}${String(runId).slice(-6)}`;
  // Одноимённую запись убираем перед своей: при `retry` повтор идёт в том же
  // процессе с тем же runId и падал бы на своём же уникальном индексе.
  await prisma.agent.deleteMany({ where: { phone } });
  return prisma.agent.create({ data: { fullName: `${name} ${runId}`, phone, role, passwordHash } });
}

async function makeClient(opts: { agent: string; accepted: boolean; tag: string; digit: string }) {
  // Номер собирается из СВОЕЙ цифры, а не из длины метки: длины у «own» и «newlead»
  // разошлись бы не сразу, а номер вышел бы один и тот же (грабли 20.09.2026).
  const phone = `+9926${opts.digit}${String(runId).slice(-6)}`;
  await prisma.client.deleteMany({ where: { phone } });
  const client = await prisma.client.create({
    data: {
      fullName: `Клиент досье ${opts.tag} ${runId}`,
      phone,
      source: "INSTAGRAM",
      assignedAgentId: opts.agent,
      acceptedAt: opts.accepted ? new Date() : null,
    },
  });
  clientIds.push(client.id);
  return client.id;
}

async function makeProfile(opts: { clientId?: string; tag: string }) {
  const profile = await prisma.contactProfile.create({
    data: {
      displayName: `Собеседник ${opts.tag} ${runId}`,
      nameSource: "self",
      category: "BUYER",
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
    },
  });
  profileIds.push(profile.id);
  return profile.id;
}

async function makeConversation(opts: { clientId?: string; profileId: string; tag: string }) {
  const conv = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `dossier-${opts.tag}-${runId}`,
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
      contactProfileId: opts.profileId,
      lastMessageAt: new Date(),
      messages: [{ role: "user", content: `реплика ${opts.tag}`, at: new Date().toISOString() }],
    },
  });
  convIds.push(conv.id);
  return conv.id;
}

const get = (id: string, token: string) =>
  request(app).get(`/api/v1/contacts/${id}`).set("Authorization", `Bearer ${token}`);

beforeAll(async () => {
  const agent = await makeAgent("Агент досье", "AGENT", "1");
  const other = await makeAgent("Чужой агент досье", "AGENT", "2");
  const director = await makeAgent("Директор досье", "DIRECTOR", "3");
  agentId = agent.id;
  otherAgentId = other.id;
  directorId = director.id;

  agentToken = (await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password })).body.accessToken;
  directorToken = (await request(app).post("/api/v1/auth/login").send({ phone: director.phone, password })).body
    .accessToken;

  const ownClientId = await makeClient({ agent: agentId, accepted: true, tag: "own", digit: "1" });
  const foreignClientId = await makeClient({ agent: otherAgentId, accepted: true, tag: "foreign", digit: "2" });
  const newClientId = await makeClient({ agent: agentId, accepted: false, tag: "newlead", digit: "3" });
  const viaConvClientId = await makeClient({ agent: agentId, accepted: true, tag: "viaconv", digit: "4" });

  ownProfileId = await makeProfile({ clientId: ownClientId, tag: "own" });
  foreignProfileId = await makeProfile({ clientId: foreignClientId, tag: "foreign" });
  orphanProfileId = await makeProfile({ tag: "orphan" });
  notAcceptedProfileId = await makeProfile({ clientId: newClientId, tag: "newlead" });

  // Досье само карточку не знает — её знает диалог, который на досье ссылается.
  byConversationProfileId = await makeProfile({ tag: "viaconv" });
  await makeConversation({ clientId: viaConvClientId, profileId: byConversationProfileId, tag: "viaconv" });

  // Надгробие: слито в досье ЧУЖОГО клиента, старый id остаётся рабочей ссылкой.
  tombstoneProfileId = await makeProfile({ tag: "tomb" });
  await prisma.contactProfile.update({
    where: { id: tombstoneProfileId },
    data: { mergedIntoId: foreignProfileId },
  });
});

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: convIds } } });
  await prisma.contactProfile.updateMany({ where: { id: { in: profileIds } }, data: { mergedIntoId: null } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: profileIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId, directorId] } } });
  await prisma.$disconnect();
});

describe("Досье собеседника суживается до клиентов агента", () => {
  it("своё досье открывается", async () => {
    const res = await get(ownProfileId, agentToken);
    expect(res.status).toBe(200);
    expect(res.body.contact?.id).toBe(ownProfileId);
  });

  it("чужое досье не открывается по прямой ссылке — 404, а не 403", async () => {
    const res = await get(foreignProfileId, agentToken);
    expect(res.status).toBe(404);
    expect(res.body.contact).toBeUndefined();
  });

  it("досье без карточки закрыто: оно в общей очереди разбора, а не у агента", async () => {
    const res = await get(orphanProfileId, agentToken);
    expect(res.status).toBe(404);
  });

  it("досье по непринятому лиду закрыто так же, как карточка до принятия", async () => {
    const res = await get(notAcceptedProfileId, agentToken);
    expect(res.status).toBe(404);
  });

  it("связь через диалог считается: карточка у агента, clientId у досье пуст", async () => {
    const res = await get(byConversationProfileId, agentToken);
    expect(res.status).toBe(200);
    expect(res.body.contact?.id).toBe(byConversationProfileId);
  });

  it("надгробие спрашивает права у живой записи, а не у себя", async () => {
    // Панель показала бы содержание выжившего (чужого) досье — значит и права
    // обязана спросить у него, иначе чужое отдаётся по старому id.
    const res = await get(tombstoneProfileId, agentToken);
    expect(res.status).toBe(404);
  });

  it("руководителю видно и своё, и чужое — сужение только для агента", async () => {
    expect((await get(ownProfileId, directorToken)).status).toBe(200);
    expect((await get(foreignProfileId, directorToken)).status).toBe(200);
    expect((await get(orphanProfileId, directorToken)).status).toBe(200);
  });

  it("менять роль собеседника агент не может ни у своего, ни у чужого", async () => {
    for (const id of [ownProfileId, foreignProfileId]) {
      const res = await request(app)
        .patch(`/api/v1/contacts/${id}`)
        .set("Authorization", `Bearer ${agentToken}`)
        .send({ category: "SELLER" });
      expect(res.status).toBe(403);
    }
  });
});
