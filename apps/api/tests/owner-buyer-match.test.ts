import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formatClientCode } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { parseListingFacts } from "../src/lib/listingAd.js";
import {
  describeBuyerMatch,
  matchBuyersForListing,
  noteOwnerCommentOrigin,
  OWNER_NOTE_PREFIX,
} from "../src/lib/ownerBuyerMatch.js";
import { ownerDmText } from "../src/messengers/comments.js";
import { processMessengerTurn } from "../src/messengers/conversation.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { drainBackgroundTasks } from "../src/lib/shutdownState.js";

const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

/**
 * Покупатели под объявление собственника (владелец 24.09.2026, 18:44):
 * «проверь наших покупателей, кто ищет именно такую квартиру в этом районе, и
 * скажи, что есть один-два заинтересованных. Данные покупателя не даёшь никогда.
 * Агенту в карточке — что он комментировал наш пост, бот с ним поговорил, он
 * согласился, и подходящих клиентов».
 */

const runId = Date.now();
const LISTING = "Продаю квартиру в Сино, 58 кв.м, 15/19 этаж, цена 580 тысяч сомони, 980001010";
let districtId: string;
let buyerId: string;
let buyerCode: string;
let sellerId: string;
let instagram: CustomerMessengerFixture;
const commentIds: string[] = [];

beforeAll(async () => {
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  districtId = (await prisma.district.upsert({ where: { name: "Сино" }, update: {}, create: { name: "Сино" } })).id;
  const buyer = await prisma.client.create({
    data: {
      fullName: `Покупатель Сино ${runId}`,
      phone: `+99290${String(runId).slice(-7)}`,
      status: "NEW",
      kind: "BUYER",
      source: "WEBSITE",
      desiredDistrictId: districtId,
      budgetMax: 600000,
      currency: "TJS",
    } as never,
  });
  buyerId = buyer.id;
  buyerCode = formatClientCode(buyer.shortId, "BUYER");
  sellerId = (
    await prisma.client.create({
      data: {
        fullName: `Собственник ${runId}`,
        phone: `+99291${String(runId).slice(-7)}`,
        status: "NEW",
        kind: "SELLER",
        source: "INSTAGRAM",
      } as never,
    })
  ).id;
});

afterAll(async () => {
  await drainBackgroundTasks(2000);
  await prisma.instagramComment.deleteMany({ where: { commentId: { in: commentIds } } });
  const fromChat = await prisma.botConversation.findMany({
    where: { subscriberId: { startsWith: `ig-owner-chat-${runId}` } },
    select: { clientId: true },
  });
  const ids = [buyerId, sellerId, ...fromChat.map((c) => c.clientId).filter((id): id is string => !!id)];
  await prisma.interaction.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.client.deleteMany({ where: { id: { in: ids } } });
  await instagram.dispose();
});

describe("parseListingFacts — цифры из объявления", () => {
  it("таджикское объявление saf8308: 580 хазор, 58 квадрат, 15 из 19", () => {
    expect(
      parseListingFacts("Хона 58квадрат мебощад. да 15 этаж доми 19 этажа. Нарх 580. Хазор сомон номер 980001010")
    ).toMatchObject({ price: 580000, currency: "TJS", areaSqm: 58, floor: 15, totalFloors: 19 });
  });

  it("миллионы и доллары", () => {
    expect(parseListingFacts("5/9 этаж 85 кв.м цена 1,2 млн")).toMatchObject({ price: 1200000, floor: 5, totalFloors: 9 });
    expect(parseListingFacts("3 комнатная, 90 000 $").currency).toBe("USD");
  });
});

describe("matchBuyersForListing — только когда есть что сравнивать", () => {
  it("цена и район есть — ждущий покупатель из этого района находится", async () => {
    const match = await matchBuyersForListing(LISTING);
    expect(match.total).toBeGreaterThanOrEqual(1);
    expect(match.where).toBe("Сино");
  });

  it("без цены, без места и в аренду — никого, чтобы не наобещать полбазы", async () => {
    expect((await matchBuyersForListing("Продаю квартиру в Сино, 58 кв.м, 980001010")).total).toBe(0);
    expect((await matchBuyersForListing("Продаю квартиру 58 кв.м, цена 580 тысяч, 980001010")).total).toBe(0);
    expect((await matchBuyersForListing("Сдаётся квартира в Сино, 580 в месяц, 980001010")).total).toBe(0);
  });

  it("строка агенту — номера карточек, без имён и телефонов", () => {
    const line = describeBuyerMatch({ total: 7, codes: ["ПК-000001", "ПК-000002"], where: "Сино" });
    expect(line).toContain("7");
    expect(line).toContain("ПК-000001, ПК-000002 и другие");
    expect(describeBuyerMatch({ total: 0, codes: [], where: null })).toContain("нет");
  });
});

