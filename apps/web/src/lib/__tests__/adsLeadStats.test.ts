import { describe, expect, it } from "vitest";
import type { AdLeadStats } from "@royal-home/shared";
import { describeLeadStats, LEAD_VS_META_HINT } from "../adsView";

/**
 * Текст «клиентов в CRM: N · цена клиента X» (волна 1 рекламы, 03.10.2026).
 * Главное правило: ноль клиентов при расходе — «клиентов в CRM нет», а не «0 с. за клиента».
 */
const stats = (extra: Partial<AdLeadStats> = {}): AdLeadStats => ({
  leads: 3,
  showings: 2,
  deals: 1,
  commissionTjs: 500,
  costPerLeadTjs: 120,
  costPerShowingTjs: 180,
  costPerLeadMeta: 45,
  romi: 0.4,
  ...extra,
});

describe("describeLeadStats", () => {
  it("сервер не прислал поле — нечего показывать", () => {
    expect(describeLeadStats(undefined, 100)).toBeNull();
    expect(describeLeadStats(null, 100)).toBeNull();
  });

  it("клиенты есть: счётчик и цена клиента, воронка дальше", () => {
    const t = describeLeadStats(stats(), 360)!;
    expect(t.noLeads).toBe(false);
    expect(t.primary).toContain("клиентов в CRM: 3");
    expect(t.primary).toContain("цена клиента");
    expect(t.funnel).toContain("до показа 2");
    expect(t.funnel).toContain("1 сделка");
    expect(t.funnel).toContain("комиссия");
  });

  it("ноль клиентов при расходе — честное «клиентов в CRM нет», без цены", () => {
    const t = describeLeadStats(
      stats({ leads: 0, showings: 0, deals: 0, commissionTjs: 0, costPerLeadTjs: null, costPerShowingTjs: null }),
      360
    )!;
    expect(t.noLeads).toBe(true);
    expect(t.primary).toBe("клиентов в CRM нет");
    expect(t.primary).not.toMatch(/с\./);
  });

  it("ноль клиентов и ноль расхода — тишина", () => {
    expect(describeLeadStats(stats({ leads: 0, showings: 0, deals: 0, commissionTjs: 0, costPerLeadTjs: null }), 0)).toBeNull();
  });

  it("клиенты без показов и сделок — воронки нет, цена клиента есть", () => {
    const t = describeLeadStats(stats({ showings: 0, deals: 0, commissionTjs: 0 }), 360)!;
    expect(t.funnel).toBe("");
  });

  it("подсказка объясняет разницу между обращением Meta и клиентом CRM", () => {
    expect(LEAD_VS_META_HINT).toMatch(/Meta/);
    expect(LEAD_VS_META_HINT).toMatch(/CRM/);
  });
});
