import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { functionStatus, integrations, notifications, pendingLeads } from "../../../../tests/e2e/helpers/adminFixtures";

/**
 * «НОВЫЙ ВИД» СЛУЖЕБНЫХ ЭКРАНОВ (пачка admin, 20.11.2026): вид другой — данные те же.
 *
 * Один и тот же ответ сервера рисуется в прежнем виде и в новом. Текст страницы (всё, что
 * читает человек и экранный чтец) обязан совпасть: новый вид не теряет ни причину
 * выключения функции, ни ошибку канала, ни метку «Новое»/«Передан», ни одной кнопки — и
 * не дописывает своего. У экранов, где меняется только оформление, текст совпадает до
 * символа и порядка; у ленты уведомлений новый вид ставит время в строку подписи (на ПК
 * оно стояло справа) — там совпадает набор слов. Без признака — ни следа нового вида.
 */
const state = vi.hoisted(() => ({ royal: false, clean: true, mobile: false, role: "AGENT" }));
vi.mock("../../../hooks/useRoyalLook", () => ({ useRoyalLook: () => state.royal }));
vi.mock("../../../hooks/useCleanShell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/useCleanShell")>()),
  useCleanShell: () => state.clean,
}));
vi.mock("../../../hooks/useMobileUx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/useMobileUx")>()),
  useMobileUx: () => state.mobile,
}));
vi.mock("../../../lib/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/permissions")>()),
  useCan: () => () => true,
}));
vi.mock("../../../store/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../store/auth")>();
  return { ...real, useAuthStore: (pick: (s: unknown) => unknown) => pick({ agent: { id: "ag-1", role: state.role } }) };
});
vi.mock("../../SectionTabs", () => ({ SettingsTabs: () => <nav>Вкладки здоровья</nav> }));

import { RolesMatrix } from "../../../pages/settings/RolesMatrix";
import { FunctionStatus } from "../../../pages/settings/FunctionStatus";
import { Integrations } from "../../../pages/Integrations";
import { ChannelDetail } from "../../../pages/ChannelDetail";
import { Notifications } from "../../../pages/Notifications";
import { Profile } from "../../../pages/Profile";
import { NotFound } from "../../NotFound";
import { AdminRoot, AdminScreen } from "./AdminRoot";

const PROFILE = {
  id: "ag-1", fullName: "Фарход Назаров", phone: "+992900000002", email: null, role: "AGENT", avatarUrl: null, preferences: null,
  totpEnabled: false, leadsPausedUntil: null, leadsPausedEndedAt: null, frozenAt: null, frozenReason: null, permissions: [],
  telegramLinked: false, telegramModeration: false, isVideoMontajer: false, montageCopiesTelegram: false, clipReviewTelegram: false,
};

function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(["notifications"], notifications);
  qc.setQueryData(["clients", { pageSize: 100, pendingAcceptance: true }], pendingLeads);
  qc.setQueryData(["integrations"], integrations);
  qc.setQueryData(["function-status"], functionStatus);
  qc.setQueryData(["me"], PROFILE);
  qc.setQueryData(["settings"], { royalScoreEnabled: false });
  return qc;
}
vi.mock("../../../hooks/useFunctionStatus", () => ({
  useFunctionStatus: () => ({ data: functionStatus, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() }),
}));

const render = (url: string, el: ReactElement, path?: string) => renderToStaticMarkup(
  <QueryClientProvider client={client()}>
    <MemoryRouter initialEntries={[url]}>
      {path ? <RoutesFor path={path} el={el} /> : el}
    </MemoryRouter>
  </QueryClientProvider>,
);
import { Route, Routes } from "react-router-dom";
function RoutesFor({ path, el }: { path: string; el: ReactElement }) {
  return <Routes><Route path={path} element={el} /></Routes>;
}
/** Что читает человек: текст без разметки (значки — svg без текста — сюда не попадают). */
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
  .replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const words = (html: string) => text(html).split(" ").sort();
/** Аватар: инициалы прежнего и нового кружка — не текст страницы (aria-hidden). */
const noAvatar = (html: string) => html.replace(/<span class="(av xl|ry-avatar)"[\s\S]*?<\/span>/, "");

beforeEach(() => Object.assign(state, { royal: false, clean: true, mobile: false, role: "AGENT" }));

const SAME_TEXT = [
  { name: "Права по ролям", url: "/settings/roles", el: <RolesMatrix /> },
  { name: "Состояние функций (директор)", url: "/settings/functions", el: <FunctionStatus />, role: "DIRECTOR" },
  { name: "Состояние функций (нет доступа)", url: "/settings/functions", el: <FunctionStatus /> },
  { name: "Интеграции и каналы", url: "/integrations", el: <Integrations /> },
  { name: "Карточка сломанного канала", url: `/integrations/${encodeURIComponent(integrations.channels[1].name)}`, el: <ChannelDetail />, path: "/integrations/:name" },
  { name: "Страница не найдена", url: "/nope", el: <NotFound /> },
];

