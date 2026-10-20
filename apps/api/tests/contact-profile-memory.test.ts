import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseContactFacts } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { contactProfileForPrompt, rememberContactTurn } from "../src/lib/contactProfileMemory.js";
import { identitiesForMessengerChannel, resolveContactProfile } from "../src/lib/contactProfiles.js";
import type { LeadDraft } from "../src/ai/leadQualifier.js";

/**
 * ПАМЯТЬ БОТА О ЧЕЛОВЕКЕ — что уходит в досье после хода и что возвращается в промт.
 *
 * Проверяется ровно то, из-за чего это написано (владелец 21.09.2026: «карточка —
 * основа, чтобы бот никогда не путался»), и то, чем это легче всего испортить:
 *
 *  1. бюджет и район из черновика доживают до СЛЕДУЮЩЕГО разговора;
 *  2. диалоговое состояние (`stage`, `pendingShowing`) в память человека НЕ
 *     попадает — иначе новый разговор начинался бы с середины прошлого;
 *  3. то, что уже стоит в черновике текущего разговора, в блок не дублируется;
 *  4. «модель не уверена» роль не заучивает;
 *  5. пустое досье даёт null, а не блок «мы тебя знаем».
 *
 * Идентификаторы — из одной полосы фиксированной длины, с уборкой за собой
 * (известная ловушка этого репозитория: иначе они сталкиваются между файлами и
 * на повторе прогона).
 */

const digits6 = String(Date.now()).slice(-6);
const WA_ID = `992917${digits6.slice(0, 3)}`;
const WA_ID2 = `992918${digits6.slice(0, 3)}`;
const CONV = `conv-memory-${digits6}`;

const created: string[] = [];

async function cleanup(): Promise<void> {
  const ids = new Set(created);
  const rows = await prisma.contactIdentity.findMany({
    where: { value: { in: [WA_ID, WA_ID2] } },
    select: { profileId: true },
  });
  for (const row of rows) ids.add(row.profileId);
  const list = [...ids];
  if (list.length === 0) return;
  await prisma.contactIdentity.deleteMany({ where: { profileId: { in: list } } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: list } } });
}

beforeAll(cleanup);
afterAll(cleanup);

async function profileFor(waId: string): Promise<string> {
  const resolved = await resolveContactProfile({ identities: identitiesForMessengerChannel("WHATSAPP", waId) });
  expect(resolved).not.toBeNull();
  created.push(resolved!.profileId);
  return resolved!.profileId;
}

