// @vitest-environment jsdom
import { onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { trackOnlineState } from "../queryClient";

/** Холодный старт без сети: начальное состояние берётся из navigator.onLine, дальше — события online/offline. */
describe("trackOnlineState", () => {
  afterEach(() => onlineManager.setOnline(true));

  it("приложение открыто без сети: сразу офлайн (запросы встанут на паузу, а не упадут)", () => {
    const target = new EventTarget() as unknown as Window;
    trackOnlineState(target, { onLine: false });
    expect(onlineManager.isOnline()).toBe(false);
  });

  it("со связью — онлайн; события offline и online переключают, и подписка выполняется", () => {
    const target = new EventTarget();
    trackOnlineState(target as unknown as Window, { onLine: true });
    expect(onlineManager.isOnline()).toBe(true);
    const seen: boolean[] = [];
    const unsubscribe = onlineManager.subscribe((online) => seen.push(online));
    target.dispatchEvent(new Event("offline"));
    expect(onlineManager.isOnline()).toBe(false);
    target.dispatchEvent(new Event("online"));
    expect(onlineManager.isOnline()).toBe(true);
    expect(seen).toEqual([false, true]);
    unsubscribe();
  });
});
