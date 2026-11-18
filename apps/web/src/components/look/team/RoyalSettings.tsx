import { useState } from "react";
import { ChevronLeft, Search, UserCircle, X } from "lucide-react";
import { Link } from "react-router-dom";
import { SETTINGS_TABS, type SettingsTabId } from "../../../lib/settingsTabs";
import {
  CLEAN_SETTINGS_LABELS, cleanSettingsHref, cleanSettingsSearchHref, cleanSettingsTasks, findCleanSettingsTasks,
  resolveCleanSettingsTask, type CleanSettingsTask,
} from "../../../lib/cleanSettingsTasks";
import { SettingsTabs } from "../../SectionTabs";
import { CleanSettingsSectionJump } from "../../clean/CleanSettingsSectionJump";
import { CleanSettingsTaskContent } from "../../settings/SettingsTabContent";
import { RhGroup } from "../ui";
import { RyChevron, TeamCircle, type TeamIconName } from "./parts";
import { useMobileUx } from "../../../hooks/useMobileUx";
import { RoyalSection } from "../clients/RoyalSection";

/**
 * НАСТРОЙКИ В «НОВОМ ВИДЕ» (18.11.2026, макет `screenSettings` / `settingsGroupBody`).
 *
 * Только навигация и оформление: те же группы (SETTINGS_TABS), те же блоки
 * (cleanSettingsTasks), тот же поиск (findCleanSettingsTasks), те же адреса
 * (?tab=&task=&section=) и те же формы внутри (CleanSettingsTaskContent) —
 * значения, проверки, права и сохранение живут в них и не тронуты.
 *
 * Телефон: список групп → экран группы со стрелкой «Настройки».
 * ПК: список слева, открытая группа справа; без выбора справа первая группа
 * (как в макете), адрес при этом не меняется.
 */
const GROUP_ICON: Record<SettingsTabId, TeamIconName> = {
  agency: "storefront", money: "banknote", leads: "inbox", matching: "map-pin",
  team: "users-round", channels: "messages-square", bot: "bot", system: "shield-check",
};
const GROUP_TONE = ["a0", "a2", "a1", "a5", "a4", "a3", "a0", "a2"] as const;
/** Блоки, где можно необратимо поменять данные: в списке блоков — отдельно, последними. */
const DANGER_TASKS = new Set(["system/data", "system/website"]);

