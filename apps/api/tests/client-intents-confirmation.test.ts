import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("../src/ai/client.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/ai/client.js")>(), callAiText: vi.fn() }));
import { callAiText } from "../src/ai/client.js";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

const tag = randomUUID();
const agentIds: string[] = [], clientIds: string[] = [];
const tokens: Record<string, string> = {};
let seller = "", pending = "";
beforeAll(async () => {
  for (const role of ["AGENT", "SECURITY", "ADMIN", "SHAREHOLDER"] as const) {
    const agent = await prisma.agent.create({ data: { fullName: `test-intent-${role}`, phone: `test-intent-${tag}-${role}`, role, passwordHash: "test-unused" } });
    agentIds.push(agent.id); tokens[role] = signAccessToken({ sub: agent.id, role });
  }
  for (const accepted of [true, false]) {
    const client = await prisma.client.create({ data: { fullName: "test-intent-client", phone: `test-client-${tag}-${accepted}`, source: "PHONE_CALL", kind: "SELLER", dualIntent: true, assignedAgentId: agentIds[0], acceptedAt: accepted ? new Date() : null } });
    clientIds.push(client.id); if (accepted) seller = client.id; else pending = client.id;
  }
});
afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});
const read = () => request(app).get(`/api/v1/clients/${seller}`).set("Authorization", `Bearer ${tokens.AGENT}`);
const confirm = (role: string, both: boolean, id = seller) => request(app).post(`/api/v1/clients/${id}/intents`).set("Authorization", `Bearer ${tokens[role]}`).send({ dualIntent: both });

it("returns the committed AUTO setting even when its optional classifier is unavailable", async () => {
  const c = await prisma.client.create({ data: { fullName: "test-auto-failure", phone: `test-auto-failure-${tag}`, kind: "BUYER", source: "PHONE_CALL", assignedAgentId: agentIds[0], acceptedAt: new Date(), dualIntentDecisionSource: "MANUAL" } });
  clientIds.push(c.id);
  await prisma.interaction.create({ data: { clientId: c.id, agentId: agentIds[0], type: "CALL", notes: "Synthetic current-role fixture", transcript: "Клиент: Я сейчас продаю свою квартиру.", recordingDurationSec: 40 } });
  vi.mocked(callAiText).mockRejectedValueOnce(new Error("synthetic provider unavailable"));
  const response = await request(app).post(`/api/v1/clients/${c.id}/intents`).set("Authorization", `Bearer ${tokens.ADMIN}`).send({ dualIntent: false, resolution: "AUTO" });
  expect(response.status).toBe(200);
  expect(response.body.dualIntentDecisionSource).toBe("AUTO");
  expect(response.body.kind).toBe("BUYER");
});

it("does not allow the owning agent to edit roles or requirements after completion, but admin can correct roles", async () => {
  const c = await prisma.client.create({ data: { fullName: "test-completed-intent", phone: `test-completed-intent-${tag}`, kind: "BUYER", source: "PHONE_CALL", assignedAgentId: agentIds[0], acceptedAt: new Date(), assignmentCompletedAt: new Date() } });
  clientIds.push(c.id);
  expect((await confirm("AGENT", true, c.id)).status).toBe(403);
  const requirements = await request(app).post(`/api/v1/clients/${c.id}/buyer-requirements`).set("Authorization", `Bearer ${tokens.AGENT}`).send({ budgetMax: 600000 });
  expect(requirements.status).toBe(403);
  expect((await confirm("ADMIN", true, c.id)).status).toBe(200);
});

