import { describe, expect, it } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

describe("route recovery without remounting a healthy viewport", () => {
  it("keeps an existing failure until the user changes route", () => {
    const error = new Error("failed client page");
    expect(ErrorBoundary.getDerivedStateFromProps({ children: null, resetKey: "/clients" }, { error, resetKey: "/clients" })).toBeNull();
    expect(ErrorBoundary.getDerivedStateFromProps({ children: null, resetKey: "/messages" }, { error, resetKey: "/clients" })).toEqual({ error: null, resetKey: "/messages" });
  });
  it("does not reset a global boundary that has no route key", () => {
    expect(ErrorBoundary.getDerivedStateFromProps({ children: null }, { error: new Error("app failed") })).toBeNull();
  });
  it("captures failures without overwriting the current route identity", () => {
    const boundary = new ErrorBoundary({ children: null, resetKey: "/clients" });
    const error = new Error("render failed");
    const caught = { ...boundary.state, ...ErrorBoundary.getDerivedStateFromError(error) };
    expect(caught).toEqual({ error, resetKey: "/clients" });
  });
});
