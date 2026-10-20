import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { parseIncoming } from "../src/messengers/meta.js";
import { instagramShortcode, sharedMediaHint, sharedPostContext } from "../src/messengers/sharedMedia.js";
import {
  captionFooterShortId,
  isMetaCdnUrl,
  matchPropertyByFacts,
  parsePropertyFacts,
} from "../src/messengers/sharedPostCard.js";
import { sharedPostSpamContext } from "../src/lib/incomingSpam.js";
import { guardOffTopic } from "../src/ai/offTopicGuard.js";
import { createTestAgent } from "./helpers/ownAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { waitFor } from "./helpers/waitFor.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * НАШ ПЕРЕСЛАННЫЙ ПОСТ БОТ УЗНАЁТ, ДАЖЕ КОГДА META НЕ ДАЛА ЕГО АДРЕС (02.10.2026).
 *
 * Жалоба владельца: клиент переслал в директ наш же пост «7 хонага, 1 221 000 TJS,
 * 163,2 м²», а бот ответил «Ин видео дар ман кушода нашуд». Meta прислала вместо
 * адреса поста ссылку на свой CDN, а номер публикации и подпись, лежавшие рядом,
 * мы выбрасывали. Плюс готовая фраза «видео не открылось» срабатывала на голый
 * пересланный пост, даже когда объект по базе был узнан.
 */

const runId = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
const CDN = `https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=${runId}&signature=x`;
/** Своя цена на прогон: база общая, и одинаковая цена у чужого теста дала бы два совпадения. */
const PRICE = 1_000_000 + (Math.floor(Math.random() * 800) + 100) * 1000;
const AREA = 163.2;
const MEDIA_ID = `179${String(Date.now()).slice(-10)}${Math.floor(Math.random() * 1e3)}`;
const CAPTION =
  `🏢 Просторная резиденция ${runId} для большой семьи\n\n7 хонага, ${AREA} м², 3 ошёна, Исмоили Сомони.\n` +
  `💰 Нарх: ${PRICE.toLocaleString("ru-RU")} сомонӣ`;

let agentId = "";
let ownerId = "";
let reelId = "";
let reelShortId = 0;
let twinA = "";
let twinB = "";
let soldId = "";
let photoPostPropertyId = "";
const PHOTO_CODE = `RHph${runId}`;
const PHOTO_MEDIA_ID = `178${String(Date.now()).slice(-10)}7`;
const FB_VIDEO_ID = `9${String(Date.now()).slice(-10)}5`;
let fbPropertyId = "";
let instagram: CustomerMessengerFixture;

async function makeProperty(data: Record<string, unknown>) {
  return prisma.property.create({
    data: {
      title: `Тест-пересланный-пост-${runId}`,
      type: "APARTMENT",
      address: "Тестовая, 1",
      condition: "GOOD",
      currency: "TJS",
      ...data,
    } as never,
  });
}

beforeAll(async () => {
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  agentId = await createTestAgent("Агент пересланного поста");
  ownerId = await createTestAgent("Хозяин без приёма");
  const reel = await makeProperty({
    rooms: 7,
    areaSqm: AREA,
    price: PRICE,
    intakeAgentId: agentId,
    reelsCaption: CAPTION,
    // Ссылки в карточке нет — как у части объектов на проде.
    publishedPostIds: { INSTAGRAM: MEDIA_ID },
  });
  reelId = reel.id;
  reelShortId = reel.shortId;

  // Двойники по цене и площади: узнавание по цифрам обязано отказаться гадать.
  const twinPrice = PRICE + 7_000;
  twinA = (await makeProperty({ rooms: 2, areaSqm: 61, price: twinPrice, intakeAgentId: agentId })).id;
  twinB = (await makeProperty({ rooms: 2, areaSqm: 61, price: twinPrice, intakeAgentId: agentId })).id;

  soldId = (
    await makeProperty({ rooms: 3, areaSqm: 90, price: PRICE + 13_000, status: "SOLD", intakeAgentId: agentId })
  ).id;

  const photo = await makeProperty({ rooms: 1, areaSqm: 40, price: PRICE + 21_000, assignedAgentId: ownerId });
  photoPostPropertyId = photo.id;
  await prisma.propertyPhotoPost.create({
    data: {
      propertyId: photo.id,
      channel: "INSTAGRAM",
      status: "PUBLISHED",
      mediaId: PHOTO_MEDIA_ID,
      permalink: `https://www.instagram.com/p/${PHOTO_CODE}/`,
    },
  });

  fbPropertyId = (
    await makeProperty({
      rooms: 4,
      areaSqm: 120,
      price: PRICE + 33_000,
      intakeAgentId: agentId,
      publishedPostIds: { FACEBOOK: FB_VIDEO_ID },
    })
  ).id;
});

