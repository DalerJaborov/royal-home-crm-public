// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwitchRow } from "../../Switch";
import { NumberRow } from "../../settings/SettingsRows";
import { settingsIconFor } from "./parts";

/**
 * «Новый вид», пачка team: общие строки настроек.
 * Без признака на <html> разметка прежняя до класса; с признаком — плитка/строка
 * со значком, пояснение под «i», тот же обработчик.
 */
afterEach(() => { cleanup(); delete document.documentElement.dataset.uiLook; });
/** Без jest-dom: «скрыто» = внутри элемента с атрибутом hidden. */
const shown = (el: HTMLElement) => el.closest("[hidden]") === null;

describe("значок строки настроек по названию", () => {
  it("узкие слова раньше общих, русские границы слов без \\b", () => {
    expect(settingsIconFor("Записывать звонки")).toBe("mic");
    expect(settingsIconFor("Ночной поиск двойных досье")).toBe("moon");
    expect(settingsIconFor("ИИ-помощник")).toBe("bot");
    expect(settingsIconFor("Дом")).toBe("building-2");
    expect(settingsIconFor("Домашний телефон")).toBe("phone-call");
    expect(settingsIconFor("Комиссия по умолчанию")).toBe("percent");
    expect(settingsIconFor("Что-то совсем другое", "key")).toBe("key");
  });
});

describe("SwitchRow", () => {
  it("без признака — прежняя строка .mod, плитки нет", () => {
    const { container } = render(<SwitchRow title="Бот отвечает" hint="Отвечает круглосуточно" on onToggle={() => {}} />);
    expect(container.querySelector(".mod")).not.toBeNull();
    expect(container.querySelector(".ry-swt")).toBeNull();
    expect(shown(screen.getByText("Отвечает круглосуточно"))).toBe(true);
  });

  it("с признаком — плитка, пояснение под «i», тот же переключатель", () => {
    document.documentElement.dataset.uiLook = "royal";
    const onToggle = vi.fn();
    const { container } = render(<SwitchRow title="Бот отвечает" hint="Отвечает круглосуточно" on={false} onToggle={onToggle}
      warning="Нужны ключи" />);
    expect(container.querySelector(".mod")).toBeNull();
    expect(container.querySelector(".ry-swt .ry-circle")).not.toBeNull();
    const hint = screen.getByText("Отвечает круглосуточно");
    expect(shown(hint)).toBe(false);
    // Предупреждение — не пояснение: видно всегда.
    expect(shown(screen.getByText("Нужны ключи"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Пояснение: Бот отвечает" }));
    expect(shown(hint)).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Бот отвечает" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("признак, поставленный после отрисовки, переключает разметку", () => {
    const { container } = render(<SwitchRow title="Бот" hint="" on onToggle={() => {}} />);
    expect(container.querySelector(".ry-swt")).toBeNull();
    act(() => { document.documentElement.dataset.uiLook = "royal"; });
    return vi.waitFor(() => expect(container.querySelector(".ry-swt")).not.toBeNull());
  });
});

describe("NumberRow", () => {
  it("с признаком — строка со значком, то же поле и тот же обработчик", () => {
    document.documentElement.dataset.uiLook = "royal";
    const onChange = vi.fn();
    const { container } = render(<NumberRow label="Пауза перед ответом" hint="Бот ждёт тишины" value="30" onChange={onChange} min={0} max={120} unit="сек" />);
    expect(container.querySelector(".ry-setrow .ry-circle")).not.toBeNull();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Пауза перед ответом" }), { target: { value: "45" } });
    expect(onChange).toHaveBeenCalledWith("45");
    expect(shown(screen.getByText("Бот ждёт тишины"))).toBe(false);
  });
});
