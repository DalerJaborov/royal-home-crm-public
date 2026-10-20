import { describe, expect, it } from "vitest";
import type { PermissionId } from "@royal-home/shared";
import { canViewPropertyHistory } from "../propertyHistoryVisible";

/** Находка №147: сайт не должен быть уже сервера (routes/auditLog.ts). */
const has = (...granted: PermissionId[]) => (p: PermissionId) => granted.includes(p);

describe("canViewPropertyHistory", () => {
  it("общий журнал открывает историю любого объекта", () => {
    expect(canViewPropertyHistory(has("auditLog.view"), false)).toBe(true);
  });

  it("ответственный видит историю своего объекта без особых прав", () => {
    expect(canViewPropertyHistory(has(), true)).toBe(true);
  });

  it("маркетинг (properties.viewOwners) видит историю чужого объекта", () => {
    expect(canViewPropertyHistory(has("properties.viewOwners"), false)).toBe(true);
  });

  it("монтажёр (properties.editForeign без viewOwners) видит историю чужого объекта", () => {
    expect(canViewPropertyHistory(has("properties.editForeign"), false)).toBe(true);
  });

  it("рядовой сотрудник без ответственности и без этих прав — не видит", () => {
    expect(canViewPropertyHistory(has("clients.viewAll"), false)).toBe(false);
  });
});
