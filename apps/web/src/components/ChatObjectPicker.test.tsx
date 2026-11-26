// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), api: h.api }));
vi.mock("../store/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/auth")>();
  const useAuthStore = Object.assign(
    <T,>(select: (state: { agent: { id: string } | null }) => T) => select({ agent: { id: "agent-1" } }),
    actual.useAuthStore
  );
  return { ...actual, useAuthStore };
});

import { ApiError } from "../lib/api";
import { toast } from "../store/toast";
import { ChatObjectPicker } from "./ChatObjectPicker";

/**
 * Шторка «Объект» в чате (26.11.2026): открывается без карточки клиента, мультивыбор, «уже
 * отправляли», проданное не выбирается, «что получит клиент» и «куда уйдёт», ошибка простыми словами.
 */

const CONVERSATION = "conv-1";
const property = (id: string, shortId: number, over: Record<string, unknown> = {}) => ({
  id, shortId, title: `Секретное название ${shortId}`, type: "APARTMENT", rooms: 2, areaSqm: "64", floor: 4, totalFloors: 9,
  price: "650000", currency: "TJS", status: "AVAILABLE", district: { name: "Шохмансур" }, photos: [{ url: "/uploads/a.webp", thumbUrl: "/uploads/a.webp" }], ...over,
});
const PAGE = { items: [property("p1", 101), property("p2", 102), property("p3", 103, { status: "SOLD" })], total: 3, page: 1, pageSize: 20 };

function context(over: Record<string, unknown> = {}) {
  return {
    hasCard: false, clientId: null, allowed: true, deniedReason: null, channel: "WHATSAPP", channelEnabled: true, windowOpen: true,
    lastClientMessageAt: null, photosSupported: true, hint: "Уйдёт в WhatsApp: карточка со ссылкой и фото.",
    sentPropertyIds: ["p2"], draft: { rooms: 2, districtName: "Шохмансур" }, ...over,
  };
}

