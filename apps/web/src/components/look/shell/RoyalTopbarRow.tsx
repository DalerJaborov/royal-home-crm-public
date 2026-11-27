import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Bell, ChevronLeft, Moon, Search, SlidersHorizontal, Sun } from "lucide-react";
import { RoyalIcon } from "../RoyalIcon";
import { ProfileMenu, initials, type ProfileMenuExtra } from "../../ProfileMenu";
import { ProfileAvatar } from "../../ProfileAvatar";
import { ShellCreateButton } from "./ShellCreateButton";
import { useAuthStore } from "../../../store/auth";
import { useUiPrefs } from "../../../store/uiPrefs";
import { THEMES } from "../../../lib/themes";

/**
 * ШАПКА «НОВОГО ВИДА» (макет 27.11.2026, пачка shell2) — одна строка на телефоне и ПК.
 *
 * ПК: поле «Найти что угодно» с подсказкой Ctrl K (открывает ту же палитру поиска,
 * CommandPalette), справа колокол с меткой, круглая «+» (те же быстрые действия и голос
 * по удержанию, что у прежнего «+» нижнего меню — components/quickCreate.tsx) и аватар.
 * Тема, ИИ-помощник и «Порядок вкладок» переехали в меню профиля — ни одно действие не
 * потеряно (ProfileMenu `extras`).
 *
 * Телефон: крупный заголовок экрана (как в макете) в начале страницы; при прокрутке —
 * мини-шапка (тот же заголовок мельче, черта снизу). На главной заголовка нет: приветствие
 * уже стоит на самом экране. Справа — кнопки экрана (или поиск), колокол, «+», аватар
 * (шторка «Ещё»: разделы и профиль).
 */
export interface RoyalProfileExtras {
  orderTabs?: { disabled: boolean; open: () => void };
  assistant?: { open: () => void; preload: { onPointerEnter: () => void; onFocus: () => void; onPointerDown: () => void } };
}

export interface RoyalTopbarRowProps {
  pageTitle: string | null;
  back: string | null;
  onBack: () => void;
  phoneActions: ReactNode[];
  bellRef: RefObject<HTMLButtonElement | null>;
  bellOpen: boolean;
  onBell: () => void;
  unreadCount: number;
  notificationsPanel: ReactNode;
  onSearch: () => void;
  onMore: () => void;
  profileExtras?: RoyalProfileExtras;
}

/**
 * Крупное название встаёт строкой ниже кнопок, если рядом с ними не помещается (длинное слово,
 * две кнопки экрана, узкий телефон) — а не режется посреди слова. Решает замер: ширина текста
 * против свободного места в строке; пересчёт при смене ширины, названия и после загрузки шрифта.
 */
function useTitleFits(row: RefObject<HTMLDivElement | null>, title: string, scrolled: boolean): boolean {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const node = row.current;
    if (!node) return;
    const canvas = document.createElement("canvas").getContext("2d");
    const measure = () => {
      const el = node.querySelector<HTMLElement>("[data-topbar-title]");
      const tools = node.querySelector<HTMLElement>(".ry-top-tools");
      const back = node.querySelector<HTMLElement>("[data-topbar-back]");
      if (!el || !tools || !title || !canvas) { setFits(true); return; }
      const style = getComputedStyle(el);
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const spacing = parseFloat(style.letterSpacing) || 0;
      // Рядом с кнопками название стоит только целиком в одну строку; иначе — строкой ниже.
      const width = canvas.measureText(title).width + spacing * title.length;
      const free = node.clientWidth - tools.offsetWidth - (back?.offsetWidth ?? 0) - 24;
      setFits(width <= free);
    };
    measure();
    // Ширина строки и ширина кнопок: кнопки экрана (фильтры, поиск) приезжают позже самой шапки.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    const toolsNode = node.querySelector(".ry-top-tools");
    if (toolsNode) observer.observe(toolsNode);
    void document.fonts?.ready.then(measure).catch(() => {});
    return () => observer.disconnect();
  }, [row, title, scrolled]);
  return fits;
}

/** Прокручена ли страница — мини-шапка. Слушатель пассивный, состояние меняется только на границе. */
function useScrolledPast(px: number): boolean {
  const [past, setPast] = useState(() => typeof window !== "undefined" && window.scrollY > px);
  useEffect(() => {
    const check = () => setPast(window.scrollY > px);
    check();
    window.addEventListener("scroll", check, { passive: true });
    return () => window.removeEventListener("scroll", check);
  }, [px]);
  return past;
}

function isMac(): boolean {
  try { return /Mac|iPhone|iPad/.test(navigator.platform); } catch { return false; }
}

