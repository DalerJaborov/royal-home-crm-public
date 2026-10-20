import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import {
  consumeLeadActionToken,
  hashActionToken,
  issueLeadActionToken,
  loadPushActionRules,
} from "../src/lib/pushLeadActions.js";

/**
 * Кнопки «Принять»/«Отклонить» прямо в шторке уведомлений (решение владельца
 * 11.08.2026).
 *
 * Проверяется то, ценой чего это сделано: маршрут действия работает БЕЗ входа в
 * CRM — у service worker нет JWT. Значит одноразовость маркера, его срок, его
 * привязка к паре «агент + клиент» и отсутствие самого маркера в базе — не
 * украшения, а единственное, что отделяет уведомление от дыры в доступе.
 *
 * РЕГРЕСС-ЩИТ: при выключенном рубильнике уведомление уходит как раньше — без
 * кнопок и без единого маркера в базе.
 */

const runId = Date.now();

let agentId: string;
let otherAgentId: string;
let clientId: string;
let savedEnabled: boolean;
let savedTtl: number;

let seq = 0;

async function makeClient(agent: string) {
  seq += 1;
  return prisma.client.create({
    data: {
      fullName: `Лид кнопок ${seq} ${runId}`,
      phone: `+9929${String(seq).padStart(2, "0")}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agent,
      assignedAt: new Date(),
    },
  });
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент кнопок ${runId}`, phone: `+992971${runId}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  const other = await prisma.agent.create({
    data: { fullName: `Агент запасной ${runId}`, phone: `+992972${runId}`, role: "AGENT", passwordHash: "x" },
  });
  otherAgentId = other.id;

  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  savedEnabled = settings.pushLeadActionsEnabled;
  savedTtl = settings.pushActionTtlMinutes;
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { pushLeadActionsEnabled: true, pushActionTtlMinutes: 30 },
  });
});

beforeEach(async () => {
  const c = await makeClient(agentId);
  clientId = c.id;
});

afterAll(async () => {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { pushLeadActionsEnabled: savedEnabled, pushActionTtlMinutes: savedTtl },
  });
  await prisma.pushActionToken.deleteMany({ where: { agentId: { in: [agentId, otherAgentId] } } });
  await prisma.interaction.deleteMany({ where: { agentId: { in: [agentId, otherAgentId] } } });
  await prisma.pendingSummary.deleteMany({ where: { agentId: { in: [agentId, otherAgentId] } } });
  await prisma.client.deleteMany({ where: { fullName: { contains: `кнопок`, mode: "insensitive" } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId] } } });
  await prisma.$disconnect();
});

function act(body: Record<string, unknown>) {
  return request(app).post("/api/v1/push/action").send(body);
}

describe("Маркер действия", () => {
  it("в базе лежит только хэш — самого маркера там нет", async () => {
    const token = await issueLeadActionToken(agentId, clientId, 30);
    const byHash = await prisma.pushActionToken.findUnique({ where: { tokenHash: hashActionToken(token) } });
    expect(byHash).not.toBeNull();
    // Прямой поиск по самому маркеру не находит ничего: в колонке хэш.
    const raw = await prisma.pushActionToken.findFirst({ where: { tokenHash: token } });
    expect(raw).toBeNull();
  });

  it("сжигается с первого раза и второй раз не срабатывает", async () => {
    const token = await issueLeadActionToken(agentId, clientId, 30);
    const first = await consumeLeadActionToken(token);
    expect(first).toEqual({ ok: true, agentId, clientId });
    const second = await consumeLeadActionToken(token);
    expect(second).toEqual({ ok: false, reason: "used" });
  });

  it("просроченный не срабатывает", async () => {
    const token = await issueLeadActionToken(agentId, clientId, 30);
    await prisma.pushActionToken.update({
      where: { tokenHash: hashActionToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await consumeLeadActionToken(token)).toEqual({ ok: false, reason: "expired" });
  });

  it("выдуманный маркер не срабатывает", async () => {
    expect(await consumeLeadActionToken("совершенно-посторонняя-строка-длиной-побольше")).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("срок жизни берётся из Настроек", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { pushActionTtlMinutes: 7 } });
    expect((await loadPushActionRules()).ttlMinutes).toBe(7);
    await prisma.settings.update({ where: { id: "singleton" }, data: { pushActionTtlMinutes: 30 } });
  });
});

describe("Действие из шторки уведомлений", () => {
  it("«Принять» принимает лид без единого заголовка авторизации", async () => {
    const token = await issueLeadActionToken(agentId, clientId, 30);
    const res = await act({ token, action: "lead-accept" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const client = await prisma.client.findUnique({ where: { id: clientId } });
    expect(client?.acceptedAt).not.toBeNull();
  });

  it("«Отклонить» снимает лид с агента", async () => {
    const token = await issueLeadActionToken(agentId, clientId, 30);
    const res = await act({ token, action: "lead-decline" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const client = await prisma.client.findUnique({ where: { id: clientId } });
    // Либо ушёл следующему агенту, либо остался непринятым и эскалирован — но
    // принятым этим агентом он не стал ни при каком исходе.
    expect(client?.acceptedAt).toBeNull();
  });

  it("повторное нажатие ничего не делает второй раз", async () => {
    const token = await issueLeadActionToken(agentId, clientId, 30);
    await act({ token, action: "lead-accept" });
    const again = await act({ token, action: "lead-accept" });
    expect(again.status).toBe(200);
    expect(again.body.ok).toBe(false);
    expect(again.body.message).toContain("уже отработано");
  });

  it("маркер чужого агента не даёт принять лид", async () => {
    // Маркер выдан ДРУГОМУ агенту — по нему клиент этого агента не его.
    const token = await issueLeadActionToken(otherAgentId, clientId, 30);
    const res = await act({ token, action: "lead-accept" });
    expect(res.body.ok).toBe(false);

    const client = await prisma.client.findUnique({ where: { id: clientId } });
    expect(client?.acceptedAt).toBeNull();
  });

  it("отвечает человеческим текстом, а не кодом ошибки", async () => {
    // Уведомление-итог показывает ровно то, что пришло с сервера: «404» в шторке
    // агенту ничего не говорит. Поэтому 200 + текст даже на отказе.
    const res = await act({ token: "заведомо-негодный-маркер-подлиннее", action: "lead-accept" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.length).toBeGreaterThan(5);
  });

  it("мусор в теле не роняет маршрут", async () => {
    expect((await act({})).status).toBe(200);
    expect((await act({ token: "коротко", action: "lead-accept" })).body.ok).toBe(false);
    expect((await act({ token: "нормальной-длины-строка-маркера", action: "удалить-всё" })).body.ok).toBe(false);
  });
});

describe("Регресс-щит: рубильник выключен", () => {
  it("маркеры не выдаются, уведомление уходит как раньше", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { pushLeadActionsEnabled: false } });
    try {
      const before = await prisma.pushActionToken.count({ where: { agentId } });
      const { sendLeadPush } = await import("../src/lib/pushLeadActions.js");
      // Подписок у агента нет — уведомление никуда не уйдёт, и это ровно то, что
      // нужно проверить: маркер не должен появиться даже в этом случае.
      await sendLeadPush(agentId, clientId, { title: "т", body: "т" });
      expect(await prisma.pushActionToken.count({ where: { agentId } })).toBe(before);
      expect((await loadPushActionRules()).enabled).toBe(false);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { pushLeadActionsEnabled: true } });
    }
  });

  it("при включённом рубильнике маркер выдаётся", async () => {
    const before = await prisma.pushActionToken.count({ where: { agentId } });
    const { sendLeadPush } = await import("../src/lib/pushLeadActions.js");
    await sendLeadPush(agentId, clientId, { title: "т", body: "т" });
    expect(await prisma.pushActionToken.count({ where: { agentId } })).toBe(before + 1);
  });
});
