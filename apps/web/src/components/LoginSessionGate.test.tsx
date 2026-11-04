import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ hasSession: false, accessToken: null as string | null }));
vi.mock("../store/auth", () => ({ useAuthStore: { getState: () => state } }));
vi.mock("../lib/api", () => ({ refreshAccessToken: vi.fn() }));
vi.mock("./AppSkeleton", () => ({ AppSkeleton: () => "RESTORING_SESSION" }));
vi.mock("react-router-dom", () => ({ Navigate: ({ to, replace }: { to: string; replace: boolean }) => `${replace ? "REPLACE" : "PUSH"}:${to}` }));
import { LoginSessionGate } from "./LoginSessionGate";

const render = () => renderToStaticMarkup(createElement(LoginSessionGate, null, "LOGIN_FORM"));
beforeEach(() => { state.hasSession = false; state.accessToken = null; });
describe("login route first paint", () => {
  it("an active session replaces /login with the CRM home without showing the form", () => {
    state.hasSession = true; state.accessToken = "test-access";
    expect(render()).toBe("REPLACE:/");
  });
  it("a persisted session waits for cookie refresh without flashing the login form", () => {
    state.hasSession = true;
    expect(render()).toBe("RESTORING_SESSION");
  });
  it("a signed-out visitor can use the normal login form", () => {
    expect(render()).toBe("LOGIN_FORM");
  });
});