afterAll(async () => {
  await instagram.dispose();
  const ids = [reelId, twinA, twinB, soldId, photoPostPropertyId, fbPropertyId].filter(Boolean);
  await prisma.propertyExposure.deleteMany({ where: { propertyId: { in: ids } } });
  await prisma.propertyPhotoPost.deleteMany({ where: { propertyId: { in: ids } } });
  await prisma.property.deleteMany({ where: { id: { in: ids } } });
  await deleteAgentsWithTraces([agentId, ownerId]);
});

describe("разбор вебхука: подпись и номер пересланной публикации не теряются", () => {
  const event = (message: unknown) => ({
    object: "instagram",
    entry: [{ messaging: [{ sender: { id: "user-1" }, message }] }],
  });

  it("рилс с адресом CDN: номер публикации и подпись доезжают до бота", () => {
    const [msg] = parseIncoming(
      event({
        mid: "m1",
        attachments: [{ type: "ig_reel", payload: { url: CDN, title: CAPTION, reel_video_id: Number(MEDIA_ID.slice(0, 15)) } }],
      })
    );
    expect(msg.attachmentType).toBe("ig_reel");
    expect(msg.attachmentUrl).toBe(CDN);
    expect(msg.attachmentTitle).toBe(CAPTION);
    expect(msg.attachmentMediaId).toBe(MEDIA_ID.slice(0, 15));
  });

  it("пост (ig_post) — номер берётся из ig_post_media_id", () => {
    const [msg] = parseIncoming(
      event({ mid: "m2", attachments: [{ type: "ig_post", payload: { url: CDN, ig_post_media_id: MEDIA_ID } }] })
    );
    expect(msg.attachmentType).toBe("ig_post");
    expect(msg.attachmentMediaId).toBe(MEDIA_ID);
  });

  it("мусор вместо номера не принимается за номер", () => {
    const [msg] = parseIncoming(
      event({ mid: "m3", attachments: [{ type: "ig_reel", payload: { url: CDN, reel_video_id: "abc" } }] })
    );
    expect(msg.attachmentMediaId).toBeUndefined();
  });

  it("ссылка в Messenger (fallback) — это текст со ссылкой, а не нечитаемое вложение", () => {
    const [msg] = parseIncoming({
      object: "page",
      entry: [
        {
          messaging: [
            {
              sender: { id: "u" },
              message: {
                mid: "m4",
                attachments: [{ type: "fallback", payload: { url: "https://somon.tj/adv/123" } }],
              },
            },
          ],
        },
      ],
    });
    expect(msg.attachmentType).toBeUndefined();
    expect(msg.text).toContain("https://somon.tj/adv/123");
  });
});

