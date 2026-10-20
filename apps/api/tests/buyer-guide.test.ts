import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { handleOutgoingEcho } from "../src/routes/webhooks.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * ГИД ПОКУПАТЕЛЯ (buyerGuide.ts) ДУБЛИРОВАЛСЯ ТЕМ ЖЕ СПОСОБОМ, ЧТО ВОРОНКА
 * ЛИД-МАГНИТА (17-18.08.2026, см. память royalhome-funnel-double-send-echo-mid-17-08).
 *
 * sendBuyerGuide() отправлял файл и подпись через Meta, но не сохранял их mid
 * в переписке. Эхо каждого исходящего сообщения, которое присылает сама Meta,
 * не находило своего mid и записывалось ВТОРОЙ раз, как будто ответил
 * сотрудник вручную — плюс бот вставал на паузу.
 *
 * Второй слой той же дыры: даже когда mid стали ловить (fileMid/captionMid),
 * его проставляли через stampOutgoingMid ДО appendConversationMessages — а
 * stampOutgoingMid метит ПОСЛЕДНЮЮ реплику уже ЗАПИСАННОЙ истории, то есть
 * реплику ПРЕДЫДУЩЕГО хода, не ту, что добавляется сейчас. Правильный путь —
 * нести mid прямо в объекте реплики (тот же приём, что в leadMagnet.ts).
 */

const runId = Date.now().toString(36);
const SUBSCRIBER = `guide-${runId}`;

let campaignId = "";
let instagram: CustomerMessengerFixture;
beforeAll(async () => { instagram = await createCustomerMessengerFixture("INSTAGRAM"); });
const savedPublicUrl = process.env.CRM_PUBLIC_URL;

vi.mock("../src/messengers/meta.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/messengers/meta.js")>();
  return {
    ...actual,
    sendFile: vi.fn(async () => "mid-file-1"),
    sendMessage: vi.fn(async () => "mid-caption-1"),
    fetchInstagramProfile: vi.fn(async () => ({ isUserFollowBusiness: true })),
  };
});

const { sendBuyerGuide, guideMessages } = await import("../src/lib/buyerGuide.js");
const { appendConversationMessages } = await import("../src/messengers/conversation.js");

async function makeConversation(): Promise<string> {
  const native = await instagram.ensureConversation(SUBSCRIBER);
  const conv = await prisma.botConversation.update({
    where: { id: native.id },
    data: {
      messages: [] as never,
      leadDraft: { stage: "chatting" } as never,
    },
  });
  return conv.id;
}

beforeEach(async () => {
  process.env.CRM_PUBLIC_URL = "https://crm.test";
  await instagram.cleanupConversations();
  if (campaignId) await prisma.leadMagnetCampaign.deleteMany({ where: { id: campaignId } });
  const campaign = await prisma.leadMagnetCampaign.create({
    data: {
      name: `guide-test-${runId}`,
      keywords: [`guide${runId}`],
      inviteText: "invite",
      deliveredText: "delivered",
      followText: "follow",
      notFollowingText: "not following",
      requireFollow: true,
      deliverIfUnsure: true,
      filePath: "/uploads/guides/test.pdf",
      fileName: "Гид покупателя.pdf",
      enabled: true,
    } as never,
  });
  campaignId = campaign.id;
});

afterAll(async () => {
  if (savedPublicUrl === undefined) delete process.env.CRM_PUBLIC_URL;
  else process.env.CRM_PUBLIC_URL = savedPublicUrl;
  await instagram.dispose();
  await prisma.leadMagnetCampaign.deleteMany({ where: { id: campaignId } });
});

describe("Гид покупателя не дублируется эхом", () => {
  it("каждая реплика гида несёт mid отправленного сообщения Meta", async () => {
    const conversationId = await makeConversation();

    const result = await sendBuyerGuide({
      wanted: true,
      conversationId,
      channel: "INSTAGRAM",
      recipientId: SUBSCRIBER,
      alreadySent: false,
      awaitingFollowSince: null,
      language: "ru",
      token: instagram.token,
    });

    expect(result.sent).toBe(true);
    const messages = guideMessages(result);
    // Обе реплики (подпись и пометка о файле) обязаны нести свой mid — без него
    // эхо от Meta не отличить от ручного ответа сотрудника.
    expect(messages.every((m) => typeof m.mid === "string" && m.mid.length > 0)).toBe(true);

    await appendConversationMessages(conversationId, messages);

    for (const m of messages) {
      await handleOutgoingEcho({
        channel: "INSTAGRAM",
        accountExternalId: instagram.externalId,
        senderId: SUBSCRIBER,
        text: m.content,
        messageId: m.mid,
      });
    }

    const conv = await prisma.botConversation.findUnique({
      where: { id: conversationId },
      select: { messages: true, pausedUntil: true },
    });
    const stored = (conv?.messages as unknown[]) ?? [];
    // Эхо своих же сообщений не должно ничего дописать и не должно поставить бота на паузу.
    expect(stored).toHaveLength(messages.length);
    expect(conv?.pausedUntil).toBeNull();
  });
});
