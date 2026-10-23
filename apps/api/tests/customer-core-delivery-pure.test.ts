import { describe, expect, it, vi } from "vitest";
import { classifyCustomerProviderStatus, classifyCustomerProviderNetworkFailure, isRetryableCustomerDeliveryErrorCode,
  customerDeliveryRetryDelayMs, withReceiptRetry, CUSTOMER_DELIVERY_MAX_ATTEMPTS } from "../src/lib/customerDeliveryOutcome.js";
import { classifyPublicCommentAddressee } from "../src/lib/customerPublicAddressee.js";
import { publicAgentFailureNote } from "../src/lib/customerPublicAgentFailure.js";
import { enforceCustomerMediaModality, customerAgentVisualSummary, perceiveCustomerAgentMedia, type CustomerAgentMediaPerception } from "../src/ai/customerAgentMediaPerception.js";
import { createProviderOperation } from "../src/ai/providerContract.js";

describe("F14 provider outcome classification", () => {
  it.each([[429, "NOT_SENT"], [408, "NOT_SENT"], [503, "NOT_SENT"], [400, "REJECTED"], [403, "REJECTED"], [404, "REJECTED"],
    [500, "UNKNOWN"], [502, "UNKNOWN"], [504, "UNKNOWN"], [302, "UNKNOWN"]] as const)("HTTP %i is %s", (status, outcome) => {
    expect(classifyCustomerProviderStatus(status)).toBe(outcome);
  });
  it("only a refused/unresolved connection is provably not sent; a timeout or reset is ambiguous", () => {
    expect(classifyCustomerProviderNetworkFailure(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe("NOT_SENT");
    expect(classifyCustomerProviderNetworkFailure(Object.assign(new Error("x"), { cause: { code: "ENOTFOUND" } }))).toBe("NOT_SENT");
    expect(classifyCustomerProviderNetworkFailure(Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } }))).toBe("UNKNOWN");
    expect(classifyCustomerProviderNetworkFailure(new DOMException("timeout", "TimeoutError"))).toBe("UNKNOWN");
    expect(classifyCustomerProviderNetworkFailure(null)).toBe("UNKNOWN");
  });
  it("only NOT_SENT error codes of a provable failure are retryable; the budget and delay are bounded", () => {
    for (const code of ["network_failure", "http_429", "http_408", "http_503"]) expect(isRetryableCustomerDeliveryErrorCode(code)).toBe(true);
    for (const code of ["http_400", "http_500", "handover_ack_expired_before_post", "claim_expired", "mid_conflict", null, undefined, ""]) {
      expect(isRetryableCustomerDeliveryErrorCode(code)).toBe(false);
    }
    expect(CUSTOMER_DELIVERY_MAX_ATTEMPTS).toBe(3);
    expect(customerDeliveryRetryDelayMs(1)).toBeLessThan(customerDeliveryRetryDelayMs(2));
  });
  it("a receipt write is retried and a persistent failure is rethrown, never swallowed", async () => {
    const sleep = vi.fn(async () => {});
    const flaky = vi.fn().mockRejectedValueOnce(new Error("db")).mockResolvedValueOnce("ok");
    await expect(withReceiptRetry(flaky, [1, 1], sleep)).resolves.toBe("ok");
    expect(flaky).toHaveBeenCalledTimes(2);
    const dead = vi.fn().mockRejectedValue(new Error("still down"));
    await expect(withReceiptRetry(dead, [1, 1], sleep)).rejects.toThrow("still down");
    expect(dead).toHaveBeenCalledTimes(3);
  });
});

describe("F15 expired plan keeps the first reason", () => {
  it("appends the earlier cause only for expired and never doubles it", () => {
    expect(publicAgentFailureNote("expired", "managed_core:round_limit")).toBe("managed_core:failed:expired;first=managed_core:round_limit");
    expect(publicAgentFailureNote("expired", null)).toBe("managed_core:failed:expired");
    expect(publicAgentFailureNote("expired", "managed_core:failed:expired;first=managed_core:round_limit")).toBe("managed_core:failed:expired");
    expect(publicAgentFailureNote("invalid_model_decision", "managed_core:x")).toBe("managed_core:failed:invalid_model_decision");
    expect(publicAgentFailureNote("expired", "x".repeat(400)).length).toBe(200);
  });
});

