import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * НАШУ ПУБЛИКАЦИЮ ИЩЕМ ПО ВСЕМУ СООБЩЕНИЮ, А НЕ ПО ОДНОМУ ПОЛЮ (20.09.2026).
 *
 * Разбор 775 живых переписок за 21.08–20.09: из 149 пересылок наших постов и
 * роликов на 80 бот ответил «видео у меня не открылось» — человеку, который
 * только что показал пальцем на нашу квартиру. Одна из причин видна в коде:
 * Meta кладёт в `attachment.payload.url` то адрес публикации, то ссылку на свой
 * CDN, из которой короткого кода не достать, а вебхук передавал в findOwnMedia
 * ровно один адрес — `attachmentUrl ?? text`. То есть при непустом CDN-адресе
 * текст сообщения не смотрели НИКОГДА.
 *
 * Проверяем именно поведение, а не подпись: публикация обязана найтись, когда
 * ссылка на неё лежит в любом месте сообщения.
 */

const { getAllOwnMedia, logSystemError } = vi.hoisted(() => ({
  getAllOwnMedia: vi.fn(),
  logSystemError: vi.fn(),
}));

vi.mock("../src/messengers/instagramFeed.js", () => ({ getAllOwnMedia }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError }));

const { findOwnMedia } = await import("../src/messengers/ownMedia.js");

const OUR_REEL = "https://www.instagram.com/reel/RH2609abc/";
/** Так Meta отдаёт превью пересланного: адрес своего CDN, кода публикации в нём нет. */
const CDN = "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=17912345678&signature=abc";

const FEED = [
  {
    id: "1",
    permalink: OUR_REEL,
    caption: "3-хонага, Сино, 420 000 сомонӣ, №1042",
    mediaType: "VIDEO",
    thumbnailUrl: "https://cdn/thumb.jpg",
  },
];

beforeEach(() => {
  getAllOwnMedia.mockReset().mockResolvedValue(FEED);
  logSystemError.mockReset();
});

describe("Своя публикация опознаётся по любому адресу в сообщении", () => {
  it("ссылка в тексте, а во вложении адрес CDN — публикация найдена", async () => {
    const found = await findOwnMedia(CDN, `Ин хона озод аст? ${OUR_REEL}`);
    expect(found?.permalink).toBe(OUR_REEL);
    // Подпись — источник цены и района для ответа, без неё находка бесполезна.
    expect(found?.caption).toContain("420 000");
  });

  it("ссылка во втором вложении той же пачки — публикация найдена", async () => {
    const found = await findOwnMedia(CDN, "", OUR_REEL);
    expect(found?.permalink).toBe(OUR_REEL);
  });

  it("адрес публикации пришёл в самом вложении — прежнее поведение сохранено", async () => {
    const found = await findOwnMedia(OUR_REEL, "");
    expect(found?.permalink).toBe(OUR_REEL);
  });

  it("кода нет ни в одном адресе — в ленту не ходим вовсе", async () => {
    expect(await findOwnMedia(CDN, "Салом", undefined)).toBeNull();
    expect(getAllOwnMedia).not.toHaveBeenCalled();
  });
});

describe("Почему не опознали — видно в журнале", () => {
  it("код достали, а в ленте его нет: запись называет длину ленты", async () => {
    expect(await findOwnMedia("https://www.instagram.com/reel/RHforeign1/")).toBeNull();
    const [[kind, message, extra]] = logSystemError.mock.calls;
    expect(kind).toBe("meta");
    expect(message).toContain("прочитано 1 записей");
    // Код — в поле адреса, а не в тексте: иначе дедупликация записей не срабатывает
    // и одинаковые по смыслу записи будят владельца утренней сводкой.
    expect(extra?.url).toContain("RHforeign1");
  });

  it("лента не прочитана вовсе — отдельная запись, а не тишина", async () => {
    getAllOwnMedia.mockResolvedValue(null);
    expect(await findOwnMedia(OUR_REEL)).toBeNull();
    expect(logSystemError.mock.calls[0][1]).toContain("не прочитана вовсе");
  });
});
