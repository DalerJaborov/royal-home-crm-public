import { describe, expect, it, vi } from "vitest";
import { matchPublicShellRequest, readAssistantPublicSiteCatalog, replyPublicShellRequest } from "../src/telegram/assistantPublicShellSearch.js";

const apartment = {
  id: 27, crmShortId: 93, category: "APARTMENT", location: "Сино, Душанбе", price: 550000, rooms: 1, area: 46,
  stage: "Коробка, черновые не сделаны", repair: "Без отделки", published: true, sold: false,
  externalId: null, mapAddress: null, lat: null, lng: null,
} as const;

const response = (url: string, rows: unknown[]) => ({
  url, status: 200, contentType: "application/json; charset=utf-8", truncated: false,
  body: Buffer.from(JSON.stringify({ result: { data: { json: rows } } })),
});

describe("public shell questions", () => {
  it("recognizes apartment, house, and the actual ambiguous Tajik wording", () => {
    expect(matchPublicShellRequest("хонаи коробкаи тайёр ва бетаъмир")).toEqual({ type: null });
    expect(matchPublicShellRequest("Квартираи коробкаи тайёр бе таъмир доред?")).toEqual({ type: "APARTMENT" });
    expect(matchPublicShellRequest("Ҳавлии коробка бе таъмир мехоҳам")).toEqual({ type: "HOUSE" });
    expect(matchPublicShellRequest("Найдите квартиру: коробка, без ремонта")).toEqual({ type: "APARTMENT" });
  });

  it("leaves seller, explicit conditions, negatives, and distinct finish questions out", () => {
    for (const text of ["Коробкаи тайёр ва бетаъмир", "Квартира бо таъмир", "Дом с черновыми работами", "Коробка без ремонта, 2 комнаты",
      "Мне не нужна квартира, коробка без отделки", "Квартиру в коробке без ремонта в Сино", "Мефурӯшам хонаи коробкаи бетаъмир"]) {
      expect(matchPublicShellRequest(text), text).toBeNull();
    }
  });

  it("asks for the property type without accessing the site", async () => {
    const read = vi.fn();
    expect(await replyPublicShellRequest({ type: null }, "tg", undefined, read)).toBe("Квартира меҷӯед ё ҳавлӣ?");
    expect(read).not.toHaveBeenCalled();
  });

  it("uses a fixed anonymous site read and projects only published, available public fields", async () => {
    const read = vi.fn(async (url: string) => response(url, [
      { ...apartment, ownerName: "PRIVATE", title: "arbitrary HTML" },
      { ...apartment, id: 29, published: false },
      { ...apartment, id: 30, sold: true },
      { ...apartment, id: 31, mapAddress: "hidden street" },
      { ...apartment, id: 32, location: "<a>inject</a>" },
    ]));
    const rows = await readAssistantPublicSiteCatalog(undefined, read);
    const [url, options] = read.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(new URL(url).origin).toBe("https://royalhome.tj");
    expect(JSON.parse(new URL(url).searchParams.get("input")!)).toEqual({ json: { sold: false } });
    expect(options).toMatchObject({ credentials: "omit", maxRedirects: 0, maxBytes: 512 * 1024 });
    expect(rows).toEqual([{ id: 27, crmShortId: 93, category: "APARTMENT", location: "Сино, Душанбе", price: 550000,
      rooms: 1, area: 46, stage: "Коробка, черновые не сделаны", repair: "Без отделки" }]);
  });

  it("requires exact shell and finish, then sends at most three public links ordered by price", async () => {
    const read = vi.fn(async (url: string) => response(url, [
      apartment, apartment,
      { ...apartment, id: 30, price: 100000, repair: "Требует ремонта" },
      { ...apartment, id: 35, price: 100000, stage: "Черновые работы сделаны" },
      { ...apartment, id: 31, price: 600000 }, { ...apartment, id: 33, price: 200000 }, { ...apartment, id: 34, price: 900000 },
    ]));
    const text = await replyPublicShellRequest({ type: "APARTMENT" }, "tg", undefined, signal => readAssistantPublicSiteCatalog(signal, read));
    expect(text.match(/https:\/\/royalhome\.tj\/tg\/khona\/\d+/gu)).toEqual([33, 27, 31].map(id => `https://royalhome.tj/tg/khona/${id}`));
    expect(text).toContain("сомонӣ");
  });

  it("distinguishes no houses from a failed or redirected website read", async () => {
    const read = vi.fn(async (url: string) => response(url, [apartment]));
    expect(await replyPublicShellRequest({ type: "HOUSE" }, "tg", undefined, signal => readAssistantPublicSiteCatalog(signal, read)))
      .toContain("Квартира ҳам мешавад?");
    const redirected = vi.fn(async () => response("https://example.com", [apartment]));
    expect(await replyPublicShellRequest({ type: "HOUSE" }, "tg", undefined, signal => readAssistantPublicSiteCatalog(signal, redirected)))
      .toBe("Ҳозир сайт ҷавоб намедиҳад. Каме баъд боз пурсед.");
  });

  it("does not use a late response after the original turn is cancelled", async () => {
    const controller = new AbortController();
    let finish!: () => void;
    const read = vi.fn((url: string) => new Promise<ReturnType<typeof response>>(resolve => {
      finish = () => resolve(response(url, [apartment]));
    }));
    const pending = readAssistantPublicSiteCatalog(controller.signal, read);
    controller.abort();
    expect(await pending).toBeNull();
    finish();
  });
});
