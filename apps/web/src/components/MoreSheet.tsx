import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, Grip, LogOut, UserCircle, Wallet, type LucideIcon } from "lucide-react";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { RH2_ROW_BUTTON, RH2_UNREAD_CHIP } from "./rh2/Rh2Scope";
import { useNavigation, type NavItem } from "../lib/navigation";
import { useAuthStore } from "../store/auth";
import { ROLE_LABELS } from "../lib/roles";
import { signOut } from "../lib/signOut";
import { useNotifications } from "../hooks/useNotifications";
import { hapticTap } from "../lib/haptics";

/**
 * ШТОРКА «ЕЩЁ» ПО НАЖАТИЮ НА АВАТАР В ШАПКЕ ТЕЛЕФОНА (06.10.2026, ревью телефона).
 *
 * С таббара ушла вкладка «Ещё» (в нём пять мест: Главная, Клиенты, «+», Объекты,
 * Чаты). Всё, что в ней лежало ежедневного, теперь за аватаром: Звонки, Календарь,
 * Сделки, Деньги, Профиль, Настройки. Состав и права берутся из того же реестра
 * `useNavigation()`, что кормит рейку и таббар, поэтому строка, на которую у роли
 * нет права, не рисуется вовсе. Остальные разделы остались на экране «Все
 * разделы» (`/more`): он никуда не делся и ведёт туда последней строкой.
 *
 * Корпус — `Rh2Sheet` (единственный корпус окон CRM): на телефоне шторка снизу,
 * плотная, без стекла (контракт: стекло только на рамке).
 */

interface Row {
  key: string;
  label: string;
  icon: LucideIcon;
  to: string;
  badge?: number;
}

function fromRegistry(item: NavItem | undefined, labelOverride?: string): Row | null {
  if (!item) return null;
  return { key: item.to, label: labelOverride ?? item.label, icon: item.icon, to: item.to, badge: item.badge };
}

export function MoreSheet({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const agent = useAuthStore((s) => s.agent);
  const { all } = useNavigation();
  const { data: notifications } = useNotifications();
  const unread = notifications?.unreadCount ?? 0;

  const rows = useMemo<Row[]>(() => {
    const byTo = (to: string) => all.find((i) => i.to === to);
    // «Деньги» — первый доступный пункт группы (Финансы → Отчёты → Источники →
    // Инсайты): тот же принцип входа в группу, что в `entry()` реестра.
    const money = all.find((i) => i.group === "money");
    return [
      { key: "/notifications", label: "Уведомления", icon: Bell, to: "/notifications", badge: unread },
      fromRegistry(byTo("/calls")),
      fromRegistry(byTo("/calendar")),
      fromRegistry(byTo("/deals")),
      money ? { key: "money", label: "Деньги", icon: Wallet, to: money.to } : null,
      { key: "/profile", label: "Профиль", icon: UserCircle, to: "/profile" },
      fromRegistry(byTo("/settings"), "Настройки"),
      { key: "/more", label: "Все разделы", icon: Grip, to: "/more" },
    ].filter((r): r is Row => r !== null);
  }, [all, unread]);

  function go(to: string) {
    hapticTap();
    onClose();
    navigate(to);
  }

  function logout() {
    onClose();
    // Тот же выход, что в ProfileMenu: гасит состояние и снимает push-подписку.
    void signOut();
    navigate("/login");
  }

  return (
    <Rh2Sheet onClose={onClose} title="Ещё" ariaLabel="Разделы и профиль">
      <div className="kvp">
        <b>{agent?.fullName ?? "Гость"}</b>
        <span>{agent ? ROLE_LABELS[agent.role] : "Агент"}</span>
      </div>
      <div className="list">
        {rows.map((r) => (
          <button key={r.key} type="button" className="row" style={RH2_ROW_BUTTON} onClick={() => go(r.to)}>
            <span className="plate soft" aria-hidden="true">
              <r.icon className="i" />
            </span>
            <span className="t">
              <b>{r.label}</b>
            </span>
            {!!r.badge && (
              <span className="chip" style={RH2_UNREAD_CHIP}>
                {r.badge > 99 ? "99+" : r.badge}
              </span>
            )}
          </button>
        ))}
        <button type="button" className="row" style={RH2_ROW_BUTTON} onClick={logout}>
          <span className="plate soft" aria-hidden="true">
            <LogOut className="i" />
          </span>
          <span className="t">
            <b>Выйти</b>
          </span>
        </button>
      </div>
    </Rh2Sheet>
  );
}
