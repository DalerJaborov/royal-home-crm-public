import { describe, expect, it } from "vitest";
import { decideBack, hasAppHistory, needsOwnEdgeSwipe } from "../goBack";

/**
 * «Назад» (21.11.2026, владелец с iPhone: «выкидывает в другое место, например в Объекты»): шаг по истории —
 * только когда перед экраном стоит экран приложения, иначе логичный родитель.
 */
describe("hasAppHistory", () => {
  it("первая запись приложения во вкладке (ссылка, пуш, экран «Домой») — истории нет", () => {
    expect(hasAppHistory({ idx: 0, key: "abc" }, "abc")).toBe(false);
  });
  it("перешли внутри приложения — история есть", () => {
    expect(hasAppHistory({ idx: 3, key: "k" }, "k")).toBe(true);
  });
  it("перезагрузка посреди работы: idx сохранился, шаг назад остаётся в приложении", () => {
    expect(hasAppHistory({ idx: 2, key: "k" }, "default")).toBe(true);
  });
  it("без idx судим по ключу: «default» — первая запись", () => {
    expect(hasAppHistory(null, "default")).toBe(false);
    expect(hasAppHistory(null, "x1y2")).toBe(true);
    expect(hasAppHistory({ idx: "2" }, "default")).toBe(false);
  });
});

describe("decideBack", () => {
  it("переписка, открытая из списка, — шаг назад по истории", () => {
    expect(decideBack({ idx: 4 }, "k", "/messages")).toEqual({ kind: "history" });
  });
  it("переписка из пуша/по ссылке — в список чатов, а не наружу и не в «Объекты»", () => {
    expect(decideBack({ idx: 0 }, "k", "/messages")).toEqual({ kind: "parent", to: "/messages" });
  });
  it("экран запретил шаг по истории (открыт заменой адреса) — только родитель, даже при истории", () => {
    expect(decideBack({ idx: 5 }, "k", "/messages", false)).toEqual({ kind: "parent", to: "/messages" });
  });
});

describe("needsOwnEdgeSwipe", () => {
  it("только приложение на экране «Домой» iPhone: у Safari и Android свой жест, второй дал бы два шага", () => {
    expect(needsOwnEdgeSwipe({ standalone: true })).toBe(true);
    expect(needsOwnEdgeSwipe({ standalone: false })).toBe(false);
    expect(needsOwnEdgeSwipe({})).toBe(false);
    expect(needsOwnEdgeSwipe(undefined)).toBe(false);
  });
});
