// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ЯДРО ГЛАВНОЙ «НОВОГО ВИДА» (пачка home, 20.11.2026): реестр блоков, раскладка по
 * роли, выключатели и граница ошибок каждого блока; и блоки пяти ролей на тех же
 * данных, что прежние главные (запросы подменены).
 */
const h = vi.hoisted(() => ({
  role: "EDITOR",
  mobile: false,
  perms: new Set<string>(["reports.view", "properties.moderate", "calls.ownTranscripts"]),
  editor: { data: undefined as unknown, isLoading: false, isError: false, isFetching: false },
  summary: { data: undefined as unknown, isLoading: false, isError: false },
  queue: { data: undefined as unknown, isLoading: false, isError: false },
  team: { data: undefined as unknown, isPending: false, isError: false },
  convs: { data: { items: [] } as unknown, isPending: false, isError: false },
}));
vi.mock("../../../store/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../store/auth")>(),
  useAuthStore: (select: (s: unknown) => unknown) => select({ agent: { id: "a1", fullName: "Сорбон Тестов", role: h.role } }),
}));
vi.mock("../../../lib/permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/permissions")>(), useCan: () => (p: string) => h.perms.has(p),
}));
vi.mock("../../../hooks/useMarketing", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../hooks/useMarketing")>(),
  useEditorQueue: () => ({ ...h.editor, refetch: vi.fn() }),
  useMarketingSummary: () => ({ ...h.summary, refetch: vi.fn() }),
  useMarketingQueue: () => ({ ...h.queue, refetch: vi.fn() }),
}));
vi.mock("../../../hooks/useAds", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../hooks/useAds")>(), useAdsBoard: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("../../../hooks/useAi", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../hooks/useAi")>(), useAiInsights: () => ({ data: { staleProperties: [] } }),
}));
vi.mock("../../../hooks/useTeamLive", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../hooks/useTeamLive")>(), useTeamLive: () => ({ ...h.team, refetch: vi.fn() }),
}));
vi.mock("../../../hooks/useConversations", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../hooks/useConversations")>(), useConversations: () => ({ ...h.convs, refetch: vi.fn() }),
}));
vi.mock("../../../hooks/useDashboard", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../hooks/useDashboard")>(), useDashboardSummary: () => ({ data: { kpis: { showingsWeek: 7 } }, isError: false }),
}));
vi.mock("../../../hooks/useMobileUx", () => ({ useMobileUx: () => h.mobile }));
vi.mock("../../home/TeamCharts", () => ({ TeamCharts: () => null }));
vi.mock("../../home/HomeAsk", () => ({ HomeAsk: ({ placeholder }: { placeholder: string }) => <input aria-label="ask" placeholder={placeholder} /> }));

import { homeBlocksFor, mergeHomeOrder, RoyalHomeCore, type HomeBlockDef } from "./core";
import { HOME_BLOCKS, HOME_LAYOUT, RoyalRoleHome } from "./registry";
import { channelBrand, greetingFor } from "./time";

const wrap = (node: React.ReactNode) => render(
  <QueryClientProvider client={new QueryClient()}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>,
);
const stage = (overdue: boolean, days = 3) => ({ inPipeline: true, owner: "EDITOR" as const, daysInStage: days, limitDays: 2, overdue });
const row = (id: string, title: string, overdue = false) => ({
  id, shortId: Number(id.replace(/\D/g, "")) || 1, title, status: "EDITING", photoCount: 12, photos: [],
  responsibleAgent: { id: "ag", fullName: "Ноза Каримова" }, pipeline: stage(overdue), instagramUrl: null, reviewRejectionReason: null,
});

beforeEach(() => {
  h.role = "EDITOR";
  h.mobile = false;
  h.editor = { data: undefined, isLoading: false, isError: false, isFetching: false };
  h.summary = { data: undefined, isLoading: false, isError: false };
  h.queue = { data: undefined, isLoading: false, isError: false };
  h.team = { data: undefined, isPending: false, isError: false };
  h.convs = { data: { items: [] }, isPending: false, isError: false };
});
afterEach(cleanup);

const A = () => <p>блок А</p>;
const B = () => <p>блок Б</p>;
const REG: HomeBlockDef[] = [
  { id: "a", roles: ["EDITOR"], title: "А", component: A },
  { id: "b", roles: ["EDITOR", "default"], title: "Б", component: B },
  { id: "c", roles: ["MARKETING"], title: "В", component: A },
];

