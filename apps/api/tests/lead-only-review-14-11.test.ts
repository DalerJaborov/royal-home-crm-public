import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ревью 14.11.2026 к режиму «только заявки» (PR #165), три находки:
 * 1) «Хонаамро мехоҳам фурӯшам» (свой дом хочу продать) не должен читаться как покупатель;
 * 2) инструмента поиска нет, значит и подсказки про подбор в ход модели не попадают;
 * 3) срок разбора 6 с прерывает сам вызов, а не бросает его в фоне (иначе callAiText ещё и повторил бы).
 */
const { callGemini, logSystemError } = vi.hoisted(() => ({ callGemini: vi.fn(), logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/ai/geminiClient.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()), callGemini }));
vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError }));

import { customerTextRole } from "../src/ai/customerAgentRole.js";
import { leadOnlyIntentFallback, classifyLeadOnlyIntent } from "../src/ai/leadOnlyIntent.js";
import { callAiText } from "../src/ai/client.js";
import { customerIntakeGuidance } from "../src/ai/customerAgentCore.js";

beforeEach(() => { callGemini.mockReset(); logSystemError.mockClear(); });

type Role = ReturnType<typeof customerTextRole>;
// [текст, роль]; новую живую фразу, на которой ошиблись, дописывать строкой.
const ROLES: [string, Role][] = [
  // своё жильё + слово продажи или притяжательное: не покупатель
  ["Хонаамро мехоҳам фурӯшам", "seller"],
  ["Хонаамро мехохам фурушам", "seller"],
  ["Хавлии худамро мехоҳам фурӯшам", "seller"],
  ["Квартираамро мехоҳам фурӯхтан", "seller"],
  ["Хонаи худам мехоҳам фурӯшам", "seller"],
  ["Хонаамро мехоҳам", null],
  ["Продать свой дом хочу, дом мехоҳам продать", "seller"],
  // покупатель остаётся покупателем (аудит 14.11)
  ["Хона мехоҳам, пул дорам", "buyer"],
  ["Хона мехохам", "buyer"],
  ["хавли мехоҳам", "buyer"],
  ["Квартира мехоҳам", "buyer"],
  ["Хонаҳо мехоҳам, пул дорам", "buyer"],
  ["Хочу купить квартиру", "buyer"],
  // отрицание
  ["Хона намехоҳам", null],
];
describe("роль по тексту: «жильё + мехоҳам» (ревью 14.11, находка 1)", () => {
  it.each(ROLES)("%s -> %s", (text, role) => { expect(customerTextRole(text, false)).toBe(role); });
  it("запасной путь режима тоже не делает продавца покупателем", () => {
    expect(leadOnlyIntentFallback("Хонаамро мехоҳам фурӯшам").role).toBe("seller");
    expect(leadOnlyIntentFallback("Хона мехоҳам, пул дорам").role).toBe("buyer");
  });
});

describe("подсказка хода заявки без инструмента поиска (находка 2)", () => {
  it("с поиском подбор остаётся, без поиска про подбор ни слова", () => {
    expect(customerIntakeGuidance(true)).toContain("next missing preference");
    const off = customerIntakeGuidance(false);
    expect(off).not.toMatch(/next missing preference|answer property questions first/u);
    expect(off).toContain("do not collect search preferences");
    expect(off).toContain("seller_details");
  });
});

describe("срок разбора прерывает вызов (находка 3)", () => {
  it("по истечении срока модель получает прерванный сигнал, ответ — запасной путь", async () => {
    let seen: AbortSignal | undefined;
    const model = vi.fn((request: { signal?: AbortSignal }) => new Promise<unknown>((_, reject) => {
      seen = request.signal;
      request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const intent = await classifyLeadOnlyIntent({ current: "Хонаамро мехоҳам фурӯшам" }, model, 20);
    expect(seen).toBeDefined();
    expect(seen?.aborted).toBe(true);
    expect(intent).toMatchObject({ source: "fallback", fallbackReason: "model_unavailable", role: "seller" });
  });
  it("быстрый ответ сигнал не прерывает", async () => {
    let seen: AbortSignal | undefined;
    const model = vi.fn(async (request: { signal?: AbortSignal }) => { seen = request.signal;
      return { role: "seller", quote: "фурӯшам", hot: false, hotQuote: "" }; });
    const intent = await classifyLeadOnlyIntent({ current: "Хонаамро мехоҳам фурӯшам" }, model, 1000);
    expect(intent.source).toBe("model");
    expect(seen?.aborted).toBe(false);
  });
  it("callAiText: прерванный вызов не повторяется и не пишет ошибку", async () => {
    const controller = new AbortController();
    callGemini.mockImplementation(async () => { controller.abort(); return null; });
    expect(await callAiText({ endpoint: "t", system: "s", signal: controller.signal })).toBeNull();
    expect(callGemini).toHaveBeenCalledTimes(1);
    expect(logSystemError).not.toHaveBeenCalled();
  });
  it("callAiText без сигнала повторяет, как раньше", async () => {
    callGemini.mockResolvedValue(null);
    expect(await callAiText({ endpoint: "t", system: "s" })).toBeNull();
    expect(callGemini).toHaveBeenCalledTimes(2);
  });
});
