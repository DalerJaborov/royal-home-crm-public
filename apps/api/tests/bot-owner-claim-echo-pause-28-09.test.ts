import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { prisma } from "../src/db.js";
import { clientStatedDirection, guardOwnerAsThirdParty, OWNER_ACK, OWNER_CLAIM } from "../src/ai/intentDirectionGuard.js";
import { keepOnePhoneAsk } from "../src/ai/replyRepeatGuard.js";
import { isOperatorPauseActive, isStalePause } from "../src/lib/conversationState.js";
import { OPERATOR_ECHO_PAUSE_MS } from "../src/lib/conversationDelivery.js";
import { handleOutgoingEcho } from "../src/routes/webhooks.js";
import { findStuckConversations } from "../src/lib/stuckConversations.js";
import { filterBotReply } from "../src/messengers/replyChain.js";

/**
 * Скриншот владельца 28.09.2026 (Facebook, #Elmurodovich): человек дважды написал
 * «Ман сохибхона», бот отвечал ему как покупателю («торг с собственником после
 * показа»), просил номер двумя пузырями подряд и продолжал писать, когда директор
 * уже отвечал из приложения. Файл стережёт все четыре правки того дня.
 */

const runId = Date.now().toString(36);
let facebook: CustomerMessengerFixture;
beforeAll(async () => { facebook = await createCustomerMessengerFixture("FACEBOOK"); });
const convIds: string[] = [];
const clientIds: string[] = [];

afterAll(async () => {
  await facebook?.dispose();
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
});

describe("собственник о себе — это продавец, во всех написаниях", () => {
  const owner = [
    "Ман сохибхона))",
    "Ман сохибхона, мегум дар эълон нархаша арзотар монем",
    "Ман соҳиби хона",
    "Соҳиби хона манам",
    "ман худам соҳибаш",
    "сохибаш ман",
    "Ман соиби хона",
    "ман сахиби хона",
    "man sohibi xona",
    "Man soxibxona",
    "Я собственник",
    "я собствиник",
    "я сабственица",
    "Я хозяйка",
    "я сама хозяйка",
    "Хозяин это я",
    "собственник - я",
    "Я владелица",
    "ya sobstvennik",
    "Это моя квартира",
    "квартира моя",
    "хонаи худам",
    "хонаамро арзонтар монед",
    "Продаю сам, без посредников",
    "мулкдор манам",
  ];
  it.each(owner)("«%s» — хозяин о себе", (text) => {
    expect(OWNER_CLAIM.test(text)).toBe(true);
    expect(clientStatedDirection(text)).toBe("sell");
  });

  const notOwner = [
    "рақами соҳиби хонаро диҳед",
    "номер хозяина дайте",
    "собственник согласен на торг?",
    "владелец квартиры кто?",
    "хозяин торгуется?",
    "Хона мехарам",
    "мне нужна квартира",
  ];
  it.each(notOwner)("«%s» — покупатель спрашивает о хозяине, не сигнал", (text) => {
    expect(OWNER_CLAIM.test(text)).toBe(false);
  });

  it("собственнику не говорят «торг с собственником» — одна фраза «передам агенту объекта»", () => {
    const out = guardOwnerAsThirdParty({
      bubbles: [
        "Савдо аслан баъди хонаро дидан бо соҳиби хона карда мешавад",
        "Рақаматонро нависед, агенти мо занг зада, ҳамаашро бо соҳиби хона мебинад",
      ],
      clientText: "Ман сохибхона))",
      language: "tg",
    });
    expect(out).toEqual([OWNER_ACK.tg]);
  });

  it("покупателю тот же ответ не трогается", () => {
    const bubbles = ["Торг есть, обсуждаем с собственником после показа"];
    expect(guardOwnerAsThirdParty({ bubbles, clientText: "Хочу купить", language: "ru" })).toEqual(bubbles);
  });
});

describe("одна просьба номера на ответ", () => {
  it("две просьбы разными словами — остаётся первая", () => {
    expect(
      keepOnePhoneAsk(["Рақаматонро гузоред, агенти мо занг мезанад", "Рақаматонро нависед, агенти мо занг зада"])
    ).toEqual(["Рақаматонро гузоред, агенти мо занг мезанад"]);
  });
  it("одна просьба рядом с ответом по делу — ничего не убираем", () => {
    const b = ["Нарх 500 ҳазор", "Рақаматонро нависед"];
    expect(keepOnePhoneAsk(b)).toEqual(b);
  });
  it("просьба ДОПОЛНИТЕЛЬНОГО номера не считается повтором", () => {
    const b = ["Оставьте номер, пожалуйста", "Есть ещё другой номер? Напишите"];
    expect(keepOnePhoneAsk(b)).toEqual(b);
  });
});

