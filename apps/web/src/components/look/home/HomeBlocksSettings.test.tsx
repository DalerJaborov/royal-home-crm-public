// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiPreferencesSchema } from "@royal-home/shared";

/**
 * ВЫКЛЮЧАТЕЛИ И ПОРЯДОК БЛОКОВ ГЛАВНОЙ (home-core, 20.11.2026): Профиль → Оформление →
 * «Главная» → личные настройки → ядро. Хранилище и сессия — настоящие, сервер подменён.
 */
const put = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ deny: new Set<string>() }));
vi.mock("../../../lib/permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/permissions")>(),
  useCan: () => (permission: string) => !perms.deny.has(permission),
}));
vi.mock("../../../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/api")>(),
  api: (...args: unknown[]) => put(...args),
}));

import { useAuthStore } from "../../../store/auth";
import { useUiPrefs } from "../../../store/uiPrefs";
import { HomeBlocksSettings } from "./HomeBlocksSettings";
import { RoyalHomeCore, type HomeBlockDef } from "./core";
import { HOME_BLOCKS, HOME_LAYOUT, useHomeLayoutPrefs } from "./registry";

/** Блоки реестра с заглушками вместо настоящих (свои запросы им здесь не нужны). */
const STUBS: HomeBlockDef[] = HOME_BLOCKS.map((block) => ({ ...block, component: () => <p data-stub={block.id}>{`блок ${block.id}`}</p> }));
function Home({ role }: { role: string }) {
  const { order, hidden } = useHomeLayoutPrefs(role);
  return <RoyalHomeCore role={role} registry={STUBS} layout={HOME_LAYOUT} order={order} hidden={hidden} />;
}
const view = (role: string) => render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter><HomeBlocksSettings /><Home role={role} /></MemoryRouter>
  </QueryClientProvider>,
);
const shown = (container: HTMLElement) => [...container.querySelectorAll("[data-stub]")].map((el) => el.getAttribute("data-stub"));

function signIn(id: string, role: string) {
  useAuthStore.setState({ agent: { id, role, fullName: "Сорбон Тестов" } as never, sessionEpoch: 1 });
  useUiPrefs.getState().hydrateFromServer({ theme: undefined }, true);
}