export function RoyalSettings({ active, role, search, params }: {
  active: SettingsTabId | null; role?: string; search: string; params: URLSearchParams;
}) {
  const mobile = useMobileUx();
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  // ПК без выбора — первая группа справа (макет); адрес не трогаем.
  const shown: SettingsTabId | null = active ?? (mobile ? null : "agency");
  const task = shown ? resolveCleanSettingsTask(shown, params, role) : undefined;
  const groupOpen = mobile && active !== null;

  const searchBox = (
    <label className="ry-search">
      <Search size={22} strokeWidth={2} aria-hidden="true" />
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder="Поиск по настройкам" aria-label="Найти настройку" />
      {query && (
        <button type="button" className="ry-search-clear" aria-label="Очистить поиск" onClick={() => setQuery("")}>
          <X size={20} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </label>
  );

  const list = searching ? (
    <SearchResults query={query} role={role} search={search} onPick={() => setQuery("")} />
  ) : (
    <>
      <RhGroup label="Группы настроек">
        {SETTINGS_TABS.map((tab, index) => (
          <Link key={tab.id} to={cleanSettingsHref(tab.id, search)} className="ry-row ry-row-link"
            aria-current={!mobile && shown === tab.id ? "page" : undefined}>
            <TeamCircle icon={GROUP_ICON[tab.id]} tone={GROUP_TONE[index % GROUP_TONE.length]} />
            <span className="ry-row-text">
              <span className="ry-row-title">{CLEAN_SETTINGS_LABELS[tab.id]}</span>
              <span className="ry-row-sub">{cleanSettingsTasks(tab.id, role).map((entry) => entry.title).join(" · ")}</span>
            </span>
            <span className="ry-row-right"><RyChevron /></span>
          </Link>
        ))}
      </RhGroup>
      <RhGroup label="Личное">
        <Link to="/profile" className="ry-row ry-row-link">
          <span className="ry-circle" data-tone="a3" aria-hidden="true"><UserCircle size={24} strokeWidth={1.8} /></span>
          <span className="ry-row-text">
            <span className="ry-row-title">Мой профиль</span>
            <span className="ry-row-sub">Тема, вход и личные данные</span>
          </span>
          <span className="ry-row-right"><RyChevron /></span>
        </Link>
      </RhGroup>
    </>
  );

  if (groupOpen && active) {
    return (
      <RoyalSection name="team"><div className="rh2 screens clean-settings-page ry-set" data-view="group" data-ry-section="team">
        <div className="scr">
          <Link to={cleanSettingsHref(null, search)} className="ry-back"><ChevronLeft size={22} strokeWidth={2} aria-hidden="true" />Настройки</Link>
          <h1 className="ry-title">{CLEAN_SETTINGS_LABELS[active]}</h1>
          {task && <GroupBody group={active} task={task} role={role} search={search} params={params} />}
        </div>
      </div></RoyalSection>
    );
  }

  return (
    <RoyalSection name="team"><div className="rh2 screens clean-settings-page ry-set" data-view={mobile ? "list" : "split"} data-ry-section="team">
      <div className="scr">
        <h1 className="ry-title" data-dup>Настройки</h1>
        <div className="ry-set-tabs"><SettingsTabs /></div>
        {searchBox}
        {mobile ? list : (
          <div className="ry-set-wrap">
            <nav className="ry-set-nav" aria-label="Группы настроек">{list}</nav>
            <div className="ry-set-main">
              {shown && task && (
                <>
                  <h2 className="ry-set-h">{CLEAN_SETTINGS_LABELS[shown]}</h2>
                  <GroupBody group={shown} task={task} role={role} search={search} params={params} />
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div></RoyalSection>
  );
}

function SearchResults({ query, role, search, onPick }: { query: string; role?: string; search: string; onPick: () => void }) {
  const results = findCleanSettingsTasks(query, role);
  if (results.length === 0) {
    return <div className="ry-state" role="status">Ничего не нашлось</div>;
  }
  return (
    <RhGroup label={`Найдено: ${results.length}`}>
      {results.map((entry) => (
        <Link key={`${entry.tab}:${entry.id}`} to={cleanSettingsSearchHref(entry, query, search)} onClick={onPick} className="ry-row ry-row-link">
          <TeamCircle icon={GROUP_ICON[entry.tab]} tone="a0" />
          <span className="ry-row-text">
            <span className="ry-row-title">{entry.title}</span>
            <span className="ry-row-sub">{CLEAN_SETTINGS_LABELS[entry.tab]}</span>
          </span>
          <span className="ry-row-right"><RyChevron /></span>
        </Link>
      ))}
    </RhGroup>
  );
}

/** Открытая группа: блоки группы таблетками (опасные — последними и красным), затем формы блока. */
function GroupBody({ group, task, role, search, params }: {
  group: SettingsTabId; task: CleanSettingsTask; role?: string; search: string; params: URLSearchParams;
}) {
  const tasks = cleanSettingsTasks(group, role);
  const ordered = [...tasks.filter((entry) => !DANGER_TASKS.has(`${group}/${entry.id}`)), ...tasks.filter((entry) => DANGER_TASKS.has(`${group}/${entry.id}`))];
  return (
    <section className="sset-body ry-set-body" aria-label={`Параметры: ${CLEAN_SETTINGS_LABELS[group]}`}>
      {ordered.length > 1 && (
        <nav className="ry-set-tasks" aria-label="Что настроить">
          {ordered.map((entry) => (
            <Link key={entry.id} to={cleanSettingsHref(group, search, entry.id)} className="ry-pill"
              aria-current={entry.id === task.id ? "page" : undefined}
              data-danger={DANGER_TASKS.has(`${group}/${entry.id}`) || undefined}>
              {entry.title}
            </Link>
          ))}
        </nav>
      )}
      <div className="clean-settings-task-heading ry-task-head"><h2>{task.title}</h2><p>{task.hint}</p></div>
      <CleanSettingsSectionJump panelKey={`${group}/${task.id}`} target={params.get("section")} />
      <CleanSettingsTaskContent key={`${group}/${task.id}`} task={task} agentRole={role} />
    </section>
  );
}
