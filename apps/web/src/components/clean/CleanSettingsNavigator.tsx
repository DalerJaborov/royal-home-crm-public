import { useState } from "react";
import { ArrowRight, Search, X } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { SETTINGS_TABS, type SettingsTabId } from "../../lib/settingsTabs";
import { CLEAN_SETTINGS_LABELS, cleanSettingsHref, cleanSettingsSearchHref, cleanSettingsTasks, findCleanSettingsTasks, type CleanSettingsTask } from "../../lib/cleanSettingsTasks";
import { CButton, CLink } from "./ui";

export function CleanSettingsNavigator({ active, task, role, search }: {
  active: SettingsTabId | null; task?: CleanSettingsTask; role?: string; search: string;
}) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const searching = query.trim().length > 0;
  const tasks = active ? cleanSettingsTasks(active, role) : [];
  const results = searching ? findCleanSettingsTasks(query, role) : [];
  return (
    <section className="clean-settings-navigator" aria-label="Навигация по настройкам">
      <div className="clean-settings-tools">
        {active && <CLink to={cleanSettingsHref(null, search)} variant="soft" onClick={() => setQuery("")}>Все настройки</CLink>}
        <label className="clean-settings-search">
          <Search className="size-5 shrink-0" aria-hidden />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск: комиссия, звонки…" aria-label="Найти настройку" />
          {query && <CButton variant="soft" size="icon" aria-label="Очистить поиск" onClick={() => setQuery("")}><X /></CButton>}
        </label>
      </div>
      {searching ? (
        <div className="clean-settings-results">
          <p role="status">Найдено блоков: {results.length}</p>
          {results.map((entry) => <Link key={`${entry.tab}:${entry.id}`} to={cleanSettingsSearchHref(entry, query, search)} onClick={() => setQuery("")} className="clean-settings-task-row">
            <span><strong>{entry.title}</strong><small>{CLEAN_SETTINGS_LABELS[entry.tab]} · {entry.hint}</small></span><ArrowRight aria-hidden />
          </Link>)}
          {results.length === 0 && <p>Ничего не найдено. Попробуйте «комиссия», «СМС» или «пауза». Поиск находит названия и назначение настроек, а не значения полей.</p>}
        </div>
      ) : active ? (
        <div className="clean-settings-selectors">
          <label>Раздел<select aria-label="Раздел настроек" value={active} onChange={(event) => navigate(cleanSettingsHref(event.target.value as SettingsTabId, search))}>
            {SETTINGS_TABS.map((tab) => <option key={tab.id} value={tab.id}>{CLEAN_SETTINGS_LABELS[tab.id]}</option>)}
          </select></label>
          {tasks.length > 1 && <label>Что настроить<select aria-label="Блок настроек" value={task?.id ?? ""} onChange={(event) => navigate(cleanSettingsHref(active, search, event.target.value))}>
            {tasks.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
          </select></label>}
        </div>
      ) : (
        <div className="clean-settings-directory">
          <p>Что вы хотите настроить?</p>
          <div className="clean-settings-categories">
            {SETTINGS_TABS.map((tab) => {
              const Icon = tab.icon;
              const entries = cleanSettingsTasks(tab.id, role);
              return <Link key={tab.id} to={cleanSettingsHref(tab.id, search)} className="clean-settings-category">
                <Icon aria-hidden /><span><strong>{CLEAN_SETTINGS_LABELS[tab.id]}</strong><small>{entries.map((entry) => entry.title).join(" · ")}</small></span><ArrowRight aria-hidden />
              </Link>;
            })}
          </div>
          <p className="clean-settings-help">Личные данные, тема и способы входа — в «Моём профиле». Здесь настраиваются общие правила компании.</p>
        </div>
      )}
    </section>
  );
}
