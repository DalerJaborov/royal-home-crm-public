import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketWhatsAppButton, openMarketWhatsApp, type MarketWhatsAppDeps, type PendingWindow } from "./MarketWhatsAppButton";

/**
 * Кнопка «Написать в WhatsApp»: логика клика проверяется отдельно от DOM (в тестах
 * фронта окружение node, без jsdom) — окно, переход, запрос номера и показ ошибки
 * подставляются заглушками.
 */

const target = { sourceUrl: "https://somon.tj/adv/1_x/", source: "somon.tj", title: "3-комн. квартира" };

function setup(over: Partial<MarketWhatsAppDeps> = {}) {
  const win: PendingWindow = { location: { href: "" }, opener: "parent", close: vi.fn() };
  const deps = {
    openWindow: vi.fn(() => win as PendingWindow | null),
    assign: vi.fn(),
    requestPhone: vi.fn(async () => "+992900000056" as string | null),
    fail: vi.fn(),
    ...over,
  } satisfies MarketWhatsAppDeps;
  return { win, deps };
}

describe("openMarketWhatsApp", () => {
  it("номер известен из каталога — запроса к серверу нет, окно ведёт в wa.me с текстом", async () => {
    const { win, deps } = setup();
    await openMarketWhatsApp({ ...target, phone: "+992 900 00 00 56" }, deps);
    expect(deps.requestPhone).not.toHaveBeenCalled();
    expect(win.location.href).toMatch(/^https:\/\/wa\.me\/992900000056\?text=/);
    expect(decodeURIComponent(win.location.href)).toContain("https://somon.tj/adv/1_x/");
    expect(win.opener).toBeNull();
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it("номера нет — берётся у сервера по ссылке объявления", async () => {
    const { win, deps } = setup();
    await openMarketWhatsApp(target, deps);
    expect(deps.requestPhone).toHaveBeenCalledWith(target.sourceUrl);
    expect(win.location.href).toContain("wa.me/992900000056");
  });

  it("окно заблокировано браузером — переходим в этой же вкладке", async () => {
    const { deps } = setup({ openWindow: vi.fn(() => null) });
    await openMarketWhatsApp(target, deps);
    expect(deps.assign).toHaveBeenCalledTimes(1);
    expect(String((deps.assign as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain("wa.me/992900000056");
  });

  it("сервер номера не дал (Paydo, нет номера) — ведём на объявление и говорим об этом", async () => {
    const { win, deps } = setup({ requestPhone: vi.fn(async () => null) });
    await openMarketWhatsApp(target, deps);
    expect(win.location.href).toBe(target.sourceUrl);
    expect(deps.fail).toHaveBeenCalledWith(expect.stringContaining("Номер не получен"));
  });

  it("429 «сайт занят»: окно закрываем, показываем текст ошибки, на объявление не уводим", async () => {
    const busy = Object.assign(new Error("Сайт сейчас занят, нажмите ещё раз через несколько секунд"), { status: 429 });
    const { win, deps } = setup({ requestPhone: vi.fn(async () => { throw busy; }) });
    await openMarketWhatsApp(target, deps);
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.location.href).toBe("");
    expect(deps.fail).toHaveBeenCalledWith("Сайт сейчас занят, нажмите ещё раз через несколько секунд");
  });

  it("ошибка не Error — общий текст, окно закрыто", async () => {
    const { win, deps } = setup({ requestPhone: vi.fn(async () => { throw "boom"; }) });
    await openMarketWhatsApp(target, deps);
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(deps.fail).toHaveBeenCalledWith("Не удалось получить номер");
  });

  it("негодный номер (короткий) — как «номер не получен»", async () => {
    const { win, deps } = setup();
    await openMarketWhatsApp({ ...target, phone: "12345" }, deps);
    expect(win.location.href).toBe(target.sourceUrl);
    expect(deps.fail).toHaveBeenCalled();
  });
});

describe("MarketWhatsAppButton (разметка)", () => {
  it("кнопка на .pill темы с трейлинг-! для размера, подпись скрыта на телефоне", () => {
    const html = renderToStaticMarkup(<MarketWhatsAppButton {...target} className="ml-auto" />);
    expect(html).toContain('aria-label="Написать продавцу в WhatsApp"');
    expect(html).toMatch(/class="pill ghost [^"]*px-3![^"]*ml-auto"/);
    expect(html).not.toContain("glass-btn");
    expect(html).toContain("hidden sm:inline");
    expect(html).not.toContain(" disabled=");
  });
});
