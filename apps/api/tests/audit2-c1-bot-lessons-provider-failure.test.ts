import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * АУДИТ CODEX 04.10.2026, CHANNEL-NEW-14: СБОЙ ИИ НАВСЕГДА ПОМЕЧАЛ ПРИМЕР ОБУЧЕНИЯ КАК НЕИНФОРМАТИВНЫЙ.
 *
 * callAiText возвращает null и при отказе Gemini (после повтора), и при блокировке промта по
 * содержимому. distillLessons превращал null в пустое правило, писал lesson="—" (active=false) и
 * засчитывал processed; выборка берёт только lesson=null, так что после восстановления ИИ пример
 * не разбирался уже никогда (до 25 за проход). Теперь отказ поставщика оставляет случай в очереди,
 * а закрывается «—» только честная блокировка промта и пример старше недели.
 */
const callAiText = vi.hoisted(() => vi.fn());
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

const { prisma } = await import("../src/db.js");
const { distillLessons, EMPTY_LESSON } = await import("../src/lib/botLessons.js");

const runId = Date.now();
const MARK = `c1-lesson-${runId}`;
let behaviour: "down" | "ok" | "blocked" = "down";

beforeEach(() => {
  callAiText.mockReset();
  callAiText.mockImplementation(async (params: { messages?: Array<{ content: string }>; onBlocked?: (r: string) => void }) => {
    const text = params.messages?.[0]?.content ?? "";
    if (!text.includes(MARK)) return { lesson: "" }; // чужие случаи очереди нас не интересуют
    if (behaviour === "down") return null;
    if (behaviour === "blocked") {
      params.onBlocked?.("PROHIBITED_CONTENT");
      return null;
    }
    return { lesson: "Если спрашивают про рассрочку — предложи обсудить цену с собственником." };
  });
});

afterEach(async () => {
  await prisma.botLesson.deleteMany({ where: { botMessage: { contains: MARK } } });
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function seed(createdAt?: Date) {
  return prisma.botLesson.create({
    data: {
      kind: "operator_override",
      channel: "PHONE",
      botMessage: `Вопрос ${MARK}`,
      humanMessage: "Ответ сотрудника",
      ...(createdAt ? { createdAt } : {}),
    },
  });
}
const lessonOf = async (id: string) => (await prisma.botLesson.findUniqueOrThrow({ where: { id } })).lesson;

describe("distillLessons: сбой поставщика ИИ не стирает случай", () => {
  it("ИИ недоступен: lesson остаётся null, следующий проход после восстановления выводит правило", async () => {
    const row = await seed();
    behaviour = "down";
    await distillLessons();
    expect(await lessonOf(row.id)).toBeNull();

    behaviour = "ok";
    await distillLessons();
    const after = await prisma.botLesson.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.lesson).toContain("рассрочку");
    expect(after.active).toBe(true);
  });

  it("промт заблокирован по содержимому: случай закрывается прочерком, токены не жжём", async () => {
    const row = await seed();
    behaviour = "blocked";
    await distillLessons();
    const after = await prisma.botLesson.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.lesson).toBe(EMPTY_LESSON);
    expect(after.active).toBe(false);
  });

  it("случай старше недели, который так и не разобрался, закрывается — очередь не копит вечный отказ", async () => {
    const row = await seed(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
    behaviour = "down";
    await distillLessons();
    expect(await lessonOf(row.id)).toBe(EMPTY_LESSON);
  });
});
