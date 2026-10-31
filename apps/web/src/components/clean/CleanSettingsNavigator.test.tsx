import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { SETTINGS_TABS } from "../../lib/settingsTabs";
import { SETTINGS_SECTIONS } from "../../lib/settingsSections";
import { CLEAN_SETTINGS_TASKS, CLEAN_SETTINGS_LABELS, cleanSettingsHref, cleanSettingsSearchHref, cleanSettingsTasks, findCleanSettingsTasks, resolveCleanSettingsTask } from "../../lib/cleanSettingsTasks";
import { CleanSettingsNavigator } from "./CleanSettingsNavigator";

describe("Clean settings tasks", () => {
  it("retains all categories and unique destinations", () => {
    expect([...new Set(CLEAN_SETTINGS_TASKS.map((task) => task.tab))]).toEqual(SETTINGS_TABS.map((tab) => tab.id));
    expect(new Set(CLEAN_SETTINGS_TASKS.map((task) => `${task.tab}/${task.id}`)).size).toBe(CLEAN_SETTINGS_TASKS.length);
    const html = renderToStaticMarkup(<MemoryRouter><CleanSettingsNavigator active={null} role="ADMIN" search="shell=clean" /></MemoryRouter>);
    for (const tab of SETTINGS_TABS) { expect(html).toContain(CLEAN_SETTINGS_LABELS[tab.id]); expect(html).toContain(`href="/settings?shell=clean&amp;tab=${tab.id}"`); }
  });
  it.each([
    ["комиссия", "money/commission"], ["курс доллара", "money/currency"],
    ["Бездействие по клиенту", "leads/deadlines"], ["Распределение лидов", "leads/distribution"],
    ["ARI", "channels/phone"], ["YouTube Shorts", "channels/publishing"],
    ["WhatsApp", "channels/messengers"], ["Фид каталога", "channels/advertising"],
    ["ElevenLabs", "bot/voice"], ["Ключи моделей", "bot/models"],
    ["Новый интерфейс CRM", "system/workspace"], ["Подтверждение личности", "system/security"], ["СМС через Payom", "channels/sms"],
  ])("routes %s to the actual task %s", (query, destination) => {
    expect(findCleanSettingsTasks(query, "ADMIN").map((task) => `${task.tab}/${task.id}`)).toContain(destination);
  });
  it("does not leave client deadlines in money or distribution in employee accounts", () => {
    expect(findCleanSettingsTasks("Бездействие по клиенту", "ADMIN").map((task) => task.tab)).toEqual(["leads"]);
    expect([...new Set(findCleanSettingsTasks("Распределение лидов", "ADMIN").map((task) => task.tab))]).toEqual(["leads"]);
  });
  it("keeps every existing public setting topic findable after relocation", () => {
    for (const sections of Object.values(SETTINGS_SECTIONS)) for (const section of sections) for (const query of [section.title, ...(section.aliases ?? [])]) {
      expect(findCleanSettingsTasks(query, "DIRECTOR").length, query).toBeGreaterThan(0);
    }
  });
  it("excludes director-only website and staff-only rollout from unauthorized search", () => {
    for (const role of ["ADMIN", "AGENT", "SHAREHOLDER"]) expect(findCleanSettingsTasks("royalhome.tj", role)).toEqual([]);
    expect(findCleanSettingsTasks("royalhome.tj", "DIRECTOR").map((task) => task.id)).toEqual(["website"]);
    expect(cleanSettingsTasks("bot", "SHAREHOLDER").some((task) => task.id === "rollout")).toBe(false);
  });
  it("preserves old URLs and opens the matching OAuth result", () => {
    expect(resolveCleanSettingsTask("money", new URLSearchParams(), "ADMIN")?.id).toBe("commission");
    expect(resolveCleanSettingsTask("system", new URLSearchParams("task=website"), "ADMIN")?.id).toBe("monitoring");
    expect(resolveCleanSettingsTask("channels", new URLSearchParams("ads=error"), "ADMIN")?.id).toBe("advertising");
    for (const provider of ["tiktok", "threads"]) expect(resolveCleanSettingsTask("channels", new URLSearchParams(`${provider}=connected`), "ADMIN")?.id).toBe("publishing");
    expect(cleanSettingsHref("money", "shell=clean&tab=channels&ads=error&message=failed&task=phone&section=old", "currency")).toBe("/settings?shell=clean&tab=money&task=currency");
    expect(cleanSettingsHref(null, "tab=money&task=currency")).toBe("/settings");
  });
  it("links search to the heading instead of a broad unrelated category", () => {
    const task = findCleanSettingsTasks("Бездействие по клиенту", "ADMIN")[0];
    const url = new URL(cleanSettingsSearchHref(task, "Бездействие по клиенту", "shell=clean"), "http://localhost");
    expect(url.searchParams.get("tab")).toBe("leads"); expect(url.searchParams.get("task")).toBe("deadlines");
    expect(url.searchParams.get("section")).toBe("Бездействие по клиенту");
  });
  it("presents two named selectors instead of competing category pills", () => {
    const task = cleanSettingsTasks("channels", "ADMIN")[0];
    const html = renderToStaticMarkup(<MemoryRouter><CleanSettingsNavigator active="channels" task={task} role="ADMIN" search="tab=channels" /></MemoryRouter>);
    expect(html).toContain('aria-label="Раздел настроек"'); expect(html).toContain('aria-label="Блок настроек"');
    expect(html).toContain("Все настройки"); expect(html.match(/<select/g)).toHaveLength(2);
  });
});
