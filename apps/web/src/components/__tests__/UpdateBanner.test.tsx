// @vitest-environment jsdom
import { act, createElement } from "react";
import * as ReactDomClient from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateBanner } from "../UpdateBanner";

/**
 * Плашка «Есть обновление · Обновить» — единственное, что человек видит, когда
 * обновление само не применилось (до 21.11.2026 в этом случае не было видно
 * ничего). Видимый текст — бытовыми словами, без эмодзи; кнопка — настоящая
 * кнопка с текстом, а нажатие не плодит второй сброс.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReactDomClient.Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(onUpdate: () => void | Promise<void>) {
  host = document.createElement("div");
  document.body.append(host);
  root = ReactDomClient.createRoot(host);
  act(() => root!.render(createElement(UpdateBanner, { onUpdate })));
  return host;
}

describe("UpdateBanner", () => {
  it("говорит простыми словами и объявляет себя для экранного диктора", () => {
    const el = mount(() => {});
    const status = el.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Есть обновление");
    const button = el.querySelector("button");
    expect(button?.textContent).toBe("Обновить");
    expect(button?.getAttribute("type")).toBe("button");
    // никаких эмодзи и служебных слов
    expect(el.textContent ?? "").not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(el.textContent ?? "").not.toMatch(/кэш|service worker|сборк/i);
  });

  it("нажатие запускает полный сброс один раз, повторное — не плодит второй", async () => {
    let finish: () => void = () => {};
    const onUpdate = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const el = mount(onUpdate);
    const button = el.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Обновляю…");
    await act(async () => {
      button.click();
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    finish();
  });

  it("сброс сорвался — кнопку можно нажать снова", async () => {
    const onUpdate = vi.fn(() => Promise.reject(new Error("нет сети")));
    const el = mount(onUpdate);
    const button = el.querySelector("button") as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Обновить");
  });
});
