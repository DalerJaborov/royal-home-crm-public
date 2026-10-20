import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Отказ обновления курса USD→TJS обязан попадать в журнал.
 *
 * Разбор 09.08.2026: logSystemError был импортирован в lib/exchangeRate.ts и НИ
 * РАЗУ не вызван — единственный внешний вызов CRM, чей отказ никуда не писался.
 * Итог: экран «Здоровье системы» показывал зелёное, пока курс месяцами не
 * обновлялся, а долларовые объекты уходили на сайт по устаревшей цене. Соседний
 * lib/notifySite.ts при этом прямо утверждает, что «все прочие необязательные
 * вызовы наружу (…, курс, …) уже пишут отказ сюда же».
 */

const logSystemError = vi.fn();
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: (...a: unknown[]) => logSystemError(...a) }));

const { fetchAlifUsdSellRate } = await import("../src/lib/exchangeRate.js");

const originalFetch = globalThis.fetch;

beforeEach(() => {
  logSystemError.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(impl: () => Promise<unknown>) {
  globalThis.fetch = vi.fn(impl) as unknown as typeof fetch;
}

describe("Курс с alif.tj: молчать об отказе нельзя", () => {
  it("сеть недоступна — причина уходит в журнал", async () => {
    mockFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    expect(await fetchAlifUsdSellRate()).toBeNull();
    expect(logSystemError).toHaveBeenCalledTimes(1);
    const [source, message] = logSystemError.mock.calls[0];
    expect(source).toBe("exchange-rate");
    expect(String(message)).toContain("ECONNREFUSED");
  });

  it("сайт ответил ошибкой — статус попадает в журнал", async () => {
    mockFetch(() => Promise.resolve({ ok: false, status: 503, statusText: "Service Unavailable" }));
    expect(await fetchAlifUsdSellRate()).toBeNull();
    expect(logSystemError).toHaveBeenCalledTimes(1);
    expect(String(logSystemError.mock.calls[0][1])).toContain("503");
  });

  it("формат ответа изменился — это тоже поломка, а не тишина", async () => {
    mockFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ localRates: [{ name: "EUR" }] }) }));
    expect(await fetchAlifUsdSellRate()).toBeNull();
    expect(logSystemError).toHaveBeenCalledTimes(1);
    expect(String(logSystemError.mock.calls[0][1])).toContain("USD");
  });

  it("курс вне разумных границ отбрасывается и логируется", async () => {
    mockFetch(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ localRates: [{ name: "USD", sellValue: "119" }] }),
      })
    );
    expect(await fetchAlifUsdSellRate()).toBeNull();
    expect(logSystemError).toHaveBeenCalledTimes(1);
    expect(String(logSystemError.mock.calls[0][1])).toContain("119");
  });

  it("нормальный ответ — курс возвращается, журнал молчит", async () => {
    mockFetch(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ localRates: [{ name: "USD", sellValue: "11.9" }] }),
      })
    );
    expect(await fetchAlifUsdSellRate()).toBe(11.9);
    expect(logSystemError).not.toHaveBeenCalled();
  });
});
