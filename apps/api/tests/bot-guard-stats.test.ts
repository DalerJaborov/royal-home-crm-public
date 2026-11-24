import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { loadBotGuardStats, summarizeBotGuardStats } from "../src/lib/botGuardStats.js";
import { dushanbeDateString } from "../src/lib/dushanbeTime.js";

/**
 * Счётчики фильтров переехали с удалённого экрана «Обучение бота» в Настройки →
 * «Бот» → «Проверка бота» (23.11.2026). Доли нового помощника считаются тем же
 * правилом, что дневная строка владельцу: намеренно выключенное в долю не входит.
 */
describe("summarizeBotGuardStats", () => {
  it("сводит дни в сумму, доли помощника без намеренно выключенного, полосы — только фильтры", () => {
    const out = summarizeBotGuardStats([
      { guard: "repeat_greeting", count: 3 },
      { guard: "repeat_greeting", count: 2 },
      { guard: "bot_repeat", count: 7 },
      { guard: "renamed_old_key", count: 1 },
      { guard: "answer_used", count: 6 },
      { guard: "answer_dropped_claim", count: 2 },
      { guard: "answer_dropped_language_disabled", count: 30 },
      { guard: "say_used", count: 4 },
      { guard: "say_dropped_language_disabled", count: 9 },
    ]);
    expect(out.days).toBe(14);
    expect(out.filters.map((f) => f.guard)).toEqual(["bot_repeat", "repeat_greeting", "renamed_old_key"]);
    expect(out.filters[1]).toEqual({ guard: "repeat_greeting", label: "Повторное приветствие", count: 5 });
    expect(out.filters[2].label).toBe("renamed_old_key");
    // 2 отброшено из 8; таджикский (30) не в доле, а рядом
    expect(out.answer).toMatchObject({ total: 8, dropped: 2, sharePercent: 25, intentional: 30, factAttempts: 2 });
    expect(out.say).toMatchObject({ total: 4, dropped: 0, sharePercent: 0, intentional: 9 });
  });

  it("пусто — нули, а не NaN", () => {
    const out = summarizeBotGuardStats([]);
    expect(out.filters).toEqual([]);
    expect(out.answer.sharePercent).toBe(0);
    expect(out.say.total).toBe(0);
  });
});

describe("loadBotGuardStats: сумма за окно считается в базе", () => {
  const guard = `zz_guard_stats_test_${Date.now()}`;
  afterAll(async () => {
    await prisma.guardHit.deleteMany({ where: { guard } });
  });

  it("берёт сегодняшний и 13-й день назад, 14-й — нет", async () => {
    const day = (back: number) => dushanbeDateString(new Date(Date.now() - back * 86_400_000));
    await prisma.guardHit.createMany({ data: [
      { day: day(0), guard, count: 2 },
      { day: day(13), guard, count: 3 },
      { day: day(14), guard, count: 100 },
    ] });
    const row = (await loadBotGuardStats()).filters.find((f) => f.guard === guard);
    expect(row?.count).toBe(5);
  });
});
