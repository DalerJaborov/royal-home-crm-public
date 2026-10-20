import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Одновременный вход одного человека с двух вкладок не должен отдавать 500.
 *
 * Так было: `createOrRefreshSession` делал `create()` внутри транзакции и ловил
 * P2002 восстановительным `update()`. В PostgreSQL это не работает — любая
 * ошибка внутри транзакции переводит её в состояние aborted, и следующая
 * команда отвергается кодом 25P02. То есть обработчик, написанный ради защиты
 * от 500, сам этим 500 и заканчивался.
 *
 * Поймано регрессионным e2e-прогоном 06.08.2026: семь ролей логинились
 * параллельно, две вкладки одного пользователя совпали по deviceKey.
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+992905${String(runId).slice(-7)}`;
let agentId: string;

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: "Тест Сессии", phone, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Гонка при входе с одного устройства", () => {
  it("пять одновременных входов — все успешны, ни одного 500", async () => {
    // Один и тот же User-Agent и IP: deviceKey совпадёт, значит все пятеро
    // претендуют на одну строку сессии — ровно та гонка, что ломала вход.
    const attempts = Array.from({ length: 5 }, () =>
      request(app)
        .post("/api/v1/auth/login")
        .set("User-Agent", "RegressionAgent/1.0")
        .send({ phone, password })
    );
    const results = await Promise.all(attempts);
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s >= 500), `Ответы: ${statuses.join(", ")}`).toHaveLength(0);
    expect(statuses.every((s) => s === 200), `Ответы: ${statuses.join(", ")}`).toBe(true);
  });

  it("после гонки на устройство осталась ровно одна сессия, живая", async () => {
    const sessions = await prisma.session.findMany({ where: { agentId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.revokedAt).toBeNull();
  });
});
