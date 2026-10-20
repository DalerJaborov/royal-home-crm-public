import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";
import { prisma } from "../src/db.js";
import { guardFired, loadGuardStats } from "../src/ai/guardMetrics.js";
import { stripRepeatGreeting, dropRepeatedQuestions } from "../src/ai/replyGuards.js";
import { dushanbeWallClock } from "../src/lib/dushanbeTime.js";

/**
 * Счётчики срабатывания фильтров ответа (совет экспертов 26.08, пункт 8).
 *
 * Восемь с лишним guard-ов молча чинили реплики бота, и сколько раз каждый из
 * них сработал, не знал никто — а это прямая мера расхождения промта с
 * желаемым поведением.
 */

const today = dushanbeWallClock().toISOString().slice(0, 10);
/** guardHit пишется через `void prisma.guardHit.upsert` (ai/guardMetrics.ts).
 *  Ожидание строки — waitFor, проверка «строки нет» — waitForSettled: ждать в ней
 *  нечего, а запоздавшая запись иначе проскочит мимо. */
const hits = (guard: string) => prisma.guardHit.count({ where: { day: today, guard } });
const settledHits = (guard: string) => waitForSettled(() => hits(guard));
const firstHit = (guard: string) =>
  waitFor(() => prisma.guardHit.findFirst({ where: { day: today, guard } }), { label: `строка guardHit ${guard}` });
/** Дождаться, пока накопленный счётчик фильтра дорастёт до ожидаемого. */
const waitForSum = (guard: string, atLeast: number) =>
  waitFor(
    async () => ((await prisma.guardHit.findFirst({ where: { day: today, guard } }))?.count ?? 0) >= atLeast,
    { label: `guardHit ${guard} ≥ ${atLeast}` }
  );

beforeEach(async () => {
  await prisma.guardHit.deleteMany({ where: { day: today } });
});

afterAll(async () => {
  await prisma.guardHit.deleteMany({ where: { day: today } });
  await prisma.$disconnect();
});

describe("счётчики фильтров", () => {
  it("копятся по (сутки, фильтр) и суммируются", async () => {
    // Между вызовами дожидаемся приземления предыдущего upsert: две встречные
    // вставки одной строки (день, фильтр) иначе дерутся за уникальный ключ.
    guardFired("repeat_greeting");
    await waitForSum("repeat_greeting", 1);
    guardFired("repeat_greeting", 2);
    await waitForSum("repeat_greeting", 3);
    guardFired("off_topic");
    await waitForSum("off_topic", 1);

    const rows = await loadGuardStats(1);
    const greeting = rows.find((r) => r.guard === "repeat_greeting");
    const offTopic = rows.find((r) => r.guard === "off_topic");
    expect(greeting?.count).toBe(3);
    expect(offTopic?.count).toBe(1);
  });

  it("нулевое срабатывание строку не заводит", async () => {
    guardFired("discount_percent", 0);
    expect(await settledHits("discount_percent")).toBe(0);
  });
});

describe("фильтры считают себя сами", () => {
  it("повторное приветствие: счётчик растёт только когда фильтр реально сработал", async () => {
    // Реплика без приветствия — фильтру нечего чинить.
    expect(stripRepeatGreeting("Квартира свободна, можем показать завтра")).toContain("Квартира");
    expect(await settledHits("repeat_greeting")).toBe(0);

    // А здесь бот поздоровался посреди разговора — фильтр срезает и считает.
    const cleaned = stripRepeatGreeting("Здравствуйте! Квартира свободна");
    expect(cleaned).not.toMatch(/Здравствуйте/);
    const row = await firstHit("repeat_greeting");
    expect(row?.count).toBe(1);
  });

  it("повторный вопрос: счётчик равен числу вычеркнутых пузырей", async () => {
    const kept = dropRepeatedQuestions(
      ["Сколько комнат вам нужно?", "Также уточните район"],
      ["Сколько комнат вам нужно?"]
    );
    // Один пузырь вычеркнут (повтор), второй остался.
    expect(kept).toHaveLength(1);
    const row = await firstHit("repeated_question");
    expect(row?.count).toBe(1);
  });
});