describe("ответ директора из приложения останавливает бота надолго", () => {
  it("эхо ставит паузу на 12 часов, а не на 10 минут", async () => {
    const conv = await prisma.botConversation.create({
      data: { channel: "FACEBOOK", accountId: facebook.id, endpointScopeId: facebook.transport.endpointScopeId,
        subscriberId: `echo12-${runId}`, messages: [{ role: "user", content: "Ман сохибхона" }] },
    });
    convIds.push(conv.id);
    await handleOutgoingEcho({ channel: "FACEBOOK", accountExternalId: facebook.externalId,
      senderId: conv.subscriberId, text: "Хоб пагоҳ агенте…", messageId: `mid-dir-${runId}` });
    const saved = await prisma.botConversation.findUnique({ where: { id: conv.id }, select: { pausedUntil: true } });
    expect(saved!.pausedUntil!.getTime() - Date.now()).toBeGreaterThan(OPERATOR_ECHO_PAUSE_MS - 60_000);
  });

  it("свежую паузу не снимает статус карточки «потерян»", async () => {
    const client = await prisma.client.create({
      data: { fullName: `Эхо ${runId}`, phone: `+99290${String(Date.now()).slice(-7)}`, status: "LOST", source: "INSTAGRAM" } as never,
    });
    clientIds.push(client.id);
    const pausedUntil = new Date(Date.now() + OPERATOR_ECHO_PAUSE_MS);
    expect(isStalePause(pausedUntil, new Date())).toBe(false);
    expect(await isOperatorPauseActive(pausedUntil, new Date(), client.id)).toBe(true);
    // Пауза, поставленная двое суток назад и почти истёкшая, снимается по-старому.
    expect(isStalePause(new Date(Date.now() + 60_000), new Date(Date.now() - 2 * 24 * 3600_000))).toBe(true);
  });
});

describe("повтор «зависших» не догоняет живой ход", () => {
  it("реплика клиента минутной давности — не «зависла»", async () => {
    const conv = await prisma.botConversation.create({
      data: {
        channel: "FACEBOOK",
        accountId: facebook.id,
        endpointScopeId: facebook.transport.endpointScopeId,
        subscriberId: `inflight-${runId}`,
        lastMessageAt: new Date(),
        messages: [{ role: "user", content: "Ман сохибхона", at: new Date().toISOString() }],
      },
    });
    convIds.push(conv.id);
    const stuck = await findStuckConversations();
    expect(stuck.some((r) => r.id === conv.id)).toBe(false);
  });
});

describe("общая цепочка ответа (replyChain) применяет обе защиты — на всех каналах", () => {
  const base = {
    conversationId: "chain-test",
    channelLabel: "FACEBOOK",
    openUrl: "/messages",
    botSpokeBefore: true,
    botSaidBefore: [] as string[],
    clientSaidTrusted: "Ман сохибхона))",
    clientTurnText: "Ман сохибхона))",
    previousBotText: "",
    language: "tg" as const,
    draft: { intent: "sell" as const, stage: "intake" as const },
    jobConversation: false,
    phoneAsksSent: 0,
    phoneKnown: true,
    fallbackLanguageWords: ["Ман сохибхона))"],
  };

  it("собственнику не говорят «торг с собственником»", () => {
    const r = filterBotReply({ ...base, reply: ["Савдо аслан баъди хонаро дидан бо соҳиби хона карда мешавад."] });
    expect(r.bubbles.join(" ")).toContain(OWNER_ACK.tg);
  });

  it("две просьбы номера разными словами — остаётся одна", () => {
    const r = filterBotReply({
      ...base,
      clientSaidTrusted: "Салом, хона мехоҳам",
      clientTurnText: "Салом, хона мехоҳам",
      draft: { intent: "buy" as const, stage: "intake" as const },
      phoneKnown: false,
      reply: ["Рақаматонро гузоред, агенти мо занг мезанад", "Рақаматонро нависед, барои пурсиш"],
    });
    expect(r.bubbles.filter((b) => /Рақаматонро/.test(b))).toHaveLength(1);
  });
});
