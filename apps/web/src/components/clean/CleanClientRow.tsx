import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "./ui";

export const cleanClientColumns = (showAgent: boolean) => showAgent
  ? "lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,.9fr)_auto]"
  : "lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto]";

interface Props {
  id: string;
  name: string;
  href?: string;
  avatar: ReactNode;
  identity: string;
  request: string;
  source: string;
  /** Факт-метка («ждёт принятия») или отметка состояния; советов здесь нет (lib/clientRowFacts.ts). */
  fact?: ReactNode;
  /** «последний контакт ДД.ММ» / «контакта ещё не было»; null — подписи нет. */
  lastContact: string | null;
  showAgent: boolean;
  agentName?: string | null;
  agentAssigned: boolean;
  actions: ReactNode;
  deleted: boolean;
}

/** Presentation only: mutations, permissions and confirmation dialogs stay in ClientRow. */
export function CleanClientRow({ id, name, href, avatar, identity, request, source, fact, lastContact, showAgent, agentName, agentAssigned, actions, deleted }: Props) {
  const person = <><span className="shrink-0">{avatar}</span><span className="min-w-0"><span className="block break-words text-[16px] font-semibold text-ink">{name}</span><span className="mt-1 block text-[14px] text-gray-500">{identity}</span></span></>;
  return (
    <div data-client-row={id} className={cn("clean-client-row grid grid-cols-2 items-center gap-4 rounded-[14px] px-4 py-3 hover:bg-row-alt", cleanClientColumns(showAgent), deleted && "bg-row-alt")}>
      {href ? <Link to={href} aria-label={`Открыть карточку: ${name}`} className="flex min-w-0 items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-blue">{person}</Link> : <div className="flex min-w-0 items-center gap-3">{person}</div>}
      <div className="min-w-0"><p className="break-words text-[14px] text-ink">{request}</p><p className="mt-1 break-words text-[14px] text-gray-500">{source}</p></div>
      <div className="min-w-0 space-y-1">
        <span className="block text-[13px] text-gray-500 lg:hidden">Последний контакт</span>
        {fact}
        {lastContact && <p className="text-[14px] text-gray-500">{lastContact}</p>}
      </div>
      {showAgent && <div className="min-w-0"><span className="block text-[13px] text-gray-500 lg:hidden">Ответственный</span><p className="break-words text-[14px] text-ink">{agentName || (agentAssigned ? "Агент назначен" : "Не назначен")}</p></div>}
      <div className="col-span-2 flex flex-wrap items-center justify-end gap-2 lg:col-span-1">{actions}</div>
    </div>
  );
}
