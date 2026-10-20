import { describe, expect, it } from "vitest";
import { showsArchivePayoutButton } from "../dealArchivePayout";

/**
 * Находка ночной проверки №206 (24.09.2026): «Отметить выплаченной» была
 * недостижима из архива «Завершённые» — окно документов открывалось только с
 * карточек доски. Кнопка, открывающая его из архивной строки, обязана
 * повторять ровно то право, что сервер проверяет в
 * apps/api/src/routes/dealPayout.ts (POST /:id/payout):
 * `can(req, "finance.manage") || can(req, "deals.setCommission")`.
 */
describe("showsArchivePayoutButton", () => {
  it("без обоих прав — кнопки нет", () => {
    expect(showsArchivePayoutButton({ financeManage: false, dealsSetCommission: false })).toBe(false);
  });

  it("finance.manage — кнопка есть", () => {
    expect(showsArchivePayoutButton({ financeManage: true, dealsSetCommission: false })).toBe(true);
  });

  it("deals.setCommission без finance.manage — кнопка тоже есть (агент со своей комиссией)", () => {
    expect(showsArchivePayoutButton({ financeManage: false, dealsSetCommission: true })).toBe(true);
  });

  it("оба права — кнопка есть", () => {
    expect(showsArchivePayoutButton({ financeManage: true, dealsSetCommission: true })).toBe(true);
  });

  it("только finance.view (менеджер без денег, правка родительской ветки) — кнопки нет", () => {
    // finance.view открывает суммы на экране (seesMoney в Deals.tsx), но не
    // право выплатить — сервер отклонил бы попытку 403.
    expect(showsArchivePayoutButton({ financeManage: false, dealsSetCommission: false })).toBe(false);
  });
});
