import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * ПРОДАВЕЦ, НАЖАВШИЙ КНОПКУ ПОД РЕКЛАМОЙ ВАКАНСИИ (20.09.2026, выгрузка 775 живых
 * переписок — docs/bot-razbor-20-09.md).
 *
 * Реклама вакансии и реклама объектов идут одновременно, и человек жмёт кнопку не
 * глядя. С 17.09.2026 признак «пришёл по вакансии» (BotConversation.adTopic="job")
 * живёт весь разговор и на каждом ходе подставляет модели подсказку, которая прямо
 * ЗАПРЕЩАЕТ спрашивать про квартиру. Выхода из этого состояния не было вовсе:
 *
 *   клиент: Хавлии фуруши дорам            («у меня дом на продажу»)
 *   бот:    Мо агентони фурӯшро ба кор қабул мекунем. Резюме доред?
 *   … ещё четыре хода про резюме …
 *   клиент: Ма мегум хавлии фуруши дорм, мада кор ларкор нест
 *
 * Собственные слова человека сильнее догадки по рекламе. Тест стережёт именно это:
 * не текст ответа (модель подменена), а какую подсказку код ей дал.
 *
 * Обратную сторону (настоящий кандидат ПО-ПРЕЖНЕМУ ведётся по сценарию работы)
 * держит vacancy-ad-full-path.test.ts; здесь она проверяется ещё раз на рассказе о
 * себе, где законно звучат и «квартира», и «продажа».
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
/** Подписчик НЕ цифрами — см. объяснение в vacancy-ad-full-path.test.ts. */
const sellerId = `vachint-seller-${runId}`;
const candidateId = `vachint-cand-${runId}`;

const VACANCY_HINT_MARK = "он откликается на объявление о работе";

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
  for (const subscriberId of [sellerId, candidateId]) {
    const convs = await prisma.botConversation.findMany({ where: { subscriberId, endpointScopeId: fixture.transport.endpointScopeId }, select: { id: true, clientId: true } });
    for (const conv of convs) {
      await prisma.jobApplication.deleteMany({ where: { conversationId: conv.id } });
      if (conv.clientId) {
        await prisma.interaction.deleteMany({ where: { clientId: conv.clientId } });
        await prisma.client.deleteMany({ where: { id: conv.clientId } });
      }
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

describe("подсказка о вакансии уступает словам клиента", () => {
  it("человек с рекламы вакансии сказал «хавлии фуруши дорам» — подсказки о работе больше нет", async () => {
    // ── ХОД 1. Кнопка под рекламой вакансии, своих слов нет.
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: ["Салом! Бифармоед, оид ба кадом масъала муроҷиат мекунед?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    await processMessengerTurn({
      channel: "WHATSAPP",
      subscriberId: sellerId,
      text: AD_TEMPLATE,
      adTopic: "job",
      adExternalId: `ad-${runId}`,
    });
    // Признак вакансии запомнен — иначе тест ниже ничего не доказывает.
    const conv = await prisma.botConversation.findFirst({ where: { subscriberId: sellerId }, select: { adTopic: true } });
    expect(conv?.adTopic).toBe("job");

    // ── ХОД 2. Человек сказал своё: у него дом на продажу.
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: ["Ҳавлӣ дар кадом тараф ҷойгир аст?"], intent: "sell", ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    await processMessengerTurn({ channel: "WHATSAPP", subscriberId: sellerId, text: "Хавлии фуруши дорам" });

    const prompt = lastPrompt();
    // Без правки здесь стояла подсказка «он откликается на объявление о работе»
    // вместе с прямым запретом спрашивать про жильё — и бот пять ходов просил резюме.
    expect(prompt).not.toContain(VACANCY_HINT_MARK);
    expect(prompt).not.toContain("ЗАПРЕЩЕНО спрашивать, какую");
  });

  it("настоящий кандидат остаётся кандидатом, даже когда в рассказе о себе звучит продажа квартир", async () => {
    callAi.mockClear();
    callAi.mockResolvedValue({ reply: ["Салом! Бифармоед, оид ба кадом масъала муроҷиат мекунед?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    await processMessengerTurn({
      channel: "WHATSAPP",
      subscriberId: candidateId,
      text: AD_TEMPLATE,
      adTopic: "job",
      adExternalId: `ad-${runId}`,
    });

    callAi.mockClear();
    callAi.mockResolvedValue({ reply: ["Хуш омадед! Резюме доред?"], intent: "job", ready: false, confident: true, topic: "job", openQuestion: "", clientAnsweredOpenQuestion: false });
    await processMessengerTurn({
      channel: "WHATSAPP",
      subscriberId: candidateId,
      // Опыт работы, а не своя квартира: слова «фурӯш» и «хона» здесь законны.
      text: "Ман дар фурӯши хона таҷриба дорам, барои кор омадам",
    });

    expect(lastPrompt()).toContain(VACANCY_HINT_MARK);
  });
});
