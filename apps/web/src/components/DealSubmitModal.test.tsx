// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DealSubmitModal } from "./DealSubmitModal";

/**
 * Клик-аудит 26.11.2026: в полях комиссии стоит бледный «0», кнопка «Отправить» при пустом
 * поле молча серая — человек не понимал, почему не отправляется. Теперь есть строка-подсказка.
 */
afterEach(cleanup);

// jsdom не знает matchMedia, а шторка (Rh2Sheet) спрашивает у него про телефон.
beforeAll(() => {
  window.scrollTo = () => {};
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
});

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("окно закрытия сделки: подсказка про пустую комиссию", () => {
  it("цена вписана, комиссия пустая → кнопка серая и есть объяснение", () => {
    render(<DealSubmitModal listedPrice="900000" currency="TJS" onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId("deal-commission-hint")).toBeNull();
    fill(/За сколько фактически продали/, "800000");
    fill(/Получает агент/, "8000");
    expect(screen.getByTestId("deal-commission-hint")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Отправить" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("обе суммы вписаны (в том числе явный 0) → подсказки нет, кнопка активна", () => {
    render(<DealSubmitModal listedPrice="900000" currency="TJS" onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fill(/За сколько фактически продали/, "800000");
    fill(/Получает агент/, "8000");
    fill(/Получает компания/, "0");
    expect(screen.queryByTestId("deal-commission-hint")).toBeNull();
    expect((screen.getByRole("button", { name: "Отправить" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
