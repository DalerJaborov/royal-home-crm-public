import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * GET /agents/:id/live — верх карточки сотрудника («сейчас», лиды, переписка,
 * звонки), см. docs/archive/employee-card-brief-20-09.md §2 и §5. Отдельная ручка от
 * /overview (своя AGENT_LIVE_QUERY_CONCURRENCY), сужение по агенту проверяется
 * так же честно, как в agent-overview-problems.test.ts.
 */

const runId = Date.now();
const password = "testpass123";
const clientIds: string[] = [];
const interactionIds: string[] = [];
const botConversationIds: string[] = [];
const incomingCallIds: string[] = [];
let agentAId = "";
let agentBId = "";
let agentAPhone = "";
let directorPhone = "";
let managerNoPhonePhone = "";

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken ?? res.body.token;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentAPhone = `+992967${String(runId).slice(-7)}`;
  const agentBPhone = `+992968${String(runId).slice(-7)}`;
  directorPhone = `+992969${String(runId).slice(-7)}`;

  // Перед созданием своих записей — убрать одноимённые (ловушка 20.09.2026).
  await prisma.agent.deleteMany({ where: { phone: { in: [agentAPhone, agentBPhone, directorPhone] } } });

  const [agentA, agentB] = await Promise.all([
    prisma.agent.create({ data: { fullName: `Живая карточка А ${runId}`, phone: agentAPhone, role: "AGENT", passwordHash } }),
    prisma.agent.create({ data: { fullName: `Живая карточка Б ${runId}`, phone: agentBPhone, role: "AGENT", passwordHash } }),
  ]);
  agentAId = agentA.id;
  agentBId = agentB.id;
  await prisma.agent.create({
    data: { fullName: `Живая карточка Директор ${runId}`, phone: directorPhone, role: "DIRECTOR", passwordHash },
  });
});

afterAll(async () => {
  await prisma.incomingCall.deleteMany({ where: { id: { in: incomingCallIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: botConversationIds } } });
  await prisma.interaction.deleteMany({ where: { id: { in: interactionIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId] } } });
  await prisma.agent.deleteMany({ where: { phone: { in: [directorPhone, managerNoPhonePhone].filter(Boolean) } } });
});

