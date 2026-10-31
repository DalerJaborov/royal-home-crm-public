import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { ChevronDown, House, Plus, SlidersHorizontal, Sparkles } from "lucide-react";
import { useNavigation, type NavItem } from "../../lib/navigation";
import { defaultCleanNavigation, partitionCleanNavigation } from "../../lib/cleanNavigationOrder";
import { useUiPrefs } from "../../store/uiPrefs";
import { CleanNavigationOrderSheet } from "./CleanNavigationOrderSheet";
export { partitionCleanNavigation } from "../../lib/cleanNavigationOrder";
import { useCan, useCanCreateProperty } from "../../lib/permissions";
import { useAuthStore } from "../../store/auth";
import { mcOk, useMissionControlLive } from "../../hooks/useMissionControl";
import { CleanCriticalNotice } from "./CleanCriticalNotice";
import { useShellStore } from "../../store/shell";
import { ASSISTANT_ENTRY_LABEL, ASSISTANT_ENTRY_TITLE, useAssistantEntry } from "../../hooks/useAssistantEntry";
import { Topbar } from "../Topbar";
import { CButton, CLink } from "./ui";
import { permitsCleanChunkWarming, scheduleCleanRouteChunks, warmCleanRouteChunk, type WarmConnection } from "../../lib/cleanRouteChunks";

function warmOnIntent(path: string) {
  if (navigator.onLine === false) return;
  if (!permitsCleanChunkWarming((navigator as Navigator & { connection?: WarmConnection }).connection)) return;
  // Optional warming failure must not trigger the route's deployment recovery.
  void warmCleanRouteChunk(path).catch(() => {});
}


function Tab({ item }: { item: NavItem }) {
  return <NavLink to={item.to} end={item.end} className="clean-tab" onPointerEnter={() => warmOnIntent(item.to)} onPointerDown={() => warmOnIntent(item.to)} onFocus={() => warmOnIntent(item.to)}>
    {item.label}
    {!!item.badge && <><span className="clean-nav-count" aria-hidden="true">{item.badge > 99 ? "99+" : item.badge}</span><span className="sr-only">{item.badgeQuiet ? "Всего" : "Новых"}: {item.badge}</span></>}
  </NavLink>;
}

