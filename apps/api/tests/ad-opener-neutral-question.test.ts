import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ШАБЛОННАЯ ФРАЗА С РЕКЛАМЫ → ОДИН НЕЙТРАЛЬНЫЙ ВОПРОС → И ТОЛЬКО ПОТОМ СЦЕНАРИЙ.
 *
 * Владелец 17.09.2026, вечером, по живой проверке: «пусть ИИ бот просто спросит,
 * по какому вопросу они обращаются или как он может им помочь, чтобы не
 * ошибаться, а то непонятно, кто за вакансиями, кто за квартирами».
 *
 * Реклама квартир и реклама вакансии идут ОДНОВРЕМЕННО, а человек, нажавший
 * кнопку под объявлением, не написал ни одной своей буквы: click-to-WhatsApp
 * подставляет фразу за него. Любая догадка стоит дорого в обе стороны —
 * кандидату бот начинал подбирать квартиру, покупателю лез с опытом продаж.
 *
 * Модель подменена целиком: тест про решения вокруг неё, а не про её ответ.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { processMessengerTurn } = await import("../src/messengers/conversation.js");

const runId = Date.now().toString(36);
const AD_TEMPLATE = "Привет! Можно узнать об этом подробнее?";

let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;
let fixture: CustomerMessengerFixture;

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("WHATSAPP");
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  settingsBefore = s;
  // Короткое окно дебаунса, иначе каждый ход ждёт настройку по умолчанию (15 сек).
  await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 1, botReplyMaxWaitSec: 3 } });
});

afterAll(async () => {
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  const convs = await prisma.botConversation.findMany({
    where: { endpointScopeId: fixture.transport.endpointScopeId },
    select: { id: true, clientId: true },
  });
  for (const conv of convs) {
    await prisma.jobApplication.deleteMany({ where: { conversationId: conv.id } });
    if (conv.clientId) {
      await prisma.interaction.deleteMany({ where: { clientId: conv.clientId } });
      await prisma.client.deleteMany({ where: { id: conv.clientId } });
    }
  }
  await fixture?.dispose();
});

/** Что именно уехало модели этим ходом — склейка всех реплик запроса. */
function lastPrompt(): string {
  const call = callAi.mock.calls.at(-1)?.[0] as
    | { system?: string; systemStable?: string; messages?: { role: string; content: string }[] }
    | undefined;
  return [call?.systemStable ?? "", call?.system ?? "", ...(call?.messages ?? []).map((m) => m.content)].join("\n");
}

describe("человек пришёл по рекламе и ничего не написал", () => {
  it("реклама ВАКАНСИИ: первый ответ — нейтральный вопрос, не сценарий работы", async () => {
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: ["Салом! Бифармоед, оид ба кадом масъала муроҷиат мекунед?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const subscriberId = `adopen-${runId}-job`;

    await processMessengerTurn({
      ...fixture.turnInput(subscriberId),
      text: AD_TEMPLATE,
      // Ровно то, что присылает Meta по click-to-WhatsApp с рекламы вакансии.
      adTopic: "job",
      adExternalId: "ad-job-1",
    });

    const prompt = lastPrompt();
    // Нейтральная подсказка на месте...
    expect(prompt).toContain("спроси только, чем можешь помочь");
    // ...а про вакансию, резюме и опыт в ЭТОМ ходе заговаривать запрещено.
    expect(prompt).toContain("заговаривать про вакансию, резюме и опыт работы");
    // Подсказка сценария вакансии в этот ход НЕ подставляется.
    expect(prompt).not.toContain("он откликается на объявление о работе");
    // Квартиру тоже не навязываем — мы не знаем, зачем человек написал.
    expect(prompt).toContain("СТРОГО ЗАПРЕЩЕНО в этом ответе: спрашивать, какую квартиру он ищет");

    // Контекст не потерян: тема сохранена в диалоге и пригодится следующим ходом.
    const conv = await prisma.botConversation.findFirst({
      where: { endpointScopeId: fixture.transport.endpointScopeId, subscriberId },
      select: { adTopic: true, clientId: true },
    });
    expect(conv?.adTopic).toBe("job");
    // И никакой карточки клиента: человек ещё ничего о себе не сказал.
    expect(conv?.clientId).toBeNull();
  });

  it("реклама ОБЪЕКТА: тот же нейтральный вопрос, без «какую квартиру ищете»", async () => {
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: ["Здравствуйте! Подскажите, по какому вопросу обращаетесь?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const subscriberId = `adopen-${runId}-prop`;

    await processMessengerTurn({
      ...fixture.turnInput(subscriberId),
      text: AD_TEMPLATE,
      adTopic: "property",
      adExternalId: "ad-prop-1",
    });

    const prompt = lastPrompt();
    expect(prompt).toContain("спроси только, чем можешь помочь");
    expect(prompt).toContain("СТРОГО ЗАПРЕЩЕНО в этом ответе: спрашивать, какую квартиру он ищет");
  });

  it("клиент написал СВОЁ — нейтральный вопрос уступает сценарию вакансии", async () => {
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: ["Бале! Резюме доред?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const subscriberId = `adopen-${runId}-job`;

    // Тот же диалог, второй ход: человек ответил на нейтральный вопрос.
    await processMessengerTurn({
      ...fixture.turnInput(subscriberId),
      text: "барои кор омадам",
    });

    const prompt = lastPrompt();
    // Тема вакансии восстановлена из диалога, хотя referral больше не приходил.
    expect(prompt).toContain("он откликается на объявление о работе");
    // Нейтральной подсказки больше нет — она была ровно на первый ход.
    expect(prompt).not.toContain("СТРОГО ЗАПРЕЩЕНО в этом ответе: спрашивать, какую квартиру он ищет");
  });
});
