import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/** Повторное обращение существующего клиента — до 11.08.2026 проходило совсем
 *  молча: createLeadFromChannel находила карточку по телефону и возвращала
 *  created:false без единой записи и без push. Агент узнавал об этом, только
 *  сам открыв «Сообщения». Решение владельца: push закреплённому агенту (или
 *  руководству, если агента нет) + запись в хронологии; принимать заново
 *  не нужно — клиент и так его. */

const sendPushToAgent = vi.fn(async () => 1);
const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents }));
vi.mock("../src/lib/workingHours.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/workingHours.js")>()),
  isWithinAlarmHours: async () => true,
}));

const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/leads.js");
const { flushDirectorAlertQueue } = await import("../src/lib/directorAlertQueue.js");

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let agentToken: string;
let directorId: string;
const clientIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент повтора", phone: `+992${runId}885`, role: "AGENT", passwordHash },
    })
  ).id;
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор повтора", phone: `+992${runId}884`, role: "DIRECTOR", passwordHash: "x" },
    })
  ).id;
  // Нужен только для ветки «потолок портфеля» ниже (POST .../reactivation-offer/accept).
  const { app } = await import("../src/app.js");
  const request = (await import("supertest")).default;
  const loginRes = await request(app).post("/api/v1/auth/login").send({ phone: `+992${runId}885`, password });
  agentToken = loginRes.body.accessToken as string;
});

beforeEach(() => {
  sendPushToAgent.mockClear();
  sendPushToAgents.mockClear();
});

/**
 * Дать «выстрелить и забыть» долететь до конца, прежде чем считать вызовы.
 *
 * Push о НОВОМ лиде уходит без await и с 11.08.2026 идёт через sendLeadPush: тот
 * сперва читает Настройки и выдаёт маркер действия, то есть делает два запроса к
 * базе, и только потом зовёт sendPushToAgent. Без паузы вызов от ПЕРВОГО обращения
 * приезжал уже после mockClear() и считался вызовом от второго.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.$disconnect();
});

describe("Повторное обращение — есть агент", () => {
  it("push уходит закреплённому агенту и в хронологии остаётся запись", async () => {
    const phone = `+992${runId}886`;
    const first = await createLeadFromChannel({ fullName: "Повторный клиент", phone, source: "INSTAGRAM" });
    clientIds.push(first.clientId);
    expect(first.created).toBe(true);
    await prisma.client.update({ where: { id: first.clientId }, data: { assignedAgentId: agentId } });
    await settle();
    sendPushToAgent.mockClear();

    const second = await createLeadFromChannel({
      fullName: "Повторный клиент",
      phone,
      source: "WHATSAPP",
      requirementsNotes: "спрашивает про рассрочку",
    });
    expect(second.created).toBe(false);
    expect(second.clientId).toBe(first.clientId);

    await settle();
    expect(sendPushToAgent).toHaveBeenCalledTimes(1);
    const [toAgent, payload] = sendPushToAgent.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(toAgent).toBe(agentId);
    expect(payload.title).toContain("снова обратился");

    const note = await prisma.interaction.findFirst({
      where: { clientId: first.clientId, type: "SYSTEM", notes: { contains: "снова обратился" } },
      orderBy: { createdAt: "desc" },
    });
    expect(note).not.toBeNull();
    // П-10 (17.09.2026, задание Б1/сборка): актор записи — КЛИЕНТ, он написал сам,
    // не агент; agentId теперь всегда null у не-агентского актора (CHECK в БД),
    // держатель карточки виден через subjectAgentId (см. intake.ts::resumeExistingChannelLead).
    expect(note?.agentId).toBeNull();
    expect(note?.subjectAgentId).toBe(agentId);
    /**
     * ПЛАТФОРМУ В ЗАМЕТКЕ НАЗЫВАЕМ СНОВА (решение владельца 12.09.2026, отмена
     * собственного запрета 17.08.2026): «пусть любой агент видит, откуда пришёл
     * клиент и в каком мессенджере общаются». С 17.08 по 12.09 тут проверялось
     * обратное — нейтральное «бот в мессенджере»; право clients.viewOrigin теперь
     * входит во все пресеты ролей, прятать канал не от кого.
     */
    expect(note?.notes).toContain("WhatsApp");
    // Суть обращения в заметке остаётся — её скрывать незачем, агенту с ней работать.
    expect(note?.notes).toContain("рассрочку");
  });

  it("повтор внутри короткого окна не шлёт второй пуш — защита от дублей вебхука", async () => {
    const phone = `+992${runId}887`;
    const first = await createLeadFromChannel({ fullName: "Дубль клиент", phone, source: "WEBSITE" });
    clientIds.push(first.clientId);
    await prisma.client.update({ where: { id: first.clientId }, data: { assignedAgentId: agentId } });

    await createLeadFromChannel({ fullName: "Дубль клиент", phone, source: "WEBSITE" });
    await settle();
    sendPushToAgent.mockClear();

    await createLeadFromChannel({ fullName: "Дубль клиент", phone, source: "WEBSITE" });
    await settle();
    expect(sendPushToAgent).not.toHaveBeenCalled();
  });
});

