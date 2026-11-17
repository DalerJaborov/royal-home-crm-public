import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * ОБРЫВ ЗАГРУЗКИ — НЕ «[unhandled]» (17.11.2026, журнал прода после #254).
 * Человек закрыл вкладку посреди отправки фото: multer бросает обычный Error
 * «Request aborted», и он уходил в общий обработчик как необработанная ошибка
 * с пушем директору. Теперь это эксплуатационная строка журнала с дедупом и без пуша.
 */
const runId = String(Date.now()).slice(-7);
const agentIds: string[] = [];
let token = "";
let server: Server;

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Тест-обрыв-${runId}`, phone: `+992931${runId}`, role: "AGENT", passwordHash: await bcrypt.hash("password123", 10) },
  });
  agentIds.push(agent.id);
  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password: "password123" });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
  server = app.listen(0);
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.errorLog.deleteMany({ where: { message: { contains: `Обрыв загрузки файла` }, url: "/api/v1/properties/drafts/current/photos", createdAt: { gte: new Date(Date.now() - 10 * 60_000) } } });
  await deleteAgentsWithTraces(agentIds);
});

describe("обрыв multipart посреди тела", () => {
  it("пишется эксплуатационной строкой, а не «[unhandled]»", async () => {
    const unhandled = vi.spyOn(console, "error");
    const { port } = server.address() as AddressInfo;
    const boundary = `----rh${runId}`;
    const head =
      `--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
    await new Promise<void>((resolve) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write(
          `POST /api/v1/properties/drafts/current/photos HTTP/1.1\r\nHost: localhost\r\n` +
            `Authorization: Bearer ${token}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\n` +
            `Content-Length: ${5 * 1024 * 1024}\r\n\r\n` +
            head
        );
        sock.write(Buffer.alloc(64 * 1024, 1));
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 300);
      });
    });

    const row = await waitFor(
      () =>
        prisma.errorLog.findFirst({
          where: { url: "/api/v1/properties/drafts/current/photos", message: { contains: "Обрыв загрузки файла" } },
          orderBy: { createdAt: "desc" },
        }),
      { timeoutMs: 10_000 }
    );
    expect(row?.message).toMatch(/Request aborted|Unexpected end of form/);
    const unhandledCalls = unhandled.mock.calls.filter((c) => c[0] === "[unhandled]" && /Request aborted/.test(String(c[1])));
    expect(unhandledCalls).toHaveLength(0);
    unhandled.mockRestore();
  });
});
