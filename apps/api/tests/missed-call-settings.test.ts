import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * Настройки «пропущенный звонок не теряется» (18.11.2026): тумблеры включаются одним запросом и
 * действуют сразу (сервер читает их при каждом звонке), текст не принимает длинное тире.
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+99277${String(runId).slice(-7)}`;
let adminId = "";
let token = "";
let saved: { missedCallSmsEnabled: boolean; missedCallSmsText: string; missedCallCallbackTaskEnabled: boolean } | null = null;

beforeAll(async () => {
  const row = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = { missedCallSmsEnabled: row.missedCallSmsEnabled, missedCallSmsText: row.missedCallSmsText, missedCallCallbackTaskEnabled: row.missedCallCallbackTaskEnabled };
  adminId = (await prisma.agent.create({ data: { fullName: `Админ настроек ${runId}`, phone, role: "ADMIN", passwordHash: await bcrypt.hash(password, 10) } })).id;
  token = (await request(app).post("/api/v1/auth/login").send({ phone, password })).body.accessToken;
  grantElevation(adminId);
});

afterAll(async () => {
  if (saved) await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.agent.delete({ where: { id: adminId } }).catch(() => {});
  await prisma.$disconnect();
});

const patch = (body: Record<string, unknown>) => request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${token}`).send(body);
const read = () => request(app).get("/api/v1/settings").set("Authorization", `Bearer ${token}`);

describe("настройки пропущенного звонка", () => {
  it("тумблеры и текст читаются из настроек и меняются одним запросом", async () => {
    const res = await patch({ missedCallSmsEnabled: true, missedCallCallbackTaskEnabled: true, missedCallSmsText: "Салом. Пишите: https://wa.me/992777776001" });
    expect(res.status).toBe(200);
    const got = await read();
    expect(got.body).toMatchObject({ missedCallSmsEnabled: true, missedCallCallbackTaskEnabled: true, missedCallSmsText: "Салом. Пишите: https://wa.me/992777776001" });
    const off = await patch({ missedCallSmsEnabled: false, missedCallCallbackTaskEnabled: false });
    expect(off.status).toBe(200);
    expect((await read()).body).toMatchObject({ missedCallSmsEnabled: false, missedCallCallbackTaskEnabled: false });
  });

  it("длинное тире и пустой текст не принимаются", async () => {
    for (const dash of ["\u2014", "\u2013", "\u2212"]) {
      expect((await patch({ missedCallSmsText: `Салом ${dash} пишите` })).status).toBe(400);
    }
    expect((await patch({ missedCallSmsText: "   " })).status).toBe(400);
    expect((await patch({ missedCallSmsText: "а".repeat(601) })).status).toBe(400);
  });
});