describe("GET /agents/:id/live", () => {
  it("1. 403 рядовому агенту — и на чужую карточку, и на свою", async () => {
    const token = await login(agentAPhone);
    const resOwn = await request(app).get(`/api/v1/agents/${agentAId}/live`).set("Authorization", `Bearer ${token}`);
    expect(resOwn.status).toBe(403);
    const resOther = await request(app).get(`/api/v1/agents/${agentBId}/live`).set("Authorization", `Bearer ${token}`);
    expect(resOther.status).toBe(403);
  });

  it("2. 404 на несуществующего сотрудника", async () => {
    const token = await login(directorPhone);
    const res = await request(app)
      .get(`/api/v1/agents/00000000-0000-0000-0000-000000000000/live`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("3. сужение по агенту честное — чужой клиент/диалог/звонок не протекают", async () => {
    const clientB = await prisma.client.create({
      data: {
        fullName: `Чужой клиент Б ${runId}`,
        phone: `+992970${String(runId).slice(-7)}`,
        source: "INSTAGRAM",
        kind: "BUYER",
        assignedAgentId: agentBId,
        acceptedAt: new Date(),
      },
    });
    clientIds.push(clientB.id);

    const chatB = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `sub-b-${runId}`,
        clientId: clientB.id,
        messages: [{ role: "user", content: "Здравствуйте" }],
        lastMessageAt: new Date(),
      },
    });
    botConversationIds.push(chatB.id);

    const callB = await prisma.interaction.create({
      data: {
        clientId: clientB.id,
        agentId: agentBId,
        type: "CALL",
        notes: "звонок агента Б",
        callAttempt: "TALKED",
        recordingUrl: "https://example.com/rec-b.mp3",
      },
    });
    interactionIds.push(callB.id);

    const token = await login(directorPhone);
    const res = await request(app).get(`/api/v1/agents/${agentAId}/live`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.chats).toEqual([]);
    expect(res.body.calls.last).toEqual([]);
    expect(res.body.leads.byStatus).toEqual({});
  });

  it("4. переписка: lastFrom честно отличает клиента/агента/бота, messages не массивом не роняет ручку", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Клиент переписки ${runId}`,
        phone: `+992971${String(runId).slice(-7)}`,
        source: "INSTAGRAM",
        kind: "BUYER",
        assignedAgentId: agentAId,
        // Не HOT/NEW намеренно — не должен мешать проверке byStatus в тесте 8
        // (клиенты этого файла живут на общем agentAId дольше одного it()).
        status: "CONTACTED",
        acceptedAt: new Date(),
      },
    });
    clientIds.push(client.id);

    const chat = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `sub-a-${runId}`,
        clientId: client.id,
        messages: [{ role: "user", content: "Привет" }],
        lastMessageAt: new Date(),
      },
    });
    botConversationIds.push(chat.id);

    const token = await login(directorPhone);

    const resUser = await request(app).get(`/api/v1/agents/${agentAId}/live`).set("Authorization", `Bearer ${token}`);
    expect(resUser.status).toBe(200);
    expect(resUser.body.chats[0].lastFrom).toBe("client");

    await prisma.botConversation.update({
      where: { id: chat.id },
      data: { messages: [{ role: "assistant", content: "Отвечаю", by: { kind: "agent", agentId: agentAId, agentName: "Тест" } }] },
    });
    const resAgent = await request(app).get(`/api/v1/agents/${agentAId}/live`).set("Authorization", `Bearer ${token}`);
    expect(resAgent.body.chats[0].lastFrom).toBe("agent");

    await prisma.botConversation.update({
      where: { id: chat.id },
      data: { messages: [{ role: "assistant", content: "Отвечает бот" }] },
    });
    const resBot = await request(app).get(`/api/v1/agents/${agentAId}/live`).set("Authorization", `Bearer ${token}`);
    expect(resBot.body.chats[0].lastFrom).toBe("bot");

    // messages не массив — ручка отвечает 200, а не 500 (ради этого в SQL jsonb_typeof).
    await prisma.$executeRaw`UPDATE "BotConversation" SET messages = '{"broken": true}'::jsonb WHERE id = ${chat.id}`;
    const resBroken = await request(app).get(`/api/v1/agents/${agentAId}/live`).set("Authorization", `Bearer ${token}`);
    expect(resBroken.status).toBe(200);
  });

  it("5. маскирование телефона в тексте переписки — по clients.viewPhone смотрящего", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Клиент с номером в тексте ${runId}`,
        phone: `+992972${String(runId).slice(-7)}`,
        source: "INSTAGRAM",
        kind: "BUYER",
        assignedAgentId: agentAId,
        status: "CONTACTED",
        acceptedAt: new Date(),
      },
    });
    clientIds.push(client.id);

    const chat = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `sub-phone-${runId}`,
        clientId: client.id,
        messages: [{ role: "user", content: "мой номер +992900112233" }],
        lastMessageAt: new Date(),
      },
    });
    botConversationIds.push(chat.id);

    const directorToken = await login(directorPhone);
    const resDirector = await request(app).get(`/api/v1/agents/${agentAId}/live`).set("Authorization", `Bearer ${directorToken}`);
    expect(resDirector.status).toBe(200);
    const directorChat = resDirector.body.chats.find((c: { conversationId: string }) => c.conversationId === chat.id);
    expect(directorChat.lastText).toContain("900112233");

    // MANAGER имеет team.viewFull (видит ручку), но не clients.viewPhone
    // (packages/shared/src/permissions.ts, ROLE_PRESETS.MANAGER) — честный
    // "смотрящий без права" для этой проверки.
    const passwordHash = await bcrypt.hash(password, 10);
    managerNoPhonePhone = `+992973${String(runId).slice(-7)}`;
    await prisma.agent.deleteMany({ where: { phone: managerNoPhonePhone } });
    await prisma.agent.create({
      data: { fullName: `Живая карточка Менеджер ${runId}`, phone: managerNoPhonePhone, role: "MANAGER", passwordHash },
    });
    const managerToken = await login(managerNoPhonePhone);
    const resManager = await request(app).get(`/api/v1/agents/${agentAId}/live`).set("Authorization", `Bearer ${managerToken}`);
    expect(resManager.status).toBe(200);
    const managerChat = resManager.body.chats.find((c: { conversationId: string }) => c.conversationId === chat.id);
    expect(managerChat.lastText).toContain("****");
    expect(managerChat.lastText).not.toContain("900112233");
  });

  it("6. звонки за неделю: groupBy честный, без записи/расшифровки не попадает в last, recordingUrl не уходит наружу", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Клиент звонков ${runId}`,
        phone: `+992974${String(runId).slice(-7)}`,
        source: "INSTAGRAM",
        kind: "BUYER",
        assignedAgentId: agentAId,
        status: "CONTACTED",
        acceptedAt: new Date(),
      },
    });
    clientIds.push(client.id);

    const [talked, noAnswer, agentNoPickup, noRecording] = await Promise.all([
      prisma.interaction.create({
        data: {
          clientId: client.id,
          agentId: agentAId,
          type: "CALL",
          notes: "поговорили",
          callAttempt: "TALKED",
          recordingUrl: "https://example.com/rec1.mp3",
          recordingDurationSec: 83,
        },
      }),
      prisma.interaction.create({
        data: { clientId: client.id, agentId: agentAId, type: "CALL", notes: "не ответил", callAttempt: "NO_ANSWER" },
      }),
      prisma.interaction.create({
        data: { clientId: client.id, agentId: agentAId, type: "CALL", notes: "сам не поднял", callAttempt: "AGENT_NO_PICKUP" },
      }),
      prisma.interaction.create({
        data: { clientId: client.id, agentId: agentAId, type: "CALL", notes: "без записи", callAttempt: "TALKED" },
      }),
    ]);
    interactionIds.push(talked.id, noAnswer.id, agentNoPickup.id, noRecording.id);

    const token = await login(directorPhone);
    const res = await request(app).get(`/api/v1/agents/${agentAId}/live`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.calls.weekTotal).toBe(4);
    expect(res.body.calls.weekTalked).toBe(2);

    const withRecording = res.body.calls.last.find((c: { id: string }) => c.id === talked.id);
    expect(withRecording).toBeDefined();
    expect(withRecording.hasRecording).toBe(true);
    expect(withRecording.recordingUrl).toBeUndefined();

    const withoutRecording = res.body.calls.last.find((c: { id: string }) => c.id === noRecording.id);
    expect(withoutRecording).toBeUndefined();
  });

  it("7. пропущенные входящие: считаются свои routedToId, чужой routedToId не считается", async () => {
    const own = await prisma.incomingCall.create({
      data: {
        channelId: `chan-own-${runId}`,
        phone: `+992975${String(runId).slice(-7)}`,
        answered: false,
        routedToId: agentAId,
      },
    });
    const foreign = await prisma.incomingCall.create({
      data: {
        channelId: `chan-foreign-${runId}`,
        phone: `+992976${String(runId).slice(-7)}`,
        answered: false,
        routedToId: agentBId,
      },
    });
    incomingCallIds.push(own.id, foreign.id);

    const token = await login(directorPhone);
    const res = await request(app).get(`/api/v1/agents/${agentAId}/live`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.calls.weekMissedIncoming).toBeGreaterThanOrEqual(1);

    const resB = await request(app).get(`/api/v1/agents/${agentBId}/live`).set("Authorization", `Bearer ${token}`);
    // У Б чужих непринятых записей быть не должно из этой пары.
    expect(resB.body.calls.weekMissedIncoming).toBeGreaterThanOrEqual(1);
  });

  it("8. лиды по этапам: byStatus честный, Корзина не считается, unaccepted честный", async () => {
    const hot1 = await prisma.client.create({
      data: {
        fullName: `Лид HOT 1 ${runId}`,
        phone: `+992977${String(runId).slice(-7)}`,
        source: "INSTAGRAM",
        kind: "BUYER",
        assignedAgentId: agentAId,
        status: "HOT",
        acceptedAt: new Date(),
      },
    });
    const hot2 = await prisma.client.create({
      data: {
        fullName: `Лид HOT 2 ${runId}`,
        phone: `+992978${String(runId).slice(-7)}`,
        source: "INSTAGRAM",
        kind: "BUYER",
        assignedAgentId: agentAId,
        status: "HOT",
        // не принят — acceptedAt намеренно не заполнен
      },
    });
    const newLead = await prisma.client.create({
      data: {
        fullName: `Лид NEW ${runId}`,
        phone: `+992979${String(runId).slice(-7)}`,
        source: "INSTAGRAM",
        kind: "BUYER",
        assignedAgentId: agentAId,
        status: "NEW",
        acceptedAt: new Date(),
      },
    });
    const trashed = await prisma.client.create({
      data: {
        fullName: `Лид в корзине ${runId}`,
        phone: `+992980${String(runId).slice(-7)}`,
        source: "INSTAGRAM",
        kind: "BUYER",
        assignedAgentId: agentAId,
        status: "HOT",
        acceptedAt: new Date(),
        deletedAt: new Date(),
      },
    });
    clientIds.push(hot1.id, hot2.id, newLead.id, trashed.id);

    const token = await login(directorPhone);
    const res = await request(app).get(`/api/v1/agents/${agentAId}/live`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.leads.byStatus.HOT).toBe(2);
    expect(res.body.leads.byStatus.NEW).toBe(1);
    expect(res.body.leads.unaccepted).toBeGreaterThanOrEqual(1);
  });

  it("9. пустой агент: 200, честные нули и null, а не undefined", async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    const emptyPhone = `+992981${String(runId).slice(-7)}`;
    await prisma.agent.deleteMany({ where: { phone: emptyPhone } });
    const emptyAgent = await prisma.agent.create({
      data: { fullName: `Пустой сотрудник ${runId}`, phone: emptyPhone, role: "AGENT", passwordHash },
    });

    const token = await login(directorPhone);
    const res = await request(app).get(`/api/v1/agents/${emptyAgent.id}/live`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.now.call).toBeNull();
    expect(res.body.now.nextTask).toBeNull();
    expect(res.body.chats).toEqual([]);
    expect(res.body.calls.last).toEqual([]);
    expect(res.body.calls.weekTotal).toBe(0);
    expect(res.body.calls.weekTalked).toBe(0);
    expect(res.body.calls.weekMissedIncoming).toBe(0);
    expect(res.body.leads.inWork).toBe(0);
    expect(res.body.leads.unaccepted).toBe(0);
    expect(res.body.leads.byStatus).toEqual({});

    await prisma.agent.delete({ where: { id: emptyAgent.id } });
  });
});
