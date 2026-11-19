// @vitest-environment jsdom
import { cleanup, render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_TABS } from "../../../lib/settingsTabs";
import { CLEAN_SETTINGS_GROUPS, cleanSettingsGroupSub, cleanSettingsTasks } from "../../../lib/cleanSettingsTasks";

// Формы внутри группы (запросы, права, сохранение) этот тест не проверяет — только навигацию.
vi.mock("../../settings/SettingsTabContent", () => ({ CleanSettingsTaskContent: () => null }));
vi.mock("../../clean/CleanSettingsSectionJump", () => ({ CleanSettingsSectionJump: () => null }));
vi.mock("../../SectionTabs", () => ({ SettingsTabs: () => null }));
vi.mock("../../../hooks/useMobileUx", () => ({ useMobileUx: () => false }));

const { RoyalSettings } = await import("./RoyalSettings");

/**
 * Подписи групп настроек «Нового вида» (пачка debt, ревью PR 286): в списке групп —
 * короткая фраза `shortLabel` до 40 знаков, а полный перечень подразделов по-прежнему
 * рисуется внутри открытой группы — ничего не потеряно.
 */
afterEach(() => { cleanup(); });

describe("RoyalSettings: короткая подпись группы и полный перечень внутри", () => {
  it.each(SETTINGS_TABS.map((tab) => tab.id))("%s: в списке — shortLabel ≤ 40 знаков, внутри группы — все подразделы", (id) => {
    const { container } = render(
      <MemoryRouter><RoyalSettings active={id} role="DIRECTOR" search="" params={new URLSearchParams()} /></MemoryRouter>,
    );
    const nav = container.querySelector<HTMLElement>('nav[aria-label="Группы настроек"]')!;
    const row = [...nav.querySelectorAll<HTMLAnchorElement>("a.ry-row")].find((a) => a.getAttribute("href")?.includes(`tab=${id}`))!;
    const sub = row.querySelector(".ry-row-sub")!.textContent!;
    expect(sub).toBe(cleanSettingsGroupSub(id, "DIRECTOR"));
    expect(sub.startsWith(CLEAN_SETTINGS_GROUPS[id].shortLabel!)).toBe(true);
    expect(sub.length).toBeLessThanOrEqual(40);
    expect(sub).not.toContain(" · ");

    const body = container.querySelector<HTMLElement>(".ry-set-body")!;
    const tasks = cleanSettingsTasks(id, "DIRECTOR");
    if (tasks.length > 1) {
      const pills = within(body).getByRole("navigation", { name: "Что настроить" });
      for (const task of tasks) expect(within(pills).getByText(task.title)).toBeTruthy();
    } else {
      expect(within(body).getByRole("heading", { name: tasks[0].title })).toBeTruthy();
    }
  });

  it("в подписи упомянуто пропущенное по смыслу: реклама, обучение, внедрение", () => {
    expect(CLEAN_SETTINGS_GROUPS.channels.shortLabel).toMatch(/реклам/i);
    expect(CLEAN_SETTINGS_GROUPS.bot.shortLabel).toMatch(/обучени/i);
    expect(cleanSettingsGroupSub("bot", "DIRECTOR")).toMatch(/внедрени/i);
  });
});
