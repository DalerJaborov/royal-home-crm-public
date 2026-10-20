import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { resetCalls } from "../src/lib/telephony/callTracker.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * Звонок кандидату через станцию (владелец 29.09.2026: «хочу позвонить кандидату
 * по HR из админки — выходит tel:+992…, станция не соединяет»). POST
 * /vacancies/:id/call — тот же путь, что звонок коллеге: сначала трубка
 * сотрудника, потом станция набирает кандидата. Карточку клиента не заводит.
 */
const tail = String(Date.now()).slice(-6);
let token: string;
let managerId: string;
let withPhoneId: string;
let noPhoneId: string;
let prevSettings: { asteriskAriUrl: string | null; asteriskAriUsername: string | null; asteriskAriPassword: string | null } | null;
const fetchMock = vi.fn();

function call(id: string) {
  return request(app).post(`/api/v1/vacancies/${id}/call`).set("Authorization", `Bearer ${token}`).send({});
}

beforeAll(async () => {
  prevSettings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { asteriskAriUrl: true, asteriskAriUsername: true, asteriskAriPassword: true },
  });
  const ari = { asteriskAriUrl: "http://ari.test:8088", asteriskAriUsername: "royalhome", asteriskAriPassword: encryptSecret("secret") };
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", ...ari }, update: ari });
  const manager = await prisma.agent.create({
    data: { fullName: `HR звонок ${tail}`, phone: `+99297${tail}3`, role: "MANAGER", passwordHash: "x", sipExtension: `7${tail.slice(-3)}` },
  });
  managerId = manager.id;
  token = signAccessToken({ sub: manager.id, role: "MANAGER" });
  withPhoneId = (
    await prisma.jobApplication.create({
      data: { conversationId: `test-cand-call-a-${tail}`, channel: "WHATSAPP", name: `Кандидат ${tail}`, phone: `+99290${tail}2`, status: "REVIEWED" },
    })
  ).id;
  noPhoneId = (
    await prisma.jobApplication.create({
      data: { conversationId: `test-cand-call-b-${tail}`, channel: "INSTAGRAM", name: `Без номера ${tail}`, status: "REVIEWED" },
    })
  ).id;
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  resetCalls();
});

afterAll(async () => {
  await prisma.jobApplication.deleteMany({ where: { id: { in: [withPhoneId, noPhoneId] } } });
  await prisma.agent.deleteMany({ where: { id: managerId } });
  if (prevSettings) await prisma.settings.update({ where: { id: "singleton" }, data: prevSettings });
});

describe("POST /vacancies/:id/call", () => {
  it("анкеты нет — 404", async () => {
    const res = await call("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("кандидат не дал телефон — 409, станцию не трогаем", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const res = await call(noPhoneId);
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("звонок уходит на станцию с номером кандидата, карточка клиента не заводится", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "cand-channel" }), text: async () => "" } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const res = await call(withPhoneId);
    expect(res.status).toBe(200);
    expect(res.body.channelId).toBe("cand-channel");
    const originate = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/ari/channels?"));
    expect(originate).toContain(`extension=90${tail}2`);
    expect(await prisma.client.count({ where: { phone: `+99290${tail}2` } })).toBe(0);
  });

  it("станция недоступна — 502 с причиной", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await call(withPhoneId);
    expect(res.status).toBe(502);
    expect(res.body.error).toBeTruthy();
  });
});
