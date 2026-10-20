import bcrypt from "bcrypt";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CRM-REVIEW01 (аудит Codex, 04.10.2026): отзыв сразу отмечался отвеченным, затем падало
 * создание лида по рекомендации, ошибка глоталась, клиенту отвечали «обязательно свяжемся»,
 * а агенту начислялись баллы за рекомендацию, которую CRM не приняла. Повторная доставка
 * уже не находила ожидающий отзыв.
 */
const createLeadFromChannel = vi.hoisted(() => vi.fn());
vi.mock("../src/services/leads/intake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/leads/intake.js")>()),
  createLeadFromChannel,
}));
const recordScoreEvent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/lib/scoreJournal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/scoreJournal.js")>()),
  recordScoreEvent,
}));
const logSystemError = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

const { prisma } = await import("../src/db.js");
const { createDealReviewAsk } = await import("../src/lib/dealReviews.js");
const { tryHandleDealReviewReply } = await import("../src/lib/dealReviewIntake.js");

const runId = Date.now();
let districtId = "";
let agentId = "";
let clientId = "";
let propertyId = "";
let dealId = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-рекомендация-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент рекомендации ${runId}`, phone: `+992966${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент рекомендации ${runId}`, phone: `+992967${runId}`, source: "PHONE_CALL", assignedAgentId: agentId, acceptedAt: new Date() },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект рекомендации ${runId}`,
        type: "APARTMENT",
        areaSqm: 55,
        price: 100000,
        currency: "TJS",
        districtId,
        address: "Тестовая, рекомендация",
        condition: "GOOD",
        intakeAgentId: agentId,
      },
    })
  ).id;
  dealId = (await prisma.deal.create({ data: { clientId, propertyId, agentId, stage: "COMPLETED" } })).id;
});

beforeEach(async () => {
  createLeadFromChannel.mockReset();
  recordScoreEvent.mockClear();
  logSystemError.mockClear();
  await prisma.dealReview.deleteMany({ where: { dealId } });
  await createDealReviewAsk({ dealId, clientId, channel: "whatsapp" });
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.dealReview.deleteMany({ where: { dealId } });
  await prisma.deal.deleteMany({ where: { id: dealId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Рекомендация после отзыва: сбой создания лида", () => {
  it("лид не создался: клиенту не обещают связаться, баллы за рекомендацию не начислены, сбой в журнале", async () => {
    createLeadFromChannel.mockRejectedValue(new Error("база моргнула"));

    const result = await tryHandleDealReviewReply(clientId, "5, 900000000");

    expect(result.handled).toBe(true);
    expect(result.reply).not.toContain("свяжемся");
    const kinds = recordScoreEvent.mock.calls.map((c) => (c as unknown as [{ kind: string }])[0].kind);
    expect(kinds).not.toContain("review_referral");
    // Оценка при этом принята и награждена: сбой касается только рекомендации.
    expect(kinds).toContain("review_received");
    const messages = logSystemError.mock.calls.map((c) => String((c as unknown[])[1]));
    expect(messages.some((m) => m.includes("Рекомендация") && m.includes("база моргнула"))).toBe(true);
  });

  it("лид создался: обещание и баллы на месте (обычный путь не сломан)", async () => {
    createLeadFromChannel.mockResolvedValue({});

    const result = await tryHandleDealReviewReply(clientId, "5, 900000000");

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("свяжемся");
    const kinds = recordScoreEvent.mock.calls.map((c) => (c as unknown as [{ kind: string }])[0].kind);
    expect(kinds).toContain("review_referral");
    expect(logSystemError).not.toHaveBeenCalled();
  });
});
