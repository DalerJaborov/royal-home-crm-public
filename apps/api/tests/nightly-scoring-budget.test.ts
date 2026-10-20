import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { scoreAllActiveClients, NIGHTLY_SCORING_FRESH_MS } from "../src/ai/scoring.js";

/**
 * Ночная оценка клиентов укладывается в отведённое время (аудит 23.09.2026,
 * круг 3, №90). Раньше проход шёл по ВСЕМ активным клиентам подряд, по вызову
 * модели на каждого, и при тысяче клиентов упирался в 20-минутный таймаут
 * тика — журнал каждую ночь получал «крон не завершил тик».
 *
 * Модель подменена функцией, которая «тратит» 10 минут на клиента по
 * подставным часам. Действия наших клиентов — в будущем, чтобы они
 * гарантированно шли первыми в общей базе тестов.
 */

const runId = Date.now();
const ids: string[] = [];

async function makeActive(name: string, minutesAhead: number, aiInsightAt?: Date) {
  const c = await prisma.client.create({
    data: { fullName: name, phone: `+99295${String(runId).slice(-6)}${ids.length}`, source: "WALK_IN", aiInsightAt },
  });
  ids.push(c.id);
  await prisma.interaction.create({
    data: { clientId: c.id, type: "SYSTEM", actorKind: "SYSTEM", notes: `ночная оценка ${runId}`, createdAt: new Date(Date.now() + minutesAhead * 60_000) },
  });
  return c.id;
}

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.client.deleteMany({ where: { id: { in: ids } } });
});

describe("ночная оценка клиентов", () => {
  it("свежие по активности — первыми; по исчерпании бюджета остаток откладывается", async () => {
    const newest = await makeActive("Оценка самый свежий", 30);
    const middle = await makeActive("Оценка средний", 20);
    const oldest = await makeActive("Оценка третий", 10);

    let clock = 1_000_000;
    const calls: string[] = [];
    const scoreOne = vi.fn(async (id: string) => {
      calls.push(id);
      clock += 10 * 60_000;
      return { aiScore: 50, aiScoreReason: "тест" };
    });

    const res = await scoreAllActiveClients({ budgetMs: 15 * 60_000, now: () => clock, scoreOne });

    // 10 мин на клиента, бюджет 15 мин: успевают двое, остальное — до следующей ночи.
    expect(calls).toEqual([newest, middle]);
    expect(calls).not.toContain(oldest);
    expect(res.scored).toBe(2);
    expect(res.deferred).toBeGreaterThanOrEqual(1);
  });

  it("клиент, чью оценку автопилот пересчитал недавно, ночью не трогается", async () => {
    const freshId = await makeActive("Оценка уже свежая", 40, new Date(Date.now() - 60 * 60_000));
    const staleId = await makeActive(
      "Оценка устаревшая",
      35,
      new Date(Date.now() - NIGHTLY_SCORING_FRESH_MS - 60 * 60_000)
    );
    const calls: string[] = [];
    let clock = 5_000_000;
    await scoreAllActiveClients({
      budgetMs: 1,
      now: () => clock,
      scoreOne: async (id) => {
        calls.push(id);
        clock += 1;
        return null;
      },
    });
    expect(calls[0]).toBe(staleId);
    expect(calls).not.toContain(freshId);
  });
});
