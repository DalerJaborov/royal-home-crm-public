import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Офлайн-очередь: смена аккаунта посреди прохода (аудит Codex 04.10.2026, №2).
 *
 * Запись 1 агента А уходит медленно; за это время А выходит, входит Б (его вход
 * запускает flush, но тот сразу выходит — проход А ещё идёт). Цикл А до правки
 * брал запись 2 с agentId=А и слал её токеном Б.
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

import { enqueueOffline, flushOfflineQueue, startOfflineQueue } from "../offlineQueue";

let currentId: string | null = "agent-1";
const send = vi.fn();
startOfflineQueue(send, () => currentId);

const queued = () => JSON.parse(store.get("royal-home-offline-queue") ?? "[]") as { path: string; agentId?: string }[];

beforeEach(() => {
  store.clear();
  send.mockReset();
  currentId = "agent-1";
});

describe("офлайн-очередь: смена аккаунта посреди прохода", () => {
  it("после смены агента вторая запись А не отправляется, остаётся в очереди", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    send.mockImplementationOnce(async () => {
      // Пока запись 1 в пути: А вышел, вошёл Б.
      currentId = "agent-2";
      await gate;
      return {};
    });
    enqueueOffline("/clients", "POST", { n: 1 });
    // enqueueOffline берёт автора из currentId — обе записи принадлежат agent-1.
    enqueueOffline("/properties", "POST", { n: 2 });

    const flush = flushOfflineQueue();
    release();
    await flush;

    expect(send).toHaveBeenCalledTimes(1);
    expect(queued().map((r) => r.path)).toEqual(["/properties"]);
  });

  it("очередь нового агента досылается сразу после прохода прежнего, не ждёт минуту", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    send.mockImplementationOnce(async () => {
      currentId = "agent-2";
      await gate;
      return {};
    });
    enqueueOffline("/clients", "POST", { n: 1 });
    currentId = "agent-2";
    enqueueOffline("/properties", "POST", { n: 2 }); // запись Б
    currentId = "agent-1";

    const flush = flushOfflineQueue();
    release();
    await flush;
    // Повторный проход запущен без await: даём ему отработать.
    await new Promise((r) => setTimeout(r, 0));

    expect(send.mock.calls.map((c) => c[0])).toEqual(["/clients", "/properties"]);
    expect(queued()).toHaveLength(0);
  });

  it("в send уходит expectAgentId: api() сверит личность перед сетью и после refresh", async () => {
    send.mockResolvedValue({});
    enqueueOffline("/clients", "POST", { n: 1 });
    await flushOfflineQueue();
    expect(send.mock.calls[0][1]).toMatchObject({ expectAgentId: "agent-1" });
  });
});
