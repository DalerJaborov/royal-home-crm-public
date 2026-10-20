import { describe, expect, it } from "vitest";
import type { Query } from "@tanstack/react-query";
import { keepWhilePaging, keepWhilePagingIndexed } from "../keepWhilePaging";

const q = (queryKey: unknown[]) => ({ queryKey }) as unknown as Query<string>;

describe("keepWhilePaging — «Показать ещё» не опустошает список", () => {
  it("та же выдача, другая страница — держим прежние данные", () => {
    const fn = keepWhilePaging<string>(["properties", { status: "A", page: 2 }]);
    expect(fn("стр.1", q(["properties", { status: "A", page: 1 }]))).toBe("стр.1");
  });
  it("сменился фильтр — чужие строки не показываем", () => {
    const fn = keepWhilePaging<string>(["properties", { status: "B", page: 1 }]);
    expect(fn("стр.1", q(["properties", { status: "A", page: 1 }]))).toBeUndefined();
  });
  it("первый запрос без прошлых данных", () => {
    expect(keepWhilePaging<string>(["x", { page: 1 }])(undefined, undefined)).toBeUndefined();
  });
  it("ключ вида [имя, страница]", () => {
    const fn = keepWhilePagingIndexed<string>(["audit-log", 2]);
    expect(fn("стр.1", q(["audit-log", 1]))).toBe("стр.1");
    expect(fn("x", q(["other", 1]))).toBeUndefined();
  });
});

describe("keepWhilePagingAt — страница в середине ключа", () => {
  it("тот же срез — держим, другой вердикт — нет", async () => {
    const { keepWhilePagingAt } = await import("../keepWhilePaging");
    const fn = keepWhilePagingAt<string>(["security", "lost", 2, "PENDING"], 2);
    expect(fn("стр.1", q(["security", "lost", 1, "PENDING"]))).toBe("стр.1");
    expect(fn("стр.1", q(["security", "lost", 1, "OTHER"]))).toBeUndefined();
  });
});
