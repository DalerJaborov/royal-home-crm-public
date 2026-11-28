import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ExchangeRateWatchPanel } from "../ExchangeRateWatchPanel";
import type { ExchangeRateStatus } from "../../../hooks/useExchangeRateWatch";

const state = vi.hoisted(() => ({ status: undefined as unknown }));
const idle = { mutate: vi.fn(), isPending: false, isSuccess: false, isError: false, data: undefined, error: null };

vi.mock("../../../hooks/useExchangeRateWatch", () => ({
  useExchangeRateStatus: () => ({ data: state.status, isError: false }),
  useConfirmPendingRate: () => idle,
  useDismissPendingRate: () => idle,
  useResyncSitePrices: () => idle,
  useRefreshRateCaptions: () => idle,
  useSetRateAlertPct: () => idle,
}));

const base: ExchangeRateStatus = {
  rate: 9.31,
  updatedAt: "2026-11-28T01:00:00Z",
  source: "alif-auto",
  ageHours: 10,
  stale: false,
  staleAfterHours: 36,
  jumpLimitPct: 5,
  pending: null,
  alertPct: 1,
  siteResyncEnabled: true,
  alertsEnabled: true,
  siteUsdCount: 22,
  staleCaptions: [],
};

it("говорит, что обновление работает, и называет порог тревоги", () => {
  state.status = base;
  const html = renderToStaticMarkup(<ExchangeRateWatchPanel />);
  expect(html).toContain("Обновление работает");
  expect(html).toContain("36 ч");
  expect(html).toContain("22 объектов");
});

it("курс застрял — красная строка, а не молчание", () => {
  state.status = { ...base, stale: true, ageHours: 50 };
  const html = renderToStaticMarkup(<ExchangeRateWatchPanel />);
  expect(html).toContain("Курс не обновлялся 50 ч");
  expect(html).toContain('role="alert"');
});

it("скачок ждёт решения руководителя", () => {
  state.status = { ...base, pending: { rate: 10.2, at: null, changePct: 9.56 } };
  const html = renderToStaticMarkup(<ExchangeRateWatchPanel />);
  expect(html).toContain("Принять новый курс");
  expect(html).toContain("Оставить прежний");
});

it("подписи со старой ценой — список и кнопка только по нажатию", () => {
  state.status = { ...base, staleCaptions: [{ code: "ОБ-000123", channels: ["TELEGRAM"] }] };
  const html = renderToStaticMarkup(<ExchangeRateWatchPanel />);
  expect(html).toContain("ОБ-000123");
  expect(html).toContain("Сами подписи не меняются");
  expect(html).not.toContain("Да, обновить");
});
