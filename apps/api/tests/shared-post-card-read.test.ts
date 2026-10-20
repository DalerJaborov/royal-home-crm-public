import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ПОСЛЕДНИЙ ПУТЬ УЗНАВАНИЯ — НАДПИСИ НА САМОЙ КАРТОЧКЕ ПОСТА (02.10.2026).
 *
 * Meta не дала ни адреса поста, ни номера, ни подписи — только картинку на своём
 * CDN. На карточке нашего поста крупно написаны цена и площадь: их читает Gemini,
 * а объект ищется ровно одним совпадением. Скачивание и Gemini здесь подменены —
 * проверяется, что прочитанное доходит до правильного объекта и что чужой адрес
 * не скачивается вовсе.
 */

const { fetchAttachments, describeMedia } = vi.hoisted(() => ({
  fetchAttachments: vi.fn(),
  describeMedia: vi.fn(),
}));
vi.mock("../src/messengers/attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/attachments.js")>()),
  fetchAttachments,
}));
vi.mock("../src/ai/geminiMedia.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiMedia.js")>()),
  describeMedia,
}));

const { prisma } = await import("../src/db.js");
const { propertyFromSharedCard, propertyFromCardSource } = await import("../src/messengers/sharedPostCard.js");

const runId = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
const PRICE = 2_000_000 + (Math.floor(Math.random() * 800) + 100) * 1000;
const CDN = `https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=${runId}`;
let propertyId = "";

beforeAll(async () => {
  const p = await prisma.property.create({
    data: {
      title: `Тест-карточка-поста-${runId}`,
      type: "APARTMENT",
      rooms: 7,
      areaSqm: 163.2,
      price: PRICE,
      currency: "TJS",
      address: "Тестовая, 2",
      condition: "GOOD",
    },
  });
  propertyId = p.id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: propertyId } });
});

beforeEach(() => {
  fetchAttachments.mockReset();
  describeMedia.mockReset();
});

const priceText = PRICE.toLocaleString("ru-RU");

describe("propertyFromSharedCard", () => {
  it("картинка поста: цена и площадь с карточки находят объект", async () => {
    fetchAttachments.mockResolvedValue({
      images: [{ kind: "image", mediaType: "image/jpeg", data: Buffer.from("x").toString("base64") }],
      audios: [],
      medias: [],
      hadUnsupported: false,
    });
    describeMedia.mockResolvedValue(`цена: ${priceText} TJS\nплощадь: 163,2 м²\nкомнат: 7\nэтаж: 3`);
    const found = await propertyFromSharedCard(CDN, "image");
    expect(found?.id).toBe(propertyId);
    expect(describeMedia.mock.calls[0]![2]).toBe("card");
  });

  it("ролик: читаются первые кадры тем же способом", async () => {
    fetchAttachments.mockResolvedValue({
      images: [],
      audios: [],
      medias: [{ kind: "media", media: "video", mediaType: "video/mp4", buffer: Buffer.from("v"), filename: "r.mp4" }],
      hadUnsupported: false,
    });
    describeMedia.mockResolvedValue(`цена: ${priceText} сомонӣ\nплощадь: 163.2 м²`);
    expect((await propertyFromSharedCard(CDN, "video"))?.id).toBe(propertyId);
  });

  it("надписей нет — объекта нет, без догадок", async () => {
    fetchAttachments.mockResolvedValue({ images: [{ kind: "image", mediaType: "image/png", data: "eA==" }], audios: [], medias: [], hadUnsupported: false });
    describeMedia.mockResolvedValue("нет");
    expect(await propertyFromSharedCard(CDN, "image")).toBeNull();
  });

  it("адрес не с CDN Meta не скачивается вовсе", async () => {
    expect(await propertyFromSharedCard("https://example.com/x.jpg", "image")).toBeNull();
    expect(fetchAttachments).not.toHaveBeenCalled();
  });

  it("скриншот обычным фото (и в WhatsApp, с маркером) — читается тем же разбором", async () => {
    fetchAttachments.mockResolvedValue({
      images: [{ kind: "image", mediaType: "image/jpeg", data: Buffer.from("s").toString("base64") }],
      audios: [],
      medias: [],
      hadUnsupported: false,
    });
    describeMedia.mockResolvedValue(`цена: ${priceText} TJS\nплощадь: 163,2 м²\nкомнат: 7`);
    const source = { url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", headers: { Authorization: "Bearer x" }, declaredKind: "image" };
    expect((await propertyFromCardSource(source))?.id).toBe(propertyId);
    expect(fetchAttachments.mock.calls[0]![0]).toEqual([source]);
  });

  it("фото без надписей объявления (квартира, документ) — объекта нет", async () => {
    fetchAttachments.mockResolvedValue({ images: [{ kind: "image", mediaType: "image/jpeg", data: "eA==" }], audios: [], medias: [], hadUnsupported: false });
    describeMedia.mockResolvedValue("нет");
    expect(await propertyFromCardSource({ url: "https://scontent.cdninstagram.com/x.jpg" })).toBeNull();
  });
});