describe("ядро главной: реестр и раскладка", () => {
  it("рисует блоки роли по порядку, выключенные и чужие отсеивает", () => {
    const layout = { EDITOR: ["b", "a", "c", "zzz", "a"], default: ["b"] };
    expect(homeBlocksFor("EDITOR", REG, layout).map((b) => b.id)).toEqual(["b", "a"]);
    expect(homeBlocksFor("EDITOR", REG, layout, { hidden: new Set(["a"]) }).map((b) => b.id)).toEqual(["b"]);
    // Сохранённый порядок не расширяет права: блок другой роли не появляется, а свой
    // блок, которого в сохранённом нет, не теряется (выключают переключателем, не порядком).
    expect(homeBlocksFor("EDITOR", REG, layout, { order: ["c", "a"] }).map((b) => b.id)).toEqual(["b", "a"]);
    // Роль без своей раскладки — раскладка и блоки `default` (как прежняя развилка Dashboard).
    expect(homeBlocksFor("SHAREHOLDER_X", REG, layout).map((b) => b.id)).toEqual(["b"]);
  });

  it("каждый id раскладки есть в реестре и разрешён своей роли", () => {
    const ids = new Set(HOME_BLOCKS.map((b) => b.id));
    expect(ids.size).toBe(HOME_BLOCKS.length);
    for (const [role, order] of Object.entries(HOME_LAYOUT)) {
      for (const id of order) expect(ids.has(id), `${role}: ${id}`).toBe(true);
      expect(homeBlocksFor(role, HOME_BLOCKS, HOME_LAYOUT).map((b) => b.id), role).toEqual(order);
    }
    for (const role of ["DIRECTOR", "ADMIN", "HEAD_OF_SALES", "AGENT", "EDITOR", "MARKETING", "SECURITY", "MANAGER", "SHAREHOLDER"]) expect(HOME_LAYOUT[role], role).toBeDefined();
  });

  it("у каждой роли ядра — свои блоки и «Весь прежний экран»; блоки чужих ролей не видны", () => {
    const ids = (role: string) => homeBlocksFor(role, HOME_BLOCKS, HOME_LAYOUT).map((b) => b.id);
    expect(ids("DIRECTOR")).toEqual(ids("ADMIN"));
    expect(ids("DIRECTOR")).toEqual(expect.arrayContaining(["money", "decisions", "burning", "pulse", "commission", "full"]));
    expect(ids("HEAD_OF_SALES")).toEqual(expect.arrayContaining(["ropTiles", "ropTasks", "teamCharts", "full"]));
    expect(ids("AGENT")).toEqual(expect.arrayContaining(["agentTiles", "agentFirstCalls", "agentMonth", "full"]));
    expect(ids("AGENT")).not.toContain("money");
    expect(ids("MANAGER")).not.toContain("full");
    // Сохранённый порядок агента с блоками директора не добавляет их агенту.
    expect(homeBlocksFor("AGENT", HOME_BLOCKS, HOME_LAYOUT, { order: ["money", "decisions", "agentMonth"] }).map((b) => b.id))
      .not.toEqual(expect.arrayContaining(["money"]));
  });

  it("блок, появившийся после сохранения порядка, встаёт на своё место включённым; неизвестные id отброшены", () => {
    expect(mergeHomeOrder(["a", "b", "c", "d"], ["c", "a"])).toEqual(["c", "d", "a", "b"]);
    expect(mergeHomeOrder(["a", "b", "c"], ["zzz", "b"])).toEqual(["a", "b", "c"]);
    expect(mergeHomeOrder(["a", "b"], undefined)).toEqual(["a", "b"]);
    expect(mergeHomeOrder(["a", "b", "c"], ["c", "c", "b"])).toEqual(["a", "c", "b"]);
  });

  it("упавший блок показывает «Не загрузилось · Повторить», соседи живут; «Повторить» рисует его заново", async () => {
    let broken = true;
    const Boom = () => { if (broken) throw new Error("boom"); return <p>ожил</p>; };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Граница пишет ошибку в журнал событием окна (ErrorBoundary); здесь гасим, иначе jsdom считает её непойманной.
    const journal: string[] = [];
    const capture = (event: ErrorEvent) => { journal.push(event.message); event.preventDefault(); event.stopImmediatePropagation(); };
    window.addEventListener("error", capture, true);
    wrap(<RoyalHomeCore role="EDITOR" registry={[...REG, { id: "boom", roles: ["EDITOR"], title: "Взрыв", component: Boom }]} layout={{ EDITOR: ["a", "boom", "b"] }} />);
    expect(screen.getByText("блок А")).toBeTruthy();
    expect(screen.getByText("блок Б")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Взрыв" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Не загрузилось");
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    // Одна дверь на «блок упал» — общая BlockBoundary: сперва перезапрос упавшего, потом новая отрисовка.
    expect(await screen.findByText("ожил")).toBeTruthy();
    expect(journal.some((message) => message.startsWith("[блок today.boom]"))).toBe(true);
    window.removeEventListener("error", capture, true);
    spy.mockRestore();
  });

  it("корень несёт метку раздела home и приветствие", () => {
    const { container } = wrap(<RoyalHomeCore role="EDITOR" registry={REG} layout={{ EDITOR: ["a"] }} />);
    const root = container.querySelector(".ry-today");
    expect(root?.getAttribute("data-ry-section")).toBe("home");
    expect(container.querySelector('.ry-home-blk[data-block="a"]')).toBeTruthy();
    expect(screen.getByText(/, Сорбон$/)).toBeTruthy();
  });
});