describe("Повторное обращение — карточка без агента", () => {
  it("push уходит руководству, а не в никуда", async () => {
    const phone = `+992${runId}888`;
    const first = await createLeadFromChannel({
      fullName: "Прочее обращение",
      phone,
      source: "INSTAGRAM",
      kind: "OTHER",
    });
    clientIds.push(first.clientId);
    await settle();
    sendPushToAgents.mockClear();

    const second = await createLeadFromChannel({ fullName: "Прочее обращение", phone, source: "INSTAGRAM" });
    expect(second.created).toBe(false);

    await settle();
    expect(sendPushToAgents).toHaveBeenCalledTimes(1);
    const [recipients, payload] = sendPushToAgents.mock.calls[0] as unknown as [string[], Record<string, string>];
    expect(recipients).toContain(directorId);
    expect(payload.title).toContain("снова обратился");
  });
});

/**
 * Пункт 26 разбора раздачи (24.09.2026): руководство будили ночью пушем
 * «Клиент без агента снова обратился» по лидам, которые утром раздадутся
 * сами, и по карточкам, ждущим ответа агента о дубле.
 */
describe("Повторное обращение без агента — когда руководство не будим", () => {
  let savedStrategy: string | undefined;
  beforeAll(async () => {
    const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadDistributionStrategy: true } });
    savedStrategy = s?.leadDistributionStrategy;
    await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: "fair" } });
  });
  afterAll(async () => {
    if (savedStrategy) {
      await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: savedStrategy } });
    }
  });

  async function unassignedBuyer(phone: string, extra: Record<string, unknown> = {}) {
    const c = await prisma.client.create({
      data: { fullName: "Покупатель без агента", phone, source: "INSTAGRAM", kind: "BUYER", ...extra },
    });
    clientIds.push(c.id);
    return c;
  }

  it("ночью лид ждёт утренней волны: пуша нет, запись в хронологии есть", async () => {
    const phone = `+992${runId}893`;
    const c = await unassignedBuyer(phone);
    const res = await createLeadFromChannel({ fullName: "Покупатель без агента", phone, source: "INSTAGRAM", deferAssignment: true });
    expect(res.created).toBe(false);
    await settle();
    const titles = sendPushToAgents.mock.calls.map((call) => (call as unknown as [string[], { title: string }])[1].title);
    expect(titles.some((t) => t.includes("снова обратился"))).toBe(false);
    const note = await prisma.interaction.findFirst({ where: { clientId: c.id, notes: { startsWith: "Клиент снова обратился" } } });
    expect(note).not.toBeNull();
  });

  it("в режиме «Вручную» ночью руководство всё равно зовут: волны не будет", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: "manual" } });
    try {
      const phone = `+992${runId}894`;
      await unassignedBuyer(phone);
      await createLeadFromChannel({ fullName: "Покупатель без агента", phone, source: "INSTAGRAM", deferAssignment: true });
      await settle();
      const titles = sendPushToAgents.mock.calls.map((call) => (call as unknown as [string[], { title: string }])[1].title);
      expect(titles.some((t) => t.includes("снова обратился"))).toBe(true);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { leadDistributionStrategy: "fair" } });
    }
  });

  it("карточка ждёт ответа агента о дубле — руководство не зовут назначать в обход", async () => {
    const original = await unassignedBuyer(`+992${runId}891`);
    const phone = `+992${runId}892`;
    await unassignedBuyer(phone, { kind: "OTHER", duplicateReviewOfClientId: original.id });
    await createLeadFromChannel({ fullName: "Покупатель без агента", phone, source: "INSTAGRAM" });
    await settle();
    const titles = sendPushToAgents.mock.calls.map((call) => (call as unknown as [string[], { title: string }])[1].title);
    expect(titles.some((t) => t.includes("снова обратился"))).toBe(false);
  });
});
