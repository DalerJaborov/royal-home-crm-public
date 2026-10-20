import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Офлайн-очередь досылает запись С ТЕМ ЖЕ ключом повтора, что был у первой
 * попытки (23.09.2026). Первая попытка могла дойти до сервера и создать объект —
 * обрыв был по нашему таймеру, а не по сети. Без ключа досылка создавала дубль.
 * И «первая попытка ещё выполняется» (409 inProgress) не повод выбросить запись.
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
import { enqueueOffline, flushOfflineQueue, startOfflineQueue } from "../offlineQueue";

const send = vi.fn();
startOfflineQueue(send, () => "agent-1");

beforeEach(() => {
  store.clear();
  send.mockReset();
});

describe("офлайн-очередь и ключ повтора", () => {
  it("досылает с ключом первой попытки", async () => {
    send.mockResolvedValue({});
    enqueueOffline("/properties", "POST", { a: 1 }, "key-12345678");
    await flushOfflineQueue();
    expect(send).toHaveBeenCalledWith("/properties", expect.objectContaining({ method: "POST", body: { a: 1 }, idempotencyKey: "key-12345678" })); // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
    expect(JSON.parse(store.get("royal-home-offline-queue") ?? "[]")).toHaveLength(0);
  });

  it("409 «уже выполняется» — запись остаётся до следующего прохода", async () => {
    send.mockRejectedValue(new ApiError("выполняется", 409, { inProgress: true }));
    enqueueOffline("/properties", "POST", { a: 1 }, "key-12345678");
    await flushOfflineQueue();
    expect(JSON.parse(store.get("royal-home-offline-queue") ?? "[]")).toHaveLength(1);
  });

  it("ordinary 4xx is retained as a rejected local record and is not auto-retried", async () => {
    send.mockRejectedValue(new ApiError("Неверные данные", 400, {}));
    enqueueOffline("/clients", "POST", { a: 1 }, "key-12345678");
    await flushOfflineQueue();
    const queue = JSON.parse(store.get("royal-home-offline-queue") ?? "[]");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ body: { a: 1 }, rejection: { status: 400 } });
    await flushOfflineQueue();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("429 «слишком часто» и 408 — не отказ по сути: запись остаётся (23.09.2026, №13)", async () => {
    for (const status of [429, 408]) {
      store.clear();
      send.mockReset();
      send.mockRejectedValue(new ApiError("Слишком много запросов", status, {}));
      enqueueOffline("/clients/x/interactions", "POST", { a: 1 }, "key-12345678");
      await flushOfflineQueue();
      expect(JSON.parse(store.get("royal-home-offline-queue") ?? "[]")).toHaveLength(1);
    }
  });
});
