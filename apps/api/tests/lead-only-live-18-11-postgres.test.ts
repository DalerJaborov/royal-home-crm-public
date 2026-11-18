import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Дверь намерения без модели: роль дают запасные регулярки, а где важен ответ модели — тест подставляет его сам.
vi.mock("../src/ai/leadOnlyIntent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/leadOnlyIntent.js")>();
  return { ...actual, classifyLeadOnlyIntent: (input: Parameters<typeof actual.classifyLeadOnlyIntent>[0]) => actual.classifyLeadOnlyIntent(input, async () => null) };
});
import { prisma } from "../src/db.js";
import { planCustomerLeadOnlyTurn, type CustomerLeadOnlyTurnInput } from "../src/lib/customerLeadOnlyCore.js";
import { leadOnlyIntentFallback, type LeadOnlyIntent } from "../src/ai/leadOnlyIntent.js";
import { LEAD_ONLY_DEFAULTS } from "../src/ai/leadOnlyMode.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";
import { decryptSecret } from "../src/crypto.js";

/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» НА ЖИВЫХ ПЕРЕПИСКАХ 18.11.2026 (жалоба директора «бот отупел»; разбор —
 * D:/TASKS-2026-11-14/reports/bot-dumb-diagnosis-2026-11-18.md). Фразы — дословно из чатов прода.
 */
const runId = Date.now().toString(36);
const config = { ...LEAD_ONLY_DEFAULTS, enabled: true, useWhatsappNumber: true, workHoursStart: "00:00", workHoursEnd: "24:00" };
const conversations: string[] = [];
const waPeer = () => `99293${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const asModel = (role: LeadOnlyIntent["role"], quote: string) => async (): Promise<LeadOnlyIntent> =>
  ({ role, hot: false, quote, hotQuote: null, source: "model" });

function input(over: Partial<CustomerLeadOnlyTurnInput>): CustomerLeadOnlyTurnInput {
  return { config, channel: "WHATSAPP", peer: waPeer(), conversationId: randomUUID(), eventKey: "b".repeat(64),
    language: "ru", inputText: "", focusPropertyId: null, focusFromThisMessage: false, turns: [], sentTexts: [], jobTopic: false, ...over };
}
/** Заявка запечатана (номер шифруется): тест открывает её тем же ключом. */
const sealedOf = (plan: { intake: { sealed: string } | null } | null) =>
  plan?.intake ? JSON.parse(decryptSecret(plan.intake.sealed)) as { lead: boolean; phone: string | null } : null;
async function waConversation(peer: string) {
  const row = await prisma.botConversation.create({ data: { channel: "WHATSAPP", subscriberId: peer, messages: [] } });
  conversations.push(row.id); return row.id;
}

beforeAll(async () => { await drainBackgroundTasks(3000); });
afterAll(async () => {
  await drainBackgroundTasks(3000);
  await prisma.botConversation.deleteMany({ where: { id: { in: conversations } } });
});

describe("WhatsApp, номер известен, карточки нет: просьба звонка — это заявка", () => {
  it("#2f2c7d: «Позвоните мне через воцтап сейчас» после разговора о квартире — заявка агенту, а не «Передал вашу просьбу» в пустоту", async () => {
    const peer = waPeer(), id = await waConversation(peer);
    const turns = [{ role: "user" as const, text: "Салом. Мне нужна квартира в районе молодёжного театра. До 1 млн сомони. Отправите варианты?" },
      { role: "assistant" as const, text: "Чем могу помочь?" }];
    const plan = await planCustomerLeadOnlyTurn(input({ peer, conversationId: id, inputText: "Позвоните мне через воцтап сейчас", turns,
      classifyIntent: asModel("other", "") }));
    expect(sealedOf(plan)?.lead).toBe(true);
    expect(plan?.text).toMatch(/агент/u);
  });

  it("#2caf75: «Ок» на вопрос бота «Мехоҳед корманд ба шумо занг занад?» — согласие, заявка", async () => {
    const peer = waPeer(), id = await waConversation(peer);
    const turns = [{ role: "user" as const, text: "Салом" }, { role: "assistant" as const, text: "Мехоҳед корманд ба шумо занг занад?" }];
    const plan = await planCustomerLeadOnlyTurn(input({ peer, conversationId: id, language: "tg", inputText: "Ок", turns,
      classifyIntent: asModel("other", "") }));
    expect(sealedOf(plan)?.lead).toBe(true);
  });

  it("«Ок» без вопроса о звонке — не заявка (ложного лида нет)", async () => {
    const peer = waPeer(), id = await waConversation(peer);
    const turns = [{ role: "user" as const, text: "Салом" }, { role: "assistant" as const, text: "Чӣ хизмат кунам?" }];
    const plan = await planCustomerLeadOnlyTurn(input({ peer, conversationId: id, language: "tg", inputText: "Ок", turns,
      classifyIntent: asModel("other", "") }));
    expect(plan?.intake ?? null).toBeNull();
  });

  it("«Не звоните мне» — не заявка и не обещание звонка", async () => {
    const peer = waPeer(), id = await waConversation(peer);
    const plan = await planCustomerLeadOnlyTurn(input({ peer, conversationId: id, inputText: "Не звоните мне", classifyIntent: asModel("other", "") }));
    expect(sealedOf(plan)?.lead ?? false).toBe(false);
  });

  it("Instagram без номера: «Перезвоните мне» — номер просим, заявки нет", async () => {
    const plan = await planCustomerLeadOnlyTurn(input({ channel: "INSTAGRAM", peer: `live-${runId}-${randomUUID()}`, inputText: "Перезвоните мне",
      classifyIntent: asModel("other", "") }));
    expect(plan?.intake ?? null).toBeNull();
  });
});

describe("«Сколько стоят ваши услуги?» — это не продавец", () => {
  it("кнопка рекламы Meta: даже если модель сказала seller, ответ не «Да, поможем продать» (ответит обычный путь: 0% и 2%)", async () => {
    for (const [inputText, language] of [["Сколько стоят ваши услуги?", "ru"], ["Хизмати шумо чанд пул мешавад?", "tg"], ["Сколько стоит услуга?", "ru"]] as const) {
      const plan = await planCustomerLeadOnlyTurn(input({ channel: "FACEBOOK", peer: `live-${runId}-${randomUUID()}`, inputText, language,
        classifyIntent: asModel("seller", inputText) }));
      expect(plan?.text ?? "").not.toMatch(/поможем продать|дар фурӯш кӯмак/u);
    }
  });

  it("«Хочу продать квартиру, сколько стоят ваши услуги?» — продавец, как и был", async () => {
    const inputText = "Хочу продать квартиру, сколько стоят ваши услуги?";
    const plan = await planCustomerLeadOnlyTurn(input({ channel: "FACEBOOK", peer: `live-${runId}-${randomUUID()}`, inputText,
      classifyIntent: asModel("seller", "Хочу продать квартиру") }));
    expect(plan?.scenario).toBe("seller");
  });
});

describe("запасные правила: опечатки продавца", () => {
  it("#6a1577: «Я хочу продоват свою квартиру» — продавец, а не покупатель", () => {
    for (const text of ["Я хочу продоват свою квартиру", "хочу прадать квартиру", "Хочу продовать дом"]) {
      expect(leadOnlyIntentFallback(text).role, text).toBe("seller");
    }
    expect(leadOnlyIntentFallback("Хочу купить квартиру").role).toBe("buyer");
  });
});
