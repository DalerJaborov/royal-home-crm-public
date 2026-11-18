import { describe, expect, it } from "vitest";
import { SETTINGS_TABS } from "../settingsTabs";
import { CLEAN_SETTINGS_GROUPS, CLEAN_SETTINGS_LABELS, cleanSettingsGroupSub, cleanSettingsTasks } from "../cleanSettingsTasks";

/**
 * Подпись группы в списке настроек «Нового вида» (18.11.2026, пачка debt): была
 * склейкой всех подразделов — у «ИИ-помощника» до шести строк. Теперь короткая фраза
 * `shortLabel`, заданная рядом с названием группы; полный список — внутри группы.
 */
describe("короткие подписи групп настроек", () => {
  it.each(SETTINGS_TABS.map((tab) => tab.id))("%s: короткая подпись задана, до 40 знаков, не склейка подразделов", (id) => {
    const short = CLEAN_SETTINGS_GROUPS[id].shortLabel;
    expect(short?.trim()).toBeTruthy();
    const extra = CLEAN_SETTINGS_GROUPS[id].directorExtra ?? "";
    expect((short! + extra).length).toBeLessThanOrEqual(40);
    expect(short).not.toContain(" · ");
    expect(cleanSettingsGroupSub(id, "DIRECTOR")).toBe(short + extra);
    expect(cleanSettingsGroupSub(id, "ADMIN")).toBe(short);
  });
  it("«сайт» в подписи системной группы — только у директора (подраздел «Управление сайтом» видит он один)", () => {
    expect(cleanSettingsGroupSub("system", "DIRECTOR")).toContain("сайт");
    expect(cleanSettingsGroupSub("system", "ADMIN")).not.toContain("сайт");
    expect(cleanSettingsTasks("system", "ADMIN").some((t) => t.id === "website")).toBe(false);
    expect(cleanSettingsTasks("system", "DIRECTOR").some((t) => t.id === "website")).toBe(true);
  });
  it("названия групп не изменились (одно место: CLEAN_SETTINGS_GROUPS)", () => {
    expect(CLEAN_SETTINGS_LABELS.bot).toBe("ИИ-помощник");
    expect(Object.keys(CLEAN_SETTINGS_LABELS).sort()).toEqual(SETTINGS_TABS.map((tab) => tab.id).sort());
  });
  it("без короткой подписи — прежняя полная (подразделы через точку)", () => {
    const saved = CLEAN_SETTINGS_GROUPS.bot.shortLabel;
    try {
      delete CLEAN_SETTINGS_GROUPS.bot.shortLabel;
      expect(cleanSettingsGroupSub("bot", "DIRECTOR")).toBe(cleanSettingsTasks("bot", "DIRECTOR").map((t) => t.title).join(" · "));
    } finally {
      CLEAN_SETTINGS_GROUPS.bot.shortLabel = saved;
    }
  });
});
