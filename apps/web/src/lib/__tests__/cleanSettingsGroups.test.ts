import { describe, expect, it } from "vitest";
import { SETTINGS_TABS } from "../settingsTabs";
import { CLEAN_SETTINGS_GROUPS, CLEAN_SETTINGS_LABELS, CLEAN_SETTINGS_TASKS, cleanSettingsGroupSub, cleanSettingsTasks } from "../cleanSettingsTasks";

const ROLES = ["DIRECTOR", "ADMIN", "MANAGER", "HEAD_OF_SALES", "AGENT", "MARKETING", "EDITOR", "SECURITY", "SHAREHOLDER"];

/**
 * Подпись группы в списке настроек «Нового вида» (18.11.2026, пачка debt): была
 * склейкой всех подразделов — у «ИИ-помощника» до шести строк. Теперь короткая фраза
 * `shortLabel`, заданная рядом с названием группы; полный список — внутри группы.
 */
describe("короткие подписи групп настроек", () => {
  it.each(SETTINGS_TABS.map((tab) => tab.id))("%s: короткая подпись задана, до 40 знаков, не склейка подразделов", (id) => {
    const short = CLEAN_SETTINGS_GROUPS[id].shortLabel;
    expect(short?.trim()).toBeTruthy();
    expect(short).not.toContain(" · ");
    for (const role of ROLES) {
      const sub = cleanSettingsGroupSub(id, role);
      expect(sub.length, role).toBeLessThanOrEqual(40);
      // хвост подписи — ровно слова подразделов, которые эта роль видит
      const words = cleanSettingsTasks(id, role).flatMap((t) => t.groupWord ? [t.groupWord] : []);
      expect(sub, role).toBe([short, ...words].join(", "));
    }
  });
  it("подраздел, видный не всем, несёт своё слово подписи, а в shortLabel его нет (правило ролей — одно)", () => {
    const restricted = CLEAN_SETTINGS_TASKS.filter((t) => t.directorOnly || t.roles);
    expect(restricted.map((t) => t.id).sort()).toEqual(["rollout", "website"]);
    for (const task of restricted) {
      expect(task.groupWord?.trim(), task.id).toBeTruthy();
      expect(CLEAN_SETTINGS_GROUPS[task.tab].shortLabel ?? "", task.id).not.toMatch(new RegExp(task.groupWord!.slice(0, 5), "i"));
      for (const role of ROLES) {
        const sees = cleanSettingsTasks(task.tab, role).includes(task);
        expect(cleanSettingsGroupSub(task.tab, role).includes(task.groupWord!), `${task.id} ${role}`).toBe(sees);
      }
    }
    // слово только у закрытых подразделов: у открытого оно повторило бы shortLabel
    expect(CLEAN_SETTINGS_TASKS.filter((t) => t.groupWord && !t.directorOnly && !t.roles)).toEqual([]);
  });
  it("«внедрение» в подписи ИИ-помощника — только тем, кто видит подраздел (директор и администратор)", () => {
    expect(cleanSettingsGroupSub("bot", "DIRECTOR")).toBe("Ответы, голос, обучение, внедрение");
    expect(cleanSettingsGroupSub("bot", "ADMIN")).toBe("Ответы, голос, обучение, внедрение");
    expect(cleanSettingsGroupSub("bot", "MANAGER")).toBe("Ответы, голос, обучение");
    expect(cleanSettingsGroupSub("bot", undefined)).toBe("Ответы, голос, обучение");
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
