// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import * as ReactDomClient from "react-dom/client";
import type { RegistryMatchPreviewResponse, RegistryProjectOption } from "@royal-home/shared";

/**
 * Поле «Застройщик и разрешение» (25.11.2026): уверенное совпадение подставлено, догадка с «проверьте», пусто — поле
 * поиска; список ищет по всему реестру, ходит стрелками, Enter выбирает, Escape закрывает; «Нет в реестре» — отдельный
 * пункт; выбор уходит в запрос сохранения объекта.
 */
const hooks = vi.hoisted(() => ({
  search: vi.fn(),
  preview: vi.fn(),
}));
vi.mock("../../hooks/useConstructionRegistry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useConstructionRegistry")>()),
  useRegistryProjectSearch: (...args: unknown[]) => hooks.search(...args),
  useRegistryMatchPreview: (...args: unknown[]) => hooks.preview(...args),
}));
vi.mock("../../hooks/useDebouncedValue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useDebouncedValue")>()),
  useDebouncedValue: (v: unknown) => v,
}));

import { RegistryPicker, type RegistryFieldState } from "./RegistryPicker";

// Свой маленький «render» на react-dom/client, как в UpdateBanner.test.tsx: без второй копии React.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReactDomClient.Root | null = null;
let host: HTMLDivElement | null = null;
function render(element: ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = ReactDomClient.createRoot(host);
  act(() => root!.render(element));
}
function cleanup() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const screen = {
  getByTestId: (id: string) => {
    const el = byTestId(id);
    if (!el) throw new Error(`нет ${id}`);
    return el;
  },
  queryByTestId: byTestId,
  getByRole: (role: string, opts?: { name?: RegExp }) => {
    const all = [...document.querySelectorAll<HTMLElement>(role === "button" ? "button" : `[role="${role}"]`)];
    const el = all.find((e) => !opts?.name || opts.name.test(e.getAttribute("aria-label") ?? e.textContent ?? ""));
    if (!el) throw new Error(`нет ${role}`);
    return el;
  },
  getAllByRole: (role: string) => [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)],
};
const fireEvent = {
  focus: (el: HTMLElement) => act(() => void el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))),
  keyDown: (el: HTMLElement, init: { key: string }) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }))),
  click: (el: HTMLElement) => act(() => el.click()),
  change: (el: HTMLElement, init: { target: { value: string } }) =>
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, init.target.value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }),
};
import { RegistryField, registryChoicePayload, type RegistryUserChoice } from "./RegistryField";

const opt = (id: string, title: string, over: Partial<RegistryProjectOption> = {}): RegistryProjectOption => ({
  id,
  title,
  developer: `Застройщик ${id}`,
  address: null,
  qaror: `${id}-2024`,
  color: "green",
  distanceM: 40,
  sourceUrl: `https://www.memor.pro/${id}`,
  ...over,
});
const A = opt("a", "ЖК Ҷамол");
const B = opt("b", "ЖК Сомон", { color: "red", distanceM: 900 });

