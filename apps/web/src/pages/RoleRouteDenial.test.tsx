import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ role: "HEAD_OF_SALES", mobile: false }));
vi.mock("../store/auth", () => ({ useAuthStore: (select: (value: { agent: { role: string } }) => unknown) => select({ agent: { role: state.role } }) }));
vi.mock("../lib/permissions", () => ({ useCan: () => (permission: string) => permission === "properties.moderate" }));
vi.mock("../hooks/useCleanShell", () => ({ useCleanShell: () => false }));
vi.mock("../hooks/useMobileUx", () => ({ useMobileUx: () => state.mobile }));
import { Pipeline } from "./Pipeline";
import { Insights } from "./Insights";
import { Ads } from "./Ads";

describe("Denied direct routes do not mount querying children", () => {
  // Deliberately no QueryClientProvider: mounting a data hook would fail this test.
  it.each([false, true])("shows access denial instead of network/empty data for mobile=%s", mobile => {
    state.mobile = mobile;
    expect(renderToStaticMarkup(<Pipeline />)).toContain("Этот раздел доступен маркетингу");
    expect(renderToStaticMarkup(<Insights />)).toContain("Недостаточно прав");
    expect(renderToStaticMarkup(<Ads />)).toContain("Недостаточно прав");
  });
});