describe("служебные экраны в новом виде: тот же текст, другие классы", () => {
  it.each(SAME_TEXT)("$name: весь текст прежнего вида на месте и в том же порядке", ({ url, el, path, role }) => {
    state.role = role ?? "AGENT";
    state.royal = false;
    const legacy = render(url, el, path);
    state.royal = true;
    const royal = render(url, el, path);
    expect(text(legacy).length).toBeGreaterThan(30);
    expect(text(royal)).toBe(text(legacy));
    expect(legacy).not.toMatch(/data-ry-section|ry-admin|ry-circle|ry-adm-/);
    expect(royal).toMatch(/data-ry-section="admin"/);
    expect(royal).toMatch(/class="rh2 screens[^"]*ry-admin"/);
  });

  it("уведомления: тот же набор слов и действий, одна разметка на телефон и ПК", () => {
    for (const mobile of [false, true]) {
      state.mobile = mobile;
      state.royal = false;
      const legacyDesk = (state.mobile = false, render("/notifications", <Notifications />));
      state.mobile = mobile;
      state.royal = true;
      const royal = render("/notifications", <Notifications />);
      expect(words(royal), `mobile=${mobile}`).toEqual(words(legacyDesk));
      expect(royal).toMatch(/data-ry-section="admin"/);
      // «Принять» свой лид, ответ на предложение, «Открыть» у каждой строки, «Показать ещё»
      expect(royal).toContain(">Принять<");
      expect(royal).toContain(">Отправлю клиенту<");
      expect(royal).toContain(">Не подходит<");
      expect(royal.match(/>Открыть</g)).toHaveLength(notifications.items.length);
      expect(royal).toContain("Показать ещё");
    }
    state.royal = false;
    state.mobile = true;
    expect(render("/notifications", <Notifications />)).not.toMatch(/data-ry-section|ry-ntf|ry-circle/);
  });

  it("уведомления: «Критичное» — сплошной красный круг, «Ждёт решения» — янтарный, переданное — спокойное", () => {
    state.royal = true;
    const html = render("/notifications", <Notifications />);
    const tones = [...html.matchAll(/class="ry-circle" data-tone="([\w-]+)"/g)].map((m) => m[1]);
    expect(tones.filter((t) => t === "crit")).toHaveLength(1);
    expect(tones.filter((t) => t === "warn")).toHaveLength(1);
    expect(tones).toHaveLength(notifications.items.length);
  });

  it("профиль: тот же текст, разделы и кнопки; без признака — прежний корень", () => {
    state.royal = false;
    const legacy = noAvatar(render("/profile", <Profile />));
    state.royal = true;
    const royal = noAvatar(render("/profile", <Profile />));
    expect(text(legacy)).toContain("Выйти из CRM");
    expect(text(royal)).toBe(text(legacy));
    expect(legacy).not.toMatch(/data-ry-section|ry-admin/);
    expect(royal).toMatch(/^<div class="rh2 screens clean-profile-page ry-admin" data-ry-section="admin">/);
  });

  it("функции: «Обратите внимание» — сплошной красный круг, «только проверка» — янтарный, работает — зелёный", () => {
    state.royal = true;
    state.role = "DIRECTOR";
    const html = render("/settings/functions", <FunctionStatus />);
    const tones = [...html.matchAll(/class="ry-circle" data-tone="([\w-]+)"/g)].map((m) => m[1]);
    expect(tones).toEqual(["crit", "warn", "ok"]);
  });

  it("интеграции: сломанный канал — красный круг с пламенем и срочная плитка", () => {
    state.royal = true;
    const html = render("/integrations", <Integrations />);
    expect(html.match(/data-tone="crit"/g)).toHaveLength(1);
    expect(html.match(/data-tone="ok"/g)).toHaveLength(2);
    expect(html).toContain('class="tile ry-tile-crit"');
  });

  it("AdminRoot и AdminScreen без признака — прежний корень до байта", () => {
    expect(renderToStaticMarkup(<AdminRoot royal={false}><i /></AdminRoot>)).toBe('<div class="rh2 screens"><i></i></div>');
    expect(renderToStaticMarkup(<AdminRoot royal><i /></AdminRoot>)).toBe('<div class="rh2 screens ry-admin" data-ry-section="admin"><i></i></div>');
    const screen = (royal: boolean) => renderToStaticMarkup(<MemoryRouter><AdminScreen royal={royal} className="clean-x"><i /></AdminScreen></MemoryRouter>);
    expect(screen(false)).toBe('<div class="rh2 screens clean-x"><div class="scr" style="padding:0"><i></i></div></div>');
    expect(screen(true)).toBe('<div class="rh2 screens clean-x ry-admin" data-ry-section="admin"><div class="scr" style="padding:0"><i></i></div></div>');
  });
});
