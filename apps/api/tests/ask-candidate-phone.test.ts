import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * askCandidatePhone — догоняющая просьба о номере (cron «candidate-phone-ask»).
 *
 * Модель и отправка подменены: тест не должен ни платить за токены, ни
 * зависеть от Meta API. Всё остальное настоящее, включая базу — тот же приём,
 * что в tests/bot-channel-toggles.test.ts.
 */

const { qualify } = vi.hoisted(() => ({ qualify: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: qualify,
}));

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("../src/messengers/sendBotMessage.js", () => ({
  sendBotMessageWithMid: sendMock,
}));

const { askCandidatePhone } = await import("../src/lib/askCandidatePhone.js");

const runId = Date.now();
const conversationIds: string[] = [];
const profileIds: string[] = [];

afterAll(async () => {
  await prisma.jobApplication.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: profileIds } } });
});

afterEach(() => {
  qualify.mockReset();
  sendMock.mockReset();
});

/**
 * Свой диалог и своя анкета на каждый тест — НЕ общий на файл. Отправка через
 * askCandidatePhone дописывает в переписку настоящую реплику бота
 * (appendConversationMessages, боевой путь, не мок), и общий диалог между
 * двумя тестами означал бы, что второй тест видит вопрос о номере, реально
 * заданный первым, — и получает не ту причину пропуска, которую проверяет.
 */
async function seedCase(
  tag: string,
  opts: { status?: string; lastMessageAt?: Date; createdAt?: Date; contactProfileId?: string } = {}
) {
  const conversationId = `ask-phone-${runId}-${tag}`;
  conversationIds.push(conversationId);
  await prisma.botConversation.create({
    data: {
      id: conversationId,
      channel: "WHATSAPP",
      subscriberId: `ask-phone-sub-${runId}-${tag}`,
      name: "Кандидат без номера",
      lastMessageAt: opts.lastMessageAt ?? new Date(),
      ...(opts.contactProfileId ? { contactProfileId: opts.contactProfileId } : {}),
      // Последним отвечал БОТ (иначе askCandidatePhone сам пропустит диалог
      // как «ещё не ответил на последнее сообщение кандидата»), и без слов
      // про номер в репликах бота (иначе сойдёт за «уже просил сам»).
      messages: [
        { role: "user", content: "Салом, кор доред?" },
        { role: "assistant", content: "Салом! Ҳа, ҷои кор ҳаст. Расскажите немного о себе." },
        { role: "user", content: "Ман 27 сола, дар бозор кор мекунам" },
        { role: "assistant", content: "Раҳмат, маълумотатонро қабул кардем." },
      ],
    },
  });
  const created = await prisma.jobApplication.create({
    data: {
      conversationId,
      channel: "WHATSAPP",
      name: `Кандидат ${runId} ${tag}`,
      status: opts.status ?? "NEW",
      phone: null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.contactProfileId ? { contactProfileId: opts.contactProfileId } : {}),
    },
  });
  return created.id;
}

/** Кому из СВОИХ диалогов ушла просьба — по subscriberId в вызове отправки. */
function sentTo(tag: string): boolean {
  return sendMock.mock.calls.some((c) => c[1] === `ask-phone-sub-${runId}-${tag}`);
}

describe("askCandidatePhone: обычная отправка", () => {
  it("отправляет просьбу и отмечает phoneAskedAt", async () => {
    const appId = await seedCase("send");
    qualify.mockResolvedValue({ reply: "Оставьте, пожалуйста, номер — с вами хотят созвониться." });
    sendMock.mockResolvedValue({ sent: true, mid: "wamid.test" });

    const result = await askCandidatePhone({ apply: true, limit: 10 });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const row = await prisma.jobApplication.findUnique({ where: { id: appId } });
    expect(row?.phoneAskedAt).not.toBeNull();
    expect(result.sent).toBeGreaterThanOrEqual(1);
  });
});

