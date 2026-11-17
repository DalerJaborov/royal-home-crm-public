import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const device = vi.hoisted(() => ({ mobile: false }));
vi.mock("./BottomSheet", async (original) => ({ ...await original<typeof import("./BottomSheet")>(), useSheetMode: () => device.mobile }));
import { PullToRefresh } from "./PullToRefresh";

describe("pull-to-refresh responsive form preservation", () => {
  it.each([false, true])("keeps the same wrapper and child position with mobile=%s", (mobile) => {
    device.mobile = mobile;
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><PullToRefresh><input aria-label="Unsaved draft" defaultValue="keep me" /></PullToRefresh></QueryClientProvider>);
    expect(html).toMatch(/^<div/);
    expect(html).toMatch(/<\/div><input[^>]*value="keep me"[^>]*\/><\/div>$/);
  });
});
