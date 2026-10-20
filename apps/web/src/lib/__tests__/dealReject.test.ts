import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dealRejectBody } from "../dealReject";

/** «Вернуть на доработку» в Сделках всегда давало ошибку (аудит 23.09.2026, №35). */
describe("возврат сделки на доработку", () => {
  it("уходит только с причиной — без неё сервер отвечает 400", () => {
    expect(dealRejectBody("  ")).toBeNull();
    expect(dealRejectBody("ок")).toBeNull();
    expect(dealRejectBody(" комиссия не та ")).toEqual({ stage: "CONTRACT_SIGNED", rejectReason: "комиссия не та" });
  });

  it("на доске сделок нет возврата без причины", () => {
    const src = readFileSync(fileURLToPath(new URL("../../pages/Deals.tsx", import.meta.url)), "utf8");
    expect(src).not.toMatch(/body:\s*\{\s*stage:\s*"CONTRACT_SIGNED"\s*\}/);
  });
});
