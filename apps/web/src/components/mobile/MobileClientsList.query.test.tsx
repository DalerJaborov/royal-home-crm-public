import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientFilters } from "../../hooks/useClients";

const state = vi.hoisted(() => ({ query: null as ClientFilters | null }));
vi.mock("../../store/auth", () => ({ useAuthStore: (select: (value: { agent: { id: string; role: string } }) => unknown) => select({ agent: { id: "qa-agent", role: "AGENT" } }) }));
vi.mock("../../lib/permissions", () => ({ useCan: () => () => false }));
vi.mock("../../hooks/useCounters", () => ({ useMarkSectionSeen: () => undefined }));
vi.mock("../../hooks/useClients", async importOriginal => ({
  ...await importOriginal<typeof import("../../hooks/useClients")>(),
  useClients: (query: ClientFilters) => { state.query = query; throw new Error("QUERY_CAPTURED"); },
}));
import { MobileClientsList } from "./MobileClientsList";

function queryFor(path: string, kind: "BUYER" | "SELLER" = "BUYER") {
  expect(() => renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><MobileClientsList kind={kind} onAddClient={() => undefined} /></MemoryRouter>)).toThrow("QUERY_CAPTURED");
  return state.query!;
}
beforeEach(() => { state.query = null; });
describe("Mobile client request matches working and historical list semantics", () => {
  it.each(["BUYER", "SELLER"] as const)("normal %s list excludes completed/historical clients", kind => {
    expect(queryFor(kind === "BUYER" ? "/clients" : "/sellers", kind)).toMatchObject({ kind, scope: "inWork" });
  });
  it("keeps inactive lists and all-mine history separate", () => {
    expect(queryFor("/inactive-clients")).toMatchObject({ workStatus: "INACTIVE" });
    expect(state.query?.scope).toBeUndefined();
    expect(queryFor("/clients/all-mine").scope).toBe("allMine");
  });
  it("deep-link search retains text and searches both kinds including history", () => {
    expect(queryFor("/clients?q=QA")).toMatchObject({ q: "QA" });
    expect(state.query?.scope).toBeUndefined();
    expect(state.query?.kind).toBeUndefined();
  });
  it("pending acceptance includes both kinds like its summary counter", () => {
    const query = queryFor("/clients?slice=pending");
    expect(query.pendingAcceptance).toBe(true);
    expect(query.kind).toBeUndefined();
    expect(query.scope).toBeUndefined();
  });
});
