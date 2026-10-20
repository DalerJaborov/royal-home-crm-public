import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { Home, ChevronsLeft, ChevronsRight, Search } from "lucide-react";
import { useBranding } from "../hooks/useBranding";
import { useUiPrefs } from "../store/uiPrefs";
// Поиск подгружается по нажатию (CommandPaletteLazy.tsx): палитра не должна
// лежать во входном куске сборки, который читается до первой отрисовки.
import { CommandPaletteLazy } from "./CommandPaletteLazy";
// Состав меню, права и счётчики — в одном месте на всё приложение
// (lib/navigation.ts): сайдбар, нижние вкладки и меню профиля читают оттуда.
import { useNavigation, type NavItem } from "../lib/navigation";

/**
 * Рейка контракта оболочки (06.10.2026): компактная 76 px (значки) от 820 px,
 * широкая 220 px (значки и подписи) от 1180 px. Источник точек перелома один —
 * `screens` в tailwind.config.js (md 820, lg 1180); запрос ниже обязан совпадать
 * с `lg`, расхождение ловит тест hooks/__tests__/breakpoints.test.ts.
 */
const RAIL_WIDTH = 76;
const RAIL_WIDTH_OPEN = 220;
const WIDE_QUERY = "(min-width: 1180px)";

/** Широкий экран (≥ 1180): только на нём рейку можно закрепить развёрнутой. */
function useWideScreen(): boolean {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    setWide(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}

function NavGroup({ items, collapsed }: { items: NavItem[]; collapsed: boolean }) {
  return (
    <>
      {items.map(({ to, end, icon: Icon, label, badge }) => (
        // ПОДПИСЬ И ЗНАЧОК РИСУЮТСЯ ВСЕГДА — их прячет и показывает CSS, а не
        // условие в разметке (правила `[data-rail]` в theme-royal-home-2026.css,
        // перенос `.rail .lbl` / `.rail .it .bd` из эталона ff1d9d17).
        //
        // ЗАЧЕМ так. Раньше подпись появлялась через `{!collapsed && label}`:
        // React вставлял узел в DOM уже после того, как ширина поехала, — текст
        // ВЫСКАКИВАЛ в середине движения и на пол-кадра ложился на иконку. В
        // эталоне подпись всё время в потоке и просто проявляется (`opacity` +
        // `max-width`), одновременно с шириной рейки, поэтому раскрытие выглядит
        // цельным движением, а не двумя рывками. Активный пункт красит CSS по
        // `aria-current="page"`, который react-router ставит сам.
        <NavLink
          key={to}
          to={to}
          end={end}
          className="sh-nav-it rail-it"
          title={collapsed ? label : undefined}
        >
          <Icon className="w-[22px] h-[22px] shrink-0" strokeWidth={1.7} />
          <span className="rail-lbl">{label}</span>
          {!!badge && <span className="rail-bd">{badge > 99 ? "99+" : badge}</span>}
        </NavLink>
      ))}
    </>
  );
}

export function Sidebar() {
  const branding = useBranding();
  const navigate = useNavigate();
  const [showSearch, setShowSearch] = useState(false);
  const wide = useWideScreen();
  const pinnedOpen = !useUiPrefs((s) => s.sidebarCollapsed);
  const toggleCollapsed = useUiPrefs((s) => s.toggleSidebarCollapsed);
  // Закреплённое состояние: на 820–1179 рейка ВСЕГДА компактная (раскрытая 220
  // съела бы треть экрана), от 1180 — по выбору человека (кнопка-закрепление).
  const collapsed = !wide || !pinnedOpen;
  // Наведение раскрывает узкую рейку (76 → 220 px), но только мышью/трекпадом —
  // на тач-устройствах hover не «залипает», поэтому проверяем сами через
  // matchMedia, а не полагаемся на CSS :hover.
  const [hoverExpanded, setHoverExpanded] = useState(false);
  const handleRailMouseEnter = () => {
    if (collapsed && typeof window !== "undefined" && window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) {
      setHoverExpanded(true);
    }
  };
  const handleRailMouseLeave = () => {
    if (hoverExpanded) setHoverExpanded(false);
  };
  const visualCollapsed = collapsed && !hoverExpanded;
  // Решение владельца 09.09.2026: НАВЕДЕНИЕ раскрывает рейку НАПЛЫВОМ поверх
  // содержимого, а закрепление кнопкой раздвигает страницу. Поэтому место в
  // потоке всегда равно ЗАКРЕПЛЁННОЙ ширине (76 или 220), а сама рейка при
  // наплыве уходит из потока: иначе каждый проход мышью у левого края дёргал бы
  // весь экран на 144 px.
  const pinnedWidth = collapsed ? RAIL_WIDTH : RAIL_WIDTH_OPEN;
  const overlaying = hoverExpanded;
  // Меню плоское: девять строк, без складок (решение владельца 15.09.2026).
  const { main, more } = useNavigation();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowSearch(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="hidden md:block shrink-0" style={{ width: pinnedWidth }}>
      <aside
        data-rail
        data-collapsed={visualCollapsed ? "" : undefined}
        data-overlaying={overlaying ? "" : undefined}
        style={{ width: visualCollapsed ? RAIL_WIDTH : RAIL_WIDTH_OPEN }}
        onMouseEnter={handleRailMouseEnter}
        onMouseLeave={handleRailMouseLeave}
        className={`sh-rail rh-glass hidden md:flex h-screen flex-col transition-[width] duration-200 ease-out motion-reduce:transition-none ${
          overlaying ? "fixed inset-y-0 left-0 z-40 shadow-lg" : "relative"
        }`}
      >
        <div className="sh-rail-head">
          <button
            type="button"
            aria-label="На главную"
            onClick={() => navigate("/")}
            data-rail-home
            className="sh-rail-home"
          >
            {/* Загруженный логотип рисуется своего размера, без цветной коробки:
                прозрачный бренд-знак, зажатый в синий квадрат, превращался в
                безликий значок приложения. Нет логотипа — синий квадрат 40 px,
                r12, контракта. Имя и слоган — только у развёрнутой рейки. */}
            {branding?.companyLogoUrl ? (
              <img src={branding.companyLogoUrl} alt="" className="object-contain shrink-0 w-10 h-10" />
            ) : (
              <div className="sh-logo">
                <Home className="w-5 h-5" strokeWidth={2.1} />
              </div>
            )}
            {!visualCollapsed && (
              <div className="min-w-0 text-center">
                <div className="sh-rail-name truncate">{branding?.companyName ?? "Royal Home"}</div>
                <div className="sh-rail-slogan truncate">{branding?.companySlogan ?? "Агентство недвижимости"}</div>
              </div>
            )}
          </button>
        </div>

        {/* ПОИСК В РЕЙКЕ ОСТАЛСЯ ТОЛЬКО У СВЁРНУТОЙ (12.09.2026): поиск стоит
            слева в шапке широким полем, и второе поле под ним в раскрытой рейке
            открывало бы ТУ ЖЕ палитру — два входа в одно окно рядом. У свёрнутой
            значок остаётся: подписей нет, кружок читается как «лупа». */}
        {visualCollapsed && (
          <button
            type="button"
            onClick={() => setShowSearch(true)}
            title="Поиск (⌘K)"
            aria-label="Поиск клиентов и объектов"
            data-rail-search
            className="sh-rail-search"
          >
            <Search className="w-[22px] h-[22px]" strokeWidth={1.8} />
          </button>
        )}

        <nav className="sh-rail-nav">
          <NavGroup items={main} collapsed={visualCollapsed} />
        </nav>

        {/* Профиль живёт в правом верхнем углу (шапка): одна точка входа в
            учётную запись вместо двух. Отступ снизу — чтобы меню не упиралось в
            край экрана. */}
        <div className="mt-auto h-4 shrink-0" />

        {/* «Ещё» (нижняя группа): то, что роль не держит на виду (у агента Звонки и
            Команда). Пустая группа не рисуется. */}
        {more.length > 0 && (
          <nav className="sh-rail-nav sh-rail-more" aria-label="Ещё">
            <NavGroup items={more} collapsed={visualCollapsed} />
          </nav>
        )}

        {/* Закрепить развёрнутой можно только от 1180 px: на 820–1179 рейка
            компактная всегда, кнопка там ничего бы не меняла. */}
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? "Развернуть меню" : "Свернуть меню"}
          aria-label={collapsed ? "Развернуть меню" : "Свернуть меню"}
          data-rail-toggle
          className="sh-rail-toggle hidden lg:flex items-center justify-center"
        >
          {collapsed ? <ChevronsRight className="w-3 h-3" /> : <ChevronsLeft className="w-3 h-3" />}
        </button>

        {showSearch && <CommandPaletteLazy onClose={() => setShowSearch(false)} />}
      </aside>
    </div>
  );
}
