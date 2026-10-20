import { describe, expect, it, vi } from "vitest";
import { handleLoginCodePush, isLoginCodePush } from "../swLoginCode";

const payload = { kind: "login-code" as const, code: "123456", ackToken: "ack-1", title: "Код входа", body: "Ваш код 123456", tag: "login-code" };

function registration(endpoint: string | null = "https://push.example/e1") {
  return {
    showNotification: vi.fn().mockResolvedValue(undefined),
    pushManager: { getSubscription: vi.fn().mockResolvedValue(endpoint ? { endpoint } : null) },
  };
}

describe("пуш с кодом входа в service worker", () => {
  it("распознаёт только свой вид пуша", () => {
    expect(isLoginCodePush(payload)).toBe(true);
    expect(isLoginCodePush({ ...payload, kind: "lead" })).toBe(false);
    expect(isLoginCodePush({ title: "x", body: "y" })).toBe(false);
    expect(isLoginCodePush(null)).toBe(false);
  });

  it("показывает уведомление с tag login-code и ведёт клик на /login", async () => {
    const reg = registration();
    await handleLoginCodePush(payload, reg, vi.fn().mockResolvedValue({}) as unknown as typeof fetch);
    expect(reg.showNotification).toHaveBeenCalledOnce();
    const [title, opts] = reg.showNotification.mock.calls[0] as [string, Record<string, unknown>];
    expect(title).toBe("Код входа");
    expect(opts).toMatchObject({ body: "Ваш код 123456", tag: "login-code", renotify: true, data: { url: "/login" } });
  });

  it("сразу отчитывается о доставке с ackToken и endpoint подписки", async () => {
    const reg = registration();
    const f = vi.fn().mockResolvedValue({});
    await handleLoginCodePush(payload, reg, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledWith("/api/v1/auth/login/code-ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ackToken: "ack-1", endpoint: "https://push.example/e1" }),
    });
  });

  it("отказ ack не мешает показу уведомления", async () => {
    const reg = registration();
    const f = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(handleLoginCodePush(payload, reg, f as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(reg.showNotification).toHaveBeenCalledOnce();
  });
});
