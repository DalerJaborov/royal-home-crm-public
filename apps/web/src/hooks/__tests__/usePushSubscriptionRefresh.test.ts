import { describe, expect, it, vi } from "vitest";
import { pushRefreshDue, refreshPushSubscription, type PushRefreshDeps } from "../usePushSubscriptionRefresh";

describe("освежение подписки на уведомления", () => {
  const now = 10 * 24 * 3600 * 1000;
  it("не чаще раза в сутки", () => {
    expect(pushRefreshDue(now, { getItem: () => String(now - 3600_000) })).toBe(false);
    expect(pushRefreshDue(now, { getItem: () => String(now - 25 * 3600_000) })).toBe(true);
  });
  it("нет метки или хранилище недоступно — освежаем", () => {
    expect(pushRefreshDue(now, { getItem: () => null })).toBe(true);
    expect(pushRefreshDue(now, null)).toBe(true);
    expect(pushRefreshDue(now, { getItem: () => { throw new Error("denied"); } })).toBe(true);
  });
});

/**
 * Полный сброс обновления (снять service worker) уносит push-подписку вместе с
 * воркером. Разрешение в браузере остаётся — значит, подписаться заново молча
 * обязаны мы, иначе сотрудник тихо перестаёт получать уведомления (21.11.2026).
 */
describe("пропавшая подписка при выданном разрешении", () => {
  const fakeSub = { toJSON: () => ({ endpoint: "https://push.example/1", keys: { p256dh: "k", auth: "a" } }) } as unknown as PushSubscription;
  function deps(over: Partial<PushRefreshDeps> & { existing?: PushSubscription | null } = {}) {
    const subscribe = vi.fn(async () => fakeSub);
    const base: PushRefreshDeps = {
      pushManager: { getSubscription: vi.fn(async () => over.existing ?? null), subscribe } as unknown as PushRefreshDeps["pushManager"],
      permission: "granted",
      due: false,
      loadConfig: vi.fn(async () => ({ enabled: true, publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U" })),
      register: vi.fn(async () => {}),
    };
    return { ...base, ...over, subscribe };
  }

  it("разрешение есть, подписки нет — подписываемся заново и регистрируем на сервере, даже если сутки не прошли", async () => {
    const d = deps();
    expect(await refreshPushSubscription(d)).toBe("resubscribed");
    expect(d.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(d.register).toHaveBeenCalledWith(fakeSub);
  });

  it("разрешение не дано или отозвано — не подписываем и не спрашиваем", async () => {
    for (const permission of ["default", "denied", undefined] as const) {
      const d = deps({ permission });
      expect(await refreshPushSubscription(d)).toBe("skipped");
      expect(d.subscribe).not.toHaveBeenCalled();
      expect(d.loadConfig).not.toHaveBeenCalled();
    }
  });

  it("уведомления выключены на сервере — не подписываем", async () => {
    const d = deps({ loadConfig: vi.fn(async () => ({ enabled: false, publicKey: null })) });
    expect(await refreshPushSubscription(d)).toBe("skipped");
    expect(d.subscribe).not.toHaveBeenCalled();
  });

  it("подписка есть — освежаем раз в сутки, как раньше", async () => {
    const fresh = deps({ existing: fakeSub, due: false });
    expect(await refreshPushSubscription(fresh)).toBe("skipped");
    expect(fresh.register).not.toHaveBeenCalled();
    const due = deps({ existing: fakeSub, due: true });
    expect(await refreshPushSubscription(due)).toBe("refreshed");
    expect(due.register).toHaveBeenCalledWith(fakeSub);
    expect(due.subscribe).not.toHaveBeenCalled();
  });
});
