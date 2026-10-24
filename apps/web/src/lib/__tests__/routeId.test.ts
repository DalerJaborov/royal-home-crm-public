import { describe, expect, it } from "vitest";
import { usableRouteId } from "../routeId";

describe("usableRouteId", () => {
  it("пропускает настоящий идентификатор", () => {
    expect(usableRouteId("c1a2b3")).toBe("c1a2b3");
  });

  it("отбрасывает пустое, undefined и литералы из строки пути", () => {
    expect(usableRouteId(undefined)).toBeUndefined();
    expect(usableRouteId(null)).toBeUndefined();
    expect(usableRouteId("")).toBeUndefined();
    expect(usableRouteId("  ")).toBeUndefined();
    expect(usableRouteId("undefined")).toBeUndefined();
    expect(usableRouteId("null")).toBeUndefined();
  });
});