describe("время и каналы ядра (свой модуль, без TodayRoyal)", () => {
  it("приветствие по часу и логотип канала", () => {
    expect([greetingFor(6), greetingFor(13), greetingFor(19), greetingFor(2)]).toEqual(["Доброе утро", "Добрый день", "Добрый вечер", "Доброй ночи"]);
    expect([channelBrand("WHATSAPP"), channelBrand("telegram"), channelBrand("website"), channelBrand("okru")]).toEqual(["whatsapp", "telegram", "site", null]);
  });
  it("анимация графиков: только при «без ограничений движения», полоса до своей доли, минус растёт вниз", async () => {
    const { readFileSync, statSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const file = ["src/theme-look-royal-home.css", "apps/web/src/theme-look-royal-home.css"].map((p) => resolve(process.cwd(), p)).find((p) => { try { return statSync(p).isFile(); } catch { return false; } })!;
    const css = readFileSync(file, "utf8");
    const motion = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference)"), css.indexOf("@keyframes ry-home-grow-y"));
    expect(motion).toMatch(/\.chart \.br \{[^}]*animation: ry-home-grow-y/);
    expect(motion).toMatch(/\.br\[data-negative\] \{ transform-origin: 50% 0; \}/);
    expect(motion).toMatch(/\.bars \.b \.tr i \{[^}]*animation: ry-home-fill-v/);
    expect(css).toMatch(/@keyframes ry-home-fill-v \{[^}]*\}[^}]*scaleX\(var\(--v, 0\)\)/);
  });

  it("ни один файл ядра не импортирует pages/TodayRoyal", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const root = ["src/components/look/home", "apps/web/src/components/look/home"].map((p) => resolve(process.cwd(), p)).find((p) => { try { return statSync(p).isDirectory(); } catch { return false; } })!;
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]);
    const offenders = files(root).filter((f) => !f.endsWith(".test.tsx") && /from\s+["'][^"']*pages\/TodayRoyal["']/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("блоки ролей на данных прежних главных", () => {
  it("монтажёр: просроченный объект первым, ссылки и счётчики прежние, отказ — не «пусто»", () => {
    h.editor = { ...h.editor, data: {
      inEditing: [row("p1", "Квартира на Рудаки"), row("p2", "Дом в Варзобе", true)], upcoming: [],
      counts: { inEditing: 2, overdue: 1, upcoming: 0 }, editingPage: 1, upcomingPage: 1, pageSize: 50,
    } };
    const { container } = wrap(<RoyalRoleHome />);
    const titles = [...container.querySelectorAll('[data-block="editorEditing"] .ry-row-title')].map((n) => n.textContent);
    expect(titles).toEqual(["Дом в Варзобе", "Квартира на Рудаки"]);
    expect(container.querySelector('a[href="/properties?status=EDITING&overdue=1"]')).toBeTruthy();
    expect(container.querySelector('a[href="/marketing"]')).toBeTruthy();
    expect(container.textContent).toContain("просрочено на 1 дн.");
    expect(container.textContent).toContain("Пока ничего не снимают");
    cleanup();
    h.editor = { data: undefined, isLoading: false, isError: true, isFetching: false };
    wrap(<RoyalRoleHome />);
    expect(screen.getAllByText("Не загрузилось").length).toBeGreaterThan(0);
    expect(screen.queryByText("Ничего не ждёт монтажа")).toBeNull();
  });

  it("«Просрочено»: срочная (чёрная) плитка только при просрочке; ПК — «Показать ещё» сразу догружает", () => {
    const tile = (container: HTMLElement) => container.querySelector('a.ry-tile[href="/properties?status=EDITING&overdue=1"]')?.getAttribute("data-variant");
    const queue = (overdue: number) => ({ ...h.editor, data: {
      inEditing: [row("p1", "Квартира"), row("p2", "Дом")], upcoming: [],
      counts: { inEditing: 60, overdue, upcoming: 0 }, editingPage: 1, upcomingPage: 1, pageSize: 50,
    } });
    h.editor = queue(0);
    expect(tile(wrap(<RoyalRoleHome />).container)).toBe("plain");
    cleanup();
    h.editor = queue(2);
    const { container } = wrap(<RoyalRoleHome />);
    expect(tile(container)).toBe("ink");
    // ПК (не телефон): видно всё пришедшее, кнопка говорит, сколько ещё на сервере.
    expect(container.querySelectorAll('[data-block="editorEditing"] .ry-row').length).toBe(2);
    expect(container.querySelector('[data-block="editorEditing"] .ry-home-more')?.textContent).toContain("(58)");
    // Блоки ядра не падают (граница ошибок молчит): подсказка на месте.
    expect(container.querySelector(".ry-home-hint")).toBeTruthy();
    cleanup();
    // Телефон: сначала пять строк — здесь пришло две, раскрывать нечего, кнопка сразу про сервер.
    h.mobile = true;
    const phone = wrap(<RoyalRoleHome />);
    expect(phone.container.querySelectorAll('[data-block="editorEditing"] .ry-row').length).toBe(2);
  });

  it("маркетинг: фокус — просроченный объект, «Очередь» только при праве", () => {
    h.role = "MARKETING";
    h.summary = { ...h.summary, data: { total: 9, awaitingReview: 2, awaitingPhotos: 3, awaitingVideo: 1, editing: 2, overdue: 1 } };
    h.queue = { ...h.queue, data: { items: [row("p3", "Офис на Сомони"), row("p4", "Склад", true)], total: 2 } };
    const { container } = wrap(<RoyalRoleHome />);
    expect(container.querySelector('[data-block="marketingFocus"] .ry-row-title')?.textContent).toBe("Склад");
    expect(container.querySelector('a[href="/pipeline"]')).toBeTruthy();
    cleanup();
    h.perms = new Set(["reports.view"]);
    const again = wrap(<RoyalRoleHome />);
    expect(again.container.querySelector('a[href="/pipeline"]')).toBeNull();
    h.perms = new Set(["reports.view", "properties.moderate", "calls.ownTranscripts"]);
  });

  it("СБ: те же два перехода", () => {
    h.role = "SECURITY";
    const { container } = wrap(<RoyalRoleHome />);
    expect([...container.querySelectorAll('[data-block="securityLinks"] a')].map((a) => a.getAttribute("href"))).toEqual(["/clients", "/properties"]);
  });

  // Акционер с 20.11.2026 — своя главная (деньги и тренды), см. blocks/leader.test.tsx.
  it.each(["MANAGER"])("%s: потерянная и «никто не принял» — смыслом; отказ сводки — не «все приняты»", (role) => {
    h.role = role;
    h.team = { ...h.team, data: {
      agents: [{ id: "g1", fullName: "Бону Саидова", avatarUrl: null, activeLoad: 0, pendingAccept: 0, acceptedToday: 2, escalated: 0 }],
      unaccepted: [
        { shortId: 11, fullName: "Зарина", agentName: "Бону", reassignCount: 2, escalated: true, lost: false, waitingMinutes: 40 },
        { shortId: 12, fullName: "Фаррух", agentName: "Бону", reassignCount: 5, escalated: true, lost: true, waitingMinutes: 90 },
      ],
      unacceptedTotal: 2, escalatedTotal: 2, queuedTotal: 1,
    } };
    const { container } = wrap(<RoyalRoleHome />);
    expect(container.querySelector('[data-block="managerFocus"]')?.textContent).toContain("никто не принял");
    expect(container.querySelector('[data-block="managerWaiting"]')?.textContent).toContain("потерянный, вручную");
    expect(container.querySelector('[data-block="managerTeam"] .ry-home-chip')?.textContent).toBe("свободен");
    expect(container.querySelector('a[href="/calls"]')?.textContent).toBe("Мои звонки");
    cleanup();
    h.team = { data: undefined, isPending: false, isError: true };
    wrap(<RoyalRoleHome />);
    expect(screen.queryByText("Все заявки приняты")).toBeNull();
    expect(screen.getAllByText("Не загрузилось").length).toBeGreaterThan(0);
  });
});
