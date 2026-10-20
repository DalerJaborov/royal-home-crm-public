import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Одна запись с отказом в доступе не держит собой очередь (23.09.2026, проверка
 * раздачи лидов, пункт 9). «Принять» без сети уходит, когда сеть вернётся; к тому
 * времени лид мог уйти другому, и до правки 403 на эту запись навсегда запирал
 * в телефоне всё, что стояло за ней: новых клиентов, заметки, объекты.
 */
vi.mock("../queryClient", () => ({ queryClient: { invalidateQueries: vi.fn() } }));

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
vi.stubGlobal("window", { addEventListener: () => {}, setInterval: () => 0 });
vi.stubGlobal("navigator", { onLine: false });

import { ApiError } from "../apiError";
import { enqueueOffline, flushOfflineQueue, startOfflineQueue, getRejectedOfflineRequests, retryRejectedOfflineRequest, discardRejectedOfflineRequest } from "../offlineQueue";
import { toast } from "../../store/toast";

const send = vi.fn();
startOfflineQueue(send, () => "agent-1");

const queued = () => JSON.parse(store.get("royal-home-offline-queue") ?? "[]") as { path: string }[];

beforeEach(() => {
  store.clear();
  send.mockReset();
});

describe("офлайн-очередь: отказ в доступе к одной записи", () => {
  it("READ_ONLY_ROLE is recoverable rejection rather than an invisible heartbeat retry", async () => {
    const notify = vi.spyOn(toast, "error");
    send.mockRejectedValueOnce(new ApiError("Роль доступна только для чтения", 403, { code: "READ_ONLY_ROLE" })).mockResolvedValue({});
    enqueueOffline("/clients", "POST", { fullName: "Сохранённый клиент" });
    enqueueOffline("/properties", "POST", { title: "Следующая запись" });
    await flushOfflineQueue();
    expect(send).toHaveBeenCalledTimes(2);
    expect(getRejectedOfflineRequests()).toHaveLength(1);
    expect(getRejectedOfflineRequests()[0]).toMatchObject({ body: { fullName: "Сохранённый клиент" }, rejection: { status: 403, message: "Роль доступна только для чтения" } });
    expect(notify).toHaveBeenCalledOnce();
    await flushOfflineQueue();
    expect(send).toHaveBeenCalledTimes(2);
    notify.mockRestore();
  });
  it.each([
    [403, "FORBIDDEN"],
    [428, "STEP_UP_REQUIRED"],
  ])("%s %s waits for identity confirmation without discarding or rejecting the local body", async (status, code) => {
    const notify = vi.spyOn(toast, "error");
    send.mockRejectedValueOnce(new ApiError("Подтвердите личность", status, { code })).mockResolvedValue({});
    enqueueOffline("/clients", "POST", { fullName: "Сохранённый клиент" });
    enqueueOffline("/properties", "POST", { title: "Следующая запись" });
    await flushOfflineQueue();
    expect(send).toHaveBeenCalledTimes(2);
    expect(queued()).toHaveLength(1);
    expect(getRejectedOfflineRequests()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    await flushOfflineQueue();
    expect(send).toHaveBeenCalledTimes(3);
    expect(queued()).toHaveLength(0);
    notify.mockRestore();
  });
  it("403 на первой записи — остальные всё равно уходят, сама запись остаётся", async () => {
    send.mockImplementation(async (path: string) => {
      if (path === "/clients/c1/interactions") throw new ApiError("Недостаточно прав", 403, {});
      return {};
    });
    enqueueOffline("/clients/c1/interactions", "POST", { n: 1 });
    enqueueOffline("/clients", "POST", { n: 2 });
    enqueueOffline("/properties", "POST", { n: 3 });
    await flushOfflineQueue();
    expect(send.mock.calls.map((c) => c[0])).toEqual(["/clients/c1/interactions", "/clients", "/properties"]);
    expect(queued().map((r) => r.path)).toEqual(["/clients/c1/interactions"]);
  });

  it("401 (вход потерян) по-прежнему останавливает проход и ничего не выбрасывает", async () => {
    send.mockRejectedValue(new ApiError("Не авторизован", 401, {}));
    enqueueOffline("/clients", "POST", { n: 1 });
    enqueueOffline("/properties", "POST", { n: 2 });
    await flushOfflineQueue();
    expect(send).toHaveBeenCalledTimes(1);
    expect(queued()).toHaveLength(2);
  });

  it("409 retains recoverable local data, notifies the user, and lets the next entry proceed", async () => {
    const notify = vi.spyOn(toast, "error");
    send.mockImplementation(async (path: string) => {
      if (path === "/clients/c1/accept") throw new ApiError("Заявка уже переназначена другому агенту", 409, {});
      return {};
    });
    enqueueOffline("/clients/c1/accept", "POST", {});
    enqueueOffline("/clients", "POST", { n: 2 });
    await flushOfflineQueue();
    expect(send).toHaveBeenCalledTimes(2);
    expect(queued()).toHaveLength(1);
    const rejected = getRejectedOfflineRequests();
    expect(rejected[0]).toMatchObject({ path: "/clients/c1/accept", body: {}, rejection: { status: 409, message: "Заявка уже переназначена другому агенту" } });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Запись сохранена"));
    await flushOfflineQueue();
    expect(send).toHaveBeenCalledTimes(2);
    notify.mockRestore();
  });
  it("allows deliberate correction and retry with a new key, or deliberate discard", async () => {
    send.mockRejectedValueOnce(new ApiError("Неверный телефон", 400, {})).mockResolvedValue({});
    enqueueOffline("/clients", "POST", { phone: "bad" }, "initial-key");
    await flushOfflineQueue();
    const entry = getRejectedOfflineRequests()[0];
    expect(retryRejectedOfflineRequest(entry.id, { phone: "+992900000001" })).toBe(true);
    await flushOfflineQueue();
    expect(send.mock.calls[1][1]).toMatchObject({ body: { phone: "+992900000001" }, idempotencyKey: expect.any(String) });
    expect(send.mock.calls[1][1].idempotencyKey).not.toBe("initial-key");
    expect(queued()).toHaveLength(0);
    send.mockRejectedValue(new ApiError("Неверные данные", 422, {}));
    enqueueOffline("/clients", "POST", { n: 1 });
    await flushOfflineQueue();
    expect(discardRejectedOfflineRequest(getRejectedOfflineRequests()[0].id)).toBe(true);
    expect(queued()).toHaveLength(0);
  });
  it("never exposes or recovers another account's rejected body", async () => {
    send.mockRejectedValue(new ApiError("Неверные данные", 400, {}));
    enqueueOffline("/clients", "POST", { private: "A" });
    await flushOfflineQueue();
    const id = getRejectedOfflineRequests()[0].id;
    startOfflineQueue(send, () => "agent-2");
    expect(getRejectedOfflineRequests()).toEqual([]);
    expect(retryRejectedOfflineRequest(id)).toBe(false);
    expect(discardRejectedOfflineRequest(id)).toBe(false);
    startOfflineQueue(send, () => "agent-1");
    expect(getRejectedOfflineRequests()[0].body).toEqual({ private: "A" });
  });
});
