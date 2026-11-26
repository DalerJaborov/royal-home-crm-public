// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", () => ({ api: vi.fn() }));

import { api } from "../../lib/api";
import { isMoneyDealWrite } from "../../lib/dealVersion";
import { useUpdateDeal } from "../useDeals";

/**
 * Клик-аудит 26.11.2026: «Закрыть сделку» двигала карточку в колонку «Завершённые» ДО ответа сервера,
 * карточка с открытым окном исчезала, и при отказе («нет проведённого показа») введённые суммы
 * пропадали, а ошибка оставалась за экраном. Деньги теперь ждут ответа; перетаскивание этапа — как раньше.
 */
const deal = { id: "d1", stage: "SIGNED", version: 1 };

function setup() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  qc.setQueryData(["deals", {}], [deal]);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, ...renderHook(() => useUpdateDeal(), { wrapper }) };
}

describe("useUpdateDeal: деньги не двигают карточку заранее", () => {
  it("isMoneyDealWrite: цена и доли — да, один этап — нет", () => {
    expect(isMoneyDealWrite({ stage: "COMPLETED", soldPrice: 1 })).toBe(true);
    expect(isMoneyDealWrite({ commissionCompanyAmount: 0 })).toBe(true);
    expect(isMoneyDealWrite({ stage: "NEGOTIATION" })).toBe(false);
  });

  it("закрытие с суммами: пока сервер не ответил, карточка на месте", async () => {
    let reject!: (e: Error) => void;
    vi.mocked(api).mockImplementation(() => new Promise((_, r) => { reject = r; }));
    const { qc, result } = setup();
    let done!: Promise<unknown>;
    act(() => {
      done = result.current.mutateAsync({ id: "d1", body: { stage: "COMPLETED", soldPrice: 9, commissionRealtorAmount: 1, commissionCompanyAmount: 1 } });
      done.catch(() => {});
    });
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalled());
    expect((qc.getQueryData(["deals", {}]) as { stage: string }[])[0].stage).toBe("SIGNED");
    await act(async () => { reject(new Error("нет показа")); await done.catch(() => {}); });
    expect((qc.getQueryData(["deals", {}]) as { stage: string }[])[0].stage).toBe("SIGNED");
  });

  it("перетаскивание этапа без денег — по-прежнему сразу", async () => {
    vi.mocked(api).mockImplementation(() => new Promise(() => {}));
    const { qc, result } = setup();
    act(() => { void result.current.mutate({ id: "d1", body: { stage: "NEGOTIATION" } }); });
    await waitFor(() => expect((qc.getQueryData(["deals", {}]) as { stage: string }[])[0].stage).toBe("NEGOTIATION"));
  });
});
