import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * ЛОВУШКА «РАБОТА» — ВЫХОД ЕСТЬ (23.09.2026, живой случай «Мичгона»).
 *
 * Генерический ответ на рекламу вакансии («Можно узнать об этом подробнее?»)
 * заставил модель один раз выставить intent=job. Дальше — даже когда человек
 * несколько сообщений подряд ясно говорил про продажу дома («Салом хонай
 * фуруши дорам», адрес, этаж) и модель, вопреки этому, продолжала подтверждать
 * intent=job (сценарийный промт для job подталкивает её вести разговор как HR,
 * а не пересматривать направление) — в момент, когда человек наконец оставил
 * номер, `acceptLead` (messengers/conversation.ts) заводил анкету кандидата и
 * снимал агента с карточки, не глядя на то, что клиент только что сам
 * описал свой дом на продажу. Продавец получил карточку кандидата с номером
 * «для вакансии».
 *
 * Этот тест стережёт именно последний рубеж: `acceptLead` — точка, где решение
 * необратимо (заявка кандидата, отвязка агента) — обязана свериться с полными
 * словами клиента (ai/housingIntent.ts::clientMeansHousingDeal), а не слепо
 * доверять устаревшему/упрямому draft.intent="job".
 *
 * Обратную сторону (настоящий кандидат по-прежнему заводит анкету) держат
 * vacancy-ad-full-path.test.ts и vacancy-hint-yields-to-seller.test.ts — этот
 * тест их не трогает и не переопределяет.
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
const AD_TEMPLATE = "Привет! Можно узнать об этом подробнее?";
const subscriberId = `jobtrap-${runId}`;
const PHONE_DIGITS = "910001044";

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

describe("выход из ловушки «работа» словами клиента о сделке с жильём", () => {
  it("продавец, застрявший на intent=job, не становится анкетой кандидата, когда сам номер сопровождён словами о продаже дома", async () => {
    // ── ХОД 1. Кнопка под рекламой вакансии, своих слов нет.
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: ["Салом! Бифармоед, оид ба кадом масъала муроҷиат мекунед?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    await processMessengerTurn({
      channel: "WHATSAPP",
      subscriberId,
      text: AD_TEMPLATE,
      adTopic: "job",
      adExternalId: `ad-${runId}`,
    });

    // ── ХОД 2. Модель (подменена) решает: это соискатель. draft.intent="job".
    callAi.mockClear();
    callAi.mockResolvedValue({
      reply: ["Бале, мо агентҳои фурӯш мегирем. Резюмеи тайёр доред?"],
      intent: "job",
      ready: false,
      confident: true,
      topic: "job",
      openQuestion: "",
      clientAnsweredOpenQuestion: false,
    });
    await processMessengerTurn({ channel: "WHATSAPP", subscriberId, text: "барои кор омадам" });
    const afterJobTurn = await prisma.botConversation.findFirst({
      where: { subscriberId },
      select: { leadDraft: true },
    });
    expect((afterJobTurn?.leadDraft as { intent?: string } | null)?.intent).toBe("job");

    // ── ХОД 3. Человек своими словами говорит про продажу дома — но модель
    // (подменена нарочно ХУДШИМ случаем: её самой заклинило на "job", как в
    // живой переписке) СНОВА подтверждает intent=job. Код-уровневой защиты от
    // этого до правки не было вовсе — только подсказка модели (другой
    // механизм, vacancy-hint-yields-to-seller.test.ts), которая тут не спасает.
    callAi.mockClear();
    callAi.mockResolvedValue({
      reply: ["Хуш, дар бораи худатон бештар нақл кунед."],
      intent: "job",
      ready: false,
      confident: true,
      topic: "job",
      openQuestion: "",
      clientAnsweredOpenQuestion: false,
    });
    await processMessengerTurn({ channel: "WHATSAPP", subscriberId, text: "Салом хонай фуруши дорам" });
    const afterHousingWordsTurn = await prisma.botConversation.findFirst({
      where: { subscriberId },
      select: { leadDraft: true },
    });
    // Подтверждаем худший случай перед главной проверкой: draft.intent
    // ДЕЙСТВИТЕЛЬНО остался "job" — то есть ниже проверяется не удача модели,
    // а именно защита в acceptLead.
    expect((afterHousingWordsTurn?.leadDraft as { intent?: string } | null)?.intent).toBe("job");

    // ── ХОД 4. Человек оставляет номер. draft.intent всё ещё "job" — без
    // правки это гарантированная анкета кандидата вместо карточки продавца.
    callAi.mockClear();
    callAi.mockResolvedValue({ bubbles: ["Спасибо, агент свяжется по этому объекту."] });
    await processMessengerTurn({
      channel: "WHATSAPP",
      subscriberId,
      text: `Хона да якачинор пеши масчиди карор дора, 13 эт, ${PHONE_DIGITS}`,
    });

    const conv = await prisma.botConversation.findFirst({
      where: { subscriberId },
      select: { id: true },
    });
    const application = await prisma.jobApplication.findUnique({ where: { conversationId: conv!.id } });
    // ГЛАВНОЕ: продавец, ясно описавший свой дом на продажу, не превращается в
    // анкету кандидата на вакансию только из-за упрямого draft.intent="job".
    expect(application).toBeNull();
  });
});
