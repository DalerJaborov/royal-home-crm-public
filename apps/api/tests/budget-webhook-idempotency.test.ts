import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

const runId = Date.now();
const TOKEN = `test-budget-token-${runId}`;

let directorId: string;
let savedToken: string | null = null;

function pushBody(messageId: string, payload: Record<string, unknown>) {
  return {
    message: {
      messageId,
      data: Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
  };
}

beforeAll(async () => {
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedToken = settings.googleBudgetToken;
  await prisma.settings.update({ where: { id: "singleton" }, data: { googleBudgetToken: TOKEN } });

  const passwordHash = await bcrypt.hash("testpass123", 10);
  const director = await prisma.agent.create({
    data: { fullName: "Директор Вебхук", phone: `+992882${runId}`, role: "DIRECTOR", passwordHash, isActive: true },
  });
  directorId = director.id;
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { googleBudgetToken: savedToken } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { agentId: directorId } });
  await prisma.agent.delete({ where: { id: directorId } }).catch(() => {});
});

describe("Идемпотентность вебхука Google Budget Pub/Sub", () => {
  it("повторная доставка того же messageId не плодит уведомления повторно", async () => {
    const messageId = `msg-${runId}-a`;
    const payload = {
      budgetDisplayName: "Royal Home AI",
      costAmount: 42,
      budgetAmount: 100,
      currencyCode: "USD",
      alertThresholdExceeded: 0.5,
    };

    const first = await request(app)
      .post(`/api/v1/webhooks/google-budget?token=${TOKEN}`)
      .send(pushBody(messageId, payload));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true });

    const afterFirst = await prisma.notification.count({ where: { agentId: directorId, kind: "finance" } });
    expect(afterFirst).toBe(1);

    const second = await request(app)
      .post(`/api/v1/webhooks/google-budget?token=${TOKEN}`)
      .send(pushBody(messageId, payload));
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, duplicate: true });

    const afterSecond = await prisma.notification.count({ where: { agentId: directorId, kind: "finance" } });
    expect(afterSecond).toBe(1);
  });

  it("разные messageId — обе доставки обрабатываются", async () => {
    const payload = {
      budgetDisplayName: "Royal Home AI",
      costAmount: 80,
      budgetAmount: 100,
      currencyCode: "USD",
      alertThresholdExceeded: 0.8,
    };

    const before = await prisma.notification.count({ where: { agentId: directorId, kind: "finance" } });

    await request(app)
      .post(`/api/v1/webhooks/google-budget?token=${TOKEN}`)
      .send(pushBody(`msg-${runId}-b`, payload));
    await request(app)
      .post(`/api/v1/webhooks/google-budget?token=${TOKEN}`)
      .send(pushBody(`msg-${runId}-c`, payload));

    const after = await prisma.notification.count({ where: { agentId: directorId, kind: "finance" } });
    expect(after).toBe(before + 2);
  });
});
