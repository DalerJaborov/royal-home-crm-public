import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * GET /team — поля нагрузки для карточки «Нагрузка» и колонки в таблице
 * (макет владельца, экран «Команда»).
 *
 * Проверяем, что `activeLoad` считается тем же правилом, что и раздача лидов
 * (lib/leadLimits.ts): активный покупатель занимает слот, продавец и удалённый
 * в корзину покупатель — нет; `leadLimit` совпадает с настройкой; `frozenAt`
 * отдаётся датой для строки «заморожен 3 дня назад».
 */

const runId = Date.now();
const password = "testpass123";
const clientIds: string[] = [];
let agentPhone = "";
let directorPhone = "";
let agentId = "";

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken ?? res.body.token;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentPhone = `+992961${String(runId).slice(-7)}`;
  directorPhone = `+992962${String(runId).slice(-7)}`;
  const agent = await prisma.agent.create({
    data: {
      fullName: `Нагрузка Агент ${runId}`,
      phone: agentPhone,
      role: "AGENT",
      passwordHash,
      frozenAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      frozenReason: "проверка нагрузки",
    },
  });
  agentId = agent.id;
  await prisma.agent.create({
    data: { fullName: `Нагрузка Директор ${runId}`, phone: directorPhone, role: "DIRECTOR", passwordHash },
  });
  const base = (n: number, kind: "BUYER" | "SELLER") => ({
    fullName: `Нагрузка ${kind} ${n} ${runId}`,
    phone: `+99296${n}${String(runId).slice(-7)}`,
    source: "INSTAGRAM" as const,
    kind,
    assignedAgentId: agent.id,
    acceptedAt: new Date(),
  });
  const rows = await Promise.all([
    prisma.client.create({ data: base(3, "BUYER") }),
    prisma.client.create({ data: base(4, "BUYER") }),
    // Продавец слот не занимает.
    prisma.client.create({ data: base(5, "SELLER") }),
    // Удалённый в корзину покупатель нагрузки не создаёт.
    prisma.client.create({ data: { ...base(6, "BUYER"), deletedAt: new Date() } }),
  ]);
  clientIds.push(...rows.map((r) => r.id));
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { phone: { in: [agentPhone, directorPhone] } } });
});

describe("GET /team — нагрузка", () => {
  it("activeLoad считает только активных покупателей, leadLimit из настроек, frozenAt датой", async () => {
    const token = await login(directorPhone);
    const [res, settings] = await Promise.all([
      request(app).get("/api/v1/team").set("Authorization", `Bearer ${token}`),
      prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadActiveLimit: true } }),
    ]);
    expect(res.status).toBe(200);
    const me = res.body.find((m: { id: string }) => m.id === agentId);
    expect(me).toBeDefined();
    expect(me.activeLoad).toBe(2);
    expect(me.leadLimit).toBe(settings?.leadActiveLimit ?? 6);
    expect(me.frozen).toBe(true);
    expect(typeof me.frozenAt).toBe("string");
    expect(new Date(me.frozenAt).getTime()).toBeLessThan(Date.now() - 2 * 24 * 60 * 60 * 1000);
  });
});