export function CleanShell() {
  const { main, all } = useNavigation();
  const [tabCapacity, setTabCapacity] = useState(6);
  const actorId = useAuthStore((state) => state.agent?.id);
  const epoch = useAuthStore((state) => state.sessionEpoch);
  const storedOwner = useUiPrefs((state) => state.navigationOwnerId);
  const storedOrder = useUiPrefs((state) => state.desktopNavigationOrder);
  const savedOrder = storedOwner === actorId ? storedOrder : [];
  const saveOrder = useUiPrefs((state) => state.saveDesktopNavigationOrder);
  const prefsHydrated = useUiPrefs((state) => state.serverHydrated);
  const [navigationEditor, setNavigationEditor] = useState<{ actorId: string; epoch: number } | null>(null);
  const { tabs, overflow } = partitionCleanNavigation(main, all, tabCapacity, savedOrder);
  const permittedPaths = [...new Set([...main, ...all].map((item) => item.to))].sort().join("\n");
  useEffect(() => {
    if (!actorId) return;
    const permitted = permittedPaths.split("\n");
    const mobile = !window.matchMedia("(min-width: 820px)").matches;
    const paths = mobile ? ["/messages", "/clients", "/properties"].filter((path) => permitted.includes(path)) : permitted;
    return scheduleCleanRouteChunks(paths, { isActive: () => {
      const current = useAuthStore.getState();
      return current.agent?.id === actorId && current.sessionEpoch === epoch;
    } });
  }, [actorId, epoch, permittedPaths]);
  const overflowUnread = overflow.reduce((total, item) => total + (item.badgeQuiet ? 0 : item.badge ?? 0), 0);
  const canCreate = useCanCreateProperty();
  const { pathname } = useLocation();
  // `all` is rebuilt on every counter refresh; only a route change may move focus.
  const routeLabel = defaultCleanNavigation(main, all).sort((a, b) => b.to.length - a.to.length).find((item) => pathname === item.to || item.to !== "/" && pathname.startsWith(`${item.to}/`))?.label;
  useEffect(() => {
    document.title = `${routeLabel ?? "Royal Home"} · Royal Home CRM`;
  }, [routeLabel]);
  useEffect(() => {
    if (document.activeElement === document.body || document.activeElement?.closest(".clean-tabs, .clean-more-panel")) document.getElementById("main")?.focus({ preventScroll: true });
  }, [pathname]);
  const back = useShellStore((s) => s.back);
  const ownHeader = useShellStore((s) => s.ownHeader);
  const title = useShellStore((s) => s.title);
  // Панель помощника одна на все входы и монтируется в AssistantHost (AppLayout).
  const assistantEntry = useAssistantEntry();
  const menu = useRef<HTMLDetailsElement>(null);
  const header = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLElement>(null);
  const openNavigationEditor = () => {
    if (!actorId || !prefsHydrated) return;
    if (menu.current) menu.current.open = false;
    menuButton.current?.focus();
    setNavigationEditor({ actorId, epoch });
  };
  const context = !!back || ownHeader || pathname === "/messages";
  const activeOverflow = overflow.find((item) => pathname === item.to || (!item.end && pathname.startsWith(`${item.to}/`)));
  useEffect(() => { if (menu.current) menu.current.open = false; }, [pathname]);
  useEffect(() => {
    const node = header.current;
    const frame = node?.parentElement;
    if (!node || !frame) return;
    const measure = () => {
      const bounds = node.getBoundingClientRect();
      frame.style.setProperty("--clean-header-height", `${bounds.height + 8}px`);
      setTabCapacity(window.matchMedia("(min-width: 820px)").matches ? 6 : 4);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => { observer.disconnect(); frame.style.removeProperty("--clean-header-height"); };
  }, []);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (menu.current?.open && event.target instanceof Node && !menu.current.contains(event.target)) menu.current.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  return <>
    <header ref={header} className={`clean-header${context ? " clean-header-context" : ""}${ownHeader || pathname === "/messages" ? " clean-header-own" : ""}`}>
      <Link to="/" className="clean-brand" aria-label="Royal Home CRM · Главная">
        <span><House aria-hidden="true" /></span>
        <b className="clean-brand-desktop">Royal Home CRM</b>
        <b className="clean-brand-mobile">{title ?? "Royal Home"}</b>
      </Link>
      <nav className="clean-tabs" aria-label="Основные разделы">
        {tabs.map((item) => <Tab key={item.to} item={item} />)}
      </nav>
      {overflow.length > 0 && <details ref={menu} className="clean-more" data-active={!!activeOverflow || undefined} onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }} onKeyDown={(event) => {
        if (event.key === "Escape" && menu.current) { menu.current.open = false; menuButton.current?.focus(); }
      }}>
        <summary ref={menuButton} aria-label={`${activeOverflow?.label ?? "Ещё"} — все разделы${overflowUnread ? `. Новых: ${overflowUnread}` : ""}`}><span>{activeOverflow?.label ?? "Ещё"}</span>{!!overflowUnread && <span className="clean-nav-count" aria-hidden="true">{overflowUnread > 99 ? "99+" : overflowUnread}</span>}<ChevronDown aria-hidden="true" /></summary>
        <nav aria-label="Остальные разделы" className="clean-more-panel">
          {overflow.map((item) => <NavLink key={item.to} to={item.to} end={item.end} onPointerEnter={() => warmOnIntent(item.to)} onFocus={() => warmOnIntent(item.to)} onClick={() => { if (menu.current) menu.current.open = false; }}>
            <item.icon aria-hidden="true" /><span>{item.label}</span>{!!item.badge && <><span className="clean-nav-count" aria-hidden="true">{item.badge > 99 ? "99+" : item.badge}</span><span className="sr-only">{item.badgeQuiet ? "Всего" : "Новых"}: {item.badge}</span></>}
          </NavLink>)}
          {actorId && <CButton variant="soft" className="mt-2 w-full justify-start" disabled={!prefsHydrated} aria-label="Настроить порядок вкладок" onClick={openNavigationEditor}><SlidersHorizontal /><span>Порядок вкладок</span></CButton>}
        </nav>
      </details>}
      <div className="clean-header-tools">
        {actorId && overflow.length === 0 && <CButton variant="soft" size="icon-md" disabled={!prefsHydrated} aria-label="Настроить порядок вкладок" onClick={openNavigationEditor}><SlidersHorizontal /></CButton>}
        {assistantEntry.visible && <CButton variant="soft" size="icon-md" className="clean-ai" aria-label={ASSISTANT_ENTRY_LABEL} title={ASSISTANT_ENTRY_TITLE} onClick={assistantEntry.open} {...assistantEntry.preloadProps}><Sparkles /></CButton>}
        {canCreate && <CLink to="/properties/new" className="clean-create" variant="soft" size="icon-md" aria-label="Создать объект"><Plus /></CLink>}
      </div>
      <div className="clean-existing-topbar"><Topbar clean /></div>
    </header>
    {navigationEditor && navigationEditor.actorId === actorId && navigationEditor.epoch === epoch && <CleanNavigationOrderSheet key={`${actorId}:${epoch}`} items={defaultCleanNavigation(main, all)} savedOrder={savedOrder} onSave={saveOrder} onClose={() => setNavigationEditor(null)} />}
    <CleanCriticalHost />
  </>;
}

/** Live events remain visible across sections, independently of slow/error zones. */
function CleanCriticalHost() {
  const { pathname } = useLocation();
  const agent = useAuthStore((state) => state.agent);
  const can = useCan();
  const enabled = !!agent && (agent.role === "DIRECTOR" || agent.role === "ADMIN") && can("dashboard.analytics");
  const { data, isError, refetch } = useMissionControlLive(enabled);
  const firstLine = data?.firstLine;
  if (enabled && (isError || firstLine && !mcOk(firstLine))) return <aside className="clean-critical-notice" role="status"><p>Критические события не загрузились. Отсутствие событий не подтверждено.</p><CButton variant="soft" onClick={() => void refetch()}>Повторить</CButton></aside>;
  return enabled && agent && mcOk(firstLine)
    ? <CleanCriticalNotice agentId={agent.id} items={firstLine.items} compact={pathname.startsWith("/messages")} />
    : null;
}
