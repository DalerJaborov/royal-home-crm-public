import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { parseIncoming } from "../src/messengers/meta.js";
import { adReferralPropertyId, looksLikeHousing } from "../src/messengers/sharedMedia.js";
import {
  recentForeignShare,
  rememberAdReferral,
  rememberForeignShare,
  resetMetaPeerMemory,
  takeAdReferral,
} from "../src/messengers/metaPeerMemory.js";
import { detectSpam, sharedPostSpamContext } from "../src/lib/incomingSpam.js";

/**
 * НАША РЕКЛАМА И ЧУЖИЕ РОЛИКИ (переписки владельца 02.10.2026).
 *
 * 1. Клик по объявлению Meta присылает отдельным событием без `message`; разбор его
 *    выбрасывал, и следующее сообщение человека приходило «ниоткуда» — бот не
 *    узнавал нашу же рекламу. Объект теперь ищется по объявлению, номеру
 *    продвигаемого поста и его подписи.
 * 2. Чужой ролик, а следом отдельным сообщением «Лайк» — накрутка, бот отвечать
 *    не должен.
 */

const runId = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
const AD_ID = `2385${String(Date.now()).slice(-9)}${Math.floor(Math.random() * 1e3)}`;
const AD_ID_BY_POST = `${AD_ID}1`;
const POST_ID = `179${String(Date.now()).slice(-10)}${Math.floor(Math.random() * 1e3)}`;
let linkedId = "";
let byPostId = "";
let byFooterId = "";
let byFooterShortId = 0;

async function makeProperty(data: Record<string, unknown> = {}) {
  return prisma.property.create({
    data: {
      title: `Тест-реклама-${runId}`,
      type: "APARTMENT",
      address: "Тестовая, 3",
      condition: "GOOD",
      currency: "TJS",
      areaSqm: 50,
      price: 100_000,
      rooms: 2,
      ...data,
    } as never,
  });
}

beforeAll(async () => {
  linkedId = (await makeProperty()).id;
  byPostId = (await makeProperty({ publishedPostIds: { INSTAGRAM: POST_ID } })).id;
  const footer = await makeProperty();
  byFooterId = footer.id;
  byFooterShortId = footer.shortId;
  await prisma.ad.create({
    data: { platform: "META", externalId: AD_ID, name: `Тест ${runId}`, propertyId: linkedId },
  });
  await prisma.ad.create({
    data: { platform: "META", externalId: AD_ID_BY_POST, name: `Тест пост ${runId}`, mediaId: `1000_${POST_ID}` },
  });
});

afterAll(async () => {
  await prisma.ad.deleteMany({ where: { externalId: { in: [AD_ID, AD_ID_BY_POST] } } });
  await prisma.property.deleteMany({ where: { id: { in: [linkedId, byPostId, byFooterId].filter(Boolean) } } });
});

beforeEach(() => resetMetaPeerMemory());

describe("разбор вебхука: клик по рекламе отдельным событием не теряется", () => {
  const body = (event: Record<string, unknown>) => ({
    object: "instagram",
    entry: [{ id: "page-1", messaging: [{ sender: { id: "user-ad" }, recipient: { id: "ig-1" }, ...event }] }],
  });

  it("referral без message отдаётся наверх с меткой рекламы и данными поста", () => {
    const [msg] = parseIncoming(
      body({
        referral: {
          source: "ADS",
          ad_id: AD_ID,
          ads_context_data: { ad_title: "7 хонага, Объект №12", post_id: POST_ID },
        },
      })
    );
    expect(msg.referralOnly).toBe(true);
    expect(msg.fromAd).toBe(true);
    expect(msg.adId).toBe(AD_ID);
    expect(msg.adPostId).toBe(POST_ID);
    expect(msg.adTitle).toBe("7 хонага, Объект №12");
    expect(msg.text).toBe("");
  });

  it("referral внутри сообщения тоже несёт данные поста", () => {
    const [msg] = parseIncoming(
      body({
        message: { mid: "m-ad", text: "Нархаш чанд?" },
        referral: { source: "ADS", ad_id: AD_ID, ads_context_data: { post_id: POST_ID } },
      })
    );
    expect(msg.referralOnly).toBeFalsy();
    expect(msg.fromAd).toBe(true);
    expect(msg.adPostId).toBe(POST_ID);
  });
});