beforeEach(() => {
  hooks.search.mockReturnValue({ data: { enabled: true, updatedAt: null, notLoaded: false, items: [B] }, isFetching: false, isError: false });
  hooks.preview.mockReturnValue({ data: undefined });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function picker(state: RegistryFieldState, nearby: RegistryProjectOption[] = []) {
  const onPick = vi.fn();
  const onNone = vi.fn();
  render(<RegistryPicker state={state} updatedAt="2026-11-24T10:00:00.000Z" point={{ lat: 38.5, lng: 68.7 }} nearby={nearby} onPick={onPick} onNone={onNone} />);
  return { onPick, onNone };
}

describe("RegistryPicker", () => {
  it("уверенное совпадение: застройщик, статус словами, дата реестра и «Изменить»", () => {
    picker({ kind: "auto", option: A });
    expect(screen.getByTestId("registry-pick-auto").textContent).toContain("Застройщик: Застройщик a");
    expect(screen.getByTestId("registry-pick-status").textContent).toBe("Разрешение есть");
    expect(screen.getByTestId("registry-pick-source").textContent).toContain("Определено автоматически по реестру memor.pro на 24.11.2026");
    expect(screen.getByRole("button", { name: /Изменить/ })).toBeTruthy();
  });

  it("догадка: «Похоже» и «Проверьте», никаких «Это он / Не он»", () => {
    picker({ kind: "guess", option: A });
    const row = screen.getByTestId("registry-pick-guess");
    expect(row.textContent).toContain("Похоже: Застройщик a");
    expect(row.textContent).toContain("Проверьте");
    expect(document.body.textContent).not.toContain("Это он");
  });

  it("пусто: сразу поле поиска; поиск не идёт, пока список закрыт", () => {
    picker({ kind: "empty" });
    const input = screen.getByRole("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(hooks.search.mock.calls.at(-1)?.[2]).toBe(false);
  });

  it("клавиатура: стрелки ходят по списку (рядом, найденное, «Нет в реестре»), Enter выбирает", () => {
    const { onPick } = picker({ kind: "empty" }, [A]);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(hooks.search.mock.calls.at(-1)?.[2]).toBe(true);
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("ЖК Ҷамол"),
      expect.stringContaining("ЖК Сомон"),
      "Нет в реестре / не новостройка",
    ]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(B);
  });

  it("ArrowUp с начала уходит на последний пункт; End/Home; Escape закрывает список", () => {
    const { onNone } = picker({ kind: "empty" }, [A]);
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const options = screen.getAllByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[2]!.id);
    fireEvent.keyDown(input, { key: "Home" });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    fireEvent.keyDown(input, { key: "End" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNone).toHaveBeenCalledTimes(1);
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

  it("набор текста ищет по всему реестру; клик по пункту выбирает", () => {
    const { onPick } = picker({ kind: "auto", option: A });
    fireEvent.click(screen.getByRole("button", { name: /Изменить/ }));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Сомон" } });
    expect(hooks.search.mock.calls.at(-1)?.slice(0, 1)).toEqual(["Сомон"]);
    fireEvent.click(screen.getAllByRole("option")[0]!);
    expect(onPick).toHaveBeenCalledWith(B);
  });
});

describe("RegistryField: подстановка по уровню уверенности", () => {
  const preview = (over: Partial<RegistryMatchPreviewResponse>): RegistryMatchPreviewResponse => ({
    enabled: true,
    updatedAt: "2026-11-24T10:00:00.000Z",
    notLoaded: false,
    noPoint: false,
    level: "none",
    best: null,
    alternatives: [],
    ...over,
  });
  function field(isNewBuilding = true, choice: RegistryUserChoice | null = null) {
    const onChoice = vi.fn();
    render(<RegistryField point={{ lat: 38.5, lng: 68.7 }} address="Айни 1" isNewBuilding={isNewBuilding} choice={choice} onChoice={onChoice} />);
    return onChoice;
  }

  it("auto — подставлено сразу", () => {
    hooks.preview.mockReturnValue({ data: preview({ level: "auto", best: { ...A, confidence: 90, reasons: [] } }) });
    field();
    expect(screen.getByTestId("registry-pick-auto")).toBeTruthy();
  });

  it("suggest — догадка с «проверьте»", () => {
    hooks.preview.mockReturnValue({ data: preview({ level: "suggest", best: { ...A, confidence: 40, reasons: [] }, alternatives: [B] }) });
    field();
    expect(screen.getByTestId("registry-pick-guess")).toBeTruthy();
  });

  it("none — пустое поле поиска", () => {
    hooks.preview.mockReturnValue({ data: preview({ level: "none" }) });
    field();
    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("вторичка без уверенного совпадения — поле свёрнуто, раскрывается кнопкой", () => {
    hooks.preview.mockReturnValue({ data: preview({ level: "suggest", best: { ...A, confidence: 30, reasons: [] } }) });
    field(false);
    expect(screen.queryByTestId("registry-pick")).toBeNull();
    fireEvent.click(screen.getByTestId("registry-field-expand"));
    expect(screen.getByTestId("registry-pick-guess")).toBeTruthy();
  });

  it("выбор сотрудника важнее догадки; «нет в реестре» — отдельное состояние", () => {
    hooks.preview.mockReturnValue({ data: preview({ level: "auto", best: { ...A, confidence: 90, reasons: [] } }) });
    field(true, { kind: "project", option: B });
    expect(screen.getByTestId("registry-pick-picked").textContent).toContain("Выбрано вручную");
    cleanup();
    field(true, { kind: "none" });
    expect(screen.getByTestId("registry-pick-none").textContent).toContain("Нет в реестре");
  });

  it("реестр выключен — поля нет", () => {
    hooks.preview.mockReturnValue({ data: preview({ enabled: false }) });
    field();
    expect(screen.queryByTestId("registry-pick")).toBeNull();
  });

  it("выбор уходит в запрос сохранения: проект — ручная связь, «нет» — none, ничего — автосвязь", () => {
    expect(registryChoicePayload({ kind: "project", option: A })).toEqual({ kind: "project", projectId: "a" });
    expect(registryChoicePayload({ kind: "none" })).toEqual({ kind: "none" });
    expect(registryChoicePayload(null)).toBeUndefined();
  });
});
