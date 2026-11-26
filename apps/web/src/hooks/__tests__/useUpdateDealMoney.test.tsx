// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", () => ({ api: vi.fn() }));

import { api } from "../../lib/api";
import { ApiError } from "../../lib/apiError";
import { isMoneyDealWrite } from "../../lib/dealVersion";
import { DealSubmitModal } from "../../components/DealSubmitModal";
import { fireEvent, render, screen } from "@testing-library/react";
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

  const money = { stage: "COMPLETED", soldPrice: 9, commissionRealtorAmount: 1, commissionCompanyAmount: 1 };
  const stageOf = (qc: QueryClient) => (qc.getQueryData(["deals", {}]) as { stage: string; version: number }[])[0];

  it("настоящий отказ сервера (409): карточка на месте, сделки перечитываются", async () => {
    vi.mocked(api).mockRejectedValue(new ApiError("Нельзя закрыть сделку без показа", 409, {}));
    const { qc, result } = setup();
    const spy = vi.spyOn(qc, "invalidateQueries");
    await act(async () => { await result.current.mutateAsync({ id: "d1", body: money }).catch(() => {}); });
    expect(stageOf(qc).stage).toBe("SIGNED");
    expect(spy).toHaveBeenCalledWith({ queryKey: ["deals"] });
  });

  it("успех: карточка переехала только после ответа, версия новая, кэш перечитан", async () => {
    let resolve!: (d: unknown) => void;
    vi.mocked(api).mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { qc, result } = setup();
    const spy = vi.spyOn(qc, "invalidateQueries");
    let done!: Promise<unknown>;
    act(() => { done = result.current.mutateAsync({ id: "d1", body: money }); });
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalled());
    expect(stageOf(qc).stage).toBe("SIGNED");
    await act(async () => { resolve({ id: "d1", stage: "COMPLETED", version: 2 }); await done; });
    expect(stageOf(qc)).toMatchObject({ stage: "COMPLETED", version: 2 });
    expect(spy).toHaveBeenCalled();
  });

  it("обрыв сети: деньги не уходят в офлайн-очередь, карточка на месте", async () => {
    vi.mocked(api).mockRejectedValue(new Error("Нет связи с сервером"));
    const { qc, result } = setup();
    await act(async () => { await result.current.mutateAsync({ id: "d1", body: money }).catch(() => {}); });
    expect(vi.mocked(api).mock.calls.at(-1)?.[1]).toMatchObject({ queueOffline: false });
    expect(stageOf(qc).stage).toBe("SIGNED");
  });

  it("перетаскивание этапа без денег по-прежнему идёт через офлайн-очередь", async () => {
    vi.mocked(api).mockResolvedValue({ id: "d1", stage: "NEGOTIATION", version: 2 });
    const { result } = setup();
    await act(async () => { await result.current.mutateAsync({ id: "d1", body: { stage: "NEGOTIATION" } }); });
    expect(vi.mocked(api).mock.calls.at(-1)?.[1]).toMatchObject({ queueOffline: true });
  });
});

describe("окно закрытия: двойной клик даёт один PATCH", () => {
  it("пока ответа нет, второе нажатие игнорируется", async () => {
    window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null })) as unknown as typeof window.matchMedia;
    window.scrollTo = () => {};
    const onSubmit = vi.fn(() => new Promise(() => {}));
    render(<DealSubmitModal listedPrice="900000" currency="TJS" mode="complete" onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText(/За сколько фактически продали/), { target: { value: "800000" } });
    fireEvent.change(screen.getByLabelText(/Получает агент/), { target: { value: "8000" } });
    fireEvent.change(screen.getByLabelText(/Получает компания/), { target: { value: "8000" } });
    const btn = screen.getByRole("button", { name: "Закрыть сделку" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
