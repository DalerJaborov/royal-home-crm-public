import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ExchangeRateSection } from "../MoneyTab";

vi.mock("../../../hooks/useSettings", () => ({
  useSettings: () => ({ data: {} }),
  useUpdateSettings: () => ({ mutateAsync: vi.fn(), isError: true, error: new Error("Курс отклонён сервером") }),
  useRefreshExchangeRate: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../../hooks/useServerSyncedForm", () => ({ useServerSyncedFields: () => undefined }));

it("rejects zero with the native numeric constraint", () => {
  const html = renderToStaticMarkup(<ExchangeRateSection />);
  const input = html.match(/<input[^>]+aria-label="1 доллар в сомони"[^>]*>/)?.[0] ?? "";
  expect(Number(input.match(/min="([^"]+)"/)?.[1])).toBeGreaterThan(0);
});
it("keeps a save failure visible next to the rate form", () => {
  expect(renderToStaticMarkup(<ExchangeRateSection />)).toContain("Курс отклонён сервером");
});
