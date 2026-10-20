import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, Phone, Search } from "lucide-react";
import { useCan } from "../../lib/permissions";
// Поиск подгружается по нажатию (CommandPaletteLazy.tsx): палитра не должна
// лежать во входном куске сборки, который читается до первой отрисовки.
import { CommandPaletteLazy } from "../CommandPaletteLazy";
import { ThemeQuickSwitch } from "../Topbar";
import { todayLabel } from "../../lib/format";
import { useNotifications } from "../../hooks/useNotifications";
import { Rh2Inline } from "../rh2/Rh2Scope";

/**
 * Шапка мобильной Главной — общая для всех пяти ролей. Разметка переведена на
 * классы прототипа темы «Royal Home 2026»: `.pg-h` (заголовок + `.sub` + `.acts`)
 * и `.pill.icon` для круглых кнопок, `.inp` для строки поиска.
 *
 * Функции прежние и все на месте: звонки (только при праве на них),
 * уведомления со счётчиком непрочитанных, переключатель темы, поиск
 * (CommandPalette). Профиль отсюда убран решением владельца 19.08.2026 —
 * он открывается только из Настроек.
 *
 * Компонент сам оборачивается в `.rh2`, потому что вызывается выше области
 * экрана: ролевые Главные ставят его перед своим `<div className="rh2 screens">`.
 */
export function MobileHomeHeader({ firstName }: { firstName: string }) {
  const navigate = useNavigate();
  const can = useCan();
  const canCall = can("calls.transcripts") || can("calls.ownTranscripts");
  const [showSearch, setShowSearch] = useState(false);
  const { data: notifications } = useNotifications();
  const unreadCount = notifications?.unreadCount ?? 0;

  return (
    <Rh2Inline>
      <div className="pg-h">
        <div>
          <h1>Салом{firstName ? `, ${firstName}` : ""}</h1>
          <p className="sub">{todayLabel()}</p>
        </div>
        <div className="acts">
          {canCall && (
            <button
              type="button"
              className="pill icon"
              onClick={() => navigate("/calls")}
              aria-label="Звонки"
              title="Звонки"
            >
              <Phone className="i" strokeWidth={1.5} />
            </button>
          )}
          {/* Уведомления — отдельный экран, не поповер (решение по скриншоту
              владельца 18.08.2026): см. pages/Notifications.tsx. */}
          <button
            type="button"
            className="pill ghost icon"
            onClick={() => navigate("/notifications")}
            aria-label={unreadCount > 0 ? `Уведомления, непрочитанных ${unreadCount}` : "Уведомления"}
          >
            <Bell className="i" strokeWidth={1.5} />
            {unreadCount > 0 && <span className="dot crit" aria-hidden="true" />}
          </button>
          <ThemeQuickSwitch buttonClassName="pill ghost icon" />
        </div>
      </div>

      <button
        type="button"
        className="inp"
        onClick={() => setShowSearch(true)}
        title="Поиск"
        aria-label="Поиск клиентов и объектов"
        style={{ display: "flex", alignItems: "center", gap: "var(--s2)", width: "100%", textAlign: "left" }}
      >
        <Search className="i" strokeWidth={1.5} />
        <span>Клиент, объект, сделка, раздел</span>
      </button>

      {showSearch && <CommandPaletteLazy onClose={() => setShowSearch(false)} />}
    </Rh2Inline>
  );
}
