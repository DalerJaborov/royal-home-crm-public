import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { computeRoyalScore, computeRoyalScoreBreakdown, recordScoreEvent } from "../src/lib/scoreJournal.js";
import { buildProblemMetrics } from "../src/lib/problemReport.js";

async function lostClientsThisWeek(): Promise<number> {
  // Неделя отчёта кончается вчерашним днём — смотрим «из завтра», чтобы сегодня попало.
  const m = await buildProblemMetrics("week", new Date(Date.now() + 86_400_000));
  for (const section of m.sections) {
    const found = section.metrics.find((x) => x.key === "lost");
    if (found) return found.value;
  }
  throw new Error("нет показателя «Клиенты потеряны окончательно»");
}

/**
 * Снятие вины директором СНИМАЕТ штраф, а не удваивает его
 * (глубокая проверка 02.10.2026, C3).
 *
 * Переопределение «по вине агента» → «не по вине» пишет строку-отмену ТОГО ЖЕ
 * вида с обратным знаком. Счёт же берёт цену ВИДА из каталога, а не записанный
 * delta — и строка-отмена считалась ещё одним «−5». Агент после оправдания
 * получал −10 вместо 0 и уходил ниже в очереди лидов.
 */

const runId = Date.now();
let agentId = "";
let directorId = "";
let directorToken = "";
let agentToken = "";
let startingScore = 100;

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: "Агент снятие вины", phone: `+99293${runId.toString().slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  const director = await prisma.agent.create({
    data: { fullName: "Директор снятие вины", phone: `+99294${runId.toString().slice(-7)}`, role: "DIRECTOR", passwordHash: "x" },
  });
  agentId = agent.id;
  directorId = director.id;
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  const settings = await prisma.settings.findFirst({ select: { royalScoreStartingScore: true } });
  startingScore = Math.min(100, settings?.royalScoreStartingScore ?? 100);
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
});

describe("C3: переопределение вины на «не по вине»", () => {
  it("счёт, разбивка и «Вы против себя» возвращаются к исходным", async () => {
    const lostBefore = await lostClientsThisWeek();
    await recordScoreEvent({
      agentId,
      kind: "client_lost_agent_fault",
      delta: -5,
      reason: "тест C3",
      sourceId: `client-lost-c3-${runId}`,
    });
    const event = await prisma.royalScoreEvent.findFirstOrThrow({ where: { agentId, sourceId: `client-lost-c3-${runId}` } });
    expect(await computeRoyalScore(agentId)).toBe(startingScore - 5);

    const res = await request(app)
      .patch(`/api/v1/royal-score-events/${event.id}/override`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ override: "client_lost_no_fault", comment: "клиент сам ушёл" });
    expect(res.status).toBe(200);

    // «Не по вине» стоит 0 — после оправдания счёт как до события.
    expect(await computeRoyalScore(agentId)).toBe(startingScore);
    const breakdown = await computeRoyalScoreBreakdown(agentId);
    expect(breakdown.sales).toBe(0);

    const months = await request(app).get("/api/v1/me/score-months").set("Authorization", `Bearer ${agentToken}`);
    expect(months.status).toBe(200);
    expect(months.body.current.points).toBe(0);

    // Отчёт о проблемах: один потерянный клиент — одна потеря, а не три
    // (исходная строка + отмена + новый вид).
    expect((await lostClientsThisWeek()) - lostBefore).toBe(1);
  });
});