export function RoyalTopbarRow({
  pageTitle, back, onBack, phoneActions, bellRef, bellOpen, onBell, unreadCount, notificationsPanel, onSearch, onMore, profileExtras,
}: RoyalTopbarRowProps) {
  const agent = useAuthStore((s) => s.agent);
  const theme = useUiPrefs((s) => s.theme);
  const setTheme = useUiPrefs((s) => s.setTheme);
  const current = THEMES.find((t) => t.id === theme) ?? THEMES[0];
  const scrolled = useScrolledPast(12);
  const title = pageTitle ?? "";
  const rowRef = useRef<HTMLDivElement>(null);
  const long = !useTitleFits(rowRef, title, scrolled);
  const badge = unreadCount > 9 ? "9+" : String(unreadCount);

  const extras: ProfileMenuExtra[] = [
    ...(profileExtras?.assistant ? [{
      key: "assistant", label: "ИИ-помощник", tone: "a4" as const,
      icon: <RoyalIcon name="bot" size={22} />, onSelect: profileExtras.assistant.open, buttonProps: profileExtras.assistant.preload,
    }] : []),
    {
      key: "theme", label: current.isDark ? "Светлая тема" : "Тёмная тема", tone: "a1" as const,
      icon: current.isDark ? <Sun size={22} strokeWidth={1.8} /> : <Moon size={22} strokeWidth={1.8} />,
      onSelect: () => setTheme(current.pairId),
    },
    ...(profileExtras?.orderTabs ? [{
      key: "order", label: "Порядок вкладок", tone: "a5" as const, disabled: profileExtras.orderTabs.disabled,
      icon: <SlidersHorizontal size={22} strokeWidth={1.8} />, onSelect: profileExtras.orderTabs.open,
    }] : []),
  ];

  // Колокол и «+» — по ОДНОМУ элементу на обе раскладки: панель уведомлений встаёт под
  // кнопкой по её координатам (bellRef), и второй, скрытый колокол сбил бы место панели.
  // Телефон/ПК переключает CSS (`.ry-only-phone` / `.ry-only-pc`, theme-look-royal.css):
  // сенсорный планшет получает телефонную шапку, как и прежде.
  return (
    <div ref={rowRef} data-topbar data-ry-top className="rh-glass sh-top flex items-center gap-3 px-4 md:px-6"
      data-scrolled={scrolled || undefined} data-long={long || undefined} data-home={!title || undefined}>
      {back && (
        <button type="button" onClick={onBack} data-topbar-back aria-label="Назад" className="sh-btn ry-only-phone flex items-center justify-center">
          <ChevronLeft className="w-[22px] h-[22px]" strokeWidth={1.8} />
        </button>
      )}
      {/* Название экрана: крупное в начале страницы, мельче — в мини-шапке при прокрутке. */}
      <span data-topbar-title className="ry-only-phone ry-top-title">{title}</span>
      {/* ПК: поле поиска (кнопка, а не <input>: искать умеет палитра со своим полем и историей). */}
      <button type="button" onClick={onSearch} data-topbar-search-wide aria-label="Найти что угодно: клиенты, объекты, сделки" aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K" className="sh-search ry-top-search ry-only-pc items-center gap-2.5">
        <Search className="w-[18px] h-[18px] shrink-0" strokeWidth={1.9} />
        <span className="ry-top-search-text">Найти что угодно</span>
        <kbd className="ry-top-kbd" aria-hidden="true">{isMac() ? "⌘ K" : "Ctrl K"}</kbd>
      </button>
      <div className="ry-top-tools flex items-center gap-2">
        {phoneActions.length > 0 ? <span className="ry-only-phone ry-top-actions items-center gap-2">{phoneActions}</span> : (
          <button type="button" onClick={onSearch} aria-label="Поиск клиентов и объектов" data-topbar-search className="sh-btn ry-top-btn ry-only-phone items-center justify-center">
            <Search className="w-[21px] h-[21px]" strokeWidth={1.8} />
          </button>
        )}
        <div className="relative ry-top-bellwrap">
          <button type="button" ref={bellRef} onClick={onBell} aria-label={unreadCount > 0 ? `Уведомления, новых: ${unreadCount}` : "Уведомления"}
            aria-expanded={bellOpen} data-topbar-bell className="sh-btn ry-top-btn flex items-center justify-center">
            <Bell className="w-[22px] h-[22px]" strokeWidth={1.8} />
            {unreadCount > 0 && <span data-unread-badge className="ry-top-badge ry-num" aria-hidden="true">{badge}</span>}
          </button>
          {notificationsPanel}
        </div>
        <ShellCreateButton className="sh-btn ry-top-btn ry-top-create flex items-center justify-center" />
        <button type="button" onClick={onMore} aria-label="Ещё: разделы и профиль" aria-haspopup="dialog" data-topbar-me className="sh-btn sh-avatar ry-only-phone items-center justify-center">
          <ProfileAvatar src={agent?.avatarUrl} fallback={initials(agent?.fullName)} className="h-full w-full rounded-full object-cover" />
        </button>
        <span data-topbar-me className="ry-only-pc">
          <ProfileMenu extras={extras} />
        </span>
      </div>
    </div>
  );
}
