import { describe, expect, it } from "vitest";
import { nextRouteViewportIdentity as next } from "../useRouteViewportKey";

describe("route viewport identity and unsaved forms", () => {
  it("keeps an unsaved form through repeated desktop/mobile shell changes", () => {
    const initial = { pathname: "/clients", generation: 0 };
    let state = initial;
    for (const clean of [true, false, true, false]) state = next(state, "/clients", clean);
    expect(state).toBe(initial);
  });
  it("resets legacy page state when switching between two client cards", () => {
    const initial = { pathname: "/clients/12", generation: 0 };
    expect(next(initial, "/clients/13", false)).toEqual({ pathname: "/clients/13", generation: 1 });
  });
  it("does not revive an older legacy page instance when returning", () => {
    const first = { pathname: "/clients/12", generation: 0 };
    const second = next(first, "/clients/13", false);
    expect(next(second, "/clients/12", false).generation).toBe(2);
  });
  it("retains the existing Clean viewport across navigation", () => {
    const first = { pathname: "/clients", generation: 4 };
    expect(next(first, "/properties", true)).toEqual({ pathname: "/properties", generation: 4 });
  });
  it("a shell rollback on the same Clean route keeps its draft but the next legacy route resets", () => {
    const first = next({ pathname: "/clients", generation: 4 }, "/properties", true);
    expect(next(first, "/properties", false)).toBe(first);
    expect(next(first, "/clients", false).generation).toBe(5);
  });
});
