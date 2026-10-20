import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nextEnabledIds } from "../../../lib/coverTemplateSelection";

/** Аудит 04.10.2026, WEB-PAGES11: второй клик по отметке шаблона отменял первый. */
const t = (id: string, enabled: boolean) => ({ id, enabled });

describe("список «участвует в выборе»", () => {
  it("снятие отметки убирает только свой шаблон", () => {
    expect(nextEnabledIds([t("A", true), t("B", true), t("C", true)], "B", false)).toEqual(["A", "C"]);
  });

  it("с обновлённым списком второе снятие не возвращает первое", () => {
    const afterFirst = [t("A", true), t("B", false), t("C", true)];
    expect(nextEnabledIds(afterFirst, "C", false)).toEqual(["A"]);
  });

  it("со СТАРЫМ списком второе снятие вернуло бы B: поэтому список перечитывается", () => {
    const stale = [t("A", true), t("B", true), t("C", true)];
    expect(nextEnabledIds(stale, "C", false)).toEqual(["A", "B"]);
  });

  it("последний участник не снимается", () => {
    expect(nextEnabledIds([t("A", true), t("B", false)], "A", false)).toBeNull();
  });

  it("включение не задваивает", () => {
    expect(nextEnabledIds([t("A", true), t("B", false)], "A", true)).toEqual(["A"]);
    expect(nextEnabledIds([t("A", true), t("B", false)], "B", true)).toEqual(["A", "B"]);
  });
});

describe("CoverTemplatesSection", () => {
  const src = readFileSync(fileURLToPath(new URL("../CoverTemplatesSection.tsx", import.meta.url)), "utf8");

  it("после каждой правки настроек перечитывает список шаблонов", () => {
    expect(src).toContain('invalidateQueries({ queryKey: ["settings", "cover-templates"] })');
  });

  it("не даёт кликать, пока список перечитывается", () => {
    expect(src).toContain("busy");
  });
});
