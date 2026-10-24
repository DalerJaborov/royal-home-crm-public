import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

let actorId: string;
let token: string;
beforeAll(async () => {
  const actor = await prisma.agent.create({ data: {
    fullName: "Night forecast validation fixture", phone: `test-night-forecast-${randomUUID()}`,
    passwordHash: "test-placeholder", role: "DIRECTOR",
  } });
  actorId = actor.id;
  token = signAccessToken({ sub: actorId, role: "DIRECTOR" });
});
afterAll(async () => { if (actorId) await prisma.agent.delete({ where: { id: actorId } }); });

describe("forecast query calendar validation", () => {
  it.each(["2026-00", "2026-13", "2026-99"])("rejects impossible month %s instead of rolling into another year", async month => {
    const response = await request(app).get("/api/v1/finance/forecast").query({ month }).set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Неверный месяц");
  });
});
