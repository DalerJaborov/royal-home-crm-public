import { describe, expect, it } from "vitest";
import { buildItems, wizardStepsLabel } from "./FabMenu";
import { WIZARD_STEPS } from "./property-wizard/types";

/**
 * Число шагов мастера — из одного места (пачка D1, 20.11.2026): в шторке «+» стояло
 * «форма в 4 шага», а мастер писал «Шаг 1 из 5». Теперь подпись берёт WIZARD_STEPS.
 */
describe("FAB: число шагов мастера объекта", () => {
  it("подпись совпадает с числом шагов, которое рисует мастер", () => {
    expect(wizardStepsLabel()).toContain(String(WIZARD_STEPS.length));
    const item = buildItems("AGENT", () => true).find((i) => i.label === "Новый объект");
    expect(item?.sub).toBe(wizardStepsLabel());
  });
});
