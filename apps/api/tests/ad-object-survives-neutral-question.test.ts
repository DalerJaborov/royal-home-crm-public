import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ОБЪЕКТ ИЗ ОБЪЯВЛЕНИЯ ПЕРЕЖИВАЕТ НЕЙТРАЛЬНЫЙ ВОПРОС (17.09.2026, вечер).
 *
 * Нюанс, вскрытый ревью #455 и ставший обязательным после решения владельца
 * отвечать на шаблонную фразу нейтральным вопросом: к моменту, когда человек
 * скажет «да, по квартире», ни referral, ни вложения в ходе уже нет. Раньше
 * подсказку про опознанный объект вдобавок перебивал общий adHint, и бот
 * спрашивал «какую квартиру вы ищете» у человека, который только что показал
 * пальцем на конкретную.
 *
 * Модель подменена: тест про то, какую подсказку код ей дал.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { processMessengerTurn } = await import("../src/messengers/conversation.js");

const runId = Date.now().toString(36);
const subscriberId = `adobj-${runId}`;

let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;
let fixture: CustomerMessengerFixture;
let propertyId = "";
/** Заведённые этим файлом объект и район — только если своих в базе не нашлось. */
let ownPropertyId = "";
let ownDistrictId = "";

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("WHATSAPP");
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  settingsBefore = s;
  await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 1, botReplyMaxWaitSec: 3 } });
  /**
   * СВОЙ ОБЪЕКТ, ЕСЛИ ЧУЖОГО НЕТ (20.09.2026).
   *
   * Здесь стояло `findFirst(...)` и сразу `existing!.id`: файл полагался на то,
   * что в общей базе тестов уже лежит хоть один объект. Не лежит — объекты
   * появляются только от соседних файлов, — и на чистой базе весь файл падал
   * ещё до первого теста, «Cannot read properties of null (reading id)», а все
   * три проверки отчитывались пропущенными. Какой именно объект взят, этому
   * файлу безразлично: он смотрит на подсказку в промте, а не на карточку.
   */
  const existing = await prisma.property.findFirst({ where: { deletedAt: null }, select: { id: true } });
  if (existing) {
    propertyId = existing.id;
    return;
  }
  const district = await prisma.district.create({ data: { name: `Тест-реклама-${runId}` } });
  ownDistrictId = district.id;
  const own = await prisma.property.create({
    data: {
      title: `Объект из объявления ${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      windowCount: 3,
      price: 400000,
      currency: "TJS",
      districtId: district.id,
      address: `Тестовая реклама, ${runId}`,
      condition: "GOOD",
      status: "AVAILABLE",
    },
  });
  ownPropertyId = own.id;
  propertyId = own.id;
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  const convs = await prisma.botConversation.findMany({ where: { endpointScopeId: fixture.transport.endpointScopeId, subscriberId }, select: { id: true, clientId: true } });
  for (const conv of convs) {
    if (conv.clientId) {
      await prisma.interaction.deleteMany({ where: { clientId: conv.clientId } });
      await prisma.client.deleteMany({ where: { id: conv.clientId } });
    }
  }
  await fixture?.dispose();
  if (ownPropertyId) await prisma.property.deleteMany({ where: { id: ownPropertyId } });
  if (ownDistrictId) await prisma.district.deleteMany({ where: { id: ownDistrictId } });
});

function lastPrompt(): string {
  const call = callAi.mock.calls.at(-1)?.[0] as
    | { system?: string; systemStable?: string; messages?: { role: string; content: string }[] }
    | undefined;
  return [call?.systemStable ?? "", call?.system ?? "", ...(call?.messages ?? []).map((m) => m.content)].join("\n");
}

describe("реклама конкретного объекта", () => {
  it("первый ход — нейтральный вопрос, объект запомнен в диалоге", async () => {
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: ["Здравствуйте! По какому вопросу обращаетесь?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });

    await processMessengerTurn({
      ...fixture.turnInput(subscriberId),
      text: "Привет! Можно узнать об этом подробнее?",
      adTopic: "property",
      adExternalId: `ad-${runId}`,
      adPropertyId: propertyId,
    });

    // Про квартиру в этом ходе не заговариваем — человек ещё ничего не сказал.
    expect(lastPrompt()).toContain("СТРОГО ЗАПРЕЩЕНО в этом ответе: спрашивать, какую квартиру он ищет");

    const conv = await prisma.botConversation.findFirst({
      where: { endpointScopeId: fixture.transport.endpointScopeId, subscriberId },
      select: { adPropertyId: true },
    });
    // Объект дождётся хода, на котором человек скажет, что ему нужно.
    expect(conv?.adPropertyId).toBe(propertyId);
  });

  it("человек ответил про квартиру — бот говорит про ЭТОТ объект, а не «какую ищете»", async () => {
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: ["Бале, ин хона ҳоло фурӯхта мешавад."], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });

    await processMessengerTurn({ ...fixture.turnInput(subscriberId), text: "по квартире" });

    const prompt = lastPrompt();
    expect(prompt).toContain("написал с НАШЕЙ рекламы ЭТОГО объекта");
    expect(prompt).toContain("НЕ спрашивай, какую");
    // «Видео не открылось» остаётся запрещённым везде на этом пути.
    expect(prompt).not.toContain("видео у тебя не открылось");
    // Нейтральная подсказка отработала свой ход и ушла.
    expect(prompt).not.toContain("СТРОГО ЗАПРЕЩЕНО в этом ответе: спрашивать, какую квартиру он ищет");
  });

  it("объект сняли с продажи — подсказки просто нет, врать про наличие нельзя", async () => {
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: ["Хуб, чӣ гуна хона мекобед?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const goneId = `gone-${runId}`;
    await prisma.botConversation.updateMany({ where: { endpointScopeId: fixture.transport.endpointScopeId, subscriberId }, data: { adPropertyId: goneId } });

    await processMessengerTurn({ ...fixture.turnInput(subscriberId), text: "а сколько стоит" });

    expect(lastPrompt()).not.toContain("написал с НАШЕЙ рекламы ЭТОГО объекта");
  });
});