/** jsdom не знает matchMedia: отдаём простую версию по ширине окна (max-width / min-width). */
function stubMatchMedia() {
  window.matchMedia = ((query: string) => {
    const max = /max-width:s*(d+)px/.exec(query);
    const min = /min-width:s*(d+)px/.exec(query);
    const matches = (max ? window.innerWidth <= Number(max[1]) : true) && (min ? window.innerWidth >= Number(min[1]) : true);
    return { matches, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

let ctx = context();
let sendResult: unknown = { ok: true, sent: 2, propertyIds: ["p1", "p2"], masked: false, pausedUntil: null, channel: "WHATSAPP", hasCard: false, photos: { queued: 2, jobIds: ["j1", "j2"], skipped: 0, note: null } };
let sendError: Error | null = null;

beforeEach(() => {
  stubMatchMedia();
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  ctx = context();
  sendError = null;
  h.api.mockReset();
  h.api.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path.startsWith(`/conversations/${CONVERSATION}/send-context`)) return ctx;
    if (path.startsWith("/properties")) return PAGE;
    if (options?.method === "POST" && path.endsWith("/send-properties")) {
      if (sendError) throw sendError;
      return sendResult;
    }
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(cleanup);

function mount(props: Partial<React.ComponentProps<typeof ChatObjectPicker>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onOpenChange = vi.fn();
  const onSent = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ChatObjectPicker conversationId={CONVERSATION} open onOpenChange={onOpenChange} hideTrigger onSent={onSent} {...props} />
    </QueryClientProvider>
  );
  return { onOpenChange, onSent };
}

describe("ChatObjectPicker", () => {
  it("открывается сразу со скелетоном и не просит карточку клиента", async () => {
    mount();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getAllByTestId("object-picker-skeleton").length).toBeGreaterThan(0);
    await screen.findAllByTestId("object-picker-row");
    const paths = h.api.mock.calls.map((c) => String(c[0]));
    expect(paths.some((p) => p.startsWith("/clients/"))).toBe(false);
  });

  it("без карточки: вкладка «Рекомендуем клиенту» строится из того, что собрал бот", async () => {
    mount();
    await screen.findAllByTestId("object-picker-row");
    expect(screen.getByRole("tab", { name: "Рекомендуем клиенту" }).getAttribute("aria-selected")).toBe("true");
    const listCall = h.api.mock.calls.map((c) => String(c[0])).find((p) => p.startsWith("/properties"));
    expect(listCall).toContain("rooms=2");
  });

  it("нечего подбирать (нет карточки и черновика бота) — вкладка «Рекомендуем» скрыта", async () => {
    ctx = context({ draft: null });
    mount();
    await screen.findAllByTestId("object-picker-row");
    expect(screen.queryByRole("tab", { name: "Рекомендуем клиенту" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Мои" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Все" })).toBeTruthy();
  });

  it("карточка объекта: цена, комнаты, район, «уже отправляли»; проданный нельзя выбрать", async () => {
    mount();
    const rows = await screen.findAllByTestId("object-picker-row");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("650");
    expect(rows[0].textContent).toContain("2к");
    expect(rows[0].textContent).toContain("Шохмансур");
    expect(rows[1].textContent).toContain("Уже отправляли");
    expect(rows[0].textContent).not.toContain("Уже отправляли");
    expect((rows[2] as HTMLButtonElement).disabled).toBe(true);
  });

  it("мультивыбор и «Отправить (N)»: уходит один запрос со всеми объектами, шторка закрывается, фото-задания переданы чату", async () => {
    const { onOpenChange, onSent } = mount({ pauseMinutes: 60 });
    const rows = await screen.findAllByTestId("object-picker-row");
    const send = screen.getByTestId("object-picker-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(rows[0]);
    fireEvent.click(rows[1]);
    expect(rows[0].getAttribute("aria-checked")).toBe("true");
    expect(send.textContent).toContain("Отправить (2)");
    const success = vi.spyOn(toast, "success").mockImplementation(() => undefined as never);
    fireEvent.click(send);
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    const call = h.api.mock.calls.find((c) => String(c[0]).endsWith("/send-properties"))!;
    const body = (call[1] as { body: { propertyIds: string[]; pausedUntil?: string } }).body;
    expect(body.propertyIds).toEqual(["p1", "p2"]);
    expect(Date.parse(body.pausedUntil!)).toBeGreaterThan(Date.now());
    expect((onSent.mock.calls[0][0] as { photos: { jobIds: string[] } }).photos.jobIds).toEqual(["j1", "j2"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(success).toHaveBeenCalledWith(expect.stringContaining("фото уходят"));
    success.mockRestore();
  });

  it("подсказка: что получит клиент и куда уйдёт; закрытое окно 24 ч — предупреждение", async () => {
    mount();
    await screen.findAllByTestId("object-picker-row");
    const hint = screen.getByTestId("object-picker-hint");
    expect(hint.textContent).toContain("Клиент получит: карточку, фото и личную ссылку");
    expect(hint.textContent).toContain("WhatsApp");
    cleanup();
    ctx = context({ windowOpen: false, hint: "Клиент не писал в WhatsApp больше суток, Meta не пропустит сообщение." });
    mount();
    await screen.findAllByTestId("object-picker-row");
    const warn = screen.getByTestId("object-picker-hint");
    expect(warn.className).toContain("warn");
    expect(warn.textContent).toContain("больше суток");
  });

  it("отказ сервера простыми словами, с кнопкой «скопировать текст со ссылками»", async () => {
    sendError = new ApiError("Клиент не писал больше суток, Meta не пропустит сообщение.", 409, { code: "window_closed", fallback: { text: "Посмотрите объект: ссылка" } });
    const { onSent } = mount();
    const rows = await screen.findAllByTestId("object-picker-row");
    fireEvent.click(rows[0]);
    fireEvent.click(screen.getByTestId("object-picker-send"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("больше суток");
    expect(alert.textContent).toContain("Скопировать текст со ссылками");
    expect(onSent).not.toHaveBeenCalled();
  });

  it("рубильник выключен и карточки нет: прежний отказ показан, отправить нельзя", async () => {
    ctx = context({ allowed: false, deniedReason: "Сначала примите заявку: у этого диалога ещё нет карточки клиента" });
    mount();
    await screen.findAllByTestId("object-picker-row");
    expect(screen.getByRole("alert").textContent).toContain("примите заявку");
    fireEvent.click(screen.getAllByTestId("object-picker-row")[0]);
    expect((screen.getByTestId("object-picker-send") as HTMLButtonElement).disabled).toBe(true);
  });

  for (const width of [390, 1440]) {
    it(`та же шторка на ${width}px: вкладки, поиск, список, кнопка`, async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      window.dispatchEvent(new Event("resize"));
      mount();
      await screen.findAllByTestId("object-picker-row");
      expect(screen.getAllByRole("tab").length).toBeGreaterThanOrEqual(2);
      expect(screen.getByLabelText("Поиск объекта")).toBeTruthy();
      expect(screen.getByTestId("object-picker-send")).toBeTruthy();
    });
  }
});
