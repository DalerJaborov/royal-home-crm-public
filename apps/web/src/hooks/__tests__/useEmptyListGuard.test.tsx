// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({ report: vi.fn(), purge: vi.fn(async () => {}) }));
vi.mock("../../lib/emptyListGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/emptyListGuard")>();
  return { ...actual, reportEmptyList: spies.report, purgeListCaches: spies.purge };
});

import { useEmptyListGuard, type EmptyListGuardInput } from "../useEmptyListGuard";

function setup(over: Partial<EmptyListGuardInput> = {}) {
  const refetchAll = vi.fn(async () => {});
  const base: EmptyListGuardInput = {
    enabled: true,
    sliceKey: "desktop:BUYER:plain",
    sliceName: "desktop-buyer",
    isLoading: false,
    isFetching: false,
    hasData: true,
    error: null,
    itemCount: 0,
    expected: 13,
    summaryPending: false,
    refetchAll,
    ...over,
  };
  const hook = renderHook((p: EmptyListGuardInput) => useEmptyListGuard(p), { initialProps: base });
  return { hook, base, refetchAll };
}
/** Новый прогон с теми же или изменёнными данными; даёт дойти завершению перезапроса. */
const again = async (h: ReturnType<typeof setup>, over: Partial<EmptyListGuardInput> = {}) => {
  await act(async () => {
    h.hook.rerender({ ...h.base, ...over });
  });
};

beforeEach(() => {
  spies.report.mockClear();
  spies.purge.mockClear();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});
afterEach(() => vi.restoreAllMocks());

describe("useEmptyListGuard", () => {
  it("пустой список при сводке 13: ровно один тихий перезапрос, потом плашка и одна запись", async () => {
    const h = setup();
    expect(h.refetchAll).toHaveBeenCalledTimes(1);
    expect(h.hook.result.current.broken).toBe(false); // перезапрос ещё идёт
    expect(spies.report).not.toHaveBeenCalled();
    await again(h); // перезапрос закончился и не помог: те же данные
    expect(h.hook.result.current.broken).toBe(true);
    expect(spies.report).toHaveBeenCalledTimes(1);
    await again(h);
    await again(h);
    expect(h.refetchAll).toHaveBeenCalledTimes(1);
    expect(spies.report).toHaveBeenCalledTimes(1);
  });

  it("пока тихий перезапрос идёт, повторных перезапросов, плашки и записи нет", async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>((r) => (release = r));
    const h = setup({ refetchAll: vi.fn(() => pending) });
    await again(h, { refetchAll: h.base.refetchAll, isFetching: true });
    await again(h, { refetchAll: h.base.refetchAll, isFetching: false }); // вердикт снова «поломка»
    expect(h.base.refetchAll).toHaveBeenCalledTimes(1);
    expect(h.hook.result.current.broken).toBe(false);
    expect(spies.report).not.toHaveBeenCalled();
    await act(async () => release());
    expect(h.hook.result.current.broken).toBe(true);
    expect(spies.report).toHaveBeenCalledTimes(1);
  });

  it("сводка 0, нет сводки или срез не сравнивается: ничего не делает", async () => {
    for (const expected of [0, null, undefined]) {
      const h = setup({ expected });
      await again(h);
      expect(h.refetchAll).not.toHaveBeenCalled();
      expect(h.hook.result.current.broken).toBe(false);
      h.hook.unmount();
    }
    expect(spies.report).not.toHaveBeenCalled();
  });

  it("пока сводка грузится, не судит (гонка список/сводка)", async () => {
    const h = setup({ summaryPending: true });
    await again(h);
    expect(h.refetchAll).not.toHaveBeenCalled();
    expect(h.hook.result.current.broken).toBe(false);
    expect(spies.report).not.toHaveBeenCalled();
  });

  it("выключенный запрос не трогается, возврат во вкладку тоже", async () => {
    const h = setup({ enabled: false, error: new Error("403"), hasData: false });
    await again(h);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(h.refetchAll).not.toHaveBeenCalled();
    expect(h.hook.result.current.broken).toBe(false);
    expect(spies.report).not.toHaveBeenCalled();
  });

  it("возврат на передний план: перезапрос только при найденной поломке", async () => {
    const ok = setup({ itemCount: 5 });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(ok.refetchAll).not.toHaveBeenCalled();
    ok.hook.unmount();

    const h = setup();
    await again(h);
    expect(h.refetchAll).toHaveBeenCalledTimes(1);
    act(() => void window.dispatchEvent(new Event("pageshow")));
    expect(h.refetchAll).toHaveBeenCalledTimes(2);
  });

  it("слушатели visibilitychange и pageshow снимаются при размонтировании", async () => {
    const addDoc = vi.spyOn(document, "addEventListener");
    const rmDoc = vi.spyOn(document, "removeEventListener");
    const addWin = vi.spyOn(window, "addEventListener");
    const rmWin = vi.spyOn(window, "removeEventListener");
    const h = setup();
    const docHandler = addDoc.mock.calls.find((c) => c[0] === "visibilitychange")?.[1];
    const winHandler = addWin.mock.calls.find((c) => c[0] === "pageshow")?.[1];
    expect(docHandler).toBeTypeOf("function");
    expect(winHandler).toBeTypeOf("function");
    h.hook.unmount();
    expect(rmDoc).toHaveBeenCalledWith("visibilitychange", docHandler);
    expect(rmWin).toHaveBeenCalledWith("pageshow", winHandler);
  });

  it("плашка не гаснет от фонового обновления", async () => {
    const h = setup();
    await again(h);
    expect(h.hook.result.current.broken).toBe(true);
    await again(h, { isFetching: true });
    expect(h.hook.result.current.broken).toBe(true);
  });

  it("«Обновить» при пустом списке чистит кэши и перезапрашивает", async () => {
    const h = setup();
    await again(h);
    await act(async () => void (await h.hook.result.current.repair()));
    expect(spies.purge).toHaveBeenCalledTimes(1);
    expect(h.refetchAll).toHaveBeenCalledTimes(2);
  });

  it("«Обновить» при ошибке и без сети кэши не трогает", async () => {
    const h = setup({ error: new Error("net"), hasData: false, expected: null });
    await again(h);
    await act(async () => void (await h.hook.result.current.repair()));
    expect(spies.purge).not.toHaveBeenCalled();

    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const g = setup();
    await again(g);
    await act(async () => void (await g.hook.result.current.repair()));
    expect(spies.purge).not.toHaveBeenCalled();
  });

  it("поломка прошла: плашка уходит, новая поломка получает свой перезапрос", async () => {
    const h = setup();
    await again(h);
    expect(h.hook.result.current.broken).toBe(true);
    await again(h, { itemCount: 3 });
    expect(h.hook.result.current.broken).toBe(false);
    await again(h, { itemCount: 0 });
    expect(h.refetchAll).toHaveBeenCalledTimes(2);
  });
});
