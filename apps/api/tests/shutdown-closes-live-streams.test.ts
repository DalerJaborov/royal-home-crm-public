import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { closeAllStreams, streamStats, __resetEventBusForTests } from "../src/lib/eventBus.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Аудит 23.09.2026, круг 3, №76: открытая вкладка CRM держала поток живых
 * событий, и `server.close()` при остановке ждал его вечно — каждый выкат
 * упирался в жёсткий выход через 15 секунд. Эти секунды сайт стоял без API,
 * а досброс посещений и отключение от базы не выполнялись.
 */
const runId = Date.now();
let agentId: string;
let token: string;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: {
      fullName: "Поток Остановка",
      phone: `+992954${runId}`,
      role: "AGENT",
      passwordHash: await bcrypt.hash("testpass123", 10),
    },
  });
  agentId = agent.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password: "testpass123" });
  token = login.body.accessToken as string;
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  __resetEventBusForTests();
  server.closeAllConnections();
  await deleteAgentsWithTraces([agentId]);
});

describe("остановка сервера не ждёт открытые потоки живых событий", () => {
  it("server.close завершается сразу после closeAllStreams", async () => {
    const ticket = await request(app).post("/api/v1/events/ticket").set("Authorization", `Bearer ${token}`);
    expect(ticket.status).toBe(200);
    const res = await fetch(`${baseUrl}/api/v1/events?ticket=${encodeURIComponent(ticket.body.ticket)}`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read(); // «поток открыт» — подписка уже стоит
    expect(streamStats(agentId).forAgent).toBe(1);

    const closed = new Promise<"closed">((resolve) => server.close(() => resolve("closed")));
    expect(closeAllStreams()).toBe(1);
    const outcome = await Promise.race([closed, new Promise<"hung">((r) => setTimeout(() => r("hung"), 3_000))]);
    expect(outcome).toBe("closed");
    expect(streamStats(agentId).forAgent).toBe(0);
    // Клиент видит честный конец потока — и переподключится, как после обрыва сети.
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  });
});
