import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cleanClientTabList, type CleanClientTab } from "../../clean/CleanClientDetailLayout";
import { RhTabs } from "../ui";
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
  /** Факт-метка строки (lib/clientRowFacts.ts: «ждёт принятия») или отметка состояния карточки; советов здесь нет. */
  fact?: ReactNode;
  /** «последний контакт ДД.ММ» / «контакта ещё не было» (lib/clientRowFacts.ts); null — подписи нет. */
  lastContact: string | null;
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
 * Строка списка клиентов: те же данные, что у CleanClientRow.
 * ПК (контейнерный запрос по ширине списка) — таблица: аватар, клиент с номером,
 * запрос с источником, последний контакт (и факт «ждёт принятия»), ответственный,
 * действия; шапка — RoyalClientListHead.
 * Телефон: имя; запрос; одна строка фактов «последний контакт ДД.ММ · ответственный»; факт-метка.
 * Номер карточки и источник (`ry-crow-pc-only`) на телефоне в строке не видны — они в
 * карточке клиента. Трубка — круг справа на всю высоту строки.
 *
 * СОВЕТОВ НЕТ (владелец 21.11.2026): ни «позвонить», ни «Давно не связывались», ни
 * «Следующий шаг не назначен», ни срока шага — только факты из lib/clientRowFacts.ts.
 * Строка контакта всегда спокойная: цвет тревоги ей не положен (сторож RoyalClients.test.tsx).
 */
export function RoyalClientRow({ id, name, href, avatar, identity, request, source, fact, lastContact, showAgent, agentName, agentAssigned, actions, deleted }: RoyalClientRowProps) {
  const agent = agentName || (agentAssigned ? "Агент назначен" : "Не назначен");
  const who = <>
    <span className="ry-crow-name" title={name}>{name}</span>
    {identity && <span className={`ry-crow-id ${ROYAL_ROW_PC_ONLY}`}>{identity}</span>}
  </>;
  return (
    <div data-client-row={id} className="ry-crow" data-deleted={deleted || undefined} data-agent={showAgent || undefined}>
      {/* Аватар — своя клетка сетки (на телефоне на все строки); ведёт туда же, что имя, но мимо чтеца и Tab. */}
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
        {fact && <span className="ry-crow-step">{fact}</span>}
        {(lastContact || showAgent) && (
          <span className="ry-crow-when">
            {lastContact && <span className="ry-crow-hint ry-crow-last">{lastContact}</span>}
            {/* Телефон (пачка shell2, 27.11.2026, плотность как в макете): ответственный — в той же строке
                фактов, что и контакт, а не отдельной строкой с кружком. На ПК (таблица) у него своя колонка
                ниже, а эта копия скрыта (theme-look-royal-clients.css). Имя полностью, без многоточия. */}
            {showAgent && <span className="ry-crow-hint ry-crow-agent-inline">{lastContact ? " · " : ""}{agent}</span>}
          </span>
        )}
      </div>
      {showAgent && (
        <div className="ry-crow-agent" title={`Ответственный: ${agent}`}>
          <span className="ry-crow-agent-av" aria-hidden="true">{agentName ? initials(agentName) : "—"}</span>
          <span className="ry-crow-label">Ответственный: </span>
          <span className="ry-crow-text">{agent}</span>
        </div>
      )}
      {/* Пустая клетка «действия» держит колонку таблицы на ПК; на телефоне скрыта (theme-look-royal-clients.css). */}
      {actions ? <div className="ry-crow-acts">{actions}</div> : <div className="ry-crow-acts" aria-hidden="true" />}
    </div>
  );
}

/** Шапка колонок списка; видна только когда список встал таблицей (ПК). */
export function RoyalClientListHead({ showAgent }: { showAgent: boolean }) {
  return (
    <div className="ry-clist-head" data-agent={showAgent || undefined} aria-hidden="true">
      <span className="ry-clist-head-client">Клиент</span><span>Запрос</span><span>Последний контакт</span>{showAgent && <span>Ответственный</span>}<span>Действия</span>
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

