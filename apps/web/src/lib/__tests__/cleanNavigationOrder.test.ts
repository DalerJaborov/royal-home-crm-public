import { describe, expect, it } from "vitest";
import { House } from "lucide-react";
import type { NavItem } from "../navigation";
import { defaultCleanNavigation, mergeCleanNavigationDraft, moveCleanNavigation, orderedCleanNavigation, partitionCleanNavigation, readCleanNavigationOrder } from "../cleanNavigationOrder";

const items = (paths: string[]): NavItem[] => paths.map((to) => ({ to, label: to, icon: House, group: "main" }));
describe("personal desktop navigation order", () => {
  it("resolves every link through allowed registry and appends new sections", () => {
    const all = items(["/", "/clients", "/messages", "/properties", "/settings"]);
    expect(orderedCleanNavigation(all, all, ["/settings", "/finance", "/clients", "/settings"]).map((item) => item.to))
      .toEqual(["/settings", "/clients", "/", "/messages", "/properties"]);
  });
  it("keeps all routes once between tabs and overflow with a custom order", () => {
    const all = items(["/", "/clients", "/messages", "/properties", "/deals", "/finance", "/settings"]);
    const result = partitionCleanNavigation(all, all, 4, ["/settings", "/finance", "/messages"]);
    expect([...result.tabs, ...result.overflow].map((item) => item.to)).toEqual(["/settings", "/finance", "/messages", "/", "/clients", "/properties", "/deals"]);
    expect(result.tabs).toHaveLength(4);
  });
  it("reset restores existing defaults and default overflow order", () => {
    const all = items(["/calendar", "/finance", "/messages", "/clients", "/properties", "/", "/deals", "/settings"]);
    expect(defaultCleanNavigation(all, all).slice(0, 6).map((item) => item.to)).toEqual(["/", "/clients", "/messages", "/properties", "/deals", "/finance"]);
    expect(partitionCleanNavigation(all, all, 6, []).overflow.map((item) => item.to)).toEqual(["/calendar", "/settings"]);
  });
  it("rejects legacy malformed or external values without granting a route", () => {
    expect(readCleanNavigationOrder(["https://evil.test", "//evil.test", "/clients?all=1", "/clients#x", 1, "/clients", "/clients"])).toEqual(["/clients"]);
    expect(readCleanNavigationOrder({ order: ["/clients"] })).toEqual([]);
  });
  it("supports drag and one-step button movement, with harmless invalid targets", () => {
    expect(moveCleanNavigation(["/", "/clients", "/messages"], "/messages", "/")).toEqual(["/messages", "/", "/clients"]);
    expect(moveCleanNavigation(["/", "/clients"], "/unknown", "/")).toEqual(["/", "/clients"]);
  });
  it("preserves dormant permissions while saving only actual visible links", () => {
    expect(mergeCleanNavigationDraft(["/finance", "/clients"], ["/messages", "/clients", "/invented"], ["/clients", "/messages"]))
      .toEqual(["/messages", "/clients", "/finance"]);
  });
});