describe("память о собеседнике между событиями", () => {
  it("метка рекламы забирается один раз", () => {
    rememberAdReferral("INSTAGRAM", "u1", { adId: AD_ID });
    expect(takeAdReferral("INSTAGRAM", "u1")?.adId).toBe(AD_ID);
    expect(takeAdReferral("INSTAGRAM", "u1")).toBeNull();
  });

  it("метка рекламы протухает через полчаса и не путает собеседников", () => {
    const t = Date.now();
    rememberAdReferral("INSTAGRAM", "u1", { adId: AD_ID }, t);
    expect(takeAdReferral("INSTAGRAM", "u2", t + 1000)).toBeNull();
    expect(takeAdReferral("INSTAGRAM", "u1", t + 31 * 60 * 1000)).toBeNull();
  });

  it("чужой ролик помнится десять минут", () => {
    const t = Date.now();
    rememberForeignShare("INSTAGRAM", "u1", t);
    expect(recentForeignShare("INSTAGRAM", "u1", t + 60_000)).toBe(true);
    expect(recentForeignShare("FACEBOOK", "u1", t + 60_000)).toBe(false);
    expect(recentForeignShare("INSTAGRAM", "u1", t + 11 * 60_000)).toBe(false);
  });
});

describe("adReferralPropertyId: объект по нашей рекламе", () => {
  it("объявление привязано к объекту — берётся он", async () => {
    expect(await adReferralPropertyId({ adId: AD_ID })).toBe(linkedId);
  });

  it("объявление не привязано, но продвигает наш пост — объект по номеру поста", async () => {
    expect(await adReferralPropertyId({ adId: AD_ID_BY_POST })).toBe(byPostId);
  });

  it("объявления в базе нет — по номеру поста из клика", async () => {
    expect(await adReferralPropertyId({ adId: "999000111", adPostId: `555_${POST_ID}` })).toBe(byPostId);
  });

  it("по подписи «Объект №N»", async () => {
    expect(await adReferralPropertyId({ adTitle: `Хонаи 3 ҳуҷрагӣ\nОбъект №${byFooterShortId}` })).toBe(byFooterId);
  });

  it("номер, набранный руками по-разному: «Объекти № N», «обьект #N», «Объект N»", async () => {
    for (const t of [`Объекти № ${byFooterShortId}`, `обьект #${byFooterShortId}`, `Объект ${byFooterShortId}, агент Умед`]) {
      expect(await adReferralPropertyId({ adTitle: t })).toBe(byFooterId);
    }
  });

  it("номер в названии объявления («#N») — тоже объект", async () => {
    const ext = `${AD_ID}9`;
    await prisma.ad.create({ data: { platform: "META", externalId: ext, name: `Реклама #${byFooterShortId} Умед` } });
    try {
      expect(await adReferralPropertyId({ adId: ext })).toBe(byFooterId);
    } finally {
      await prisma.ad.deleteMany({ where: { externalId: ext } });
    }
  });

  it("ничего не известно — null, без догадок", async () => {
    expect(await adReferralPropertyId({ adId: "999000222" })).toBeNull();
    expect(await adReferralPropertyId({})).toBeNull();
  });
});

describe("чужой ролик: похож ли он на жильё", () => {
  it("подпись про квартиру — похоже, бот ответит", () => {
    expect(looksLikeHousing("Фурӯхта мешавад хонаи 3 ҳуҷрагӣ, 85 м²")).toBe(true);
    expect(looksLikeHousing("Продаётся квартира в Сино, 450 000 сомони")).toBe(true);
  });

  it("игра, дети, музыка или пустая подпись — не жильё, бот молчит", () => {
    expect(looksLikeHousing("😂😂 смотри до конца")).toBe(false);
    expect(looksLikeHousing("Free Fire best moments")).toBe(false);
    expect(looksLikeHousing("")).toBe(false);
    expect(looksLikeHousing(undefined)).toBe(false);
  });
});

describe("накрутка двумя сообщениями: чужой ролик, а следом «Лайк»", () => {
  it("«Лайк» сразу после чужого ролика — спам", () => {
    // Вебхук ставит sharedPost: true, если чужой ролик был недавно (recentForeignShare).
    const ctx = sharedPostSpamContext({ sharedPost: true, ownMedia: false, adProperty: false, vacancyPost: false });
    expect(detectSpam("Лайк", ctx)).not.toBeNull();
  });

  it("«Лайк» без ролика перед ним — не спам", () => {
    const ctx = sharedPostSpamContext({ sharedPost: false, ownMedia: false, adProperty: false, vacancyPost: false });
    expect(detectSpam("Лайк", ctx)).toBeNull();
  });

  it("наш ролик с рекламы, затем «лайк» — не спам", () => {
    const ctx = sharedPostSpamContext({ sharedPost: true, ownMedia: false, adProperty: true, vacancyPost: false });
    expect(detectSpam("лайк", ctx)).toBeNull();
  });
});
