import { describe, expect, it } from "vitest";
import { parseRemovalChoice } from "./PropertyRemovalDialog";

describe("explicit removal reason", () => {
  it("requires a reason, and refuses unsupported reasons", () => {
    expect(parseRemovalChoice("", "")).toBeNull();
    expect(parseRemovalChoice("invented", "comment")).toBeNull();
  });
  it("requires actual detail for other or external sale", () => {
    expect(parseRemovalChoice("OTHER", "  ")).toBeNull();
    expect(parseRemovalChoice("SOLD_ELSEWHERE", "продано")).toBeNull();
    expect(parseRemovalChoice("SOLD_ELSEWHERE", "Собственник сообщил о продаже через другое агентство")).toMatchObject({ removalReason: "SOLD_ELSEWHERE" });
    expect(parseRemovalChoice("OTHER", "  Другая причина  ")).toEqual({ removalReason: "OTHER", removalComment: "Другая причина" });
  });
});