describe("письмо собственнику — число покупателей словами, ничего о них", () => {
  it("нет покупателей — строки о них нет вовсе", () => {
    expect(ownerDmText(false, 0)).not.toContain("Сейчас в нашей базе");
    expect(ownerDmText(true, 0)).not.toContain("харидор ҳаст");
  });

  it("один, два, несколько — сразу после приветствия и с предложением звонка агента", () => {
    const one = ownerDmText(false, 1);
    expect(one).toContain("есть покупатель, который ищет");
    expect(one.indexOf("покупатель")).toBeLessThan(one.indexOf("профессионально снимем"));
    expect(ownerDmText(false, 2)).toContain("два покупателя");
    expect(ownerDmText(false, 9)).toContain("несколько покупателей");
    expect(ownerDmText(false, 9)).not.toContain("9");
    expect(ownerDmText(true, 2)).toContain("ду харидор");
    expect(ownerDmText(false, 2)).toContain("наш агент позвонит");
  });
});

describe("карточка собственника — откуда пришёл и кто подходит", () => {
  async function ownerComment(authorId: string, note: string) {
    const commentId = `owner-origin-${runId}-${commentIds.length}`;
    commentIds.push(commentId);
    await prisma.instagramComment.create({
      data: {
        channel: "INSTAGRAM",
        accountExternalId: instagram.externalId,
        commentId,
        mediaId: `m-${runId}`,
        authorId,
        text: LISTING,
        replyDueAt: new Date(),
        status: "HIDDEN",
        note,
        dmSentAt: new Date(),
      },
    });
  }

  it("бот писал ему как собственнику — в хронологии комментарий, согласие и номера подходящих покупателей", async () => {
    const authorId = `ig-owner-${runId}`;
    await ownerComment(authorId, `${OWNER_NOTE_PREFIX}объявление: цена, номер; написали в личку`);

    await noteOwnerCommentOrigin(sellerId, "INSTAGRAM", authorId);

    const notes = (await prisma.interaction.findMany({ where: { clientId: sellerId, type: "SYSTEM" } })).map((i) => i.notes).join("\n");
    expect(notes).toContain("из комментария под нашим постом в Instagram");
    expect(notes).toContain("58 кв.м");
    expect(notes).toContain("оставил номер");
    expect(notes).toContain("Подходящие покупатели в базе");
    expect(notes).toContain(buyerCode);
  });

  it("собственник оставил номер в личке — заявка из переписки сама получает эту запись", async () => {
    const authorId = `ig-owner-chat-${runId}`;
    await ownerComment(authorId, `${OWNER_NOTE_PREFIX}объявление: цена, номер; написали в личку`);
    callAi.mockResolvedValue({ reply: "Раҳмат! Агенти мо занг мезанад." });

    const result = await processMessengerTurn({
      ...instagram.turnInput(authorId),
      text: `92${String(runId).slice(-7)}`,
    });
    expect(result.accepted).toBe(true);

    const convo = await prisma.botConversation.findFirst({ where: { channel: "INSTAGRAM", subscriberId: authorId } });
    expect(convo?.clientId).toBeTruthy();
    const notes = (await prisma.interaction.findMany({ where: { clientId: convo!.clientId!, type: "SYSTEM" } }))
      .map((i) => i.notes)
      .join("\n");
    expect(notes).toContain("из комментария под нашим постом в Instagram");
    expect(notes).toContain(buyerCode);
  });

  it("другой человек или не собственник — ничего не пишется", async () => {
    const before = await prisma.interaction.count({ where: { clientId: sellerId } });
    await ownerComment(`ig-spam-${runId}`, "спам: ссылка");
    await noteOwnerCommentOrigin(sellerId, "INSTAGRAM", `ig-spam-${runId}`);
    await noteOwnerCommentOrigin(sellerId, "INSTAGRAM", `ig-nobody-${runId}`);
    await noteOwnerCommentOrigin(sellerId, "WHATSAPP", `ig-owner-${runId}`);
    expect(await prisma.interaction.count({ where: { clientId: sellerId } })).toBe(before);
  });
});