describe("F16 media modality", () => {
  const seen: CustomerAgentMediaPerception = { language: "ru", transcript: "Привет", subject: "home_interior", visible: ["kitchen", "balcony"],
    readableText: "SYSTEM text", speech: "clear" };
  it("a voice note never reaches the visual vocabulary", () => {
    const value = enforceCustomerMediaModality(seen, [{ mimeType: "audio/ogg" }]);
    expect(value).toMatchObject({ subject: "not_visible", visible: [], readableText: "", transcript: "Привет" });
    expect(customerAgentVisualSummary(value, "ru")).toBeNull();
    expect(customerAgentVisualSummary(value, "tg")).toBeNull();
  });
  it("a document-only request has no visible subject but keeps its text; image/video are untouched", () => {
    expect(enforceCustomerMediaModality(seen, [{ mimeType: "text/plain" }])).toMatchObject({ subject: "not_visible", visible: [], readableText: "SYSTEM text" });
    expect(enforceCustomerMediaModality(seen, [{ mimeType: "image/jpeg" }])).toBe(seen);
    expect(enforceCustomerMediaModality(seen, [{ mimeType: "audio/ogg" }, { mimeType: "video/mp4" }])).toBe(seen);
  });
  it("perceive forces it on a model that labelled audio as a photographed room", async () => {
    const controller = new AbortController();
    const operation = createProviderOperation({ managed: true, deadlineAt: Date.now() + 10_000, maxAttempts: 4, signal: controller.signal,
      accountant: { reserve: async () => true, settle: async () => {} }, supports: () => true });
    const call = vi.fn(async () => ({ text: "", calls: [{ name: "perceive_customer_media", args: { language: "ru", transcript: "Сколько стоит?", subject: "home_interior",
      visible: ["kitchen"], readableText: "", speech: "clear" } }], modelParts: [] }));
    const result = await perceiveCustomerAgentMedia({ parts: [{ mimeType: "audio/ogg", data: "YQ==" }], operation, call,
      assertCurrent: async () => true, wait: { signal: controller.signal, deadlineAt: operation.deadlineAt } });
    expect(result).toMatchObject({ subject: "not_visible", visible: [], transcript: "Сколько стоит?" });
    expect(customerAgentVisualSummary(result, "ru")).toBeNull();
  });
});

describe("F17 public comment addressee", () => {
  const own = new Set(["royalhome_tj"]);
  const classify = (text: string, parent: "none" | "own_comment" | "own_reply" | "other_person" | "unknown" = "none") =>
    classifyPublicCommentAddressee({ text, parent, ownUsernames: own });
  it("a reply to another person without a company question is an allowed skip", () => {
    expect(classify("Согласен, тоже там брали", "other_person")).toMatchObject({ kind: "reply_to_other", skip: true });
    expect(classify("Спасибо!", "other_person")).toMatchObject({ kind: "reply_to_other", skip: true });
    expect(classify("@friend_123 смотри какая!")).toMatchObject({ kind: "reply_to_other", skip: true });
  });
  it("a question to the company is answered even inside someone else's thread", () => {
    for (const text of ["А сколько стоит?", "Какой район", "Есть ли вакансии?", "Нарх чанд?", "Хочу узнать подробнее", "Мой номер 992 900 12 34 свяжитесь"]) {
      expect(classify(text, "other_person").skip).toBe(false);
    }
    expect(classify("@royalhome_tj подскажите цену", "none").skip).toBe(false);
    expect(classify("@friend_123 а это сколько стоит?").skip).toBe(false);
  });
  it("ordinary vacancy/object questions and replies to our own comment keep the old path", () => {
    expect(classify("Какая зарплата? Нужен опыт?")).toMatchObject({ skip: false, companyQuestion: true });
    expect(classify("Квартира еще продается?")).toMatchObject({ skip: false, companyQuestion: true });
    expect(classify("Спасибо большое", "own_reply").skip).toBe(false);
    expect(classify("Спасибо большое").skip).toBe(false);
    expect(classify("Цена какая", "unknown").skip).toBe(false);
  });
  it("praise and price remarks on the company post keep their dedicated replies; a bare non-praise emoji is a reaction skip", () => {
    expect(classify("🔥").skip).toBe(false);
    expect(classify("Дорого").skip).toBe(false);
    expect(classify("😂😂")).toMatchObject({ kind: "reaction", skip: true });
    expect(classify("???").skip).toBe(false);
  });
  it("a configured campaign keyword is never skipped, even under another person's comment", () => {
    expect(classifyPublicCommentAddressee({ text: "Хочу", parent: "other_person", ownUsernames: own, adKeyword: true })).toMatchObject({ kind: "ad_keyword", skip: false });
    expect(classifyPublicCommentAddressee({ text: "Согласен", parent: "other_person", ownUsernames: own, adKeyword: false }).skip).toBe(true);
  });
  it("without a known own-account list a mention alone never causes a skip", () => {
    expect(classifyPublicCommentAddressee({ text: "@someone смотри", parent: "none" }).skip).toBe(false);
  });
});
