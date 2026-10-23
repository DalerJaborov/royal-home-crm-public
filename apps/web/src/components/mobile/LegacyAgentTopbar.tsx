import type { ReactNode, RefObject } from "react";
import { Bell, ChevronLeft, Search } from "lucide-react";
import { ProfileMenu } from "../ProfileMenu";

interface Props {
  title: string | null;
  back: string | null;
  onNavigate: (path: string) => void;
  actions: ReactNode;
  onSearch: () => void;
  bellRef: RefObject<HTMLButtonElement | null>;
  unreadCount: number;
  notificationsOpen: boolean;
  onToggleNotifications: () => void;
  notificationsPanel: ReactNode;
  searchPanel: ReactNode;
}

/** Frozen agent phone presentation; queries and notification actions remain in Topbar. */
export function LegacyAgentTopbar({ title, back, onNavigate, actions, onSearch, bellRef, unreadCount, notificationsOpen, onToggleNotifications, notificationsPanel, searchPanel }: Props) {
  return (
    <div data-topbar data-legacy-agent-mobile className="rh-glass h-14 bg-card border-b border-line items-center px-3.5 gap-3.5 flex">
      {back && (
        <button type="button" onClick={() => onNavigate(back)} data-topbar-back aria-label="Назад" className="sh-btn flex items-center justify-center md:hidden">
          <ChevronLeft className="w-[22px] h-[22px]" strokeWidth={1.8} />
        </button>
      )}
      <span data-topbar-title className="md:hidden flex-1 min-w-0 truncate">{title ?? ""}</span>
      {actions}
      <button type="button" onClick={onSearch} aria-label="Поиск клиентов и объектов" data-topbar-search className="w-11 h-11 shrink-0 rounded-full border border-line flex items-center justify-center text-gray-500 hover:bg-hover-tint active:scale-90 transition-all">
        <Search className="w-[19px] h-[19px]" strokeWidth={1.8} />
      </button>
      <div className="ml-auto flex items-center gap-2">
        <div className="relative">
          <button type="button" ref={bellRef} onClick={onToggleNotifications} aria-label="Уведомления" aria-expanded={notificationsOpen} data-topbar-bell className="relative w-11 h-11 shrink-0 rounded-full border border-line flex items-center justify-center text-gray-500 hover:bg-hover-tint active:scale-90 transition-all">
            <Bell className="w-[19px] h-[19px]" strokeWidth={1.8} />
            {unreadCount > 0 && <span data-unread-badge className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full text-[13px] font-bold flex items-center justify-center bg-blue text-white">{unreadCount > 9 ? "9+" : unreadCount}</span>}
          </button>
          {notificationsPanel}
        </div>
        <span data-topbar-me className="contents"><ProfileMenu /></span>
      </div>
      {searchPanel}
    </div>
  );
}
