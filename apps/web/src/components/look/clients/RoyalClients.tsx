import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { exactDateTime } from "../../../lib/format";
import { cleanClientTabList, type CleanClientTab } from "../../clean/CleanClientDetailLayout";
import { RhTabs } from "../ui";
import { RoyalIcon } from "../RoyalIcon";
import type { RoyalIconName } from "../royalIconData";
import { overdueStepTone, pillTone } from "../tileTone";

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

/** Поля, которые строка телефона не показывает (номер карточки, источник): они есть в карточке клиента. */
export const ROYAL_ROW_PC_ONLY = "ry-crow-pc-only";

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

/**
 * Строка списка клиентов: те же данные, что у CleanClientRow, ничего не
 * выброшено из разметки.
 * ПК (контейнерный запрос по ширине списка) — таблица: аватар, клиент с номером,
 * запрос с источником, следующее действие со сроком и последним контактом,
 * ответственный, действия; шапка — RoyalClientListHead.
 * Телефон — три строки (~96 px): имя … время; запрос одной строкой; плашка шага …
 * ответственный. Номер карточки и источник (`ry-crow-pc-only`) на телефоне в
 * строке не видны — они в карточке клиента (номер рядом с «назад», источник —
 * фактом в шапке). Трубка — круг справа на всю высоту строки.
 */
export function RoyalClientRow({ id, name, href, avatar, identity, request, source, nextAction, nextActionDate, lastContact, staleContact = false, showAgent, agentName, agentAssigned, actions, deleted }: RoyalClientRowProps) {
  const deadline = nextAction && nextActionDate ? exactDateTime(nextActionDate) : "";
  const overdue = !!deadline && new Date(nextActionDate!).getTime() < Date.now();
  const agent = agentName || (agentAssigned ? "Агент назначен" : "Не назначен");
  const who = <>
    <span className="ry-crow-name">{name}</span>
    {identity && <span className={`ry-crow-id ${ROYAL_ROW_PC_ONLY}`}>{identity}</span>}
  </>;
  return (
    <div data-client-row={id} className="ry-crow" data-deleted={deleted || undefined} data-agent={showAgent || undefined} data-deadline={deadline ? "" : undefined}>
      {/* Аватар — своя клетка сетки (на телефоне на все три строки); ведёт туда же, что имя, но мимо чтеца и Tab. */}
      {href
        ? <Link to={href} className="ry-crow-av" tabIndex={-1} aria-hidden="true">{avatar}</Link>
        : <span className="ry-crow-av" aria-hidden="true">{avatar}</span>}
      {href
        ? <Link to={href} aria-label={`Открыть карточку: ${name}`} className="ry-crow-main">{who}</Link>
        : <div className="ry-crow-main">{who}</div>}
      <div className="ry-crow-req">
        <span className="ry-crow-text">{request}</span>
        <span className={`ry-crow-hint ${ROYAL_ROW_PC_ONLY}`}>{source}</span>
      </div>
      <div className="ry-crow-next">
        {nextAction ? <span className="ry-crow-step">{nextAction}</span> : <span className="ry-crow-step ry-crow-hint">Следующий шаг не назначен</span>}
        {/* Одна дата с глаголом (пачка D1): есть срок шага — срок («срок …» / «просрочено · …»),
            нет — когда связывались. Две даты столбиком без подписи читались загадкой
            (critic-uiux P1-3); последний контакт при сроке есть в карточке клиента. */}
        <span className="ry-crow-when" data-tone={overdue ? overdueStepTone(Date.now() - new Date(nextActionDate!).getTime()) : !deadline && staleContact ? pillTone("overdue") : undefined}>
          {deadline
            ? <span className="ry-crow-text ry-crow-deadline">{overdue ? "просрочено · " : "срок "}<span className="ry-crow-nowrap">{deadline}</span></span>
            : <span className="ry-crow-hint ry-crow-last">{staleContact ? "Давно не связывались · " : "связывались "}<span className="ry-crow-nowrap">{lastContact}</span></span>}
          {/* Оба признака сразу (ревью PR 331): срок шага не прячет, что клиент давно без связи. */}
          {deadline && staleContact && <span className="ry-crow-hint ry-crow-stale">Давно не связывались</span>}
        </span>
      </div>
      {showAgent && (
        <div className="ry-crow-agent" title={`Ответственный: ${agent}`}>
          <span className="ry-crow-agent-av" aria-hidden="true">{agentName ? initials(agentName) : "—"}</span>
          <span className="ry-crow-label">Ответственный: </span>
          <span className="ry-crow-text">{agent}</span>
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
      <span className="ry-clist-head-client">Клиент</span><span>Запрос</span><span>Следующее действие</span>{showAgent && <span>Ответственный</span>}<span>Действия</span>
    </div>
  );
}

export interface RoyalClientFact { icon: RoyalIconName; text: string; /** Полная подпись для чтеца и подсказки, когда текст короче. */ label?: string }

/**
 * Номер первым фактом под именем карточки (пачка D1): какой номер наберёт «Позвонить»,
 * видно до нажатия. Строку отдаёт сервер по правам (директору полный, остальным маской).
 * До приёма заявки (`locked`) — ничего, даже маски: хвост маски — тоже часть чужого номера.
 */
export function royalPhoneFact(phone: string | null | undefined, locked: boolean): RoyalClientFact[] {
  return phone && !locked ? [{ icon: "phone", text: phone, label: `Телефон ${phone}` }] : [];
}

/**
 * Шапка карточки: короткие факты со значками в одну строку (на узком экране
 * переносятся) вместо одной длинной фразы «Пришёл… Последний контакт… Агент…».
 */
export function RoyalClientFacts({ facts }: { facts: RoyalClientFact[] }) {
  return (
    <ul className="ry-cd-facts" aria-label="О клиенте">
      {facts.map((fact) => (
        <li key={fact.icon + fact.text} title={fact.label}>
          <RoyalIcon name={fact.icon} size={18} />
          {fact.label
            ? <><span aria-hidden="true">{fact.text}</span><span className="sr-only">{fact.label}</span></>
            : <span>{fact.text}</span>}
        </li>
      ))}
    </ul>
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
  // Тот же список, что у CleanClientDetailTabs (одно место: cleanClientTabList).
  const tabs = cleanClientTabList(objectsLabel);
  return (
    <RhTabs
      className="ry-ctabs" tabClassName="ry-ctab" idPrefix="clean-client" label="Разделы карточки клиента"
      value={value} onChange={onChange}
      tabs={tabs.map(({ id, label, short }) => ({
        id, ariaLabel: label,
        label: <>
          <RoyalIcon name={TAB_ICONS[id]} size={20} />
          <span className="ry-ctab-long">{label}</span>
          <span className="ry-ctab-short" aria-hidden="true">{short}</span>
        </>,
      }))}
    />
  );
}

