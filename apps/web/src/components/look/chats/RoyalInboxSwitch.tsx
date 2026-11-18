import { NavLink } from "react-router-dom";
import { useCan } from "../../../lib/permissions";
import { useCounters } from "../../../hooks/useCounters";
import { inboxTabs } from "../../SectionTabs";
import { visibleScreenTabs } from "../../ScreenTabs";
import { RoyalIcon } from "../RoyalIcon";
import { royalIconForPath } from "../royalNavIcons";

/**
 * Шапка раздела «Чаты» нового вида: заголовок и переключатель значками
 * (Сообщения / Комментарии / Звонки / Телефония), 18.11.2026.
 *
 * Состав, права и счётчики — те же, что у прежней полосы вкладок
 * (`inboxTabs` в SectionTabs.tsx, одна дверь). Значками, а не словами, —
 * чтобы шапка помещалась в ширину телефона (ошибка макета: «Чаты/Звонки»
 * словами вылезали за экран на 390 px). Подпись — в aria-label и title.
 */
export function RoyalInboxSwitch({ title }: { title: string }) {
  const can = useCan();
  const { data: counters } = useCounters();
  const tabs = visibleScreenTabs(inboxTabs(can, counters), can);
  return (
    <header className="ry-chats-head">
      <h1>{title}</h1>
      {tabs.length > 1 && (
        <nav className="ry-chats-switch" aria-label="Разделы обращений">
          {tabs.map((tab) => {
            const count = typeof tab.count === "number" && tab.count > 0 ? (tab.count > 99 ? "99+" : String(tab.count)) : null;
            const label = count ? `${tab.label}: ${count}` : tab.label;
            return (
              <NavLink key={tab.to} to={tab.to} end={tab.end} aria-label={label} title={tab.label}>
                {({ isActive }) => <>
                  <RoyalIcon name={royalIconForPath(tab.to)} filled={isActive} />
                  {count && <b className="ry-chats-switch-n" aria-hidden="true">{count}</b>}
                </>}
              </NavLink>
            );
          })}
        </nav>
      )}
    </header>
  );
}
