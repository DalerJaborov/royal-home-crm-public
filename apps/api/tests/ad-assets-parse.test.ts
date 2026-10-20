import { describe, expect, it } from "vitest";
import { applyVideoDetails, creativeBodyText, parseCreativeAssets } from "../src/lib/ads/adAssets.js";
import { nameShortId, nameShortIds } from "../src/lib/ads/adMatching.js";

/**
 * Разбор креатива Meta на материалы (lib/ads/adAssets.ts) и номера объектов в
 * названии. Чистая логика: ни сети, ни базы.
 */

describe("parseCreativeAssets", () => {
  it("«гибкое» объявление: четыре ролика — четыре материала, картинки отдельно", () => {
    const assets = parseCreativeAssets({
      asset_feed_spec: {
        videos: [
          { video_id: "v1", thumbnail_url: "https://t/1.jpg" },
          { video_id: "v2" },
          { video_id: "v3" },
          { video_id: "v4" },
        ],
        images: [{ hash: "h1", url: "https://i/1.jpg" }],
        bodies: [{ text: "Квартира" }],
      },
      instagram_permalink_url: "https://www.instagram.com/reel/AAA/",
    });
    expect(assets.filter((a) => a.kind === "video").map((a) => a.id)).toEqual(["v1", "v2", "v3", "v4"]);
    expect(assets.find((a) => a.kind === "image")?.id).toBe("h1");
    // Публикация не добавляется рядом с роликами: счёт материалов не должен раздуваться.
    expect(assets.some((a) => a.kind === "post")).toBe(false);
  });

  it("обычное объявление на пост — один материал «post» с текстом", () => {
    const assets = parseCreativeAssets({
      instagram_permalink_url: "https://www.instagram.com/reel/BBB/",
      thumbnail_url: "https://t/b.jpg",
      object_story_spec: { video_data: { message: "Дом на Рудаки" } },
    });
    expect(assets).toEqual([
      {
        kind: "post",
        id: "https://www.instagram.com/reel/BBB/",
        permalink: "https://www.instagram.com/reel/BBB/",
        thumbnailUrl: "https://t/b.jpg",
        text: "Дом на Рудаки",
      },
    ]);
  });

  it("карусель из 3 карточек с роликами → три материала, а не шесть (assetCount = 3)", () => {
    const assets = parseCreativeAssets({
      object_story_spec: {
        link_data: {
          child_attachments: [
            { link: "https://site/1", name: "№1", video_id: "cv1" },
            { link: "https://site/2", name: "№2", video_id: "cv2" },
            { link: "https://site/3", name: "№3", video_id: "cv3" },
          ],
        },
      },
    });
    expect(assets).toHaveLength(3);
    expect(assets.every((a) => a.kind === "carousel_card")).toBe(true);
    // video_id хранится ВНУТРИ карточки…
    expect(assets.map((a) => a.videoId)).toEqual(["cv1", "cv2", "cv3"]);
    // …а подпись ролика, добытая у Graph, подмешивается в текст самой карточки.
    const filled = applyVideoDetails(assets, new Map([["cv2", { text: "Ролик про №2", permalink: "https://fb/cv2" }]]));
    expect(filled).toHaveLength(3);
    expect(filled[1].text).toBe("№2\nРолик про №2");
    expect(filled[1].permalink).toBe("https://site/2");
    expect(filled[0].text).toBe("№1");
  });

  it("карусель: карточки с текстом и ссылкой, ролик внутри карточки — НЕ отдельный материал", () => {
    const assets = parseCreativeAssets({
      object_story_spec: {
        link_data: {
          child_attachments: [
            { link: "https://site/1", name: "№12", description: "2 комнаты", picture: "https://p/1.jpg", video_id: "cv1" },
            { link: "https://site/2", name: "№13" },
          ],
        },
      },
    });
    expect(assets.map((a) => `${a.kind}:${a.id}`)).toEqual(["carousel_card:https://site/1", "carousel_card:https://site/2"]);
    expect(assets[0].text).toBe("№12\n2 комнаты");
    expect(assets[0].videoId).toBe("cv1");
  });

  it("мусор и пустые поля не ломают разбор; повторы схлопываются", () => {
    expect(parseCreativeAssets(undefined)).toEqual([]);
    expect(parseCreativeAssets({})).toEqual([]);
    expect(
      parseCreativeAssets({
        asset_feed_spec: { videos: [{}, { video_id: " " }, { video_id: "v1" }, { video_id: "v1" }], images: [{}] },
        object_story_spec: { link_data: { child_attachments: [{}] } },
      })
    ).toEqual([{ kind: "video", id: "v1", thumbnailUrl: undefined }]);
  });

  it("подписи роликов, добытые у Graph, вписываются в материалы; ролики без подписи остаются как есть", () => {
    const assets = parseCreativeAssets({ asset_feed_spec: { videos: [{ video_id: "v1" }, { video_id: "v2" }] } });
    const filled = applyVideoDetails(assets, new Map([["v1", { text: "Продаётся №5", permalink: "https://fb/v1" }]]));
    expect(filled[0].text).toBe("Продаётся №5");
    expect(filled[0].permalink).toBe("https://fb/v1");
    expect(filled[1].text).toBeUndefined();
  });
});

describe("creativeBodyText", () => {
  it("берёт первое непустое поле в прежнем порядке", () => {
    expect(creativeBodyText({ body: "  ", object_story_spec: { link_data: { message: "Текст" } } })).toBe("Текст");
    expect(creativeBodyText({ asset_feed_spec: { bodies: [{ text: "Из гибкого" }] } })).toBe("Из гибкого");
    expect(creativeBodyText(undefined)).toBeUndefined();
  });
});

describe("nameShortIds — ВСЕ номера объектов из названия", () => {
  it("«№12 и #13» → оба, без повторов, в порядке записи", () => {
    expect(nameShortIds("Умед хонахо №12, #13 и №12")).toEqual([12, 13]);
    expect(nameShortIds("Без номера 1042 июль")).toEqual([]);
    expect(nameShortIds(null)).toEqual([]);
  });

  it("старая nameShortId — первый номер", () => {
    expect(nameShortId("№7 и №8")).toBe(7);
    expect(nameShortId("нет")).toBeNull();
  });
});