describe("цифры из подписи и с карточки", () => {
  it("карточка поста: цена в сомони, площадь с запятой, комнаты по-таджикски", () => {
    expect(parsePropertyFacts("7 ХОНАГА 1 221 000 TJS 163,2 м² МАСОҲАТ 3 ОШЁНА")).toEqual({
      price: 1_221_000,
      currency: "TJS",
      areaSqm: 163.2,
      rooms: 7,
    });
  });

  it("цена в долларах и «3-комнатная»", () => {
    expect(parsePropertyFacts("3-комнатная, 78 м2, цена $62 000")).toMatchObject({
      price: 62_000,
      currency: "USD",
      areaSqm: 78,
      rooms: 3,
    });
  });

  it("телефон ценой не считается", () => {
    expect(parsePropertyFacts("звоните +992 900 12 34 56").price).toBeUndefined();
  });

  it("«Объект №N» — только строка, которую ставит CRM", () => {
    expect(captionFooterShortId("…\n\nОбъект №1042")).toBe(1042);
    expect(captionFooterShortId("дом №5, кв 3")).toBeNull();
    expect(captionFooterShortId("Объект 3 хонагӣ, 85 м²")).toBeNull();
    expect(captionFooterShortId("Объекти № 557")).toBe(557);
  });

  it("CDN самой Meta отличается от чужого сайта", () => {
    expect(isMetaCdnUrl(CDN)).toBe(true);
    expect(isMetaCdnUrl("https://scontent-fra5-1.cdninstagram.com/v/x.mp4")).toBe(true);
    expect(isMetaCdnUrl("https://lookaside.fbsbx.com.evil.ru/x")).toBe(false);
    expect(isMetaCdnUrl("https://somon.tj/x")).toBe(false);
  });

  it("код поста — и из ссылки с именем аккаунта, и из instagr.am", () => {
    expect(instagramShortcode("https://www.instagram.com/royal.home.tj/reel/ABC_12/")).toBe("ABC_12");
    expect(instagramShortcode("https://instagr.am/p/XYZ9/")).toBe("XYZ9");
    expect(instagramShortcode("https://instagram.com/stories/royal.home.tj/123")).toBeNull();
  });
});

describe("пересланный пост с адресом CDN узнаётся", () => {
  const expectReel = (out: string) => {
    expect(out).toContain(`объект №${reelShortId}`);
    expect(out).toContain("Отвечай про ЭТОТ объект");
  };

  it("по номеру публикации из вложения", async () => {
    expectReel(await sharedMediaHint({ text: "", attachmentType: "ig_reel", attachmentUrl: CDN, mediaId: MEDIA_ID }));
  });

  it("по номеру публикации из нашей ленты", async () => {
    expectReel(await sharedMediaHint({ text: "", attachmentType: "share", attachmentUrl: CDN, ownMediaId: MEDIA_ID }));
  });

  it("пост с типом ig_post — тоже пересланная публикация", async () => {
    const ctx = await sharedPostContext({ text: "", attachmentType: "ig_post", attachmentUrl: CDN, mediaId: MEDIA_ID });
    expect(ctx).toEqual({ propertyId: reelId, unresolved: false });
  });

  it("по подписи, опубликованной самой CRM", async () => {
    expectReel(await sharedMediaHint({ text: "", attachmentType: "ig_reel", attachmentUrl: CDN, postTitle: CAPTION }));
  });

  it("по строке «Объект №N» в подписи", async () => {
    expectReel(
      await sharedMediaHint({
        text: "",
        attachmentType: "ig_reel",
        attachmentUrl: CDN,
        postTitle: `Квартира мечты\n\nОбъект №${reelShortId}`,
      })
    );
  });

  it("по цене и площади в подписи, если подпись своя, но переписана", async () => {
    expectReel(
      await sharedMediaHint({
        text: "нарх?",
        attachmentType: "ig_reel",
        attachmentUrl: CDN,
        postTitle: `Другая подпись. ${PRICE.toLocaleString("ru-RU")} TJS, ${AREA} м²`,
      })
    );
  });

  it("двойники по цене и площади — не гадает", async () => {
    expect(await matchPropertyByFacts({ price: PRICE + 7_000, currency: "TJS", areaSqm: 61 })).toBeNull();
  });

  it("объект, прочитанный с картинки, подставляется", async () => {
    expectReel(await sharedMediaHint({ text: "", attachmentType: "ig_reel", attachmentUrl: CDN, cardPropertyId: reelId }));
  });

  it("фото-пост: по коду из ссылки и по номеру публикации", async () => {
    const byCode = await sharedPostContext({
      text: "",
      attachmentType: "share",
      attachmentUrl: `https://www.instagram.com/p/${PHOTO_CODE}/`,
    });
    expect(byCode.propertyId).toBe(photoPostPropertyId);
    const byId = await sharedPostContext({ text: "", attachmentType: "share", attachmentUrl: CDN, mediaId: PHOTO_MEDIA_ID });
    expect(byId.propertyId).toBe(photoPostPropertyId);
  });

  it("ссылка на наш ролик в Facebook текстом", async () => {
    const out = await sharedMediaHint({ text: `https://www.facebook.com/royalhome.tj/videos/${FB_VIDEO_ID}/ есть?` });
    expect(out).toContain("Отвечай про ЭТОТ объект");
  });

  it("пост чужого канала Telegram с тем же номером — не наш объект", async () => {
    const ctx = await sharedPostContext({
      text: "",
      attachmentType: "share",
      attachmentUrl: "https://t.me/chuzhoy_kanal_xyz/1",
    });
    expect(ctx.propertyId).toBeNull();
  });

  it("чужой пост без подписи и номера — по-прежнему не узнан", async () => {
    const ctx = await sharedPostContext({ text: "", attachmentType: "ig_reel", attachmentUrl: CDN });
    expect(ctx).toEqual({ propertyId: null, unresolved: true });
  });
});

