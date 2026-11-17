import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { resolvePermissions } from "@royal-home/shared";

/**
 * ЗАЯВКИ НА УДАЛЕНИЕ РЕШАЕТ РОП (владелец 17.11.2026: «РОП тут главнее»).
 *
 * Заявки заводит агент кнопкой и сама CRM, когда работа кончилась отказом или
 * исчерпанными передачами (lib/clientDeleteRequest.ts). Решают их РОП и директор:
 *  • у роли РОП (HEAD_OF_SALES) по умолчанию есть `clients.delete`;
 *  • пуш о новой заявке уходит по этому праву — значит, всем активным РОП и
 *    директору (если РОП нет, остаётся директор);
 *  • РОП одобряет заявку сам — карточка уходит в Корзину.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { findAgentsWithPermission } = await import("../src/lib/recipients.js");
const { fileClientDeleteRequest } = await import("../src/lib/clientDeleteRequest.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const agentIds: string[] = [];
const clientIds: string[] = [];
let ropId = "";
let agentId = "";
let ropToken = "";

beforeAll(async () => {
  const mk = async (phone: string, role: string) =>
    (await prisma.agent.create({ data: { fullName: `РОП-тест ${phone}`, phone, role: role as never, passwordHash: "x" } })).id;
  ropId = await mk(`+99231${tail}`, "HEAD_OF_SALES");
  agentId = await mk(`+99232${tail}`, "AGENT");
  agentIds.push(ropId, agentId);
  ropToken = signAccessToken({ sub: ropId, role: "HEAD_OF_SALES" });
});

afterAll(async () => {
  await prisma.clientDeleteRequest.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("заявки на удаление решает РОП", () => {
  it("у роли РОП по умолчанию есть право решать заявки и восстанавливать из Корзины", () => {
    expect(resolvePermissions("HEAD_OF_SALES").has("clients.delete")).toBe(true);
    expect(resolvePermissions("HEAD_OF_SALES").has("archive.view")).toBe(true);
    // Агенту — только просить.
    expect(resolvePermissions("AGENT").has("clients.delete")).toBe(false);
  });

  it("пуш о новой заявке получают активные РОП (и директор — тем же правом)", async () => {
    const recipients = await findAgentsWithPermission("clients.delete");
    expect(recipients).toContain(ropId);
    expect(recipients).not.toContain(agentId);
  });

  it("заявку, заведённую CRM после отказа, РОП одобряет сам — карточка в Корзине", async () => {
    const c = await prisma.client.create({
      data: { fullName: `Отказ для РОП ${runId}`, phone: `+99233${tail}1`, kind: "BUYER", source: "PHONE_CALL", assignedAgentId: agentId, acceptedAt: new Date() },
    });
    clientIds.push(c.id);
    const filed = await fileClientDeleteRequest({ clientId: c.id, requestedById: agentId, reason: "OTHER", comment: "Отказ клиента: работа завершена" });
    expect(filed.ok && filed.created).toBe(true);
    const id = filed.ok ? filed.id : "";

    const list = await request(app).get("/api/v1/clients/delete-requests").set("Authorization", `Bearer ${ropToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items.some((r: { id: string }) => r.id === id)).toBe(true);

    const res = await request(app)
      .post(`/api/v1/clients/delete-requests/${id}/approve`)
      .set("Authorization", `Bearer ${ropToken}`)
      .send({});
    expect(res.status).toBe(200);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.deletedAt).not.toBeNull();
  });
});
