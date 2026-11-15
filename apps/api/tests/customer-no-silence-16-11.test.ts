import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CUSTOMER_NO_SAFETY_LINE_REASONS, CUSTOMER_SAFETY_LINE_REASONS, customerCoreRetryWorthwhile, customerHeldForChangedContext,
  customerSafetyLine, customerSafetyLineAllowed, customerSafetyMemory } from "../src/lib/customerNoSilence.js";
import { CUSTOMER_TURN_INTENDED_SILENCE } from "../src/lib/customerIntendedSilence.js";
import { customerReplyCallsStaff } from "../src/ai/customerAgentStaffFollowUp.js";
import { isOurBrandCaption, latinOf, silentOnForeignShare } from "../src/messengers/sharedMedia.js";

/**
 * КЛАСС «КЛИЕНТУ ТИШИНА» (аудит 16.11.2026, 11–15.11): ход ядра HELD, щит вырезал весь ответ, свой ролик Арвана
 * считался чужим. Здесь — чистые правила и сторож списков; живые ходы ядра — tests/customer-dm-agent-turn-postgres.test.ts
 * (describe «never silence»), повторный сигнал «взял и не ответил» — tests/client-waiting-alert.test.ts.
 */

describe("сторож: каждая причина HELD ядра — ровно в одном списке", () => {
  const core = readFileSync(path.join(__dirname, "../src/ai/customerAgentCore.ts"), "utf8");
  const literals = new Set([...core.matchAll(/\b(?:held|confirmCommitted)\("([a-z_]+)"/g)].map(m => m[1]));
  // held(<ternary>, cause) in the catch of the turn: effect_unknown / operation_stopped / turn_deadline / turn_unavailable
  for (const call of core.matchAll(/\bheld\((unsettledWrites[^\n]*?), cause\)/g)) {
    for (const m of call[1].matchAll(/"([a-z_]+)"/g)) literals.add(m[1]);
  }

  it("ни одной причины ядра без решения «молчать намеренно / страховочная фраза / говорить нельзя»", () => {
    expect(literals.size).toBeGreaterThan(20);
    const lists = [CUSTOMER_TURN_INTENDED_SILENCE, CUSTOMER_SAFETY_LINE_REASONS, CUSTOMER_NO_SAFETY_LINE_REASONS];
    const unclassified = [...literals].filter(reason => lists.every(list => !list.includes(reason)));
    expect(unclassified, "новая причина HELD в ядре: впишите её в lib/customerNoSilence.ts или customerIntendedSilence.ts").toEqual([]);
  });
  it("списки не пересекаются", () => {
    const all = [...CUSTOMER_TURN_INTENDED_SILENCE, ...CUSTOMER_SAFETY_LINE_REASONS, ...CUSTOMER_NO_SAFETY_LINE_REASONS];
    expect(new Set(all).size).toBe(all.length);
  });
  it("намеренное молчание никогда не превращается в страховочную фразу", () => {
    for (const reason of CUSTOMER_TURN_INTENDED_SILENCE) expect(customerSafetyLineAllowed(reason)).toBe(false);
    for (const reason of ["round_limit", "unsupported_decision_evidence", "turn_unavailable", "staff_or_supported_reply_required"]) {
      expect(customerSafetyLineAllowed(reason)).toBe(true);
    }
    for (const reason of ["effect_unknown", "customer_turn_budget_or_context", "original_context_changed", "input_limit", "что-то новое"]) {
      expect(customerSafetyLineAllowed(reason)).toBe(false);
    }
  });
});

describe("страховочная фраза — проверенные строки двери «это скажет агент»", () => {
  it("без номера просит номер один раз; дальше — без второй просьбы; с номером — агент позвонит", () => {
    const first = customerSafetyLine("tg", "none", customerSafetyMemory([]));
    expect(first).toBe("Инро аниқ агенти мо мегӯяд. Рақами телефонатонро нависед, то агенти мо занг занад.");
    const second = customerSafetyLine("tg", "none", customerSafetyMemory([first]));
    expect(second).toBe("Инро аниқ агенти мо мегӯяд.");
    expect(customerSafetyLine("ru", "scoped_contact", customerSafetyMemory([]))).toBe("Это точно подскажет наш агент. Он позвонит вам в рабочее время.");
    // every line the door produces is a staff line: the turn MUST signal the responsible person
    for (const line of [first, second]) expect(customerReplyCallsStaff(line)).toBe(true);
  });
  it("строка, которую щит вырезал бы как повтор, не выбирается", () => {
    const memory = customerSafetyMemory(["Рақами телефонатонро нависед"], line => line === "Инро аниқ агенти мо мегӯяд.");
    expect(customerSafetyLine("tg", "none", memory)).toBe("Агенти мо ҳамаи тафсилотро ба шумо мегӯяд.");
  });
});

describe("повтор хода и «клиент дописал»", () => {
  const held = (reason: string, extra: object = {}) => ({ status: "held", reason, unknownToolCalls: [], evidence: [], ...extra });
  it("сбой поставщика — один повтор; клиент дописал, запись могла пройти, квитанция, мало времени — нет", () => {
    expect(customerCoreRetryWorthwhile(held("turn_unavailable", { cause: "ProviderOperationError" }), 60_000)).toBe(true);
    expect(customerCoreRetryWorthwhile(held("turn_unavailable", { cause: "original_context_changed" }), 60_000)).toBe(false);
    expect(customerCoreRetryWorthwhile(held("turn_unavailable", { unknownToolCalls: [{}] }), 60_000)).toBe(false);
    expect(customerCoreRetryWorthwhile(held("turn_unavailable", { evidence: [{ value: { kind: "receipt" } }] }), 60_000)).toBe(false);
    expect(customerCoreRetryWorthwhile(held("turn_unavailable"), 5_000)).toBe(false);
    expect(customerCoreRetryWorthwhile(held("round_limit"), 60_000)).toBe(false);
  });
  it("переписка сменилась под ходом — слова уходят в более новый ход", () => {
    expect(customerHeldForChangedContext("turn_unavailable", "original_context_changed")).toBe(true);
    expect(customerHeldForChangedContext("original_context_changed")).toBe(true);
    expect(customerHeldForChangedContext("turn_unavailable", "ProviderOperationError")).toBe(false);
  });
});

describe("свой рекламный ролик Арвана — не чужой (медиа без текста, 16.11)", () => {
  it("имя аккаунта кириллицей узнаёт латинскую подпись и описание ролика", () => {
    expect(latinOf("Арван")).toBe("arvan");
    // настоящий текст описания ролика из переписки 44597bed (13.11, Arvan)
    expect(isOurBrandCaption("Видео представляет собой рекламный ролик агентства недвижимости «Arvan Estate» на таджикском", "Арван")).toBe(true);
    expect(isOurBrandCaption("arvan__estate", "Арван")).toBe(true);
    expect(isOurBrandCaption("Арван — продажа квартир", "Арван")).toBe(true);
    // по границе слова: чужое слово, начинающееся так же, нашим не становится
    expect(isOurBrandCaption("Arvanita games", "Арван")).toBe(false);
    expect(isOurBrandCaption("Arvan Estate", null)).toBe(false);
  });
  it("решение владельца 03.10 не тронуто: чужой ролик без слов и без признаков жилья — молчим", () => {
    expect(silentOnForeignShare({ foreignShare: true, fromAd: false, text: "", caption: null, card: null })).toBe(true);
    expect(silentOnForeignShare({ foreignShare: true, fromAd: false, text: "нархаш чанд?", caption: null, card: null })).toBe(false);
  });
});
