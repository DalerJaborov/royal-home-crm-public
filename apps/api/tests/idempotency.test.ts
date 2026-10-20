import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { invalidateAgentAccess } from "../src/auth/middleware.js";
import { idempotencyGuard, IN_PROGRESS_MESSAGE } from "../src/lib/idempotency.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * Повтор записи с тем же Idempotency-Key не создаёт вторую строку (23.09.2026).
 *
 * Живой случай: создание объекта дольше 30 секунд (сервер ходит к модели), сайт
 * обрывал ожидание и клал запрос в офлайн-очередь, агент жал «Сохранить» ещё
 * раз — два-три одинаковых объекта. Здесь проверяется сам щиток на маленьком
 * приложении (счётчик вызовов роута), плюс что он стоит на настоящем /api/v1.
 */

const runId = Date.now();
let agentId = "";
let otherAgentId = "";
let token = "";
let otherToken = "";
const createdClientIds: string[] = [];

let calls = 0;
let release: (() => void) | null = null;
const mini = express();
mini.use(express.json());
mini.use(idempotencyGuard);
mini.post("/thing", (_req, res) => {
  calls += 1;
  res.status(201).json({ id: `thing-${calls}` });
});
mini.post("/slow", async (_req, res) => {
  calls += 1;
  await new Promise<void>((r) => (release = r));
  res.status(201).json({ id: `slow-${calls}` });
});
mini.post("/bad", (_req, res) => {
  calls += 1;
  res.status(400).json({ error: "Неверные данные" });
});

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 4);
  const a = await prisma.agent.create({
    data: { fullName: `Идемп ${runId}`, phone: `+99290${String(runId).slice(-7)}`, role: "AGENT", passwordHash },
  });
  const b = await prisma.agent.create({
    data: { fullName: `Идемп2 ${runId}`, phone: `+99291${String(runId).slice(-7)}`, role: "AGENT", passwordHash },
  });
  agentId = a.id;
  otherAgentId = b.id;
  token = signAccessToken({ sub: a.id, role: "AGENT" });
  otherToken = signAccessToken({ sub: b.id, role: "AGENT" });
});

afterAll(async () => {
  await prisma.idempotencyKey.deleteMany({ where: { agentId: { in: [agentId, otherAgentId] } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: createdClientIds } } }).catch(() => {});
  await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId] } } }).catch(() => {});
  await prisma.$disconnect();
});

const key = (s: string) => `test-${runId}-${s}`;

describe("Idempotency-Key", () => {
  it("повтор после успеха отдаёт тот же ответ и не зовёт роут второй раз", async () => {
    calls = 0;
    const first = await request(mini).post("/thing").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key("a"));
    expect(first.status).toBe(201);
    await waitFor(async () => (await prisma.idempotencyKey.findFirst({ where: { agentId, key: key("a") } }))?.status === 201);
    const second = await request(mini).post("/thing").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key("a"));
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(calls).toBe(1);
  });

  it("без ключа — обычное поведение", async () => {
    calls = 0;
    await request(mini).post("/thing").set("Authorization", `Bearer ${token}`);
    await request(mini).post("/thing").set("Authorization", `Bearer ${token}`);
    expect(calls).toBe(2);
  });

  it("ключ другого сотрудника не отдаёт чужой ответ", async () => {
    calls = 0;
    await request(mini).post("/thing").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key("b"));
    const other = await request(mini).post("/thing").set("Authorization", `Bearer ${otherToken}`).set("Idempotency-Key", key("b"));
    expect(other.status).toBe(201);
    expect(calls).toBe(2);
  });

  it("ошибка не запоминается — исправленный повтор проходит", async () => {
    calls = 0;
    const first = await request(mini).post("/bad").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key("c"));
    expect(first.status).toBe(400);
    await waitFor(async () => (await prisma.idempotencyKey.count({ where: { agentId, key: key("c") } })) === 0);
    await request(mini).post("/bad").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key("c"));
    expect(calls).toBe(2);
  });

  it("повтор, пока первый запрос ещё идёт, — 409 «уже выполняется», роут не зовётся", async () => {
    calls = 0;
    release = null;
    const firstP = request(mini).post("/slow").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key("d")).then((r) => r);
    await waitFor(async () => release !== null);
    const second = await request(mini).post("/slow").set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key("d"));
    expect(second.status).toBe(409);
    expect(second.body.error).toBe(IN_PROGRESS_MESSAGE);
    expect(second.body.inProgress).toBe(true);
    release!();
    const first = await firstP;
    expect(first.status).toBe(201);
    expect(calls).toBe(1);
  });

  it("стоит на настоящем /api/v1: повтор создания клиента не заводит второго", async () => {
    const body = { fullName: `Повтор ${runId}`, phone: `+99293${String(runId).slice(-7)}`, kind: "BUYER", source: "PHONE_CALL" };
    const first = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", key("client"))
      .send(body);
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    const id = first.body.id as string;
    createdClientIds.push(id);
    await waitFor(async () => (await prisma.idempotencyKey.findFirst({ where: { agentId, key: key("client") } }))?.status != null);
    const second = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", key("client"))
      .send(body);
    expect(second.status).toBe(first.status);
    expect(second.body.id).toBe(id);
    expect(await prisma.client.count({ where: { fullName: body.fullName } })).toBe(1);
  });
});

/**
 * Повтор по сохранённому ответу не должен работать для отключённого сотрудника
 * (находка Codex №4, 04.10.2026). Щиток стоит ДО requireAuth и проверяет только
 * подпись токена; отдаваемое тело проходит signMediaUrlsInResponses, то есть
 * отключённый или запертый сменой пароля сотрудник получал заново подписанные
 * ссылки на медиа из своего же ответа. Доступ проверяется тем же способом, что
 * в requireAuth (loadAgentAccess с его коротким кэшем).
 */
describe("Idempotency-Key: повтор и состояние учётки", () => {
  const extraIds: string[] = [];
  afterAll(async () => {
    await prisma.idempotencyKey.deleteMany({ where: { agentId: { in: extraIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: extraIds } } }).catch(() => {});
  });

  async function stored(name: string, phoneTail: string) {
    const a = await prisma.agent.create({
      data: { fullName: `Идемп ${name} ${runId}`, phone: `+99295${phoneTail}${String(runId).slice(-4)}`, role: "AGENT", passwordHash: "x" },
    });
    extraIds.push(a.id);
    const tok = signAccessToken({ sub: a.id, role: "AGENT" });
    const k = key(`acc-${name}`);
    const first = await request(mini).post("/thing").set("Authorization", `Bearer ${tok}`).set("Idempotency-Key", k);
    expect(first.status).toBe(201);
    await waitFor(async () => (await prisma.idempotencyKey.findFirst({ where: { agentId: a.id, key: k } }))?.status === 201);
    return { id: a.id, tok, k };
  }

  it("отключённый (isActive=false) сотрудник повтор не получает", async () => {
    const { id, tok, k } = await stored("off", "100");
    await prisma.agent.update({ where: { id }, data: { isActive: false } });
    invalidateAgentAccess(id);
    const replay = await request(mini).post("/thing").set("Authorization", `Bearer ${tok}`).set("Idempotency-Key", k);
    expect(replay.status).toBe(403);
    expect(replay.headers["idempotent-replayed"]).toBeUndefined();
  });

  it("активный сотрудник по-прежнему получает сохранённое тело", async () => {
    const { id, tok, k } = await stored("ok", "400");
    invalidateAgentAccess(id);
    const replay = await request(mini).post("/thing").set("Authorization", `Bearer ${tok}`).set("Idempotency-Key", k);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
  });
});
