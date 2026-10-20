import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ТРИ ОБЪЕКТА В ПРОМТЕ — НЕ «ТРИ САМЫХ СВЕЖИХ» (20.09.2026, выгрузка 775 живых
 * переписок, docs/bot-razbor-20-09.md).
 *
 * Две жалобы из одной строки кода (`take: 3` по дате добавления):
 *
 *  1. «У вас всего три квартиры». Собеседнику, который фотографии этих трёх уже
 *     получал, на следующем ходе предлагались ровно они же: защита от повтора
 *     гасила отправку снимков, а список в промте не менялся, и модели просто
 *     нечего было назвать.
 *  2. Нижняя граница бюджета не учитывалась вовсе: человеку, назвавшему «от 60
 *     до 80 тысяч», можно было предложить за 20.
 *
 * Проверяем не текст ответа (модель подменена), а какие объекты код положил
 * модели в промт: именно это решает, о чём она может говорить.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { runQualifyTurn } = await import("../src/ai/leadQualifier.js");

const runId = Date.now().toString(36);
let districtId = "";
/** Номера карточек по метке: дешёвая, три подходящие по бюджету (от старой к свежей). */
const shortIds: Record<string, number> = {};

const ABILITIES = {
  showings: false,
  callback: false,
  askOwner: false,
  vacancies: false,
  links: false,
  cautious: false,
  promptEconomy: false,
};

async function makeProperty(mark: string, price: number, ageDays: number): Promise<void> {
  const p = await prisma.property.create({
    data: {
      title: `Подбор-${mark}-${runId}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      price,
      currency: "TJS",
      districtId,
      address: `Подборная, ${mark}`,
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
      createdAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000),
    },
  });
  shortIds[mark] = p.shortId;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-подбор-${runId}` } })).id;
  // Четыре в бюджете «от 600 000 до 800 000»: самые свежие — «new1» и «new2».
  await makeProperty("new1", 700_000, 1);
  await makeProperty("new2", 750_000, 2);
  await makeProperty("old1", 650_000, 30);
  await makeProperty("old2", 780_000, 40);
  // Вчетверо дешевле названного минимума: под верхнюю границу подходит, под
  // ожидание человека — нет. Самая свежая из всех намеренно.
  await makeProperty("cheap", 150_000, 0);
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { districtId } });
  await prisma.district.delete({ where: { id: districtId } });
  await prisma.$disconnect();
});

/** Весь промт хода одной строкой — смотрим, что код сказал модели. */
function lastPrompt(): string {
  const call = callAi.mock.calls.at(-1)?.[0] as
    | { systemStable?: string; system?: string; messages?: { content: string }[] }
    | undefined;
  return [call?.systemStable ?? "", call?.system ?? "", ...(call?.messages ?? []).map((m) => m.content)].join("\n");
}

async function promptFor(alreadyShownShortIds: number[]): Promise<string> {
  callAi.mockReset();
  callAi.mockResolvedValue({ reply: "Хуб", ready: false, confident: true });
  await runQualifyTurn(
    [{ role: "user", content: "2-хонага дар ин район мекобам, аз 600 то 800 ҳазор" }],
    {
      intent: "buy",
      type: "APARTMENT",
      districtName: `Тест-район-подбор-${runId}`,
      budgetMin: 600_000,
      budgetMax: 800_000,
      rooms: 2,
    },
    { abilities: ABILITIES, showcase: { canSendPhotos: true, photosPerOffer: 3, alreadyShownShortIds } }
  );
  return lastPrompt();
}

/** Номера карточек, которые код перечислил в блоке подходящих объектов. */
function listedShortIds(prompt: string): number[] {
  const block = prompt.slice(prompt.indexOf("ЧТО У НАС СЕЙЧАС ЕСТЬ ПОДХОДЯЩЕГО"));
  return [...block.matchAll(/^- №(\d+) /gmu)].map((m) => Number(m[1]));
}

describe("Подбор объектов для промта", () => {
  it("объект вчетверо дешевле названного минимума в три строки не попадает", async () => {
    const listed = listedShortIds(await promptFor([]));
    expect(listed).toHaveLength(3);
    // Самый свежий из всех — и всё равно последний по смыслу: человек просил от 600 000.
    expect(listed).not.toContain(shortIds.cheap);
  });

  it("уже показанные уступают место тем, которых человек ещё не видел", async () => {
    const listed = listedShortIds(await promptFor([shortIds.new1, shortIds.new2]));
    expect(listed).not.toContain(shortIds.new1);
    expect(listed).not.toContain(shortIds.new2);
    // Вместо них — те, что раньше не показывали и которые в бюджете.
    expect(listed).toContain(shortIds.old1);
    expect(listed).toContain(shortIds.old2);
  });

  it("других вариантов нет — уже показанные остаются, блок не пустеет", async () => {
    const all = Object.values(shortIds);
    const listed = listedShortIds(await promptFor(all));
    // Молчание про весь ассортимент хуже повтора: прежнее поведение сохранено.
    expect(listed.length).toBeGreaterThan(0);
  });
});