it("does not present an automatic historical role signal as two actual roles", async () => {
  const response = await read();
  expect(response.status).toBe(200); expect(response.body.dualIntent).toBe(false);
  expect(response.body.dualIntentNeedsConfirmation).toBe(true);
  const match = await request(app).get(`/api/v1/clients/${seller}/match`).set("Authorization", `Bearer ${tokens.AGENT}`);
  expect(match.body.properties).toEqual([]);
});
it("records explicit current roles with actor and time, and allows returning to a single role", async () => {
  const both = await confirm("AGENT", true);
  expect(both.status).toBe(200); expect(both.body.dualIntent).toBe(true); expect(both.body.dualIntentNeedsConfirmation).toBe(false);
  expect(both.body.dualIntentConfirmedAt).toBeTruthy();
  const stored = await prisma.client.findUniqueOrThrow({ where: { id: seller } });
  expect(stored.dualIntentConfirmedById).toBe(agentIds[0]);
  const single = await confirm("AGENT", false);
  expect(single.status).toBe(200); expect(single.body.dualIntent).toBe(false); expect(single.body.dualIntentNeedsConfirmation).toBe(false);
  expect(single.body.dualIntentConfirmedAt).toBeNull();
  expect(await prisma.interaction.count({ where: { clientId: seller, type: "SYSTEM", notes: { contains: "Подтвержд" } } })).toBe(2);
});
it("does not allow a reader or an unaccepted lead to confirm roles", async () => {
  expect((await confirm("SECURITY", true)).status).toBe(403);
  expect((await confirm("SHAREHOLDER", true)).status).toBe(403);
  expect((await confirm("AGENT", true, pending)).status).toBe(403);
  expect((await confirm("ADMIN", true)).status).toBe(200);
});
it("keeps buyer requirements separate from stale seller fields and validates write access", async () => {
  await prisma.client.update({ where: { id: seller }, data: { kind: "SELLER", dualIntent: true, dualIntentConfirmedAt: null, requirementsFieldsKind: "SELLER", budgetMax: 900000, desiredFloorMin: 7, requirementsNotes: "test-old-sale-details" } });
  const write = (role: string, data: unknown) => request(app).post(`/api/v1/clients/${seller}/buyer-requirements`).set("Authorization", `Bearer ${tokens[role]}`).send(data as object);
  expect((await write("AGENT", { budgetMax: 500000 })).status).toBe(409);
  expect((await confirm("AGENT", true)).status).toBe(200);
  expect((await write("SECURITY", { budgetMax: 500000 })).status).toBe(403);
  expect((await write("AGENT", { budgetMin: 600000, budgetMax: 500000 })).status).toBe(400);
  expect((await write("AGENT", { kind: "BUYER", budgetMax: 500000 })).status).toBe(400);
  const saved = await write("AGENT", { budgetMax: 500000, desiredRooms: 2, requirementsNotes: "test-new-buying-details" });
  expect(saved.status).toBe(200); expect(saved.body.kind).toBe("SELLER");
  expect(saved.body.requirementsFieldsKind).toBe("BUYER"); expect(saved.body.desiredFloorMin).toBeNull();
  expect(Number(saved.body.budgetMax)).toBe(500000);
  expect(await prisma.interaction.count({ where: { clientId: seller, notes: { contains: "test-old-sale-details" } } })).toBe(1);
});
it("clears confirmation when the primary kind changes", async () => {
  expect((await confirm("AGENT", true)).status).toBe(200);
  const changed = await request(app).patch(`/api/v1/clients/${seller}`).set("Authorization", `Bearer ${tokens.AGENT}`).send({ kind: "BUYER" });
  expect(changed.status).toBe(200); expect(changed.body.dualIntent).toBe(false);
  expect(changed.body.dualIntentConfirmedAt).toBeNull(); expect(changed.body.dualIntentNeedsConfirmation).toBe(true);
});
it("validates identity and rejects forged confirmation metadata", async () => {
  expect((await request(app).post(`/api/v1/clients/${seller}/intents`).send({ dualIntent: true })).status).toBe(401);
  expect((await confirm("AGENT", true, "invalid")).status).toBe(400);
  const forged = await request(app).post(`/api/v1/clients/${seller}/intents`).set("Authorization", `Bearer ${tokens.AGENT}`).send({ dualIntent: true, dualIntentConfirmedAt: new Date().toISOString() });
  expect(forged.status).toBe(400);
});
