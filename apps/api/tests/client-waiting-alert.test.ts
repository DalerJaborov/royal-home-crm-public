import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));

const { prisma } = await import("../src/db.js");
const { alertClientWaiting, runClientSilenceSweep, waitingEpisodeOf, CLIENT_WAITING_MINUTES } = await import(
  "../src/lib/clientWaitingAlert.js"
);

/**
 * «КЛИЕНТ НАПИСАЛ — ЕМУ НИКТО НЕ ОТВЕТИЛ» (14.11.2026, аудит скрытых механизмов №4).
 * Сторож молчания (крон `client-silence-sweep`) и одна дверь `alertClientWaiting`,
 * которую зовёт и ядро бота при «передать сотруднику» без ответа.
 */

const runId = Date.now().toString(36);
const minutesAgo = (n: number, from = new Date()) => new Date(from.getTime() - n * 60_000).toISOString();
let agentId = "";
let inactiveAgentId = "";
const clientIds: string[] = [];
const convIds: string[] = [];
let savedHours: { workHoursStart: string | null; workHoursEnd: string | null } | null = null;

async function conversation(messages: object[], opts: { clientAgentId?: string | null; noClient?: boolean } = {}) {
  let clientId: string | null = null;
  if (!opts.noClient) {
    const client = await prisma.client.create({
      data: {
        fullName: `Ждущий клиент ${runId}-${convIds.length}`,
        phone: `+99291${String(Date.now() + convIds.length).slice(-7)}`,
        source: "INSTAGRAM",
        assignedAgentId: opts.clientAgentId ?? agentId,
      },
    });
    clientId = client.id;
    clientIds.push(client.id);
  }
  const conv = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `client-waiting-${runId}-${convIds.length}`,
      messages,
      lastMessageAt: new Date(),
      ...(clientId ? { clientId } : {}),
    },
  });
  convIds.push(conv.id);
  return conv.id;
}

const ownPush = (convId: string) =>
  sendPushToAgent.mock.calls.filter(([, p]) => (p as { tag?: string }).tag === `client-waiting-${convId}`);

beforeAll(async () => {
  savedHours = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { workHoursStart: true, workHoursEnd: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "23:59" } });
  agentId = (
    await prisma.agent.create({ data: { fullName: `Агент ждущих ${runId}`, phone: `+99292${String(Date.now()).slice(-7)}`, role: "AGENT", passwordHash: "x" } })
  ).id;
  inactiveAgentId = (
    await prisma.agent.create({
      data: { fullName: `Уволенный ${runId}`, phone: `+99293${String(Date.now()).slice(-7)}`, role: "AGENT", passwordHash: "x", isActive: false },
    })
  ).id;
});

beforeEach(() => sendPushToAgent.mockClear());

afterAll(async () => {
  if (savedHours) await prisma.settings.update({ where: { id: "singleton" }, data: savedHours });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: convIds.map((id) => `client-waiting-${id}`) } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: convIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, inactiveAgentId] } } });
});

describe("waitingEpisodeOf — хвост неотвеченных реплик", () => {
  it("начало эпизода — ПЕРВАЯ неотвеченная реплика, а не последняя", () => {
    const ep = waitingEpisodeOf([
      { role: "user", content: "старое", at: "2026-11-14T05:00:00Z" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "вопрос", at: "2026-11-14T06:00:00Z", customerPropertyAdmission: { eventKey: "k1" } },
      { role: "user", content: "алло?", at: "2026-11-14T06:20:00Z" },
    ]);
    expect(ep?.since.toISOString()).toBe("2026-11-14T06:00:00.000Z");
    expect(ep?.eventKeys).toEqual(["k1"]);
    expect(ep?.untracked).toBe(1);
  });
  it("последней ответили — молчания нет", () => {
    expect(waitingEpisodeOf([{ role: "user", at: "2026-11-14T06:00:00Z" }, { role: "assistant", content: "да" }])).toBeNull();
  });
  it("недоставленный ответ бота — молчание продолжается", () => {
    const ep = waitingEpisodeOf([
      { role: "user", at: "2026-11-14T06:00:00Z" },
      { role: "assistant", content: "не дошло", deliveryStatus: "failed" },
    ]);
    expect(ep?.since.toISOString()).toBe("2026-11-14T06:00:00.000Z");
  });
  it("реплика, записанная самим кодом (тихий приём номера), эпизод не начинает", () => {
    expect(waitingEpisodeOf([{ role: "assistant", content: "ок" }, { role: "user", at: "2026-11-14T06:00:00Z", silentCapture: true }])).toBeNull();
  });
  it("без отметки времени начало не доказать — молчим", () => {
    expect(waitingEpisodeOf([{ role: "user", content: "старая запись" }])).toBeNull();
    expect(waitingEpisodeOf("not-an-array")).toBeNull();
  });
});