describe("узнанный пост — лид агенту объекта, а не «видео не открылось»", () => {
  it("интерес пишется хозяину объекта, даже если агента приёма нет", async () => {
    const recipientId = `rcp-photo-${runId}`;
    await sharedMediaHint({
      text: "",
      attachmentType: "share",
      attachmentUrl: CDN,
      mediaId: PHOTO_MEDIA_ID,
      channel: "INSTAGRAM",
      recipientId,
      transport: instagram.transport,
    });
    const row = await waitFor(() =>
      prisma.propertyExposure.findFirst({
        where: { channel: "INSTAGRAM", recipientId, propertyId: photoPostPropertyId, kind: "CLIENT_SHARED" },
      })
    );
    expect(row).not.toBeNull();
  });

  it("проданный объект лид бывшему агенту не отдаёт", async () => {
    const recipientId = `rcp-sold-${runId}`;
    const out = await sharedMediaHint({
      text: "",
      attachmentType: "ig_reel",
      attachmentUrl: CDN,
      cardPropertyId: soldId,
      channel: "INSTAGRAM",
      recipientId,
      transport: instagram.transport,
    });
    expect(out).toContain("УЖЕ НЕ В ПРОДАЖЕ");
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.propertyExposure.count({ where: { recipientId } })).toBe(0);
  });

  it("узнанный по базе пост — наш: готовая фраза «видео не открылось» не срабатывает", () => {
    const ctx = sharedPostSpamContext({
      sharedPost: true,
      ownMedia: false,
      adProperty: false,
      vacancyPost: false,
      recognizedProperty: true,
    });
    expect(ctx.ourPost).toBe(true);
    expect(guardOffTopic("", ctx)).toBeNull();
    // Чужой голый пост — прежнее поведение.
    expect(
      guardOffTopic("", sharedPostSpamContext({ sharedPost: true, ownMedia: false, adProperty: false, vacancyPost: false }))
        ?.kind
    ).toBe("blind_share");
  });

  it("картинку видим, а чья — не знаем: не называет её нашей и не говорит «не открылось»", async () => {
    const out = await sharedMediaHint({ text: "", attachmentType: "share", attachmentUrl: CDN, mediaSeen: true });
    expect(out).toContain("НЕ говори, что видео не открылось");
    expect(out).not.toContain("НАШУ публикацию");
  });
});
