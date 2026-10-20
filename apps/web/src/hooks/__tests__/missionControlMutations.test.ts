import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { approveDealBody, invalidateAfterClientTransfer } from "../useMissionControl";
import { invalidateAfterDealChange } from "../useDeals";

/**
 * Пульт: передача клиента и одобрение сделки (глубокая проверка 02.10.2026, F14).
 *
 * 1. «Передать» с пульта, экрана клиентов и телефона гасил только
 *    ["mission-control"] — строка «ждёт агента… Передать» в списке клиентов
 *    и открытая карточка висели до живого события.
 * 2. Одобрение сделки не передавало version — замок от одновременной правки
 *    (409 на сервере) на этом пути не работал.
 */
describe("передача клиента гасит и списки клиентов, и карточку", () => {
  it("помечает устаревшими пульт, список клиентов, сводку и карточку", () => {
    const qc = new QueryClient();
    for (const key of [["mission-control"], ["clients", {}], ["clients", "summary"], ["client", "c1"]]) qc.setQueryData(key, {});
    invalidateAfterClientTransfer(qc);
    for (const key of [["mission-control"], ["clients", {}], ["clients", "summary"], ["client", "c1"]]) {
      expect(qc.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    }
  });
});

describe("одобрение сделки несёт версию", () => {
  it("version уходит в теле, если известна", () => {
    expect(approveDealBody(7)).toEqual({ stage: "COMPLETED", version: 7 });
  });
  it("без версии — как раньше", () => {
    expect(approveDealBody(undefined)).toEqual({ stage: "COMPLETED" });
  });
});

describe("изменение сделки обновляет все связанные финансовые срезы", () => {
  it("сбрасывает текущий и исторический прогноз, сводки, pulse и пульт", () => {
    const qc = new QueryClient();
    const keys = [
      ["finance-summary", 6], ["finance-summary", 12],
      ["finance-forecast", "current"], ["finance-forecast", "2026-10"],
      ["expenses", "pulse"], ["expenses", "forecast"], ["expenses", "2026-10"],
      ["mission-control", "live"], ["mission-control", "zones"],
      ["deals", "pending-approval"], ["property", "42"], ["client", "7"],
    ];
    for (const key of keys) qc.setQueryData(key, {});
    qc.setQueryData(["unrelated-settings"], {});
    invalidateAfterDealChange(qc);
    for (const key of keys) {
      expect(qc.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    }
    expect(qc.getQueryState(["unrelated-settings"])?.isInvalidated).toBe(false);
  });
});
