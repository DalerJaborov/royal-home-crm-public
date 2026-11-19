import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ role: "HEAD_OF_SALES", mobile: false }));
vi.mock("../store/auth", () => ({ useAuthStore: (select: (value: { agent: { role: string } }) => unknown) => select({ agent: { role: state.role } }) }));
vi.mock("../lib/permissions", () => ({ useCan: () => (permission: string) => permission === "properties.moderate" }));
vi.mock("../hooks/useCleanShell", () => ({ useCleanShell: () => false, useCleanShellSelection: () => ({ clean: false, look: undefined }) }));
vi.mock("../hooks/useMobileUx", () => ({ useMobileUx: () => state.mobile }));
import { Pipeline } from "./Pipeline";
import { Insights } from "./Insights";
import { Ads } from "./Ads";

describe("Denied direct routes do not mount querying children", () => {
  // Deliberately no QueryClientProvider: mounting a data hook would fail this test.
  it.each([false, true])("shows access denial instead of network/empty data for mobile=%s", mobile => {
    state.mobile = mobile;
    // Router: экраны раздела «Аналитика» читают выбор «Нового вида» из адреса (useRoyalLook).
    expect(renderToStaticMarkup(<MemoryRouter><Pipeline /></MemoryRouter>)).toContain("Этот раздел доступен маркетингу");
    expect(renderToStaticMarkup(<MemoryRouter><Insights /></MemoryRouter>)).toContain("Недостаточно прав");
    expect(renderToStaticMarkup(<Ads />)).toContain("Недостаточно прав");
  });
});
