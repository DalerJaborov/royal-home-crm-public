// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoyalPicker } from "./RoyalPicker";

/**
 * Шторка выбора «Нового вида» вместо серого <select> (пачка shell2, 27.11.2026): клавиатура как у
 * группы радиокнопок. Ревью 27.11 нашло: фокус при открытии вставал на ПЕРВЫЙ вариант, а не на
 * выбранный (селектор «a, b» в querySelector отдаёт первый в документе), стрелок не было.
 */
const OPTIONS = [
  { value: "0", label: "10 минут" },
  { value: "1", label: "1 час" },
  { value: "2", label: "До завтра" },
];

afterEach(cleanup);

function open(value = "1", onChange = vi.fn()) {
  render(<RoyalPicker label="Бот молчит" value={value} options={OPTIONS} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: /Бот молчит/ }));
  return onChange;
}

describe("RoyalPicker", () => {
  it("фокус при открытии — на выбранном варианте, в Tab стоит только он", () => {
    open("1");
    const radios = screen.getAllByRole("radio");
    expect(document.activeElement).toBe(radios[1]);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("ничего не выбрано — фокус на первом варианте", () => {
    open("нет такого");
    expect(document.activeElement).toBe(screen.getAllByRole("radio")[0]);
  });

  it("стрелки ходят по кругу, Home/End — к краям; переход не выбирает", () => {
    const onChange = open("1");
    const radios = screen.getAllByRole("radio");
    fireEvent.keyDown(radios[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios[2]);
    fireEvent.keyDown(radios[2], { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(radios[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(radios[2]);
    fireEvent.keyDown(radios[2], { key: "Home" });
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(radios[0], { key: "End" });
    expect(document.activeElement).toBe(radios[2]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("выбор отдаёт то же значение, что <select>; Escape закрывает и возвращает фокус на кнопку", () => {
    const onChange = open("1");
    fireEvent.click(screen.getByRole("radio", { name: /До завтра/ }));
    expect(onChange).toHaveBeenCalledWith("2");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Бот молчит/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Бот молчит/ }));
  });
});
