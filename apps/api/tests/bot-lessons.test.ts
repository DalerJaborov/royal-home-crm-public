import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { isConfusedMessage, learnedRulesBlock, recordLesson } from "../src/lib/botLessons.js";

/**
 * Бот учится на своих ошибках.
 *
 * Главный риск здесь не в том, что мы пропустим случай, — их и так будет много.
 * Риск в обратном: если считать ошибкой любой вопрос клиента, обучение засорится
 * мусором, а мусор попадёт прямо в промт и начнёт портить ответы всем. Поэтому
 * больше всего проверок именно на ложные срабатывания.
 */

const runId = Date.now().toString(36);
const MARKER = `тест-правило-${runId}`;
const createdIds: string[] = [];

beforeAll(async () => {
  // Своё правило, не полагаясь на содержимое базы: в CI она пустая, локально — засеяна.
  const own = await prisma.botLesson.create({
    data: {
      kind: "operator_override",
      channel: "WHATSAPP",
      botMessage: "Бот сказал что-то невнятное",
      humanMessage: "Оператор ответил по делу",
      lesson: MARKER,
      active: true,
    },
  });
  createdIds.push(own.id);
});

afterAll(async () => {
  await prisma.botLesson.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.botLesson.deleteMany({ where: { botMessage: { startsWith: `бот-${runId}` } } });
});

describe("клиент не понял — ловим", () => {
  it("прямые признаки непонимания по-русски", () => {
    expect(isConfusedMessage("не понял")).toBe(true);
    expect(isConfusedMessage("Не поняла вас")).toBe(true);
    expect(isConfusedMessage("непонятно")).toBe(true);
    expect(isConfusedMessage("что вы имеете в виду?")).toBe(true);
    expect(isConfusedMessage("повторите пожалуйста")).toBe(true);
  });

  it("по-таджикски тоже", () => {
    expect(isConfusedMessage("нафаҳмидам")).toBe(true);
    expect(isConfusedMessage("намефаҳмам")).toBe(true);
    expect(isConfusedMessage("фаҳмо нест")).toBe(true);
  });

  it("одинокий вопросительный знак — это «что?», а не вопрос по делу", () => {
    expect(isConfusedMessage("?")).toBe(true);
    expect(isConfusedMessage("???")).toBe(true);
    expect(isConfusedMessage("что?")).toBe(true);
    expect(isConfusedMessage("чӣ?")).toBe(true);
  });
});

describe("ложные срабатывания — самое важное", () => {
  it("обычный вопрос по делу ошибкой не считается", () => {
    expect(isConfusedMessage("а что входит в цену?")).toBe(false);
    expect(isConfusedMessage("что там по документам?")).toBe(false);
    expect(isConfusedMessage("сколько стоит?")).toBe(false);
    expect(isConfusedMessage("есть двушка в Сино?")).toBe(false);
  });

  it("слово «что» посреди длинной фразы не превращает её в непонимание", () => {
    expect(isConfusedMessage("скажите, что нужно для оформления сделки")).toBe(false);
  });

  it("пустое и пробельное не ловится", () => {
    expect(isConfusedMessage("")).toBe(false);
    expect(isConfusedMessage("   ")).toBe(false);
  });

  it("согласие и благодарность — не ошибка", () => {
    expect(isConfusedMessage("хорошо, спасибо")).toBe(false);
    expect(isConfusedMessage("ок")).toBe(false);
  });
});

describe("запись случая", () => {
  it("случай сохраняется неразобранным — правило выведет ночной проход", async () => {
    await recordLesson({
      kind: "client_confused",
      channel: "INSTAGRAM",
      botMessage: `бот-${runId} сказал непонятное`,
      humanMessage: "не понял",
    });
    const saved = await prisma.botLesson.findFirst({ where: { botMessage: `бот-${runId} сказал непонятное` } });
    expect(saved).not.toBeNull();
    expect(saved!.lesson).toBeNull();
    expect(saved!.kind).toBe("client_confused");
  });

  it("пустая реплика не записывается — учиться не на чем", async () => {
    await recordLesson({ kind: "operator_override", channel: "WHATSAPP", botMessage: "", humanMessage: "ответ" });
    await recordLesson({ kind: "operator_override", channel: "WHATSAPP", botMessage: `бот-${runId} X`, humanMessage: "  " });
    const count = await prisma.botLesson.count({ where: { botMessage: `бот-${runId} X` } });
    expect(count).toBe(0);
  });
});

describe("выученное попадает в промт", () => {
  it("активное правило подмешивается", async () => {
    const block = await learnedRulesBlock();
    expect(block).toContain(MARKER);
    expect(block).toContain("не повторяй");
  });

  it("выключенное владельцем правило в промт не идёт", async () => {
    await prisma.botLesson.updateMany({ where: { id: { in: createdIds } }, data: { active: false } });
    const block = await learnedRulesBlock();
    expect(block).not.toContain(MARKER);
    await prisma.botLesson.updateMany({ where: { id: { in: createdIds } }, data: { active: true } });
  });

  it("неразобранный случай в промт не идёт — там ещё нет правила", async () => {
    const block = await learnedRulesBlock();
    expect(block).not.toContain(`бот-${runId}`);
  });
});
