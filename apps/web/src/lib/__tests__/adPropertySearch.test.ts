import { describe, expect, it } from "vitest";
import { cardToSearchHit, mergeSearchResults, parsePropertySearch } from "../adPropertySearch";

describe("parsePropertySearch — номер или адрес", () => {
  it.each([
    ["103", 103],
    ["  103  ", 103],
    ["№103", 103],
    ["№ 103", 103],
    ["#103", 103],
    ["ОБ-000103", 103],
    ["об 103", 103],
    ["OB-000103", 103],
    ["5", 5],
  ])("«%s» — номер %i", (raw, shortId) => {
    expect(parsePropertySearch(raw)).toEqual({ shortId, text: String(shortId) });
  });

  it.each(["Фирдавси", "Рудаки 45", "103 Фирдавси", "103/2", "0", "ОБ-", "", "   ", "1234567890123"])(
    "«%s» — адресный поиск, номера нет",
    (raw) => {
      const parsed = parsePropertySearch(raw);
      expect(parsed.shortId).toBeNull();
      expect(parsed.text).toBe(raw.trim());
    }
  );

  it("«103 Фирдавси» остаётся текстом с числом", () => {
    expect(parsePropertySearch("103 Фирдавси")).toEqual({ shortId: null, text: "103 Фирдавси" });
  });
});

describe("cardToSearchHit", () => {
  const card = { id: "a", shortId: 103, title: "3-к", address: "Фирдавси 5", status: "AVAILABLE" };

  it("берёт первую миниатюру", () => {
    expect(cardToSearchHit({ ...card, photos: [{ thumbUrl: "/t1.jpg" }, { thumbUrl: "/t2.jpg" }] })?.coverUrl).toBe(
      "/t1.jpg"
    );
  });
  it("без фото — coverUrl null", () => {
    expect(cardToSearchHit({ ...card, photos: [] })?.coverUrl).toBeNull();
  });
  it("объект в корзине не показываем", () => {
    expect(cardToSearchHit({ ...card, deletedAt: "2026-10-01T00:00:00.000Z" })).toBeNull();
  });
  it("объект не в продаже не фильтруем", () => {
    expect(cardToSearchHit({ ...card, status: "SOLD" })?.status).toBe("SOLD");
  });
});

describe("mergeSearchResults", () => {
  const hit = { id: "103", n: "exact" };
  const text = [{ id: "90" }, { id: "103" }, { id: "7" }];

  it("точное совпадение первым, без дубля из текстового поиска", () => {
    expect(mergeSearchResults(hit, text, new Set(), 6).map((r) => r.id)).toEqual(["103", "90", "7"]);
  });
  it("выбранные не показываем, в том числе точное", () => {
    expect(mergeSearchResults(hit, text, new Set(["103", "7"]), 6).map((r) => r.id)).toEqual(["90"]);
  });
  it("нет точного — только текстовые", () => {
    expect(mergeSearchResults(null, text, new Set(), 6).map((r) => r.id)).toEqual(["90", "103", "7"]);
  });
  it("предел длины", () => {
    expect(mergeSearchResults(hit, text, new Set(), 2).map((r) => r.id)).toEqual(["103", "90"]);
  });
  it("ничего нет — пустой список", () => {
    expect(mergeSearchResults(undefined, undefined, new Set(), 6)).toEqual([]);
  });
});
