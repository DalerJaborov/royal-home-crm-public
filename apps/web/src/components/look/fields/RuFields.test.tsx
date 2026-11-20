// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuDateField, RuDateTimeField, RuMonthField, RuTimeField } from "./RuFields";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";

function setUa(ua: string) {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ua);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("поля даты по-русски (К01)", () => {
  it("iPhone: значение поверх поля по-русски, родное поле на месте и прозрачное", () => {
    setUa(IPHONE);
    const { container } = render(<RuDateField value="2026-11-20" onChange={() => {}} aria-label="Дата" />);
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("date");
    expect(input.getAttribute("lang")).toBe("ru");
    expect(input.style.color).toBe("transparent");
    expect(container.querySelector("[data-ru-field-text]")?.textContent).toBe("20 ноября 2026");
    expect(container.textContent).not.toMatch(/November|PM|AM/);
  });

  it("месяц, время и дата со временем", () => {
    setUa(IPHONE);
    const { container } = render(<>
      <RuMonthField value="2026-11" onChange={() => {}} />
      <RuTimeField value="14:30" onChange={() => {}} />
      <RuDateTimeField value="2026-11-20T14:30" onChange={() => {}} />
    </>);
    expect([...container.querySelectorAll("[data-ru-field-text]")].map((n) => n.textContent)).toEqual([
      "Ноябрь 2026", "14:30", "20 ноября 2026, 14:30",
    ]);
    // время — по Душанбе: подсказка на поле
    expect((container.querySelectorAll("input")[1] as HTMLInputElement).title).toBe("Время по Душанбе");
  });

  it("пустое — «Выберите дату», приглушённым цветом", () => {
    setUa(IPHONE);
    const { container } = render(<RuDateField value="" onChange={() => {}} />);
    const label = container.querySelector("[data-ru-field-text]") as HTMLElement;
    expect(label.textContent).toBe("Выберите дату");
    expect(label.hasAttribute("data-empty")).toBe(true);
  });

  it("подпись не перехватывает нажатия и скрыта от экранного чтеца", () => {
    setUa(IPHONE);
    const { container } = render(<RuDateField value="2026-11-20" onChange={() => {}} />);
    const label = container.querySelector("[data-ru-field-text]") as HTMLElement;
    expect(label.style.pointerEvents).toBe("none");
    expect(label.getAttribute("aria-hidden")).toBe("true");
  });

  it("выбор доходит до экрана, подпись обновляется; ref и min/required — как у обычного поля", () => {
    setUa(IPHONE);
    const ref = createRef<HTMLInputElement>();
    function Screen() {
      const [v, setV] = useState("");
      return <RuDateField ref={ref} required min="2026-11-01" value={v} onChange={(e) => setV(e.target.value)} />;
    }
    const { container } = render(<Screen />);
    const input = container.querySelector("input") as HTMLInputElement;
    expect(ref.current).toBe(input);
    expect(input.required).toBe(true);
    expect(input.min).toBe("2026-11-01");
    fireEvent.change(input, { target: { value: "2026-12-05" } });
    expect(container.querySelector("[data-ru-field-text]")?.textContent).toBe("5 декабря 2026");
  });

  it("поле без состояния (defaultValue + onBlur): подпись следует за выбором", () => {
    setUa(IPHONE);
    const onBlur = vi.fn();
    const { container } = render(<RuTimeField defaultValue="09:00" onBlur={onBlur} />);
    expect(container.querySelector("[data-ru-field-text]")?.textContent).toBe("09:00");
    fireEvent.change(container.querySelector("input")!, { target: { value: "18:45" } });
    expect(container.querySelector("[data-ru-field-text]")?.textContent).toBe("18:45");
  });

  it("компьютер: подпись по-русски тоже (английский Chrome), но на время набора поле родное", () => {
    setUa(DESKTOP);
    const { container } = render(<RuMonthField value="2026-11" onChange={() => {}} />);
    const label = container.querySelector("[data-ru-field-text]") as HTMLElement;
    expect(label.textContent).toBe("Ноябрь 2026");
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.style.color).toBe("transparent");
    fireEvent.focus(input);
    expect(input.style.color).toBe("");
    expect(label.style.visibility).toBe("hidden");
    fireEvent.blur(input);
    expect(label.style.visibility).toBe("visible");
  });

  it("телефон: подпись не прячется и в фокусе (там колесо, печатать нечем)", () => {
    setUa(IPHONE);
    const { container } = render(<RuDateField value="2026-11-20" onChange={() => {}} />);
    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.focus(input);
    expect((container.querySelector("[data-ru-field-text]") as HTMLElement).style.visibility).toBe("visible");
    expect(input.style.color).toBe("transparent");
  });

  it("поле и подпись в одной ячейке сетки, родителю ничего не правим; выключенное тускнеет", () => {
    setUa(IPHONE);
    const { container } = render(<div id="p"><RuTimeField value="" disabled onChange={() => {}} /></div>);
    const wrap = container.querySelector(".ru-field") as HTMLElement;
    expect(wrap.style.display).toBe("grid");
    expect((container.querySelector("#p") as HTMLElement).style.position).toBe("");
    expect((wrap.querySelector("input") as HTMLElement).style.gridArea).toBe("1 / 1");
    expect((wrap.querySelector("[data-ru-field-text]") as HTMLElement).style.opacity).toBe("0.55");
  });

  it("браузер без родного month: обычное текстовое поле с подсказкой формата", () => {
    setUa(IPHONE);
    const real = document.createElement.bind(document);
    // Проверка поддержки создаёт пробное поле: подсовываем ему тип text, как в Safari на Mac у month.
    let probes = 0;
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const el = real(tag);
      if (tag === "input" && probes++ === 0) Object.defineProperty(el, "type", { get: () => "text", set: () => {}, configurable: true });
      return el;
    }) as typeof document.createElement);
    const { container } = render(<RuMonthField value="" onChange={() => {}} />);
    vi.restoreAllMocks();
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("text");
    expect(input.placeholder).toContain("ГГГГ-ММ");
    expect(container.querySelector("[data-ru-field-text]")).toBeNull();
  });
});
