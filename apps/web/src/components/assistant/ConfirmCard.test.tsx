import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssistantActionOutcome, AssistantActionView } from "@royal-home/shared";

vi.mock("../../lib/api", () => ({ refreshAccessToken: vi.fn(async () => null), api: vi.fn() }));
vi.mock("../../lib/deviceId", () => ({ getOrCreateDeviceId: () => "test-device" }));

const { AssistantActionRequestError } = await import("../../lib/assistantStream");
const { ConfirmCardController, phaseOf } = await import("./confirmCardModel");
const { ConfirmCard, ConfirmCardView } = await import("./ConfirmCard");
const { previewRows, formatPreviewValue, fieldLabel } = await import("./previewRows");

const NOW = Date.parse("2026-11-01T10:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function action(over: Partial<AssistantActionView> = {}): AssistantActionView {
  return {
    id: "a1",
    tool: "change_client_agent",
    status: "PENDING",
    preview: {
      title: "Передать клиента ПК-000042",
      was: { client: "ПК-000042", agent: "Иванов", href: "/clients/42" },
      becomes: { client: "ПК-000042", agent: "Петров" },
      risk: "Иванов перестанет видеть клиента",
    },
    expiresAt: iso(10 * 60_000),
    executedAt: null,
    undoneAt: null,
    undoUntil: null,
    result: null,
    ...over,
  };
}

const executed = (over: Partial<AssistantActionView> = {}) =>
  action({ status: "EXECUTED", executedAt: iso(0), undoUntil: iso(15 * 60_000), ...over });

