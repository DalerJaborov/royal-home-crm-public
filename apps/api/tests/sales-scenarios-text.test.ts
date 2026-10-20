import { describe, expect, it } from "vitest";
import { DEFAULT_SCENARIO_ID, SALES_SCENARIOS } from "../src/ai/salesScenarios.js";

/**
 * Тексты сравниваемых манер продажи.
 *
 * Сравнение имеет смысл, только пока манеры РАЗЛИЧАЮТСЯ ПОВЕДЕНИЕМ, а не тоном.
 * Два вежливых текста «будь дружелюбным» дадут одинаковые числа, и неделя
 * наблюдений уйдёт впустую. Поэтому тесты стерегут именно различие.
 */

const byId = (id: string) => SALES_SCENARIOS.find((s) => s.id === id)!;

describe("контрольная группа", () => {
  it("у контроля промт ПУСТОЙ — иначе не с чем сравнивать «как было»", () => {
    expect(byId(DEFAULT_SCENARIO_ID).prompt).toBe("");
  });
});

describe("манеры действительно различаются", () => {
  it("заглушек не осталось", () => {
    for (const s of SALES_SCENARIOS) {
      expect(s.prompt).not.toContain("ЗАГЛУШКА");
      expect(s.summary).not.toContain("Заглушка");
    }
  });

  it("одна манера сначала спрашивает, другая сразу показывает", () => {
    // Это и есть проверяемая гипотеза: что в Душанбе работает лучше —
    // разобраться до предложения или сразу дать конкретику.
    expect(byId("warm_consultant").prompt).toContain("два-три коротких вопроса");
    expect(byId("fast_closer").prompt).toContain("показывай конкретные варианты");
  });

  it("они по-разному подходят к моменту показа", () => {
    expect(byId("warm_consultant").prompt).toContain("после того, как клиент отозвался");
    expect(byId("fast_closer").prompt).toContain("Предлагай посмотреть рано");
  });

  it("тексты не совпадают между собой", () => {
    const prompts = SALES_SCENARIOS.map((s) => s.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);
  });
});

describe("манера не подменяет собой правила агентства", () => {
  it("ни одна манера не трогает условия сделки", () => {
    // Условия (торг, комиссия, рассрочка) живут в salesPlaybook и идут РАНЬШЕ
    // манеры. Манера может менять, КАК говорить, но не ЧТО является правдой.
    for (const s of SALES_SCENARIOS) {
      expect(s.prompt).not.toContain("комисси");
      expect(s.prompt).not.toContain("рассрочк");
      expect(s.prompt).not.toContain("процент");
    }
  });
});
