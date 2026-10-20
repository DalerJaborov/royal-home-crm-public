import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

/**
 * ctwa_clid ИЗ WHATSAPP-РЕКЛАМЫ (04.10.2026, слой обучения «Студии запуска рекламы»).
 *
 * Вебхук WhatsApp читал `referral.source_id` и текст объявления, но НЕ идентификатор
 * клика `ctwa_clid` — без него нельзя отдавать события обратно в Meta (Conversions API).
 * Теперь он разбирается и пишется в BotConversation.adClickId ПЕРВЫМ касанием, как
 * adExternalId, и ничего наружу не отправляет: проверяется и сам разбор, и запись, и то,
 * что повтор (тот же referral или другой клик позже) первый идентификатор не затирает.
 */

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { parseIncoming } = await import("../src/messengers/meta.js");
const { processMessengerTurn } = await import("../src/messengers/conversation.js");

const runId = Date.now().toString(36);
const subscriberId = `ctwa-${runId}`;
const noClickSubscriber = `ctwa-none-${runId}`;
const CLID_FIRST = `ARAkLkA8rmlFeiCktEJQ-${runId}-first`;
const CLID_LATER = `ARAkLkA8rmlFeiCktEJQ-${runId}-later`;

let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;
let whatsapp: CustomerMessengerFixture;

beforeAll(async () => {
  whatsapp = await createCustomerMessengerFixture("WHATSAPP");
  settingsBefore = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botReplyDelaySec: 1, botReplyMaxWaitSec: 3 } });
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
  const convs = await prisma.botConversation.findMany({
    where: { endpointScopeId: whatsapp.transport.endpointScopeId, subscriberId: { in: [subscriberId, noClickSubscriber] } },
    select: { id: true, clientId: true },
  });
  for (const conv of convs) {
    if (conv.clientId) {
      await prisma.interaction.deleteMany({ where: { clientId: conv.clientId } });
      await prisma.client.deleteMany({ where: { id: conv.clientId } });
    }
  }
  await whatsapp.dispose();
});

const waBody = (referral: Record<string, unknown> | undefined) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "waba-1",
      changes: [
        {
          field: "messages",
          value: {
            metadata: { display_phone_number: "992000000000", phone_number_id: "pn-1" },
            contacts: [{ wa_id: "992900000001", profile: { name: "Тест" } }],
            messages: [
              {
                from: "992900000001",
                id: "wamid.1",
                type: "text",
                text: { body: "Можно узнать об этом подробнее?" },
                ...(referral ? { referral } : {}),
              },
            ],
          },
        },
      ],
    },
  ],
});

describe("разбор вебхука WhatsApp", () => {
  it("ctwa_clid из referral доезжает как adClickId рядом с adId", () => {
    const [msg] = parseIncoming(
      waBody({ source_id: "238500000001", source_type: "ad", headline: "Продаётся", body: "2 комнаты", ctwa_clid: CLID_FIRST })
    );
    expect(msg.adId).toBe("238500000001");
    expect(msg.adClickId).toBe(CLID_FIRST);
    expect(msg.fromAd).toBe(true);
  });

  it("referral без ctwa_clid и сообщение без referral — adClickId пуст", () => {
    const [noClid] = parseIncoming(waBody({ source_id: "238500000001", source_type: "ad" }));
    expect(noClid.adClickId).toBeUndefined();
    const [organic] = parseIncoming(waBody(undefined));
    expect(organic.adClickId).toBeUndefined();
    expect(organic.fromAd).toBe(false);
  });
});

describe("запись первым касанием", () => {
  it("первый ход сохраняет ctwa_clid, повтор и другой клик его не перезаписывают", async () => {
    callAi.mockResolvedValue({ reply: ["Здравствуйте! По какому вопросу обращаетесь?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });

    await processMessengerTurn({
      ...whatsapp.turnInput(subscriberId),
      text: "Привет! Можно узнать об этом подробнее?",
      adExternalId: `ad-${runId}`,
      adClickId: CLID_FIRST,
    });
    // Запись фоновая (void) — ждём, пока она ляжет.
    await vi.waitFor(async () => {
      const row = await prisma.botConversation.findFirst({ where: { subscriberId }, select: { adClickId: true } });
      expect(row?.adClickId).toBe(CLID_FIRST);
    });

    // Тот же referral ещё раз (повторная доставка) и клик по другому объявлению позже.
    await processMessengerTurn({ ...whatsapp.turnInput(subscriberId), text: "и ещё вопрос", adClickId: CLID_FIRST });
    await processMessengerTurn({ ...whatsapp.turnInput(subscriberId), text: "а это что?", adClickId: CLID_LATER });
    await new Promise((r) => setTimeout(r, 300));

    const rows = await prisma.botConversation.findMany({ where: { subscriberId }, select: { adClickId: true, adExternalId: true } });
    expect(rows).toHaveLength(1);
    // Первое касание: атрибуция отвечает «какая реклама ПРИВЕЛА», а не «какую видел последней».
    expect(rows[0].adClickId).toBe(CLID_FIRST);
    expect(rows[0].adExternalId).toBe(`ad-${runId}`);
  });

  it("без ctwa_clid колонка остаётся пустой, ответ бота идёт как обычно", async () => {
    callAi.mockResolvedValue({ reply: ["Здравствуйте!"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false });
    const result = await processMessengerTurn({
      ...whatsapp.turnInput(noClickSubscriber),
      text: "Привет",
      adExternalId: `ad-none-${runId}`,
    });
    expect(result).toBeTruthy();
    await new Promise((r) => setTimeout(r, 200));
    const row = await prisma.botConversation.findFirst({ where: { subscriberId: noClickSubscriber }, select: { adClickId: true } });
    expect(row?.adClickId).toBeNull();
  });
});