describe("память бота о человеке", () => {
  it("бюджет и район из черновика доживают до следующего разговора, а состояние диалога — нет", async () => {
    const profileId = await profileFor(WA_ID);
    const draft: LeadDraft = {
      stage: "awaiting_phone",
      intent: "buy",
      budgetMax: 480000,
      districtName: "Сино",
      rooms: 2,
      pendingShowing: { at: new Date().toISOString() } as never,
    };
    await rememberContactTurn({ profileId, conversationId: CONV, draft, selfName: "Далер" });

    const row = await prisma.contactProfile.findUnique({ where: { id: profileId }, select: { facts: true } });
    const facts = parseContactFacts(row!.facts);
    expect(facts.buyer.budgetMax?.v).toBe(480000);
    expect(facts.buyer.districtName?.v).toBe("Сино");
    expect(facts.buyer.rooms?.v).toBe(2);
    // Диалоговое состояние в памяти ЧЕЛОВЕКА не живёт.
    expect(facts.buyer.stage).toBeUndefined();
    expect(facts.buyer.pendingShowing).toBeUndefined();

    // Новый разговор: черновик пустой — значит всё известное печатается из досье.
    const forPrompt = await contactProfileForPrompt(profileId, { stage: "chatting" });
    expect(forPrompt).not.toBeNull();
    expect(forPrompt!.category).toBe("BUYER");
    expect(forPrompt!.selfName).toBe("Далер");
    expect(forPrompt!.buyer.join(" ")).toContain("480000");
    expect(forPrompt!.buyer.join(" ")).toContain("Сино");
  });

  it("то, что уже стоит в черновике этого разговора, в досье-блок не дублируется", async () => {
    const profileId = await profileFor(WA_ID);
    await rememberContactTurn({
      profileId,
      conversationId: CONV,
      draft: { stage: "chatting", intent: "buy", budgetMax: 480000, districtName: "Сино" },
    });
    const forPrompt = await contactProfileForPrompt(profileId, {
      stage: "chatting",
      budgetMax: 480000,
      districtName: "Сино",
    });
    expect(forPrompt).not.toBeNull();
    expect(forPrompt!.buyer.join(" ")).not.toContain("480000");
    expect(forPrompt!.buyer.join(" ")).not.toContain("Сино");
  });

  it("«модель не уверена» роль не заучивает", async () => {
    const profileId = await profileFor(WA_ID2);
    await rememberContactTurn({
      profileId,
      conversationId: CONV,
      draft: { stage: "chatting", intent: "sell", confident: false },
    });
    const row = await prisma.contactProfile.findUnique({ where: { id: profileId }, select: { category: true } });
    expect(row!.category).toBe("UNKNOWN");
  });

  it("неуверенный ход не перетирает намерение, записанное уверенным (AI-DIALOGUE02)", async () => {
    const profileId = await profileFor(WA_ID2);
    await rememberContactTurn({
      profileId,
      conversationId: CONV,
      draft: { stage: "chatting", intent: "buy", budgetMax: 300000, confident: true },
    });
    // Неуверенная реплика: намерение иное, а бюджет и район человек назвал по-настоящему.
    await rememberContactTurn({
      profileId,
      conversationId: CONV,
      draft: { stage: "chatting", intent: "rent", districtName: "Фирдавси", confident: false },
    });
    const row = await prisma.contactProfile.findUnique({ where: { id: profileId }, select: { facts: true, category: true } });
    const facts = parseContactFacts(row!.facts);
    expect(row!.category).toBe("BUYER");
    expect(facts.buyer.intent?.v).toBe("buy");
    // Остальные факты неуверенный ход пишет как прежде.
    expect(facts.buyer.districtName?.v).toBe("Фирдавси");

    // Уверенный ход с тем же «rent» намерение и категорию обновляет.
    await rememberContactTurn({
      profileId,
      conversationId: CONV,
      draft: { stage: "chatting", intent: "rent", confident: true },
    });
    const after = await prisma.contactProfile.findUnique({ where: { id: profileId }, select: { facts: true } });
    expect(parseContactFacts(after!.facts).buyer.intent?.v).toBe("rent");
    await prisma.contactProfile.update({ where: { id: profileId }, data: { facts: {}, category: "UNKNOWN" } });
  });

  it("названное продавцом про объект запоминается как счёт кода, а не как слова модели", async () => {
    const profileId = await profileFor(WA_ID2);
    await rememberContactTurn({
      profileId,
      conversationId: CONV,
      draft: { stage: "chatting", intent: "sell" },
      sellerFacts: { area: true, floor: true },
    });
    const row = await prisma.contactProfile.findUnique({ where: { id: profileId }, select: { facts: true } });
    const facts = parseContactFacts(row!.facts);
    expect(facts.seller.area?.v).toBe(true);
    expect(facts.seller.area?.src).toBe("guard");

    const forPrompt = await contactProfileForPrompt(profileId, { stage: "chatting" });
    expect(forPrompt!.seller.join(" ")).toContain("площадь");
  });

  it("пустое досье даёт null — блока «мы тебя знаем» на первом сообщении не будет", async () => {
    const profileId = await profileFor(WA_ID2);
    await prisma.contactProfile.update({
      where: { id: profileId },
      data: { facts: {}, category: "UNKNOWN", language: null, displayName: null, nameSource: null, messagesIn: 0 },
    });
    expect(await contactProfileForPrompt(profileId, { stage: "chatting" })).toBeNull();
  });

  it("без досье (старый диалог до карточек) чтение молча даёт null, а не падает", async () => {
    expect(await contactProfileForPrompt(null, { stage: "chatting" })).toBeNull();
    expect(await contactProfileForPrompt("нет-такого-досье", { stage: "chatting" })).toBeNull();
  });
});
