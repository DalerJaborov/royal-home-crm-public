import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * ЗАЯВКИ НА УДАЛЕНИЕ НЕ ОТДАЮТ НОМЕР КЛИЕНТА БЕЗ clients.viewPhone
 * (аудит Codex 04.10.2026, ACCESS-01, расширение «комментарии и заметки решения»).
 *
 * Так было: phone маскировался, а имя карточки, комментарий агента, расшифровка
 * голосовой заметки и заметка решения шли сырыми — туда номер попадает словами.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const DIGITS = "900001122";
const agentIds: string[] = [];
const clientIds: string[] = [];
let blindToken = "";
let seeingToken = "";
let clientId = "";

beforeAll(async () => {
  const mk = async (phone: string, permissions: unknown) =>
    (
      await prisma.agent.create({
        data: { fullName: `Удаления ${phone}`, phone, role: "MANAGER", passwordHash: "x", permissions: permissions as never },
      })
    ).id;
  const blind = await mk(`+99211${tail}`, { granted: ["clients.delete", "clients.viewAll"], revoked: ["clients.viewPhone"] });
  const seeing = await mk(`+99212${tail}`, { granted: ["clients.delete", "clients.viewAll", "clients.viewPhone"], revoked: [] });
  agentIds.push(blind, seeing);
  blindToken = signAccessToken({ sub: blind, role: "MANAGER" });
  seeingToken = signAccessToken({ sub: seeing, role: "MANAGER" });
  const client = await prisma.client.create({
    data: { fullName: `Входящий +992${DIGITS}`, phone: `+99213${tail}1`, kind: "BUYER", source: "TELEGRAM", assignedAgentId: blind, acceptedAt: new Date() } as never,
  });
  clientId = client.id;
  clientIds.push(client.id);
  await prisma.clientDeleteRequest.create({
    data: {
      clientId,
      requestedById: seeing,
      reason: "OTHER",
      comment: `клиент просит звонить на +992${DIGITS}`,
      commentVoiceTranscript: `мой номер девять ноль ноль ${DIGITS}`,
      decisionNote: `проверено, номер +992${DIGITS}`,
    },
  });
});

afterAll(async () => {
  await prisma.clientDeleteRequest.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

const get = (path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);

describe("заявки на удаление", () => {
  it("список без clients.viewPhone: ни имя, ни комментарий, ни заметка решения не несут номер", async () => {
    const res = await get("/api/v1/clients/delete-requests", blindToken);
    expect(res.status).toBe(200);
    const mine = (res.body.items as Array<{ client: { id: string } }>).filter((i) => i.client.id === clientId);
    expect(mine.length).toBe(1);
    expect(JSON.stringify(mine)).not.toContain(DIGITS);
  });

  it("карточка: заявка без номера в комментарии", async () => {
    const res = await get(`/api/v1/clients/${clientId}/delete-request`, blindToken);
    expect(res.status).toBe(200);
    expect(res.body.request).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(DIGITS);
  });

  it("с clients.viewPhone всё как есть", async () => {
    const res = await get("/api/v1/clients/delete-requests", seeingToken);
    const mine = (res.body.items as Array<{ client: { id: string }; comment: string }>).find((i) => i.client.id === clientId);
    expect(mine!.comment).toContain(DIGITS);
  });
});
