import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ПЕРВЫЙ ХОД ЧАТА: «ИЩУ ДВУШКУ В СИНО» — ВАРИАНТЫ В ЭТОМ ЖЕ ОТВЕТЕ (10.10.2026, аудит
 * поиска P0-2, docs/audit-bots-2026-10-10-search.md).
 *
 * Подборка строилась по черновику лида, а черновик модель заполняет в ОТВЕТЕ: на ходе,
 * где клиент впервые назвал район и комнаты, блока объектов в промте не было, и правило
 * «нет блока — нет подходящего» толкало бота к «вариантҳо надорем». Теперь реплика
 * разбирается кодом до вызова модели (lib/searchPlace.ts::buyerQueryForTurn).
 *
 * Проверяем не ответ (модель подменена), а промт: что код положил перед моделью.
 * Поломка-проверка: верни в runQualifyTurn `searchMatchingProperties(draft, …)` — тест
 * краснеет (черновик пуст, блока нет).
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { runQualifyTurn } = await import("../src/ai/leadQualifier.js");

const runId = Date.now().toString(36);
const TITLE = `Первый-ход-${runId}`;
let createdDistrict = false;

const ABILITIES = {
  showings: false,
  callback: false,
  askOwner: false,
  vacancies: false,
  links: false,
  cautious: false,
  promptEconomy: false,
};

beforeAll(async () => {
  let sino = await prisma.district.findUnique({ where: { name: "Сино" } });
  if (!sino) {
    sino = await prisma.district.create({ data: { name: "Сино" } });
    createdDistrict = true;
  }
  await prisma.property.create({
    data: {
      title: TITLE,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 61,
      price: 640_000,
      currency: "TJS",
      districtId: sino.id,
      address: "Сино, Первоходная",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
    },
  });
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { title: TITLE } });
  if (createdDistrict) await prisma.district.deleteMany({ where: { name: "Сино" } });
  await prisma.$disconnect();
});

function lastPrompt(): string {
  const call = callAi.mock.calls.at(-1)?.[0] as
    | { systemStable?: string; system?: string; messages?: { content: string }[] }
    | undefined;
  return [call?.systemStable ?? "", call?.system ?? "", ...(call?.messages ?? []).map((m) => m.content)].join("\n");
}

describe("подборка на первом ходе", () => {
  it("пустой черновик + «ищу двушку в Сино» — блок вариантов уже в этом ходе", async () => {
    callAi.mockReset();
    callAi.mockResolvedValue({ reply: "Хуб", ready: false, confident: true });
    await runQualifyTurn([{ role: "user", content: "Салом, ищу двушку в Сино" }], {}, { abilities: ABILITIES });
    const prompt = lastPrompt();
    expect(prompt).toContain("ЧТО У НАС СЕЙЧАС ЕСТЬ ПОДХОДЯЩЕГО");
    const block = prompt.slice(prompt.indexOf("ЧТО У НАС СЕЙЧАС ЕСТЬ ПОДХОДЯЩЕГО"));
    // Первой — двушка: комнаты разобраны из реплики; соседние (±1) — только следом и с пометкой.
    const lines = block.split("\n").filter((l) => /^- №\d+ /u.test(l));
    expect(lines[0]).toMatch(/2-комн/u);
    for (const line of lines.filter((l) => !/2-комн/u.test(l))) expect(line).toMatch(/комнат на 1/u);
  });

  it("правило промта не велит считать пустой блок отказом, пока запрос не назван", async () => {
    const prompt = lastPrompt();
    expect(prompt).toContain("Ещё не назвал ни района, ни что ищет — блока и быть не может");
  });
});
