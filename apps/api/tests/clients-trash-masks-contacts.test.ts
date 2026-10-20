import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { createTestAgent } from "./helpers/ownAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Корзина клиентов не отдаёт телефон открытым тому, у кого нет права
 * `clients.viewPhone` (находка №151, ночная проверка 24.09.2026). Маска стояла
 * на обычном списке (`GET /clients`), а Корзина отдавала карточки как есть.
 */

const runId = Date.now();
const phone = `+99290${String(runId).slice(-7)}`;
let viewerId = "";
let viewerToken = "";
let clientId = "";

beforeAll(async () => {
  viewerId = await createTestAgent("Корзина Смотрящий");
  // Корзина открыта точечно, а право на телефон снято.
  await prisma.agent.update({
    where: { id: viewerId },
    data: { permissions: { granted: ["archive.view"], revoked: ["clients.viewPhone"] } },
  });
  viewerToken = signAccessToken({ sub: viewerId, role: "AGENT" });
  clientId = (
    await prisma.client.create({
      data: {
        fullName: "Корзинный Клиент",
        phone,
        source: "WALK_IN",
        acceptedAt: new Date(),
        deletedAt: new Date(),
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: clientId } });
  await deleteAgentsWithTraces([viewerId]);
});

describe("GET /clients/trash", () => {
  it("без права на телефон номер скрыт маской, как в обычном списке клиентов", async () => {
    const res = await request(app).get("/api/v1/clients/trash").set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    const item = (res.body.items as { id: string; phone: string; email?: string | null }[]).find((c) => c.id === clientId);
    expect(item).toBeTruthy();
    expect(item!.phone).toContain("•");
    expect(item!.phone).not.toContain(phone.slice(-7));
    // Номер не должен проявиться ни в одном другом поле ответа.
    expect(JSON.stringify(item)).not.toContain(phone.slice(-7));
  });
});
