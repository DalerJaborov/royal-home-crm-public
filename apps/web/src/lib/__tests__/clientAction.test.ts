import { describe, expect, it } from "vitest";
import { clientAction } from "../clientAction";

const NOW = Date.parse("2026-10-06T10:00:00Z");
const base = {
  kind: "BUYER" as const,
  status: "CONTACTED" as const,
  workStatus: "ACTIVE" as const,
  pendingAcceptance: false,
  escalatedAt: null,
  acceptedAt: "2026-10-01T10:00:00Z",
  firstContactAt: "2026-10-01T11:00:00Z",
  unread: false,
  nextStep: null,
  deletedAt: null,
  hiddenReason: null,
};

describe("clientAction: один чип-действие по приоритету", () => {
  it("нет дела, нет чипа", () => {
    expect(clientAction(base, NOW, false)).toBeNull();
  });
  it("непринятый лид у держателя: принять лид", () => {
    expect(clientAction({ ...base, pendingAcceptance: true }, NOW, true)?.id).toBe("accept");
  });
  it("непринятый лид глазами руководителя: не зовёт принимать", () => {
    expect(clientAction({ ...base, pendingAcceptance: true }, NOW, false)?.id).toBe("waiting");
    expect(clientAction({ ...base, pendingAcceptance: true, escalatedAt: "x" }, NOW, false)?.tone).toBe("crit");
  });
  it("просроченный шаг важнее непрочитанного", () => {
    const c = { ...base, unread: true, nextStep: { nextAction: "позвонить", nextActionDate: "2026-10-05T10:00:00Z" } };
    expect(clientAction(c, NOW, false)?.id).toBe("call-now");
  });
  it("будущий шаг чипа не даёт", () => {
    const c = { ...base, nextStep: { nextAction: "показ", nextActionDate: "2026-10-07T10:00:00Z" } };
    expect(clientAction(c, NOW, false)).toBeNull();
  });
  it("непрочитанное: ответить", () => {
    expect(clientAction({ ...base, unread: true }, NOW, false)?.id).toBe("reply");
  });
  it("новый принятый без попытки связаться: первый звонок", () => {
    expect(clientAction({ ...base, status: "NEW", firstContactAt: null }, NOW, false)?.id).toBe("first-call");
  });
  it("горячий сам по себе чипа не даёт", () => {
    expect(clientAction({ ...base, status: "HOT" }, NOW, false)).toBeNull();
  });
  it("неактивный и прочие обращения без чипа", () => {
    expect(clientAction({ ...base, workStatus: "INACTIVE", unread: true }, NOW, false)).toBeNull();
    expect(clientAction({ ...base, kind: "OTHER", unread: true }, NOW, false)).toBeNull();
  });
});