/** Ручной ответ сервера: тест сам решает, когда запрос «вернулся». */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function client() {
  return {
    confirm: vi.fn<(id: string) => Promise<AssistantActionOutcome>>(),
    cancel: vi.fn<(id: string) => Promise<AssistantActionOutcome>>(),
    undo: vi.fn<(id: string) => Promise<AssistantActionOutcome>>(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("состояния карточки: ждёт → выполняется → сделано → отменено", () => {
  it("полный путь с откатом", async () => {
    const api = client();
    const c = new ConfirmCardController(action(), api);
    expect(c.getState().phase).toBe("pending");

    const confirmed = deferred<AssistantActionOutcome>();
    api.confirm.mockReturnValue(confirmed.promise);
    const pressing = c.confirm();
    expect(c.getState().phase).toBe("running");
    confirmed.resolve({ action: executed(), replay: false });
    await pressing;
    expect(c.getState()).toMatchObject({ phase: "done", canUndo: true });

    api.undo.mockResolvedValue({ action: executed({ status: "UNDONE", undoneAt: iso(1000) }), replay: false });
    await c.undo();
    expect(c.getState().phase).toBe("undone");
    expect(c.getState().canUndo).toBe(false);
  });

  it("двойное нажатие «Подтвердить» шлёт один запрос", async () => {
    const api = client();
    const c = new ConfirmCardController(action(), api);
    const confirmed = deferred<AssistantActionOutcome>();
    api.confirm.mockReturnValue(confirmed.promise);
    const first = c.confirm();
    const second = c.confirm();
    void c.cancel(); // во время запроса и «Отмена» не уходит
    confirmed.resolve({ action: executed(), replay: false });
    await Promise.all([first, second]);
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("«Отмена» до исполнения", async () => {
    const api = client();
    api.cancel.mockResolvedValue({ action: action({ status: "CANCELLED" }), replay: false });
    const c = new ConfirmCardController(action(), api);
    await c.cancel();
    expect(c.getState().phase).toBe("cancelled");
    expect(api.confirm).not.toHaveBeenCalled();
  });
});

describe("необратимое действие", () => {
  const irreversible = () => action({ preview: { ...action().preview, irreversible: true } });

  it("первое нажатие только взводит «Да, безвозвратно», запрос — со второго", async () => {
    const api = client();
    api.confirm.mockResolvedValue({ action: executed({ undoUntil: null }), replay: false });
    const c = new ConfirmCardController(irreversible(), api);
    await c.confirm();
    expect(c.getState().phase).toBe("arming");
    expect(api.confirm).not.toHaveBeenCalled();
    await c.confirm();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(c.getState()).toMatchObject({ phase: "done", canUndo: false });
  });

  it("«Назад» из «Да, безвозвратно» возвращает к выбору без запроса", async () => {
    const api = client();
    const c = new ConfirmCardController(irreversible(), api);
    await c.confirm();
    await c.cancel();
    expect(c.getState().phase).toBe("pending");
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("разметка: красная плашка, чип «Необратимо», вторая кнопка", () => {
    const c = new ConfirmCardController(irreversible(), client());
    const pending = renderToStaticMarkup(<ConfirmCardView state={c.getState()} layout="columns" onConfirm={() => {}} onCancel={() => {}} onUndo={() => {}} />);
    expect(pending).toContain("Необратимо");
    expect(pending).toContain("Подтвердить");
    expect(pending).not.toContain("Да, безвозвратно");
    void c.confirm();
    const arming = renderToStaticMarkup(<ConfirmCardView state={c.getState()} layout="columns" onConfirm={() => {}} onCancel={() => {}} onUndo={() => {}} />);
    expect(arming).toContain("Да, безвозвратно");
    expect(arming).toContain("Назад");
  });
});

describe("окно отката и срок подтверждения", () => {
  it("кнопка «Отменить» исчезает сама в момент undoUntil", () => {
    const c = new ConfirmCardController(executed({ undoUntil: iso(15_000) }), client());
    const seen: boolean[] = [];
    c.subscribe(() => seen.push(c.getState().canUndo));
    c.start();
    expect(c.getState().canUndo).toBe(true);
    vi.advanceTimersByTime(14_000);
    expect(c.getState().canUndo).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(c.getState().canUndo).toBe(false);
    expect(seen).toContain(false);
    const html = renderToStaticMarkup(<ConfirmCardView state={c.getState()} layout="rows" onConfirm={() => {}} onCancel={() => {}} onUndo={() => {}} />);
    expect(html).toContain("Сделано");
    expect(html).not.toContain("Отменить");
    c.stop();
  });

  it("срок подтверждения вышел — «Время вышло», кнопок нет", () => {
    const c = new ConfirmCardController(action({ expiresAt: iso(5_000) }), client());
    c.start();
    vi.advanceTimersByTime(5_000);
    expect(c.getState().phase).toBe("expired");
    const html = renderToStaticMarkup(<ConfirmCardView state={c.getState()} layout="rows" onConfirm={() => {}} onCancel={() => {}} onUndo={() => {}} />);
    expect(html).toContain("Время вышло");
    expect(html).not.toContain("Подтвердить");
    c.stop();
  });

  it("phaseOf: просроченное PENDING уже при показе — истекло", () => {
    expect(phaseOf(action({ expiresAt: iso(-1) }), NOW)).toBe("expired");
    expect(phaseOf(action({ status: "CONFIRMED" }), NOW)).toBe("running");
  });
});

describe("ошибки сервера", () => {
  const err = (status: number, code: string | null, fresh: AssistantActionView | null = null) =>
    new AssistantActionRequestError("сервер", status, code, fresh);

  it("409 STALE с новым превью — карточка показывает новое и снова ждёт", async () => {
    const api = client();
    const fresh = action({ id: "a2", preview: { title: "Передать клиента", was: { agent: "Сидоров" }, becomes: { agent: "Петров" } } });
    api.confirm.mockRejectedValue(err(409, "STALE", fresh));
    const c = new ConfirmCardController(action(), api);
    await c.confirm();
    expect(c.getState()).toMatchObject({ phase: "pending", action: { id: "a2" } });
    expect(c.getState().notice?.text).toMatch(/Данные изменились/);
  });

  it("409 STALE без превью — «попросите заново», 410 — «Время вышло», 403 — «Нет доступа»", async () => {
    const cases: Array<[InstanceType<typeof AssistantActionRequestError>, string, string]> = [
      [err(409, "STALE"), "failed", "Данные изменились — попросите заново"],
      [err(410, "EXPIRED"), "expired", "Время вышло"],
      [err(403, "FORBIDDEN"), "failed", "Нет доступа"],
    ];
    for (const [e, phase, text] of cases) {
      const api = client();
      api.confirm.mockRejectedValue(e);
      const c = new ConfirmCardController(action(), api);
      await c.confirm();
      expect(c.getState().phase).toBe(phase);
      expect(c.getState().notice?.text).toContain(text);
      const html = renderToStaticMarkup(<ConfirmCardView state={c.getState()} layout="columns" onConfirm={() => {}} onCancel={() => {}} onUndo={() => {}} />);
      expect(html).toContain(text);
      expect(html).not.toContain("Подтвердить");
    }
  });

  it("сеть упала — снова «Подтвердить», можно нажать ещё раз", async () => {
    const api = client();
    api.confirm.mockRejectedValueOnce(err(0, null)).mockResolvedValueOnce({ action: executed(), replay: false });
    const c = new ConfirmCardController(action(), api);
    await c.confirm();
    expect(c.getState().phase).toBe("pending");
    await c.confirm();
    expect(c.getState().phase).toBe("done");
  });

  it("откат: окно вышло на сервере — кнопка больше не показывается", async () => {
    const api = client();
    api.undo.mockRejectedValue(err(410, "UNDO_WINDOW_PASSED"));
    const c = new ConfirmCardController(executed(), api);
    await c.undo();
    expect(c.getState()).toMatchObject({ phase: "done", canUndo: false });
    expect(c.getState().notice?.text).toBe("Время на отмену вышло");
  });
});

describe("разметка", () => {
  it("ПК: две колонки «Было / Станет», изменённое подсвечено, служебная ссылка скрыта, без HTML из данных", () => {
    const evil = action({ preview: { title: "Тест", was: { agent: "<img src=x onerror=alert(1)>" }, becomes: { agent: "Петров" } } });
    const html = renderToStaticMarkup(<ConfirmCard action={evil} layout="columns" />);
    expect(html).toContain("Было");
    expect(html).toContain("Станет");
    expect(html).toContain("<mark");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("телефон: строками, подпись поля по словарю, кнопки ≥ 44 px, aria-live на состоянии", () => {
    const html = renderToStaticMarkup(<ConfirmCard action={action()} layout="rows" />);
    expect(html).toContain("Агент");
    expect(html).toContain("Станет:");
    expect(html).not.toContain("/clients/42");
    expect(html).toContain("min-height:44px");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Иванов перестанет видеть клиента");
  });

  it("«Сделано · Отменить» у исполненного (уровень B пришёл сразу EXECUTED)", () => {
    const html = renderToStaticMarkup(<ConfirmCard action={executed()} layout="columns" />);
    expect(html).toContain("Сделано");
    expect(html).toContain("Отменить");
    expect(html).not.toContain("Подтвердить");
  });
});

describe("было/станет", () => {
  it("незнакомый ключ — как есть, контекст не подсвечен, новое поле — «—» → значение", () => {
    const rows = previewRows({ was: { Объект: "ОБ-1", price: 100 }, becomes: { price: 90, Заявка: "уйдёт" } });
    expect(rows.map((r) => [r.label, r.was, r.becomes, r.changed])).toEqual([
      ["Объект", "ОБ-1", "ОБ-1", false],
      ["Цена", "100", "90", true],
      ["Заявка", "—", "уйдёт", true],
    ]);
    expect(fieldLabel("somethingNew")).toBe("somethingNew");
    expect(formatPreviewValue(true)).toBe("да");
    expect(formatPreviewValue(null)).toBe("—");
    expect(formatPreviewValue(["a", null, "b"])).toBe("a, b");
  });
});
