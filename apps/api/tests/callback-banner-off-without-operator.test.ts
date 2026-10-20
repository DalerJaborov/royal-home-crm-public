import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * ПЛАШКА «КЛИЕНТ ПРОСИТ ЗВОНОК» ГАСНЕТ ВМЕСТЕ С РУБИЛЬНИКОМ (владелец 23.08.2026).
 *
 * Предыстория. Просьба о звонке жила параллельной очередью: своя таблица, push и
 * плашка на главной. Дежурного оператора нет, АТС никого не набирала, и просьбы
 * висели у руководства по двое суток, пока не протухали. Решение: пока нет
 * колл-центра, такие обращения идут агентам обычной заявкой, а очереди нет вовсе.
 *
 * Проверяется именно СЕРВЕР, а не фронт: условие живёт в маршруте, чтобы плашку не
 * показала старая вкладка в браузере и чтобы правда была в одном месте. Механика
 * очереди при этом цела — включённый рубильник обязан вернуть её как была, иначе
 * «выключено» незаметно превратится в «сломано».
 */

const runId = Date.now();
let token = "";
let requestId = "";
let previous = false;
let adminId = "";

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: {
      fullName: `Админ плашки ${runId}`,
      phone: `+99283${String(runId).slice(-7)}`,
      role: "ADMIN",
      passwordHash: "x",
    },
  });
  adminId = admin.id;
  token = signAccessToken({ sub: admin.id, role: "ADMIN" });

  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { botCanRequestCallback: true },
  });
  previous = settings?.botCanRequestCallback ?? false;

  const created = await prisma.callbackRequest.create({
    data: { channel: "WHATSAPP", topic: `Просьба о звонке ${runId}`, phone: `+99284${String(runId).slice(-7)}` },
  });
  requestId = created.id;
});

afterAll(async () => {
  await prisma.callbackRequest.deleteMany({ where: { id: requestId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botCanRequestCallback: previous } });
  await deleteAgentsWithTraces([adminId]);
});

describe("очередь просьб о звонке зависит от наличия оператора", () => {
  it("оператора нет — очередь пуста, плашке нечего показывать", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botCanRequestCallback: false } });
    const res = await request(app).get("/api/v1/me/callback-requests").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("оператор есть — та же просьба снова в очереди", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { botCanRequestCallback: true } });
    const res = await request(app).get("/api/v1/me/callback-requests").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.items.some((i: { id: string }) => i.id === requestId)).toBe(true);
  });
});
