import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { Client } from "../types";
const h = vi.hoisted(() => ({ seller: { data: undefined as unknown, isLoading: false, isError: false, refetch: vi.fn() },
  activity: { data: { items: [], total: 0, page: 1, pageSize: 20 } as unknown, isLoading: false, isError: false, refetch: vi.fn() },
  properties: vi.fn(), history: vi.fn() }));
vi.mock("../hooks/useProperties", () => ({ useProperties: (...args: unknown[]) => { h.properties(...args); return h.seller; } }));
vi.mock("../hooks/useClientPropertyActivity", () => ({ useClientPropertyActivity: (...args: unknown[]) => { h.history(...args); return h.activity; } }));
vi.mock("./ClientShowingActions", () => ({ ClientShowingActions: () => <span>Showing actions</span> }));
import { ClientPropertyWorkspace } from "./ClientPropertyWorkspace";
const seller = { id: "seller-test", kind: "SELLER", dualIntent: false } as Client;
const props = { client: seller, locked: false, canCreate: true, onCreate: vi.fn(), onSchedule: vi.fn() };
function render(extra: Partial<Parameters<typeof ClientPropertyWorkspace>[0]> = {}) {
  return renderToStaticMarkup(<MemoryRouter><ClientPropertyWorkspace {...props} {...extra} /></MemoryRouter>);
}
beforeEach(() => {
  h.properties.mockReset(); h.history.mockReset(); h.seller.isLoading = false; h.seller.isError = false;
  h.seller.data = { items: Array.from({ length: 4 }, (_, i) => ({ id: `property-${i}`, shortId: i + 1,
    title: `Квартира ${i + 1}`, price: "500000", currency: "TJS", status: "AVAILABLE", photos: [] })), total: 4, pageSize: 20 };
  h.activity.data = { items: [], total: 0, page: 1, pageSize: 20 };
});
describe("client overview portfolio and activity separation", () => {
  it("queries only this seller and previews three own properties with a working expansion affordance", () => {
    const html = render({ variant: "portfolio" });
    expect(h.properties).toHaveBeenCalledWith({ sellerClientId: seller.id, page: 1 }, true);
    expect(h.history).toHaveBeenLastCalledWith(seller.id, "showings", 1, false);
    expect(html.match(/class="client-property-line"/g)).toHaveLength(3);
    expect(html).toContain("Показать все объекты · 4"); expect(html).not.toContain("Квартира 4");
    expect(html).toContain("Добавить объект"); expect(html).not.toContain("Подходят");
  });
  it("does not confuse a failed portfolio request with an empty seller", () => {
    h.seller.isError = true;
    const html = render({ variant: "portfolio" });
    expect(html).toContain('role="alert"'); expect(html).toContain("Повторить");
    expect(html).not.toContain("Объекты продавца ещё не добавлены"); expect(html).not.toContain('class="client-property-line"');
  });
  it("keeps an unaccepted gated client from loading portfolios or history", () => {
    const html = render({ variant: "portfolio", locked: true, client: { ...seller, pendingAcceptance: true } });
    expect(html).toContain("после принятия лида");
    expect(h.properties).toHaveBeenLastCalledWith({ sellerClientId: seller.id, page: 1 }, false);
    expect(h.history).toHaveBeenLastCalledWith(seller.id, "showings", 1, false);
  });
  it("never queries or renders a seller portfolio for a pure buyer", () => {
    expect(render({ variant: "portfolio", client: { ...seller, kind: "BUYER" } })).toBe("");
    expect(h.properties).toHaveBeenLastCalledWith({ sellerClientId: seller.id, page: 1 }, false);
  });
  it("offers buyer sending history independently without embedding another matching panel", () => {
    const html = render({ client: { ...seller, kind: "BUYER" } });
    expect(h.history).toHaveBeenLastCalledWith(seller.id, "sent", 1, true);
    expect(html).toContain("Отправлены"); expect(html).toContain("Показы");
    expect(html).not.toContain("Подходят"); expect(html).not.toContain("Квартира 1");
  });
  it("keeps seller history focused on showings without buyer sends", () => {
    const html = render({ canCreate: false });
    expect(h.history).toHaveBeenLastCalledWith(seller.id, "showings", 1, true);
    expect(html).not.toContain("Отправлены"); expect(html).not.toContain("Добавить объект");
  });
});