describe("askCandidatePhone: выключенный аккаунт Meta (CHANNEL-NEW-11)", () => {
  it("диалог выключенного аккаунта не получает просьбу о номере, отметка phoneAskedAt не ставится", async () => {
    const { encryptSecret } = await import("../src/crypto.js");
    const { resetAccountsCache } = await import("../src/messengers/accounts.js");
    const account = await prisma.messengerAccount.create({
      data: {
        channel: "WHATSAPP",
        externalId: `ask-phone-off-${runId}`,
        title: "Выключенный аккаунт",
        token: encryptSecret("tok-off"),
        enabled: false,
      },
    });
    resetAccountsCache();
    try {
      const appId = await seedCase("disabled-account");
      await prisma.botConversation.update({
        where: { id: `ask-phone-${runId}-disabled-account` },
        data: { accountId: account.id },
      });
      qualify.mockResolvedValue({ reply: "Оставьте, пожалуйста, номер — с вами хотят созвониться." });
      sendMock.mockResolvedValue({ sent: true, mid: "wamid.test" });

      const result = await askCandidatePhone({ apply: true, limit: 10 });

      expect(sentTo("disabled-account")).toBe(false);
      const row = await prisma.jobApplication.findUnique({ where: { id: appId } });
      expect(row?.phoneAskedAt).toBeNull();
      expect(result.skipped.some((s) => s.reason.includes("аккаунт выключен"))).toBe(true);
    } finally {
      await prisma.jobApplication.deleteMany({ where: { conversationId: `ask-phone-${runId}-disabled-account` } });
      await prisma.botConversation.deleteMany({ where: { id: `ask-phone-${runId}-disabled-account` } });
      await prisma.messengerAccount.delete({ where: { id: account.id } });
      resetAccountsCache();
    }
  });
});
describe("askCandidatePhone: перепроверка перед самой отправкой", () => {
  /**
   * НАЙДЕНО 04.09.2026 (полный обход раздела). shortAgentReply — это секунды на
   * живом кандидате, который продолжает переписываться с ботом НЕЗАВИСИМО от
   * этого прохода: он вполне мог прислать номер именно в эти секунды, бот его
   * уже принял и записал, а мы всё ещё держим готовый текст «дайте номер».
   * Без перепроверки кандидат, только что давший номер, получил бы просьбу
   * дать его снова — тот самый «неисправный автомат», от которого модуль
   * специально защищается на каждом другом шаге.
   */
  it("не отправляет и не перезаписывает номер, если кандидат ответил, пока готовился текст", async () => {
    const appId = await seedCase("race");
    // Мок ИИ имитирует гонку: пока «готовится» текст просьбы, кандидат успевает
    // ответить боту сам, и запись в базе меняется прямо внутри вызова модели.
    qualify.mockImplementation(async () => {
      await prisma.jobApplication.update({ where: { id: appId }, data: { phone: "+992900112233" } });
      return { reply: "Оставьте, пожалуйста, номер — с вами хотят созвониться." };
    });
    sendMock.mockResolvedValue({ sent: true, mid: "wamid.test" });

    const result = await askCandidatePhone({ apply: true, limit: 10 });

    // Главная проверка: отправка НЕ ушла.
    expect(sendMock).not.toHaveBeenCalled();
    const row = await prisma.jobApplication.findUnique({ where: { id: appId } });
    // Номер, который «дал кандидат», остался — перепроверка не должна была
    // его перезаписать или стереть.
    expect(row?.phone).toBe("+992900112233");
    expect(result.skipped.some((s) => s.reason.includes("номер уже появился"))).toBe(true);
  });
});

/**
 * Разбор 02.10.2026: крон каждые 15 минут писал «оставьте номер» и тем, кому
 * уже отказали (REJECTED), и принятым на работу (HIRED), и продавцам, ошибочно
 * попавшим в анкеты (NOT_CANDIDATE) — фильтра по статусу не было вовсе.
 */
describe("askCandidatePhone: только тем, кто в воронке", () => {
  it("NOT_CANDIDATE, REJECTED и HIRED не получают просьбу и не помечаются", async () => {
    const ids = {
      nc: await seedCase("st-nc", { status: "NOT_CANDIDATE" }),
      rej: await seedCase("st-rej", { status: "REJECTED" }),
      hired: await seedCase("st-hired", { status: "HIRED" }),
    };
    qualify.mockResolvedValue({ reply: "Оставьте, пожалуйста, номер." });
    sendMock.mockResolvedValue({ sent: true, mid: "wamid.test" });

    await askCandidatePhone({ apply: true, limit: 200 });

    expect(sentTo("st-nc")).toBe(false);
    expect(sentTo("st-rej")).toBe(false);
    expect(sentTo("st-hired")).toBe(false);
    for (const id of Object.values(ids)) {
      expect((await prisma.jobApplication.findUnique({ where: { id } }))?.phoneAskedAt).toBeNull();
    }
  });

  it("номер уже дан по другой анкете того же человека — второй раз не просим", async () => {
    const profile = await prisma.contactProfile.create({ data: {} });
    profileIds.push(profile.id);
    const withPhone = `ask-phone-${runId}-b4-other`;
    conversationIds.push(withPhone);
    await prisma.jobApplication.create({
      data: { conversationId: withPhone, channel: "INSTAGRAM", contactProfileId: profile.id, phone: "+992935556677" },
    });
    await seedCase("b4", { contactProfileId: profile.id });
    qualify.mockResolvedValue({ reply: "Оставьте, пожалуйста, номер." });
    sendMock.mockResolvedValue({ sent: true, mid: "wamid.test" });

    await askCandidatePhone({ apply: true, limit: 200 });

    expect(sentTo("b4")).toBe(false);
  });
});

/**
 * Голодание очереди (разбор 02.10.2026). Предел брался с самых новых анкет ДО
 * проверок, а пропуски «окно 24 часа закрыто» ничем не помечались — такие
 * строки вечно занимали все места, и живой кандидат за ними не получал
 * просьбу никогда. Свои строки — в «будущем», чтобы чужие анкеты общей базы
 * стояли в очереди позади и не влияли на исход.
 */
describe("askCandidatePhone: закрытые окна не занимают очередь", () => {
  it("живой кандидат за тремя молчащими больше суток всё равно получает просьбу", async () => {
    const future = Date.now() + 365 * 24 * 3600_000;
    const stale = new Date(Date.now() - 3 * 24 * 3600_000);
    for (let i = 0; i < 3; i++) {
      await seedCase(`starve-${i}`, { lastMessageAt: stale, createdAt: new Date(future + (i + 1) * 1000) });
    }
    const liveId = await seedCase("starve-live", { createdAt: new Date(future) });
    qualify.mockResolvedValue({ reply: "Оставьте, пожалуйста, номер." });
    sendMock.mockResolvedValue({ sent: true, mid: "wamid.test" });

    await askCandidatePhone({ apply: true, limit: 3 });

    expect(sentTo("starve-live")).toBe(true);
    expect((await prisma.jobApplication.findUnique({ where: { id: liveId } }))?.phoneAskedAt).not.toBeNull();
  });
});
