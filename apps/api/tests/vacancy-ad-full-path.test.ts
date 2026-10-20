import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * СКВОЗНОЙ ПУТЬ КАНДИДАТА С РЕКЛАМЫ ВАКАНСИИ (владелец, живая проверка 17.09.2026).
 *
 * Шаблон с click-to-WhatsApp → нейтральный вопрос → «барои кор» → анкета в
 * разделе «Вакансии», вопрос про резюме, и НИ КАРТОЧКИ КЛИЕНТА, НИ АГЕНТА.
 *
 * Каждый из этих шагов уже закрыт своим тестом по отдельности; этот проходит их
 * подряд одним диалогом — ровно так, как их проходит живой человек. Разошлись бы
 * они только здесь: по отдельности каждый шаг честен, а вместе они раньше давали
 * покупателя с агентом и вопрос «какую квартиру ищете» кандидату на работу.
 *
 * Модель подменена: тест про решения вокруг неё.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { processMessengerTurn: actualProcessMessengerTurn } = await import("../src/messengers/conversation.js");
let fixture: CustomerMessengerFixture | undefined;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...fixture!.turnInput(input.subscriberId) });
}

const runId = Date.now().toString(36);
/**
 * Подписчик НЕ цифрами: у WhatsApp числовой subscriberId — это wa_id, и ход
 * дополнительно ходит в базу за личностью отправителя (lib/whatsappPhone.ts).
 * Тесту это не нужно, а окно дебаунса оно съедает — первый ход успевал
 * вернуть «извините за задержку» вместо ответа бота.
 */
const subscriberId = `vacpath-${runId}`;
const AD_TEMPLATE = "Привет! Можно узнать об этом подробнее?";

let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;

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
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  if (!fixture) return;
  const convs = await prisma.botConversation.findMany({ where: { subscriberId, endpointScopeId: fixture.transport.endpointScopeId }, select: { id: true, clientId: true } });
  for (const conv of convs) {
    await prisma.jobApplication.deleteMany({ where: { conversationId: conv.id } });
    if (conv.clientId) {
      await prisma.interaction.deleteMany({ where: { clientId: conv.clientId } });
      await prisma.client.deleteMany({ where: { id: conv.clientId } });
    }
  }
  await fixture.dispose();
});

function lastPrompt(): string {
  const call = callAi.mock.calls.at(-1)?.[0] as
    | { system?: string; systemStable?: string; messages?: { role: string; content: string }[] }
    | undefined;
  return [call?.systemStable ?? "", call?.system ?? "", ...(call?.messages ?? []).map((m) => m.content)].join("\n");
}

describe("весь путь: реклама вакансии → нейтральный вопрос → кандидат", () => {
  it("шаблон → нейтральный вопрос → «барои кор» → анкета без карточки и агента", async () => {
    // ── ХОД 1. Человек нажал кнопку под рекламой вакансии. Своих слов нет.
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: ["Салом! Бифармоед, оид ба кадом масъала муроҷиат мекунед?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    await processMessengerTurn({
      channel: "WHATSAPP",
      subscriberId,
      text: AD_TEMPLATE,
      adTopic: "job",
      adExternalId: `ad-${runId}`,
    });

    // Текст ответа — работа модели, а она подменена: стережём то, что решает КОД, —
    // какую подсказку он ей дал. Гадать, что человеку нужно, запрещено.
    expect(callAi).toHaveBeenCalledTimes(1);
    expect(lastPrompt()).toContain("спроси только, чем можешь помочь");
    expect(lastPrompt()).not.toContain("он откликается на объявление о работе");

    // ── ХОД 2. Человек ответил. Теперь понятно: он про работу.
    callAi.mockClear();
    callAi.mockResolvedValue({
      reply: ["Бале, мо агентҳои фурӯш мегирем. Резюмеи тайёр доред?"],
      intent: "job",
      jobApplication: { summary: "Пришёл по рекламе вакансии", name: "Фируз" },
      ready: false,
      confident: true,
      topic: "job",
      openQuestion: "",
      clientAnsweredOpenQuestion: false,
    });
    await processMessengerTurn({ channel: "WHATSAPP", subscriberId, text: "барои кор омадам" });

    const prompt = lastPrompt();
    // Тема вакансии восстановлена из диалога — referral больше не приходил.
    expect(prompt).toContain("он откликается на объявление о работе");
    // Правила сценария JOB доехали: первым делом резюме, а не опрос.
    expect(prompt).toContain("ШАГ 1 — ПОДТВЕРДИ ВАКАНСИЮ И СПРОСИ ПРО РЕЗЮМЕ");
    // Лишние вопросы запрещены прямо в промте.
    expect(prompt).toContain("ЗАПРЕЩЕНЫ КАК ОТДЕЛЬНЫЕ ВОПРОСЫ");

    const conv = await prisma.botConversation.findFirst({
      where: { subscriberId },
      select: { id: true, clientId: true, adTopic: true },
    });
    expect(conv?.adTopic).toBe("job");

    // ГЛАВНОЕ: анкета кандидата есть...
    const application = await prisma.jobApplication.findUnique({ where: { conversationId: conv!.id } });
    expect(application).not.toBeNull();
    expect(application?.name).toBe("Фируз");
    expect(application?.channel).toBe("WHATSAPP");

    // ...а карточки клиента и агента нет и быть не должно.
    expect(conv?.clientId).toBeNull();
    const linked = await prisma.botConversation.findFirst({ where: { subscriberId }, select: { clientId: true } });
    expect(linked?.clientId).toBeNull();
  });
});
