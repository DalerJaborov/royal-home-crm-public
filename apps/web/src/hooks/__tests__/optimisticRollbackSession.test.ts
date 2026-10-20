import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Поздний откат оптимистичного апдейта не возвращает данные прежнего сотрудника
 * после смены аккаунта (аудит Codex 04.10.2026, WEB-01).
 *
 * Мутация А ушла в сеть, А вышел, вошёл Б (кэш очищен), и только теперь пришла
 * ошибка запроса А. Стор настоящий, useMutation подменён на «вернуть опции»,
 * чтобы дёрнуть onMutate/onError руками с управляемой паузой между ними.
 */
const lsStore = vi.hoisted(() => {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
});
vi.mock("../../lib/queryClient", () => ({ queryClient: { clear: vi.fn(), invalidateQueries: vi.fn() } }));
vi.mock("../../lib/queryPersist", () => ({ clearPersistedQueryCache: vi.fn(async () => {}) }));
vi.mock("../../lib/pendingMapPin", () => ({ clearPendingMapPin: vi.fn() }));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useMutation: (o: unknown) => o,
    useQueryClient: () => (globalThis as { __qc?: unknown }).__qc,
  };
});

import { ApiError } from "../../lib/apiError";
import { useAuthStore } from "../../store/auth";
import { useUpdateClient, useAcceptLead } from "../useClients";
import { useUpdateDeal } from "../useDeals";
import { useUpdateSettings } from "../useSettings";
import { useReplyToConversation } from "../useConversations";
import { useUpdateBotLesson } from "../useBotLearning";

const A = { id: "agent-A", fullName: "А", phone: "+992900000001", role: "AGENT" as const };
const B = { id: "agent-B", fullName: "Б", phone: "+992900000002", role: "AGENT" as const };

type Opts = {
  onMutate: (v: unknown) => Promise<unknown>;
  onError: (e: unknown, v: unknown, ctx: unknown) => void;
};

let qc: QueryClient;
beforeEach(() => {
  lsStore.clear();
  qc = new QueryClient();
  (globalThis as { __qc?: unknown }).__qc = qc;
  useAuthStore.getState().setSession(A, "token-A");
});

/** Выход А и вход Б: стор двигает эпоху, кэш чистится (queryClient в сторе подменён). */
function switchToB() {
  useAuthStore.getState().logout();
  qc.clear();
  useAuthStore.getState().setSession(B, "token-B");
}

describe("откат оптимистичного апдейта привязан к сессии", () => {
  it("useUpdateClient: ошибка после смены аккаунта не возвращает карточку А", async () => {
    const o = useUpdateClient("c1") as unknown as Opts;
    qc.setQueryData(["client", 1], { id: "c1", status: "NEW" });
    const ctx = await o.onMutate({ status: "WON" });
    switchToB();
    o.onError(new ApiError("сбой", 500, {}), {}, ctx);
    expect(qc.getQueryData(["client", 1])).toBeUndefined();
  });

  it("useUpdateClient: в своей сессии откат работает как раньше", async () => {
    const o = useUpdateClient("c1") as unknown as Opts;
    qc.setQueryData(["client", 1], { id: "c1", status: "NEW" });
    const ctx = await o.onMutate({ status: "WON" });
    expect(qc.getQueryData<{ status: string }>(["client", 1])?.status).toBe("WON");
    o.onError(new ApiError("сбой", 500, {}), {}, ctx);
    expect(qc.getQueryData<{ status: string }>(["client", 1])?.status).toBe("NEW");
  });

  it("useAcceptLead: то же", async () => {
    const o = useAcceptLead("c1") as unknown as Opts;
    qc.setQueryData(["client", 1], { id: "c1", pendingAcceptance: true });
    const ctx = await o.onMutate({});
    switchToB();
    o.onError(new ApiError("сбой", 500, {}), {}, ctx);
    expect(qc.getQueryData(["client", 1])).toBeUndefined();
  });

  it("useUpdateDeal: то же", async () => {
    const o = useUpdateDeal() as unknown as Opts;
    qc.setQueryData(["deals", {}], [{ id: "d1", stage: "NEW" }]);
    const ctx = await o.onMutate({ id: "d1", body: { stage: "WON" } });
    switchToB();
    o.onError(new ApiError("сбой", 500, {}), {}, ctx);
    expect(qc.getQueryData(["deals", {}])).toBeUndefined();
  });

  it("useUpdateSettings: то же", async () => {
    const o = useUpdateSettings() as unknown as Opts;
    qc.setQueryData(["settings"], { companyName: "A" });
    const ctx = await o.onMutate({ companyName: "X" });
    switchToB();
    o.onError(new ApiError("сбой", 500, {}), {}, ctx);
    expect(qc.getQueryData(["settings"])).toBeUndefined();
  });

  it("useReplyToConversation: то же", async () => {
    const o = useReplyToConversation("conv1") as unknown as Opts;
    qc.setQueryData(["conversations", "conv1"], { messages: [] });
    const ctx = await o.onMutate({ text: "привет" });
    switchToB();
    o.onError(new ApiError("сбой", 500, {}), {}, ctx);
    expect(qc.getQueryData(["conversations", "conv1"])).toBeUndefined();
  });

  it("useUpdateBotLesson: то же", async () => {
    const o = useUpdateBotLesson() as unknown as Opts;
    qc.setQueryData(["bot-learning"], { items: [{ id: "l1", active: true }] });
    const ctx = await o.onMutate({ id: "l1", active: false });
    switchToB();
    o.onError(new ApiError("сбой", 500, {}), {}, ctx);
    expect(qc.getQueryData(["bot-learning"])).toBeUndefined();
  });

  it("useUpdateSettings: поздний УСПЕХ прежней сессии не пишет ответ в чужой кэш", async () => {
    const o = useUpdateSettings() as unknown as Opts & {
      onSuccess: (fresh: unknown, v: unknown, ctx: unknown) => void;
    };
    qc.setQueryData(["settings"], { companyName: "A" });
    const ctx = await o.onMutate({ companyName: "X" });
    switchToB();
    o.onSuccess({ companyName: "X" }, {}, ctx);
    expect(qc.getQueryData(["settings"])).toBeUndefined();
  });
});