beforeEach(() => {
  perms.deny = new Set();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  put.mockReset();
  put.mockImplementation((path: string) => Promise.resolve(path === "/me" ? { id: "a1", preferences: {} } : {}));
  signIn("a1", "AGENT");
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("«Оформление» → «Главная»", () => {
  it("по умолчанию всё включено и в порядке реестра", () => {
    const { container } = view("AGENT");
    expect(shown(container)).toEqual([...HOME_LAYOUT.AGENT]);
    for (const toggle of screen.getAllByRole("switch")) expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: "Вернуть как было" })).toBeNull();
  });

  it("выключатель сразу убирает блок с главной и уходит в личные настройки на сервер", async () => {
    const { container } = view("AGENT");
    fireEvent.click(screen.getByRole("switch", { name: "Мой месяц" }));
    expect(screen.getByRole("switch", { name: "Мой месяц" }).getAttribute("aria-checked")).toBe("false");
    expect(shown(container)).not.toContain("agentMonth");
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    const body = put.mock.calls.find(([path]) => path === "/me/preferences")?.[1] as { body: unknown } | undefined;
    expect(body?.body).toMatchObject({ home: { blocks: { AGENT: { hidden: ["agentMonth"] } } } });
    // То, что ушло на сервер, проходит его схему.
    expect(uiPreferencesSchema.safeParse(body?.body).success).toBe(true);
    // Включили обратно — запись роли стирается целиком, «Вернуть как было» пропадает.
    fireEvent.click(screen.getByRole("switch", { name: "Мой месяц" }));
    expect(shown(container)).toContain("agentMonth");
    expect(useUiPrefs.getState().homeBlocks.AGENT).toBeUndefined();
  });

  it("«выше/ниже» меняют порядок на главной; «Вернуть как было» — назад к реестру", () => {
    const { container } = view("AGENT");
    fireEvent.click(screen.getByRole("button", { name: "Выше: Ждут принятия" }));
    const order = shown(container);
    expect(order.indexOf("agentPending")).toBeLessThan(order.indexOf("agentFirstCalls"));
    expect((screen.getByRole("button", { name: "Выше: Заявки, показы и дела" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Вернуть как было" }));
    expect(shown(container)).toEqual([...HOME_LAYOUT.AGENT]);
  });

  it("чужой роли блок не добавить: ни в списке, ни на главной, даже если он в сохранённом", () => {
    useUiPrefs.getState().setHomeBlocks("AGENT", { order: ["money", "decisions", "agentMonth"], hidden: [] });
    const { container } = view("AGENT");
    expect(screen.queryByRole("switch", { name: "Нужно ваше решение" })).toBeNull();
    expect(shown(container)).not.toContain("money");
    expect(shown(container)).not.toContain("decisions");
    expect(shown(container)).toEqual(expect.arrayContaining([...HOME_LAYOUT.AGENT]));
  });

  it("раскладка прежнего входа на общем устройстве не применяется к следующему", () => {
    useUiPrefs.getState().setHomeBlocks("AGENT", { hidden: ["agentTiles", "agentPending"] });
    // Вошёл другой сотрудник, его /me ещё не пришёл: хранилище держит чужую раскладку.
    useAuthStore.setState({ agent: { id: "b2", role: "AGENT", fullName: "Другой" } as never, sessionEpoch: 2 });
    const { container } = view("AGENT");
    expect(shown(container)).toEqual([...HOME_LAYOUT.AGENT]);
  });

  it("схема настроек: принимает раскладку по ролям, отвергает неизвестную роль и лишние поля", () => {
    expect(uiPreferencesSchema.safeParse({ home: { blocks: { DIRECTOR: { order: ["money"], hidden: ["full"] } } } }).success).toBe(true);
    expect(uiPreferencesSchema.safeParse({ home: { blocks: { HACKER: { hidden: ["x"] } } } }).success).toBe(false);
    expect(uiPreferencesSchema.safeParse({ home: { blocks: { AGENT: { hidden: ["x"], roles: ["DIRECTOR"] } } } }).success).toBe(false);
    expect(uiPreferencesSchema.safeParse({ home: { blocks: { AGENT: { hidden: Array.from({ length: 41 }, (_, i) => `b${i}`) } } } }).success).toBe(false);
  });

  it("последний включённый блок не выключить — главная не остаётся пустой", () => {
    const { container } = view("AGENT");
    const rest = HOME_LAYOUT.AGENT.slice(1);
    for (const id of rest) {
      const title = HOME_BLOCKS.find((b) => b.id === id)!.title;
      fireEvent.click(screen.getByRole("switch", { name: title }));
    }
    const last = screen.getByRole("switch", { name: "Заявки, показы и дела" }) as HTMLButtonElement;
    expect(last.disabled).toBe(true);
    fireEvent.click(last);
    expect(shown(container)).toEqual(["agentTiles"]);
  });

  it("админ без права на аналитику не видит выключателей блоков, которые ему не рисуются", () => {
    signIn("ad1", "ADMIN");
    perms.deny = new Set(["dashboard.analytics"]);
    view("ADMIN");
    // Главная руководителя с правом на отчёты (пачка home2, 27.11.2026): без права на аналитику
    // ему рисуются только быстрые действия и «Заявки» — выключатели только у них.
    expect(screen.getByRole("switch", { name: "Быстрые действия" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Заявки по источникам" })).toBeTruthy();
    for (const name of ["Комиссия за месяц", "Ждут ответа и горит", "Нужно ваше решение", "Команда"]) expect(screen.queryByRole("switch", { name })).toBeNull();
    // РОП с правом на отчёты: выключатели блоков макета его главной (сама «Аналитика» — не выключается).
    perms.deny = new Set();
    cleanup();
    signIn("r1", "HEAD_OF_SALES");
    view("HEAD_OF_SALES");
    for (const name of ["Ждут ответа и горит", "Горит сейчас", "Нужно ваше решение", "Скорость ответа", "Команда", "Мои задачи"]) expect(screen.getByRole("switch", { name })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Дашборд" })).toBeNull();
    // Без права на отчёты — прежняя главная РОПа со своими выключателями.
    perms.deny = new Set(["team.viewFull", "reports.view"]);
    cleanup();
    view("HEAD_OF_SALES");
    expect(screen.queryByRole("switch", { name: "Команда" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Мои задачи" })).toBeTruthy();
  });
});