describe("runClientSilenceSweep — сторож молчания", () => {
  it("клиент ждёт дольше порога — пуш закреплённому агенту, один раз на эпизод", async () => {
    const firstAsk = { role: "user", content: "есть 2-комн.?", at: minutesAgo(CLIENT_WAITING_MINUTES + 10) };
    const id = await conversation([firstAsk]);
    await runClientSilenceSweep();
    const first = ownPush(id);
    expect(first).toHaveLength(1);
    expect(first[0][0]).toBe(agentId);
    expect((first[0][1] as { url?: string }).url).toBe(`/messages?open=${id}`);

    // Второй тик — тот же эпизод, сигнала нет.
    await runClientSilenceSweep();
    expect(ownPush(id)).toHaveLength(1);

    // Клиент дописал ещё — эпизод тот же.
    await prisma.botConversation.update({
      where: { id },
      data: { messages: [firstAsk, { role: "user", content: "алло", at: minutesAgo(1) }] },
    });
    await runClientSilenceSweep();
    expect(ownPush(id)).toHaveLength(1);

    // Ответили, потом снова молчание дольше порога — новый эпизод, новый сигнал.
    await prisma.botConversation.update({
      where: { id },
      data: {
        messages: [
          { role: "user", content: "есть 2-комн.?", at: minutesAgo(200) },
          { role: "assistant", content: "Да, есть" },
          { role: "user", content: "а цена?", at: minutesAgo(CLIENT_WAITING_MINUTES + 5) },
        ],
      },
    });
    await runClientSilenceSweep();
    expect(ownPush(id)).toHaveLength(2);
  });

  it("моложе порога — рано", async () => {
    const id = await conversation([{ role: "user", content: "привет", at: minutesAgo(CLIENT_WAITING_MINUTES - 10) }]);
    await runClientSilenceSweep();
    expect(ownPush(id)).toHaveLength(0);
  });

  it("агента нет (или он уволен) — срочная тревога руководству, мимо часов алармов", async () => {
    const noClient = await conversation([{ role: "user", content: "здравствуйте", at: minutesAgo(45) }], { noClient: true });
    const firedAgent = await conversation([{ role: "user", content: "здравствуйте", at: minutesAgo(45) }], { clientAgentId: inactiveAgentId });
    await runClientSilenceSweep();
    for (const id of [noClient, firedAgent]) {
      expect(ownPush(id)).toHaveLength(0);
      const row = await prisma.pendingDirectorAlert.findFirst({ where: { tag: `client-waiting-${id}` } });
      expect(row?.urgent).toBe(true);
      expect(row?.level).toBe("CRITICAL");
    }
  });

  it("агент позвонил клиенту после его реплики — разговор был, сигнала нет", async () => {
    const id = await conversation([{ role: "user", content: "перезвоните", at: minutesAgo(50) }]);
    const conv = await prisma.botConversation.findUniqueOrThrow({ where: { id }, select: { clientId: true } });
    await prisma.interaction.create({
      data: { clientId: conv.clientId!, agentId, type: "CALL", outcome: "POSITIVE", notes: "дозвонился", createdAt: new Date(Date.now() - 20 * 60_000) },
    });
    await runClientSilenceSweep();
    expect(ownPush(id)).toHaveLength(0);
    await prisma.interaction.deleteMany({ where: { clientId: conv.clientId! } });
  });

  it("ядро промолчало намеренно (чужой ролик без вопроса) — сигнала нет", async () => {
    const key = `intentional-${runId}`;
    const id = await conversation([{ role: "user", content: "[reel]", at: minutesAgo(50), customerPropertyAdmission: { eventKey: key } }]);
    const spy = vi
      .spyOn(prisma.customerPropertyIngressTicket, "findMany")
      .mockResolvedValueOnce([{ eventKey: key, errorCode: "foreign_share_no_reply" }] as never);
    await runClientSilenceSweep();
    spy.mockRestore();
    expect(ownPush(id)).toHaveLength(0);
  });

  it("вне часов раздачи сторож молчит", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "03:00", workHoursEnd: "03:01" } });
    try {
      const res = await runClientSilenceSweep(new Date("2026-11-14T12:00:00Z")); // 17:00 Душанбе
      expect(res.skippedOffHours).toBe(true);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "00:00", workHoursEnd: "23:59" } });
    }
  });
});

describe("alertClientWaiting — «передать сотруднику» без ответа", () => {
  it("эскалация из ядра зовёт агента сразу, повтор того же эпизода (сторож) — молчит", async () => {
    const id = await conversation([{ role: "user", content: "позовите человека", at: minutesAgo(1) }]);
    expect(await alertClientWaiting({ conversationId: id, trigger: "escalate" })).toBe("agent");
    const pushed = ownPush(id);
    expect(pushed).toHaveLength(1);
    expect((pushed[0][1] as { body: string }).body).toContain("нужен сотрудник");
    expect(await alertClientWaiting({ conversationId: id, trigger: "silence" })).toBe("skipped");
    expect(ownPush(id)).toHaveLength(1);
  });

  it("отписавшийся клиент — не беспокоим", async () => {
    const id = await conversation([{ role: "user", content: "стоп", at: minutesAgo(40) }]);
    await prisma.botConversation.update({ where: { id }, data: { optedOutAt: new Date() } });
    expect(await alertClientWaiting({ conversationId: id, trigger: "silence" })).toBe("skipped");
  });
});
