import { LegacyAgentTopbar } from "./mobile/LegacyAgentTopbar";
import { Children, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import { RH2_ROW_BUTTON, Rh2Portal } from "./rh2/Rh2Scope";
import { useNavigation } from "../lib/navigation";
import { defaultCleanNavigation } from "../lib/cleanNavigationOrder";
import { Bell, ChevronLeft, Moon, Search, Sun } from "lucide-react";
import { useUiPrefs } from "../store/uiPrefs";
import { THEMES } from "../lib/themes";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { ROLE_LABELS } from "../lib/roles";
// Поиск подгружается по нажатию — см. CommandPaletteLazy.tsx (там же разобрано,
// почему обёртка одна на все три места оболочки, а не lazy() в каждом файле).
import { CommandPaletteLazy } from "./CommandPaletteLazy";
import { ProfileMenu, initials } from "./ProfileMenu";
import { ProfileAvatar } from "./ProfileAvatar";
import { MoreSheet } from "./MoreSheet";
import { useShellStore } from "../store/shell";
import { useMobileUx } from "../hooks/useMobileUx";
import { useLegacyAgentMobile } from "../hooks/useLegacyAgentMobile";
import {
  useNotifications,
  useMarkNotificationRead,
  useAutoReadNotifications,
} from "../hooks/useNotifications";

export function Topbar({ clean = false }: { clean?: boolean }) {
  const [showNotifications, setShowNotifications] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);
  // Экран, а не проценты от .relative-обёртки: панель уходит в createPortal
  // (см. комментарий у неё ниже), поэтому координаты считаются от кнопки
  // один раз при открытии — так же ведёт себя FabMenu.tsx.
  const [notifPos, setNotifPos] = useState<{ top: number; right: number } | null>(null);
  const navigate = useNavigate();
  const { data: notifications, isError: notificationsFailed, isLoading: notificationsLoading, refetch: retryNotifications } = useNotifications();
  const markRead = useMarkNotificationRead();
  const notificationItems = notifications?.items ?? [];
  const unreadCount = notifications?.unreadCount ?? 0;
  // УВИДЕЛ — ЗНАЧИТ ПРОЧИТАНО (владелец 27.08.2026), см. useNotifications.ts.
  // Раньше это правило работало только на полноэкранной ленте /notifications:
  // открыв список прямо из колокольчика в шапке, счётчик так и оставался
  // «9+» — человек уже всё прочитал, а бейдж и подсветка «непрочитанного»
  // висели, будто он не заходил вовсе (жалоба владельца 30.08.2026).
  // Показаны в выпадающем списке только первые 6 записей (см. ниже) — столько и
  // гасим, остальное и APPROVAL/CRITICAL автопрочтение не трогает (WEB-PAGES16).
  useAutoReadNotifications(unreadCount, showNotifications, notificationItems.slice(0, 6));
  const [showSearch, setShowSearch] = useState(false);
  // Значка телефонии в шапке больше нет (владелец 18.08.2026). Он показывал
  // состояние браузерной трубки и вёл в «Телефонию», а трубку и роль оператора
  // входящих удалили целиком — звонки идут прямо агентам на мобильный. Раздел
  // «Телефония» никуда не делся: он в боковом меню, по тому же праву.

  const { pathname } = useLocation();

  // ЗАГОЛОВОК НА ТЕЛЕФОНЕ — ЯВНЫЙ ДОГОВОР, А НЕ УГАДЫВАНИЕ (06.10.2026).
  // Раньше шапка нюхала DOM наблюдателями: одни искали `.top`/`.chead` внутри
  // `.mh`, другие следили за `h1`, таймер в 1200 мс решал, что раздел без
  // заголовка. Это давало двойные шапки и пустые полоски. Теперь экран сам
  // сообщает оболочке одно из двух (store/shell.ts): «вот мой заголовок»
  // (`<Rh2Screen title=…>`) или «шапку рисую я» (`<ShellOwnHeader />`). Ничего
  // не сообщил — старая страница, и шапка берёт имя раздела из реестра, как
  // и раньше: терять у неё поиск и аватар нельзя.
  const mobile = useMobileUx();
  const shellTitle = useShellStore((s) => s.title);
  const shellBack = useShellStore((s) => s.back);
  const shellOnBack = useShellStore((s) => s.onBack);
  const shellActions = useShellStore((s) => s.actions);
  const ownHeader = useShellStore((s) => s.ownHeader);
  // «Сообщения» (MobileChats*) рисуют свою шапку всегда; Главная её рисует, пока
  // не заявила заголовок оболочке: главная агента (E1) и пульт директора (E4) с
  // 06.10.2026 — единые экраны с `<Rh2Screen title=…>`, своей шапки у них нет;
  // ролевые главные на `MhScreen` по-прежнему свои.
  const hideOnMobile = mobile && ((!clean && pathname === "/" && shellTitle === null) || pathname === "/messages" || ownHeader);
  const { all: navItems } = useNavigation();
  const pageTitle = shellTitle ?? (mobile ? pageTitleFor(pathname, clean ? defaultCleanNavigation([], navItems) : navItems) : null);

  if (hideOnMobile) return null;

  return (
    // Обёртка нужна, чтобы под верхней строкой встала вторая — лента разделов
    // пульта. Прилипание (sticky) переехало сюда с самой строки: две прилипшие
    // друг под другом полосы считают `top` каждая от себя и при прокрутке
    // наезжают одна на другую.
    <div data-topbar-shell className="sticky top-[env(safe-area-inset-top)] z-30 shrink-0">
      <TopbarRow
        pageTitle={pageTitle}
        back={shellBack}
        onBack={shellOnBack}
        actions={shellActions}
        showNotifications={showNotifications}
        setShowNotifications={setShowNotifications}
        bellRef={bellRef}
        notifPos={notifPos}
        setNotifPos={setNotifPos}
        notificationItems={notificationItems}
        notificationsFailed={clean && notificationsFailed}
        notificationsLoading={clean && notificationsLoading}
        retryNotifications={() => void retryNotifications()}
        unreadCount={unreadCount}
        markRead={markRead}
        navigate={navigate}
        showSearch={showSearch}
        setShowSearch={setShowSearch}
      />
    </div>
  );
}

