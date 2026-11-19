import { describe, expect, it } from "vitest";
import { shrinkConversation, shrinkToolResult, MAX_SHRINK_RETRIES, type ShrinkContent } from "../src/ai/assistant/requestShrink.js";
import { assistantLimitCode, assistantLimitText } from "../src/ai/assistant/limitText.js";
import { AssistantAttemptLimitError } from "../src/ai/assistant/attemptLimit.js";

/**
 * Сжатие запроса помощницы (19.11.2026): чистые функции, без базы и без сети.
 * Сквозной ход с настоящей денежной защитой — assistant-oversized-request.test.ts.
 */

const list = (n: number) => ({ total: n, items: Array.from({ length: n }, (_, i) => ({ n: i + 1, title: `обращение ${i + 1}`, note: "y".repeat(80) })) });
const responsePart = (name: string, result: unknown) => ({ functionResponse: { name, response: { result } } });
const resultOf = (part: Record<string, unknown>) => (part.functionResponse as { response: { result: unknown } }).response.result;

describe("shrinkToolResult", () => {
  it("leaves a result that fits untouched", () => {
    expect(shrinkToolResult(list(3), 10_000)).toBeNull();
  });
  it("cuts the heaviest list from the end and tells the model how many are shown", () => {
    const cut = shrinkToolResult(list(200), 5_000)!;
    const value = cut.value as { total: number; items: { n: number }[]; _обрезано: string };
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(5_000);
    expect(cut.total).toBe(200);
    expect(value.items.length).toBe(cut.shown);
    expect(value.items[0].n).toBe(1); // порядок сохранён — остаются первые
    expect(value.total).toBe(200);
    expect(value._обрезано).toContain(`показаны первые ${cut.shown} из 200`);
  });
  it("wraps a top-level array and cuts a nested one", () => {
    const top = shrinkToolResult(list(100).items, 3_000)!;
    expect(top.value).toMatchObject({ items: expect.any(Array), _обрезано: expect.stringContaining("из 100") });
    const nested = shrinkToolResult({ summary: "день", data: { rows: list(100).items } }, 3_000)!;
    expect((nested.value as { data: { rows: unknown[] } }).data.rows.length).toBe(nested.shown);
  });
  it("without any list keeps the beginning with an honest note", () => {
    const cut = shrinkToolResult({ text: "z".repeat(20_000) }, 2_000)!;
    expect(JSON.stringify(cut.value).length).toBeLessThanOrEqual(2_000);
    expect(cut.value).toMatchObject({ _обрезано: expect.stringContaining("сузить вопрос") });
  });
});

describe("shrinkConversation", () => {
  function conversation(history: number, bigN = 400): ShrinkContent[] {
    const old: ShrinkContent[] = [];
    for (let i = 0; i < history; i++) {
      old.push({ role: "user", parts: [{ text: `старый вопрос ${i} ${"q".repeat(3_000)}` }] });
      old.push({ role: "model", parts: [{ text: `старый ответ ${i} ${"a".repeat(3_000)}` }] });
    }
    return [
      ...old,
      { role: "user", parts: [{ text: "Покажи подробный список" }] },
      { role: "model", parts: [{ functionCall: { name: "a", args: {} } }, { functionCall: { name: "b", args: {} } }] },
      { role: "user", parts: [responsePart("a", list(bigN)), responsePart("b", list(30))] },
    ];
  }

  it("cuts the biggest tool result first, keeps the question and the call pairs", () => {
    const conv = conversation(0);
    const chars = JSON.stringify(conv).length;
    const report = shrinkConversation(conv, 0, { inputTokens: 80_000, requestChars: chars + 20_000, limitTokens: 65_536 }, 1);
    expect(report.changed).toBe(true);
    expect(report.droppedHistory).toBe(0);
    expect(report.truncated.map((t) => t.name)).toEqual(["a"]);
    expect(conv).toHaveLength(3);
    expect((resultOf(conv[2].parts[0]) as { items: unknown[] }).items.length).toBeLessThan(400);
    expect((resultOf(conv[2].parts[1]) as { items: unknown[] }).items).toHaveLength(30);
  });

  it("drops the oldest history when tool results are already small; starts with the human", () => {
    const conv = conversation(6, 5);
    const protectedFrom = 12;
    const report = shrinkConversation(conv, protectedFrom, { inputTokens: 70_000, requestChars: 140_000, limitTokens: 65_536 }, 1);
    expect(report.droppedHistory).toBeGreaterThan(0);
    expect(conv[0].role).toBe("user");
    expect(conv.at(-3)!.parts[0]).toEqual({ text: "Покажи подробный список" });
    expect(conv.at(-2)!.parts.every((p) => "functionCall" in p)).toBe(true);
  });

  it("nothing left to shrink — reports no change (caller answers «сузьте вопрос»)", () => {
    const conv: ShrinkContent[] = [{ role: "user", parts: [{ text: "вопрос" }] }];
    expect(shrinkConversation(conv, 0, { inputTokens: 90_000, requestChars: 200_000, limitTokens: 65_536 }, 2).changed).toBe(false);
    expect(MAX_SHRINK_RETRIES).toBe(2);
  });
});

describe("truthful text for every refusal reason", () => {
  it.each([
    ["input_too_large", "too_large"], ["attempt_cap", "too_large"], ["money_turn", "too_large"],
    ["money_daily", "daily_limit"], ["attempts_daily", "daily_limit"],
    ["accounting_unavailable", "unavailable"], ["policy_expired", "unavailable"], ["unsupported_request", "unavailable"],
    ["day_rollover", "internal"], ["aborted", "aborted"],
  ] as const)("%s → %s", (reason, code) => {
    expect(assistantLimitCode(reason)).toBe(code);
  });
  it("side paths (files, voice, drafts, receipts) get the same words", () => {
    expect(assistantLimitText(new AssistantAttemptLimitError("money_daily"), "tg")).toBe(
      "Имрӯз ҳадди хароҷоти ИИ тамом шуд, пагоҳ идома медиҳем. Ба роҳбар хабар дода шуд.",
    );
    expect(assistantLimitText(new AssistantAttemptLimitError("input_too_large"))).toMatch(/^Ответ получается слишком большим/);
    expect(assistantLimitText(new Error("other"))).toBeNull();
    for (const text of [assistantLimitText(new AssistantAttemptLimitError("accounting_unavailable")), assistantLimitText(new AssistantAttemptLimitError("money_turn"))]) {
      expect(text).not.toMatch(/—/); // без длинного тире
    }
  });
});
