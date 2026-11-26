// Пачка роликов в черновик и подпись альбома (26.11.2026): одна карточка на пачку, номер из подписи — всем роликам альбома.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => {} } }));

import { albumCaption, openVideoBatch, settleVideoBatch } from "../src/telegram/videoBatch.js";

describe("пачка роликов в черновик", () => {
  it("итог один — после последнего ролика, с числом добавленных", () => {
    const key = `c:${Math.random()}`;
    openVideoBatch(key); openVideoBatch(key); openVideoBatch(key);
    expect(settleVideoBatch(key, true)).toBeNull();
    expect(settleVideoBatch(key, false)).toBeNull();
    expect(settleVideoBatch(key, true)).toBe(2);
  });
  it("один ролик — 1; все упали — 0 (карточки нет)", () => {
    const one = `c:${Math.random()}`;
    openVideoBatch(one);
    expect(settleVideoBatch(one, true)).toBe(1);
    const failed = `c:${Math.random()}`;
    openVideoBatch(failed);
    expect(settleVideoBatch(failed, false)).toBe(0);
  });
});

describe("подпись альбома роликов", () => {
  it("номер из подписи первого ролика достаётся остальным роликам того же альбома", () => {
    expect(albumCaption("1", "g1", "№231")).toBe("№231");
    expect(albumCaption("1", "g1", undefined)).toBe("№231");
    expect(albumCaption("1", "g2", undefined)).toBeNull();
    expect(albumCaption("2", "g1", undefined)).toBeNull();
    expect(albumCaption("1", undefined, "  ")).toBeNull();
  });
});