interface TopbarRowProps {
  notificationsFailed: boolean;
  notificationsLoading: boolean;
  retryNotifications: () => void;
  pageTitle: string | null;
  back: string | null;
  onBack: (() => void) | null;
  actions: ReactNode;
  showNotifications: boolean;
  setShowNotifications: Dispatch<SetStateAction<boolean>>;
  bellRef: RefObject<HTMLButtonElement | null>;
  notifPos: { top: number; right: number } | null;
  setNotifPos: (p: { top: number; right: number }) => void;
  notificationItems: { id: string; title: string; body?: string | null; read: boolean; url?: string | null }[];
  unreadCount: number;
  markRead: { mutate: (id: string) => void };
  navigate: (to: string) => void;
  showSearch: boolean;
  setShowSearch: (v: boolean) => void;
}

/** Сама верхняя строка — вынесена из `Topbar`, чтобы над ней встала лента разделов. */
function TopbarRow({
  notificationsFailed,
  notificationsLoading,
  retryNotifications,
  pageTitle,
  back,
  onBack,
  actions,
  showNotifications,
  setShowNotifications,
  bellRef,
  notifPos,
  setNotifPos,
  notificationItems,
  unreadCount,
  markRead,
  navigate,
  showSearch,
  setShowSearch,
}: TopbarRowProps) {
  const agent = useAuthStore((s) => s.agent);
  const legacyAgentMobile = useLegacyAgentMobile();
  const [showMore, setShowMore] = useState(false);
  // До двух круглых кнопок справа (контракт); лишние шапка не рисует. Без своих
  // кнопок у экрана — поиск, как у всех.
  const phoneActions = Children.toArray(actions).slice(0, 2);
  const toggleNotifications = () => {
              if (!showNotifications && bellRef.current) {
                const rect = bellRef.current.getBoundingClientRect();
                setNotifPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
              }
              setShowNotifications((v) => !v);
            };
  const notificationsPanel = showNotifications &&
            notifPos &&
            (
              <Rh2Portal>
                {/* Оверлей и панель — ОБА в document.body, одним поддеревом, как в
                    FabMenu.tsx и ProfileMenu.tsx: шапка стоит на стекле с
                    backdrop-filter, а он создаёт containing block для
                    fixed-потомков, и подложка внутри шапки сжималась бы до её
                    высоты (жалоба владельца 30.08.2026). Координаты top/right —
                    px, снятые с кнопки при открытии.

                    Панель в области темы (`Rh2Portal`, 24.10.2026): раньше она
                    рисовалась вне `.rh2` на Tailwind-классах и `sh-notice-*`,
                    перепись экранов нашла её «из другой темы». Теперь это
                    `.card.tight` со строками `.row`, как меню профиля. */}
                <div className="sheet-back" style={{ backdropFilter: "none", background: "transparent" }} onClick={() => setShowNotifications(false)} />
                <div
                  className="card tight"
                  style={{
                    position: "fixed",
                    zIndex: 41,
                    top: notifPos.top,
                    right: notifPos.right,
                    width: "min(320px, calc(100vw - 16px))",
                    maxHeight: "70vh",
                    overflowY: "auto",
                  }}
                >
                  {notificationsFailed ? (
                    <div role="status">
                      <p className="state err">Уведомления не загрузились.</p>
                      <button type="button" className="pill ghost sm" onClick={() => void retryNotifications()}>
                        Повторить
                      </button>
                    </div>
                  ) : notificationsLoading ? (
                    <p className="state" role="status">Загружаем уведомления…</p>
                  ) : notificationItems.length === 0 ? (
                    <p className="state">Новых уведомлений нет</p>
                  ) : (
                    <>
                      <div className="list">
                        {notificationItems.slice(0, 6).map((n) => (
                          <button
                            key={n.id}
                            type="button"
                            onClick={() => {
                              if (!n.read) markRead.mutate(n.id);
                              setShowNotifications(false);
                              if (n.url) navigate(n.url);
                            }}
                            data-unread={!n.read || undefined}
                            className="row"
                            style={RH2_ROW_BUTTON}
                          >
                            <span className="t">
                              <span className="n">{n.title}</span>
                              {n.body && <span className="s">{n.body}</span>}
                            </span>
                            {!n.read && <span className="chip warn">Новое</span>}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setShowNotifications(false);
                          navigate("/notifications");
                        }}
                        data-view-all-notifications
                        className="pill ghost"
                        style={{ width: "100%", marginTop: "var(--s2)" }}
                      >
                        Все уведомления
                      </button>
                    </>
                  )}
                </div>
              </Rh2Portal>
            );
  if (legacyAgentMobile) {
    return <LegacyAgentTopbar
      title={pageTitle}
      back={back}
      onNavigate={navigate}
      actions={phoneActions}
      onSearch={() => setShowSearch(true)}
      bellRef={bellRef}
      unreadCount={unreadCount}
      notificationsOpen={showNotifications}
      onToggleNotifications={toggleNotifications}
      notificationsPanel={notificationsPanel}
      searchPanel={showSearch ? <CommandPaletteLazy onClose={() => setShowSearch(false)} /> : null}
    />;
  }
  return (
    // Одна строка 60 px на обеих ширинах. Стекло (`.rh-glass`) — только от 820 px:
    // на телефоне шапка плотная (фон страницы), единственный стеклянный слой
    // там — таббар (правило контракта, theme-2026-mobile-shell.css блок 1).
    // Прилипание живёт на обёртке `[data-topbar-shell]` (см. `Topbar`): под этой
    // строкой на пульте стоит вторая — лента разделов.
    <div data-topbar className="rh-glass sh-top flex items-center gap-3 px-4 md:px-6">
      {/* ТЕЛЕФОН (< 820): «Назад» (если экран назвал раздел-родитель), заголовок
          22 px из стора оболочки, справа до двух кнопок и аватар → шторка «Ещё».
          Логотипа и колокольчика здесь нет: бренд на ПК живёт в рейке, на телефоне
          Главная — вкладка таббара; уведомления — первая строка шторки «Ещё». */}
      {back && (
        <button
          type="button"
          onClick={() => onBack ? onBack() : navigate(back)}
          data-topbar-back
          aria-label="Назад"
          className="sh-btn flex items-center justify-center md:hidden"
        >
          <ChevronLeft className="w-[22px] h-[22px]" strokeWidth={1.8} />
        </button>
      )}
      <span data-topbar-title className="md:hidden flex-1 min-w-0 truncate">
        {pageTitle ?? ""}
      </span>
      <div className="md:hidden flex items-center gap-2">
        {phoneActions.length > 0 ? (
          phoneActions
        ) : (
          <button
            type="button"
            onClick={() => setShowSearch(true)}
            aria-label="Поиск клиентов и объектов"
            data-topbar-search
            className="sh-btn flex items-center justify-center"
          >
            <Search className="w-[19px] h-[19px]" strokeWidth={1.8} />
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowMore(true)}
          aria-label="Ещё: разделы и профиль"
          aria-haspopup="dialog"
          data-topbar-me
          className="sh-btn sh-avatar flex items-center justify-center"
        >
          <ProfileAvatar src={agent?.avatarUrl} fallback={initials(agent?.fullName)} className="h-full w-full rounded-full object-cover" />
          {unreadCount > 0 && <span data-unread-dot aria-hidden="true" />}
        </button>
      </div>

      {/* КОМПЬЮТЕР (≥ 820): поиск слева широкой пилюлей 40 px, справа тема,
          колокольчик, имя и аватар. Кнопка, а не `<input>`: искать умеет палитра
          команд (CommandPalette) со своим полем и историей — второе поле в шапке
          пришлось бы синхронизировать с её полем. */}
      <button
        type="button"
        onClick={() => setShowSearch(true)}
        data-topbar-search-wide
        aria-label="Поиск клиентов и объектов"
        aria-haspopup="dialog"
        className="sh-search hidden md:flex items-center gap-2.5"
      >
        <Search className="w-[17px] h-[17px] shrink-0" strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate">Поиск клиентов, объектов, сделок</span>
      </button>

      <div className="hidden md:flex ml-auto items-center gap-2">
        <ThemeQuickSwitch />

        {/* КОЛОКОЛЬЧИК ПОКАЗЫВАЕТ НАСТОЯЩИЕ УВЕДОМЛЕНИЯ (аудит №4, 27.08). */}
        <div className="relative">
          <button type="button"
            ref={bellRef}
            onClick={toggleNotifications}
            aria-label="Уведомления"
            aria-expanded={showNotifications}
            data-topbar-bell
            className="sh-btn flex items-center justify-center"
          >
            <Bell className="w-[19px] h-[19px]" strokeWidth={1.8} />
            {unreadCount > 0 && (
              <span
                data-unread-badge
                className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full text-[13px] font-bold flex items-center justify-center"
              >
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </button>
          {notificationsPanel}
        </div>

        {/* Имя и должность рядом с аватаром — блок `.toprow .user .un` артефакта,
            только на широком экране: подсказка, что кружок кликабелен. */}
        {agent && (
          <span data-topbar-user className="hidden lg:flex min-w-0 flex-col items-end leading-tight">
            <b className="sh-user-name max-w-[180px] truncate">{agent.fullName}</b>
            <small className="sh-user-role max-w-[180px] truncate">{ROLE_LABELS[agent.role]}</small>
          </span>
        )}
        {/* Профиль — единственная точка входа в учётную запись на ПК. */}
        <span data-topbar-me className="contents">
          <ProfileMenu />
        </span>
      </div>

      {showSearch && <CommandPaletteLazy onClose={() => setShowSearch(false)} />}
      {showMore && <MoreSheet onClose={() => setShowMore(false)} />}
    </div>
  );
}

/** Имя раздела для компактного заголовка шапки: самый длинный путь реестра,
 *  которым начинается текущий адрес (карточка клиента → «Клиенты»). Разделы,
 *  которых в реестре нет (профиль, уведомления, «ещё»), — короткой картой здесь,
 *  а не вторым реестром: это подписи ровно трёх экранов оболочки. */
const SHELL_TITLES: Record<string, string> = {
  "/profile": "Профиль",
  "/notifications": "Уведомления",
  "/more": "Ещё",
};
function pageTitleFor(pathname: string, items: { to: string; label: string }[]): string | null {
  let best: { to: string; label: string } | null = null;
  for (const item of items) {
    if (item.to === "/" ) continue;
    if (pathname === item.to || pathname.startsWith(item.to + "/")) {
      if (!best || item.to.length > best.to.length) best = item;
    }
  }
  if (best) return best.label;
  for (const [to, label] of Object.entries(SHELL_TITLES)) {
    if (pathname === to || pathname.startsWith(to + "/")) return label;
  }
  return null;
}

/** Быстрое переключение светлая/тёмная из шапки — просто тумблер, без выбора
 *  цветовой темы (19.08.2026, решение владельца: полный выбор темы — только
 *  в Профиле → Оформление, см. AppearanceSettings). Одно нажатие меняет
 *  isDark, оставляя цветовую семью текущей темы прежней (theme.pairId).
 *  `buttonClassName` — переопределение вида самой кнопки: мобильная шапка Главной
 *  (MobileHomeHeader) рисует её 34px-кружком по прототипу design_handoff, а
 *  десктопная шапка остаётся на прежних 40px — поэтому проп, а не правка базы. */
export function ThemeQuickSwitch({ buttonClassName }: { buttonClassName?: string }) {
  const theme = useUiPrefs((s) => s.theme);
  const setTheme = useUiPrefs((s) => s.setTheme);
  const current = THEMES.find((t) => t.id === theme) ?? THEMES[0];

  return (
    <button type="button"
      onClick={() => setTheme(current.pairId)}
      title={current.isDark ? "Светлая тема" : "Тёмная тема"}
      data-topbar-theme
      aria-label={current.isDark ? "Включить светлую тему" : "Включить тёмную тему"}
      className={
        buttonClassName ??
        "sh-btn flex items-center justify-center"
      }
    >
      {current.isDark ? <Sun className="w-[19px] h-[19px]" strokeWidth={1.8} /> : <Moon className="w-[19px] h-[19px]" strokeWidth={1.8} />}
    </button>
  );
}
