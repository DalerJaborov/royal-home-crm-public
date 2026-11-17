import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { exactDateTime } from "../../../lib/format";
import { cleanRecordTabForKey, type CleanClientTab } from "../../clean/CleanClientDetailLayout";
import { RoyalIcon } from "../RoyalIcon";
import type { RoyalIconName } from "../royalIconData";

/**
 * РАЗДЕЛ «КЛИЕНТЫ» В «НОВОМ ВИДЕ» (пачка clients, 18.11.2026).
 *
 * Только разметка: запросы, права, мутации и окна остаются у вызывающего
 * (pages/Clients.tsx, pages/ClientDetail.tsx). Оформление —
 * theme-look-royal-clients.css, только под `:root[data-ui-look="royal"]`.
 * Рендерится лишь веткой `useRoyalLook()`: без признака эти детали не
 * появляются вовсе.
 */

export interface RoyalClientRowProps {
  id: string;
  name: string;
  href?: string;
  avatar: ReactNode;
  identity: string;
  request: string;
  source: string;
  nextAction: ReactNode;
  nextActionDate?: string | null;
  lastContact: string;
  staleContact?: boolean;
  showAgent: boolean;
  agentName?: string | null;
  agentAssigned: boolean;
  actions: ReactNode;
  deleted: boolean;
}

/**
 * Строка списка клиентов: те же данные, что у CleanClientRow, ничего не
 * выброшено. Телефон — аватар, имя и действие в первой строке, ниже запрос,
 * следующий шаг и ответственный с отступом под имя. ПК (по ширине списка,
 * контейнерный запрос) — таблица в пять колонок с шапкой RoyalClientListHead.
 */
export function RoyalClientRow({ id, name, href, avatar, identity, request, source, nextAction, nextActionDate, lastContact, staleContact = false, showAgent, agentName, agentAssigned, actions, deleted }: RoyalClientRowProps) {
  const deadline = nextAction && nextActionDate ? exactDateTime(nextActionDate) : "";
  const who = <>
    <span className="ry-crow-av">{avatar}</span>
    <span className="ry-crow-who">
      <span className="ry-crow-name">{name}</span>
      {identity && <span className="ry-crow-id">{identity}</span>}
    </span>
  </>;
  return (
    <div data-client-row={id} className="ry-crow" data-deleted={deleted || undefined} data-agent={showAgent || undefined}>
      {href
        ? <Link to={href} aria-label={`Открыть карточку: ${name}`} className="ry-crow-main">{who}</Link>
        : <div className="ry-crow-main">{who}</div>}
      <div className="ry-crow-req">
        <span className="ry-crow-text">{request}</span>
        <span className="ry-crow-hint">{source}</span>
      </div>
      <div className="ry-crow-next">
        {nextAction ? <span className="ry-crow-step">{nextAction}</span> : <span className="ry-crow-hint">Следующий шаг не назначен</span>}
        {deadline && <span className="ry-crow-text">Срок: {deadline}</span>}
        <span className="ry-crow-hint ry-crow-last" data-tone={staleContact ? "crit" : undefined}>
          {/* Телефон: значок часов вместо слов «Последний контакт» (слова остаются для чтеца). */}
          <RoyalIcon name="clock" size={16} className="ry-crow-ico" />
          {staleContact && <>Давно не связывались · </>}
          <span className="ry-crow-label ry-crow-label-pc">Последний контакт: </span>
          <span className="ry-crow-nowrap">{lastContact}</span>
        </span>
      </div>
      {showAgent && (
        <div className="ry-crow-agent">
          <RoyalIcon name="users" size={16} className="ry-crow-ico" />
          <span className="ry-crow-label">Ответственный: </span>
          <span className="ry-crow-text">{agentName || (agentAssigned ? "Агент назначен" : "Не назначен")}</span>
        </div>
      )}
      {actions ? <div className="ry-crow-acts">{actions}</div> : null}
    </div>
  );
}

/** Шапка колонок списка; видна только когда список встал таблицей (ПК). */
export function RoyalClientListHead({ showAgent }: { showAgent: boolean }) {
  return (
    <div className="ry-clist-head" data-agent={showAgent || undefined} aria-hidden="true">
      <span>Клиент</span><span>Запрос</span><span>Следующее действие</span>{showAgent && <span>Ответственный</span>}<span>Действия</span>
    </div>
  );
}

const TAB_ICONS: Record<CleanClientTab, RoyalIconName> = {
  short: "layout-dashboard",
  props: "building-2",
  chat: "message-circle",
  calls: "phone",
  hist: "clock",
};

/**
 * Вкладки карточки клиента. Те же id, роли и клавиши, что у CleanClientDetailTabs
 * (`clean-client-tab-<id>` ↔ `clean-client-panel-<id>`), поэтому панели
 * карточки не меняются; отличается только оформление: таблетки без инлайновых
 * цветов и лента с прокруткой внутри карточки на узком экране.
 */
export function RoyalClientTabs({ value, onChange, objectsLabel = "Объекты" }: { value: CleanClientTab; onChange: (value: CleanClientTab) => void; objectsLabel?: string }) {
  const tabs: { id: CleanClientTab; label: string; short: string }[] = [
    { id: "short", label: "Обзор", short: "Обзор" },
    { id: "props", label: objectsLabel, short: "По объектам" },
    { id: "chat", label: "Переписка", short: "Чаты" },
    { id: "calls", label: "Звонки", short: "Звонки" },
    { id: "hist", label: "История", short: "История" },
  ];
  const ids = tabs.map((t) => t.id);
  return (
    <div role="tablist" aria-label="Разделы карточки клиента" className="ry-ctabs">
      {tabs.map(({ id, label, short }) => (
        <button key={id} type="button" role="tab" id={`clean-client-tab-${id}`}
          aria-selected={id === value} aria-label={label} aria-controls={`clean-client-panel-${id}`} tabIndex={id === value ? 0 : -1}
          className="ry-ctab"
          onClick={(event) => { onChange(id); event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" }); }}
          onKeyDown={(event) => {
            const next = cleanRecordTabForKey(ids, id, event.key);
            if (!next) return;
            event.preventDefault();
            onChange(next);
            event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#clean-client-tab-${next}`)?.focus();
          }}
        >
          <RoyalIcon name={TAB_ICONS[id]} size={20} />
          <span className="ry-ctab-long">{label}</span>
          <span className="ry-ctab-short" aria-hidden="true">{short}</span>
        </button>
      ))}
    </div>
  );
}
