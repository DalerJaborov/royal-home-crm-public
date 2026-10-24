import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

const marker = `synthetic-bulk-access-${randomUUID()}`;
const positionKey = `bulk-${randomUUID()}`;
const ids: string[] = [];
const actors: string[] = [];
const tokens: Record<string, string> = {};
beforeAll(async () => {
  for (const role of ["ADMIN", "MANAGER", "AGENT", "SHAREHOLDER"] as const) {
    const actor = await prisma.agent.create({ data: { fullName: marker, phone: `${marker}-${role}`, role, passwordHash: "synthetic-unused" } });
    actors.push(actor.id);
    tokens[role] = signAccessToken({ sub: actor.id, role });
  }
  await prisma.recruitmentPosition.create({ data: { key: positionKey, titleRu: "Тестовая вакансия", titleTg: "Вазифаи санҷишӣ", isOpen: true } });
});
afterAll(async () => {
  await prisma.jobApplication.deleteMany({ where: { id: { in: ids } } });
  await prisma.recruitmentPosition.deleteMany({ where: { key: positionKey } });
  await prisma.agent.deleteMany({ where: { id: { in: actors } } });
});
async function candidate() {
  const row = await prisma.jobApplication.create({ data: { channel: "MANUAL", name: marker, status: "NEW" } });
  ids.push(row.id);
  return row;
}
const bulk = (role: string, body: unknown) => request(app).post("/api/v1/vacancies/bulk").set("Authorization", `Bearer ${tokens[role]}`).send(body);

it.each([["ADMIN", 200], ["MANAGER", 200], ["AGENT", 403], ["SHAREHOLDER", 403]] as const)(
  "%s bulk status access returns %s and preserves denied rows", async (role, expectedStatus) => {
    const row = await candidate();
    const result = await bulk(role, { ids: [row.id], action: "setStatus", status: "REVIEWED" });
    expect(result.status).toBe(expectedStatus);
    expect((await prisma.jobApplication.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(expectedStatus === 200 ? "REVIEWED" : "NEW");
  }
);

it("an administrator can create, inspect, assign and erase a manual candidate through the API", async () => {
  const created = await request(app).post("/api/v1/vacancies").set("Authorization", `Bearer ${tokens.ADMIN}`).send({ name: marker, positionKey });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  ids.push(id);
  const card = await request(app).get(`/api/v1/vacancies/${id}`).set("Authorization", `Bearer ${tokens.ADMIN}`);
  expect(card.status).toBe(200);
  expect(card.body).toMatchObject({ id, name: marker, positionKey, status: "NEW" });
  expect((await bulk("ADMIN", { ids: [id, id], action: "assignPosition", positionKey })).body).toMatchObject({ updated: 1, skipped: [] });
  const erased = await bulk("ADMIN", { ids: [id], action: "delete" });
  expect(erased.status).toBe(200);
  expect(erased.body).toEqual({ updated: 1, skipped: [] });
  expect((await request(app).get(`/api/v1/vacancies/${id}`).set("Authorization", `Bearer ${tokens.ADMIN}`)).status).toBe(404);
});

it("a manager may edit HR stages but cannot erase a candidate with either delete endpoint", async () => {
  const row = await candidate();
  expect((await bulk("MANAGER", { ids: [row.id], action: "delete" })).status).toBe(403);
  expect((await request(app).delete(`/api/v1/vacancies/${row.id}`).set("Authorization", `Bearer ${tokens.MANAGER}`)).status).toBe(403);
  expect(await prisma.jobApplication.findUnique({ where: { id: row.id } })).not.toBeNull();
});

it.each([
  { action: "setStatus" },
  { action: "setStatus", status: "INTERVIEW" },
  { action: "assignPosition" },
  { action: "not-an-action" },
])("rejects incomplete or unsupported bulk commands: %j", async (command) => {
  const row = await candidate();
  expect((await bulk("ADMIN", { ids: [row.id], ...command })).status).toBe(400);
  expect((await prisma.jobApplication.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("NEW");
});
