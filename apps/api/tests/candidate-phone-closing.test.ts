import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * НОМЕР КАНДИДАТА В МЕССЕНДЖЕРЕ НЕ ОБЕЩАЕТ ЗВОНОК (CHANNEL-NEW-42, аудит 04.10.2026).
 *
 * Быстрый путь acceptLead для кандидата закрывал разговор хардкодом «передам
 * руководству, с вами свяжутся» и просил модель сказать то же самое. Правило
 * владельца от 20.09.2026 (SCENARIO_JOB): звонок не обещать, «заявка будет
 * рассмотрена». Telegram-пути берут канонический JOB_ACCEPTED_REPLY; здесь
 * проверяем, что общий мессенджерный канал с ним не расходится — и когда модель
 * недоступна (запасная фраза), и в самом задании модели.
 */

const { callAiText } = vi.hoisted(() => ({ callAiText: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));
vi.mock("../src/lib/clientToCandidate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientToCandidate.js")>()),
  notifyCandidateOwners: vi.fn(async () => {}),
}));

const { prisma } = await import("../src/db.js");
const { acceptLead } = await import("../src/messengers/conversation.js");
const { recordJobApplication } = await import("../src/lib/jobApplications.js");
const { JOB_ACCEPTED_REPLY } = await import("../src/messengers/leadAcceptedReply.js");

const runId = Date.now().toString(36);
const botConvIds: string[] = [];

function freshDigits(): string {
  return `93${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
}

let savedVacancies = false;
beforeAll(async () => {
  const row = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botCanHandleVacancies: true },
  });
  savedVacancies = row.botCanHandleVacancies;
  await prisma.settings.update({ where: { id: "singleton" }, data: { botCanHandleVacancies: true } });
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { botCanHandleVacancies: savedVacancies } });
  await prisma.jobApplication.deleteMany({ where: { conversationId: { in: botConvIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: botConvIds } } });
});

beforeEach(() => {
  callAiText.mockReset();
  callAiText.mockResolvedValue(null);
});

describe("кандидат оставил номер в Instagram/WhatsApp/Facebook", () => {
  it("рассказ собран, модель недоступна: запасная фраза каноническая, без обещания звонка", async () => {
    const digits = freshDigits();
    const history = [{ role: "user" as const, content: "Хочу работать агентом, мне 25 лет" }];
    const conv = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `cand-close-${runId}-${digits}`,
        leadDraft: { stage: "chatting", intent: "job", confident: true },
        messages: history as object[],
      },
    });
    botConvIds.push(conv.id);
    // Возраст уже назван, а «работает/учится сейчас» ещё нет.
    await recordJobApplication({ conversationId: conv.id, channel: "INSTAGRAM", draft: { age: 25 } });

    const draft = { stage: "chatting" as const, intent: "job" as const, confident: true };
    const res = await acceptLead(conv.id, "INSTAGRAM", "Фируз Назаров", `+992${digits}`, draft, history, {
      clientText: `Мой номер ${digits}`,
    });

    expect(res.reply).toBe(JOB_ACCEPTED_REPLY.ru);
    expect(res.reply).not.toMatch(/свяж|тамос/i);
    // Задание модели тоже не велит обещать связь.
    const system = String(callAiText.mock.calls[0]?.[0]?.system ?? "");
    expect(system).not.toMatch(/с ним свяжутся/);
  });
});
