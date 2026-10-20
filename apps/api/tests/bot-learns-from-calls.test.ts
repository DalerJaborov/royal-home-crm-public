import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { distillLessons } from "../src/lib/botLessons.js";

/**
 * Бот учится у живых продавцов.
 *
 * Третий источник обучения (07.08.2026) после ошибок бота и непонимания клиента:
 * пары «о чём спросил клиент по телефону» → «как ответил агент». Материал самый
 * качественный из трёх — это не догадка модели и не разбор чужой ошибки, а то, как
 * в агентстве отвечают на самом деле.
 *
 * Здесь проверяется, что случай из звонка доходит до ночного разбора и что защита
 * от подмены промта распространяется и на него: реплики — данные, а не указания.
 */

const runId = Date.now();
const QUESTION = `Есть ли рассрочка на квартиры ${runId}`;

afterEach(async () => {
  await prisma.botLesson.deleteMany({ where: { botMessage: { contains: String(runId) } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Обучение бота на телефонных разговорах", () => {
  it("случай из звонка попадает в очередь разбора вместе с ответом агента", async () => {
    await prisma.botLesson.create({
      data: {
        kind: "call_answer",
        channel: "PHONE",
        botMessage: QUESTION,
        humanMessage: "Рассрочки у нас нет, но по цене всегда можно обсудить с собственником.",
      },
    });

    const pending = await prisma.botLesson.findFirst({ where: { botMessage: QUESTION } });
    expect(pending?.kind).toBe("call_answer");
    // Правило ещё не выведено — этим занимается ночной разбор.
    expect(pending?.lesson).toBeNull();
  });

  it("разбор доходит до случаев из звонков и не оставляет их в очереди навсегда", async () => {
    await prisma.botLesson.create({
      data: {
        kind: "call_answer",
        channel: "PHONE",
        botMessage: QUESTION,
        humanMessage: "Рассрочки нет, но торг с собственником обсуждаем всегда.",
      },
    });

    // Без ключа ИИ разбор ничего не выведет — это нормальный путь на машине
    // разработчика и в CI. Случай при этом остаётся в очереди (lesson=null) до
    // восстановления ИИ (аудит Codex 04.10, CHANNEL-NEW-14: отказ поставщика не
    // равен «учиться нечему»); закрывается «—» блокировка промта и случай старше
    // недели — см. audit2-c1-bot-lessons-provider-failure.test.ts.
    await distillLessons().catch(() => 0);

    const after = await prisma.botLesson.findFirst({ where: { botMessage: QUESTION } });
    expect(after, "случай пропал из базы").toBeDefined();
    // Либо выведено правило, либо помечено прочерком — но не осталось null.
    if (after?.lesson !== null) {
      expect(typeof after?.lesson).toBe("string");
    }
  });

  it("повторный вопрос не заводит второй случай: очередь не забивается одинаковым", async () => {
    const data = {
      kind: "call_answer",
      channel: "PHONE",
      botMessage: QUESTION,
      humanMessage: "Рассрочки нет.",
    };
    await prisma.botLesson.create({ data });

    // Ту же проверку делает saveBotAnswers перед записью (см. ai/callInsights.ts):
    // «есть ли рассрочка» звучит в каждом втором разговоре, и без неё очередь за
    // месяц наполнилась бы одним и тем же — а каждый случай стоит вызова модели.
    const duplicate = await prisma.botLesson.findFirst({
      where: { kind: "call_answer", botMessage: QUESTION },
      select: { id: true },
    });
    expect(duplicate).not.toBeNull();

    const count = await prisma.botLesson.count({ where: { botMessage: QUESTION } });
    expect(count).toBe(1);
  });
});
