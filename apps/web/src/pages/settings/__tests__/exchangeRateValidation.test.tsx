import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ExchangeRateSection } from "../MoneyTab";
import { serverRefillPatch } from "../../../lib/serverFormSync";

const state = vi.hoisted(() => ({ pending: false, server: undefined as { rate: string | number } | undefined }));

vi.mock("../../../hooks/useSettings", () => ({
  useSettings: () => ({ data: { usdToTjsRate: state.pending ? 10 : "" } }),
  useUpdateSettings: () => ({ mutateAsync: vi.fn(), isPending: state.pending, isError: true, error: new Error("Курс отклонён сервером") }),
  useRefreshExchangeRate: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../../hooks/useServerSyncedForm", () => ({ useServerSyncedFields: (server: typeof state.server) => { state.server = server; } }));

it("rejects zero with the native numeric constraint", () => {
  const html = renderToStaticMarkup(<ExchangeRateSection />);
  const input = html.match(/<input[^>]+aria-label="1 доллар в сомони"[^>]*>/)?.[0] ?? "";
  expect(Number(input.match(/min="([^"]+)"/)?.[1])).toBeGreaterThan(0);
});
it("keeps a save failure visible next to the rate form", () => {
  expect(renderToStaticMarkup(<ExchangeRateSection />)).toContain("Курс отклонён сервером");
});
it("does not acknowledge an optimistic rate as saved or erase the draft on rollback", () => {
  state.pending = false;
  renderToStaticMarkup(<ExchangeRateSection />);
  let confirmed = state.server;
  state.pending = true;
  renderToStaticMarkup(<ExchangeRateSection />);
  if (state.server !== undefined) confirmed = state.server;
  state.pending = false;
  renderToStaticMarkup(<ExchangeRateSection />);
  expect(serverRefillPatch(state.server!, confirmed, { rate: "10" })).toEqual({});
});
