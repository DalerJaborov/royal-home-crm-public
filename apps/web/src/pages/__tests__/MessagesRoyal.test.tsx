// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import * as ReactDomClient from "react-dom/client";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_PHONE_MASK } from "@royal-home/shared";

/**
 * «Новый вид» раздела «Чаты» — окно переписки «как в WhatsApp» (владелец
 * 20.11.2026). Сторож двух вещей сразу:
 *  1) из окна ушло лишнее: состояние и пауза бота, «Верно/Неверно»
 *     под пузырями, метка «бот», выбор канала строкой, «Позвонить» без номера;
 *  2) ничего не потерялось: ответ, вложение, объект, голос, звонок, поиск,
 *     карточка, канал ответа, пауза бота и оценка ответов — у руководства в «⋯»
 *     и в «Сведениях о сообщении».
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom не умеет прокрутку — лента зовёт её при открытии переписки.
if (typeof Element !== "undefined") {
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  // Шторка смотрит на ширину экрана через matchMedia — jsdom его не знает.
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
}

const conversationId = "00000000-0000-4000-8000-000000000002";
const instagramSource = "00000000-0000-4000-8000-000000000003";
const now = new Date().toISOString();
const AGENT = new Set(["messages.viewOwn"]);
const DIRECTOR = new Set(["messages.view", "settings.manage"]);
const h = vi.hoisted(() => ({
  readOnly: false, narrow: false, mutation: vi.fn(), pausedUntil: null as string | null, grouped: null as unknown,
  perms: new Set<string>(), replyTarget: undefined as string | null | undefined,
  pauseIds: null as unknown, messages: null as unknown[] | null, api: vi.fn(), requests: [] as unknown[], noCard: false,
}));
vi.mock("../../lib/permissions", () => ({ useCan: () => (p: string) => h.perms.has(p), useIsReadOnly: () => h.readOnly }));
vi.mock("../../store/auth", () => ({ useAuthStore: Object.assign((select: (state: unknown) => unknown) => select({ agent: { id: "actor", role: h.readOnly ? "SHAREHOLDER" : "MANAGER" }, sessionEpoch: 1 }), { getState: () => ({ agent: { id: "actor" }, sessionEpoch: 1 }), subscribe: () => () => {} }) }));
vi.mock("../../hooks/useNarrowScreen", () => ({ useNarrowScreen: () => h.narrow }));
vi.mock("../../hooks/useSellerObject", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../hooks/useSellerObject")>()), useSellerObject: () => ({ data: null, isLoading: false }) }));
vi.mock("../../hooks/useCleanChatDraft", () => ({ useCleanChatDraft: () => {} }));
vi.mock("../../store/mediaUploads", () => ({ usePendingMediaUploads: () => [] }));
vi.mock("../../hooks/useConversations", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../hooks/useConversations")>();
  const mutation = () => ({ isPending: false, isError: false, error: null, mutate: h.mutation, mutateAsync: h.mutation });
  return {
    ...original,
    useConversation: () => ({ data: {
      id: conversationId, name: "Продавец ПР-000894", profileName: null, channel: "INSTAGRAM", clientId: h.noCard ? null : "client", clientShortId: h.noCard ? null : "7",
      clientPhone: "+992900000099", firstContactAt: now, pausedUntil: h.pausedUntil, shieldPause: null, contact: null, subscriberId: "peer",
      messages: h.messages ?? [
        { role: "user", content: `Квартира ещё продаётся? Мой номер ${MESSAGE_PHONE_MASK}`, at: now },
        { role: "assistant", content: "Да, могу прислать фото", at: now, by: { kind: "bot" }, deliveryStatus: "read" },
        { role: "assistant", content: "Добрый день, это Азиз", at: now, by: { kind: "agent", agentId: "a", agentName: "Азиз" }, deliveryStatus: "delivered" },
        { role: "assistant", content: "Отправляю адрес", by: { kind: "manual" } },
      ],
    }, isLoading: false, refetch: h.mutation }),
    useGroupedConversation: () => ({ data: h.grouped, isLoading: false, isError: false, error: null, refetch: h.mutation }),
    useReplyToConversation: (id: string | null) => { h.replyTarget = id; return mutation(); },
    useSendVoiceMessage: mutation, useResumeConversationBot: mutation,
    usePauseConversationBot: (ids: unknown) => { h.pauseIds = ids; return mutation(); }, useUploadConversationMediaWithProgress: () => ({ start: h.mutation, retry: h.mutation, cancel: h.mutation }),
    isWindowClosedError: () => false,
  };
});
vi.mock("../../components/CallClientButton", () => ({ CallClientButton: () => createElement("button", null, "Позвонить") }));
// Подмена кнопки голоса умеет «начать запись»: так проверяется, что набор текста
// во время записи не подменяет её на «Отправить» (ревью #332).
vi.mock("../../components/VoiceRecordButton", () => ({ VoiceRecordButton: ({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) =>
  createElement("button", { title: "Записать голосовое", onClick: () => onBusyChange?.(true) }, "Голосовое") }));
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), api: h.api }));
vi.mock("../../components/ChatObjectPicker", () => ({ ChatObjectPicker: ({ open }: { open?: boolean }) => (open ? createElement("div", null, "Окно подбора") : null) }));
vi.mock("../../hooks/useContactProfile", () => ({ useSetContactCategory: () => ({ mutate: h.mutation, isPending: false, isError: false }) }));
import { ConversationView } from "../Messages";

function tree(id: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["customer-requests", conversationId, "actor"], h.requests);
  client.setQueryData(["customer-requests", instagramSource, "actor"], []);
  return createElement(QueryClientProvider, { client },
    createElement(MemoryRouter, null, createElement(ConversationView, { id, onBack: () => {}, clean: true, royal: true })) as ReactNode);
}
const markup = (id = conversationId) => renderMarkup(tree(id));

let root: ReactDomClient.Root | null = null;
let host: HTMLDivElement | null = null;
function mount(id = conversationId) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = ReactDomClient.createRoot(host);
  currentId = id;
  act(() => root!.render(tree(id)));
  return host;
}
function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null; host = null;
  document.body.innerHTML = "";
}
afterEach(() => {
  unmount();
  h.readOnly = false; h.narrow = false; h.pausedUntil = null; h.grouped = null; h.perms = new Set(); h.mutation.mockReset();
  h.pauseIds = null; h.messages = null; h.api.mockReset(); h.requests = []; h.noCard = false;
});
const click = (el: Element | null | undefined) => { expect(el, "кнопка на месте").toBeTruthy(); act(() => (el as HTMLElement).click()); };
const byLabel = (label: string) => document.querySelector(`[aria-label="${label}"]`);
const menuText = () => [...document.querySelectorAll('[role="menu"]')].map((m) => m.textContent).join(" | ");
const item = (role: string, text: string) => [...document.querySelectorAll(`[role="${role}"]`)].find((b) => b.textContent?.includes(text));
const bubble = (text: string) => [...document.querySelectorAll("[data-chat-message]")].find((b) => b.textContent?.includes(text));
let currentId = conversationId;
function rerender() { act(() => root!.render(tree(currentId))); }
function type(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => { setter.call(textarea, value); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
}

describe("Чаты в новом виде: окно как в WhatsApp", () => {
  it("agent: nothing about the bot, no rating, no card code, no call-without-number in a bubble", () => {
    h.perms = AGENT;
    const html = markup();
    const head = html.slice(html.indexOf('class="ry-chat-head"'), html.indexOf("clean-conversation-workspace"));
    expect(head).toContain("Продавец из Instagram");
    expect(head).not.toContain("ПР-000894");
    expect(head).not.toContain("<small");
    for (const gone of ["Бот на паузе", "Отвечает бот", "Ведёте вы", "Поставить на паузу", "Вернуть боту", "Ответ ставит бота на паузу",
      "Верно", "Неверно", "Выберите канал", "Время сообщения неизвестно", "ry-chat-quick", "seller-object-strip"]) {
      expect(html, gone).not.toContain(gone);
    }
    const thread = html.slice(html.indexOf('class="thread"'), html.indexOf("ry-chat-compose"));
    expect(thread).not.toContain("Позвонить");
    expect(thread).toContain("номер скрыт");
    // Бот, сотрудник и «вручную» — одинаковые пузыри справа, без подписи отправителя.
    expect(thread.match(/class="bub me[ "]/g)?.length).toBe(3);
    expect(thread).not.toContain('class="who"');
    // Хвостик — у последней реплики группы; галочки — только у наших и только со статусом.
    expect(thread.match(/ry-tail/g)?.length).toBe(2);
    expect(thread.match(/data-status=/g)?.length).toBe(2);
  });

  it("keeps every action: reply, attach, voice, call, «⋯», message details", () => {
    h.perms = AGENT;
    const html = markup();
    for (const label of ['aria-label="Текст ответа"', 'aria-label="Прикрепить"', "Голосовое", "Позвонить", 'aria-label="Ещё"', 'aria-label="Сведения о сообщении"']) {
      expect(html, label).toContain(label);
    }
    expect(h.mutation).not.toHaveBeenCalled();
  });

  it("one round button: microphone while empty, «send» once there is text — the reply carries the pause, one hour by default", () => {
    h.perms = AGENT;
    mount();
    expect(byLabel("Отправить")).toBeNull();
    expect(document.querySelector('[title="Записать голосовое"]')).toBeTruthy();
    type(byLabel("Текст ответа") as HTMLTextAreaElement, "Здравствуйте");
    expect(document.querySelector('[title="Записать голосовое"]')).toBeNull();
    h.mutation.mockResolvedValue({ ok: true });
    click(byLabel("Отправить"));
    // Ревью #332: без срока сервер дал бы директору/чужому агенту 10 минут, и бот писал бы поверх человека.
    // Владелец 26.11.2026: по умолчанию ЧАС, а не «бессрочно».
    const body = h.mutation.mock.calls[0][0] as { text: string; pausedUntil?: string };
    expect(body.text).toBe("Здравствуйте");
    const minutes = (Date.parse(body.pausedUntil ?? "") - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(59);
    expect(minutes).toBeLessThan(61);
  });

  describe("срок паузы бота при ответе (владелец 26.11.2026)", () => {
    const pauseSelect = () => byLabel("На сколько бот замолкает после вашего ответа") as HTMLSelectElement | null;
    function choose(select: HTMLSelectElement, label: string) {
      const index = [...select.options].findIndex((o) => o.textContent === label);
      expect(index, `вариант «${label}»`).toBeGreaterThanOrEqual(0);
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      act(() => { setter.call(select, String(index)); select.dispatchEvent(new Event("change", { bubbles: true })); });
    }
    const sendText = (value: string) => {
      type(byLabel("Текст ответа") as HTMLTextAreaElement, value);
      click(byLabel("Отправить"));
      return h.mutation.mock.calls.at(-1)![0] as { pausedUntil?: string };
    };
    const minutesOf = (iso?: string) => Math.round((Date.parse(iso ?? "") - Date.now()) / 60_000);
    afterEach(() => { try { window.localStorage.clear(); } catch { /* нет хранилища */ } });

    it("виден в новом виде и на ПК, и на узком экране; час выбран, «Бессрочно» последним", () => {
      h.perms = AGENT;
      for (const narrow of [false, true]) {
        h.narrow = narrow;
        mount();
        const select = pauseSelect();
        expect(select, narrow ? "телефон" : "ПК").toBeTruthy();
        expect(select!.options[select!.selectedIndex].textContent).toBe("1 час");
        expect([...select!.options].at(-1)!.textContent).toBe("Бессрочно");
        expect(document.querySelector('label[for="chat-reply-pause-select"]')?.textContent).toBe("Бот молчит:");
        unmount();
      }
    });

    it("выбранный срок уходит с текстом и помнится при следующем открытии", () => {
      h.perms = AGENT;
      mount();
      h.mutation.mockResolvedValue({ ok: true });
      choose(pauseSelect()!, "2 часа");
      expect(minutesOf(sendText("Привет").pausedUntil)).toBe(120);
      unmount();
      mount();
      expect(pauseSelect()!.options[pauseSelect()!.selectedIndex].textContent).toBe("2 часа");
      choose(pauseSelect()!, "Бессрочно");
      expect(minutesOf(sendText("Ещё").pausedUntil)).toBeGreaterThan(5 * 365 * 24 * 60);
    });

    it("хранилище закрыто — страница работает, час по умолчанию", () => {
      h.perms = AGENT;
      const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
      const setSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
      try {
        mount();
        expect(pauseSelect()!.options[pauseSelect()!.selectedIndex].textContent).toBe("1 час");
        expect(() => choose(pauseSelect()!, "30 минут")).not.toThrow();
      } finally { spy.mockRestore(); setSpy.mockRestore(); }
    });

    it("тот же срок получают фото/видео: третий аргумент старта загрузки", async () => {
      h.perms = AGENT;
      const file = new File(["x"], "a.jpg", { type: "image/jpeg" });
      mount();
      choose(pauseSelect()!, "30 минут");
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      act(() => { input.dispatchEvent(new Event("change", { bubbles: true })); });
      click([...document.querySelectorAll("button")].find((b) => b.textContent === "Отправить"));
      const call = h.mutation.mock.calls.at(-1)!;
      expect(call[2]).toBe(30);
    });

    it("нет строки у переписки только для чтения (общий чат без каналов ответа)", () => {
      h.perms = DIRECTOR;
      h.grouped = { id: "client:client", sources: [{ id: "td_1", channel: "TELEGRAM_DIRECT", canReply: false, pausedUntil: null }], messages: [] };
      const html = markup("client:client");
      expect(html).not.toContain("chat-reply-pause");
    });
  });

  it("typing during a voice recording keeps the recording: the button stays and the field is locked", () => {
    h.perms = AGENT;
    mount();
    click(document.querySelector('[title="Записать голосовое"]'));
    const field = byLabel("Текст ответа") as HTMLTextAreaElement;
    expect(field.readOnly).toBe(true);
    type(field, "буква");
    expect(document.querySelector('[title="Записать голосовое"]')).toBeTruthy();
    expect(byLabel("Отправить")).toBeNull();
  });

  it("«/» with the quick replies open is not sent by Enter", () => {
    h.perms = AGENT;
    mount();
    const field = byLabel("Текст ответа") as HTMLTextAreaElement;
    type(field, "/");
    expect(menuText()).toContain("Быстрые ответы");
    act(() => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(h.mutation).not.toHaveBeenCalled();
  });

  it("grouping follows the next VISIBLE message: an empty service record does not break the client's group", () => {
    h.perms = AGENT;
    h.messages = [
      { role: "user", content: "Первое", at: now },
      { role: "assistant", content: "", at: now, by: { kind: "bot" } },
      { role: "user", content: "Второе", at: now },
    ];
    const thread = markup();
    expect(thread.match(/ry-tail/g)?.length).toBe(1);
    expect(thread.match(/ry-cont/g)?.length).toBe(1);
  });

  it("the client's request line: «Закрыть» asks first", async () => {
    h.perms = AGENT;
    h.requests = [{ id: "rq1", conversationId, requestKind: "HUMAN", lifecycleStatus: "QUEUED", lifecycleRevision: "r1", topic: "Хочет поговорить", requestedAt: now, assignedAgentId: null }];
    h.api.mockResolvedValue({ ok: true });
    mount();
    const line = document.querySelector(".ry-service")!;
    expect(line.textContent).toContain("Клиент ждёт сотрудника");
    click([...line.querySelectorAll("button")].find((b) => b.textContent === "Закрыть"));
    expect(h.api).not.toHaveBeenCalled();
    expect(document.querySelector(".ry-service")!.textContent).toContain("Закрыть запрос?");
    click([...document.querySelectorAll(".ry-service button")].find((b) => b.textContent === "Да, закрыть"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(h.api).toHaveBeenCalledWith("/me/callback-requests/rq1/transition", expect.objectContaining({ body: expect.objectContaining({ action: "close" }) }));
  });

  it("attach menu: photo, object from the base and quick replies; «/» opens it too", () => {
    h.perms = AGENT;
    mount();
    click(byLabel("Прикрепить"));
    const menu = menuText();
    expect(menu).toContain("Фото или видео");
    expect(menu).toContain("Объект из базы");
    expect(menu).toContain("Отправляю адрес");
    expect(menu).not.toContain("Да, могу прислать фото");
    click(item("menuitem", "Объект из базы"));
    expect(document.body.textContent).toContain("Окно подбора");
    expect(menuText()).toBe("");
    type(byLabel("Текст ответа") as HTMLTextAreaElement, "/");
    expect(menuText()).toContain("Быстрые ответы");
  });

  // «Объект» — пункт меню скрепки (владелец 26.11.2026: отдельную кнопку-здание убрать, это дубль).
  it("«Объект из базы» is a paperclip menu item (no separate building button) and opens the picker", () => {
    h.perms = AGENT;
    mount();
    expect(document.querySelector('[data-testid="chat-send-property"]'), "отдельной кнопки-здания нет").toBeNull();
    expect(document.body.textContent).not.toContain("Окно подбора");
    click(byLabel("Прикрепить"));
    const entry = item("menuitem", "Объект из базы");
    expect(entry, "пункт в скрепке").toBeTruthy();
    expect(entry!.getAttribute("aria-disabled")).toBeNull();
    click(entry);
    expect(document.body.textContent).toContain("Окно подбора");
  });

  // Владелец 26.11.2026: «клиент должен СНАЧАЛА посмотреть объекты, а потом дать номер» — без карточки пункт активен.
  it("no client card: «Объект из базы» is active and opens the picker (no grey «примите заявку» stub)", () => {
    h.perms = AGENT; h.noCard = true;
    mount();
    click(byLabel("Прикрепить"));
    const entry = item("menuitem", "Объект из базы");
    expect(entry, "пункт в скрепке не пропал").toBeTruthy();
    expect(entry!.getAttribute("aria-disabled")).toBeNull();
    expect((entry as HTMLButtonElement).disabled).toBe(false);
    click(entry);
    expect(document.body.textContent).toContain("Окно подбора");
    expect(document.body.textContent).not.toContain("Сначала примите заявку");
    expect(document.querySelector('[data-testid="chat-send-property-hint"]')).toBeNull();
  });
  it("agent «⋯»: search, contact details, client card — and no bot control", () => {
    h.perms = AGENT;
    mount();
    click(byLabel("Ещё"));
    const menu = menuText();
    expect(menu).toContain("Найти в переписке");
    expect(menu).toContain("Сведения о контакте");
    expect(menu).toContain("Карточка клиента");
    expect(menu).not.toMatch(/бот/i);
  });

  it("director «⋯»: the bot pause lives here, with the same terms; a paused bot — «Вернуть боту»", () => {
    h.perms = DIRECTOR;
    mount();
    click(byLabel("Ещё"));
    click(item("menuitem", "Поставить бота на паузу"));
    const menu = menuText();
    expect(menu).toContain("Пауза: 2 часа");
    expect(menu).toContain("Пауза: Бессрочно");
    click(item("menuitem", "Пауза: 2 часа"));
    expect(h.mutation).toHaveBeenCalledTimes(1);
    unmount();
    h.pausedUntil = "2099-01-01T00:00:00Z";
    mount();
    click(byLabel("Ещё"));
    expect(menuText()).toContain("Вернуть боту");
  });

  it("message details: who answered and delivery for everyone; no bot rating for anyone (removed with bot training)", () => {
    for (const perms of [AGENT, DIRECTOR]) {
      h.perms = perms;
      mount();
      click(bubble("Да, могу прислать фото")?.querySelector('[aria-label="Сведения о сообщении"]'));
      const sheet = document.body.textContent ?? "";
      expect(sheet).toContain("Сведения о сообщении");
      expect(sheet).toContain("Отправил");
      expect(sheet).toContain("Прочитано");
      expect(sheet).not.toContain("Верно");
      expect(sheet).not.toContain("Неверно");
      unmount();
    }
  });

  it("right click on a bubble opens the same details", () => {
    h.perms = AGENT;
    mount();
    const target = bubble("Добрый день, это Азиз")!;
    act(() => { target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    const sheet = document.querySelector(".ry-msg-info")?.textContent ?? "";
    expect(sheet).toContain("Азиз");
    expect(sheet).toContain("Доставлено");
  });

  it("grouped history: the reply channel is chosen by itself — where the client wrote last; manual choice in «⋯»", () => {
    h.perms = AGENT;
    const msg = (role: "user" | "assistant", content: string, source: string, channel: string) => ({ role, content, at: now, sourceConversationId: source, sourceChannel: channel, by: role === "assistant" ? { kind: "agent", agentId: "a", agentName: "Азиз" } : undefined });
    h.grouped = {
      id: "client:client", clientId: "client", clientShortId: "1", name: "Клиент Нигина", profileName: null, channel: "MULTI",
      clientPhone: null, firstContactAt: now, pausedUntil: null, contact: null, subscriberId: null,
      sources: [
        { id: conversationId, channel: "WHATSAPP", canReply: true, pausedUntil: null },
        { id: instagramSource, channel: "INSTAGRAM", canReply: true, pausedUntil: null },
      ],
      messages: [msg("user", "Первое", conversationId, "WHATSAPP"), msg("user", "Второе", instagramSource, "INSTAGRAM"), msg("assistant", "Ответ", conversationId, "WHATSAPP")],
    };
    const html = markup("client:client");
    // Выбора канала строкой нет; единственный список в окне — срок паузы бота над полем ввода.
    expect(html).not.toContain('aria-label="Куда ответить"');
    expect(html.match(/<select/g)?.length).toBe(1);
    expect(html).not.toContain("Выберите канал");
    expect(html).toContain('placeholder="Сообщение в Instagram"');
    expect(h.replyTarget).toBe(instagramSource);
    mount("client:client");
    click(byLabel("Ещё"));
    expect(menuText()).toContain("Ответить через");
    click(item("menuitemradio", "WhatsApp"));
    expect((byLabel("Текст ответа") as HTMLTextAreaElement).placeholder).toBe("Сообщение в WhatsApp");
    expect(h.replyTarget).toBe(conversationId);
  });

  it("auto channel is frozen while typing and shown on the send button", () => {
    h.perms = AGENT;
    const msg = (content: string, source: string, channel: string) => ({ role: "user", content, at: now, sourceConversationId: source, sourceChannel: channel });
    const group = (messages: unknown[]) => ({
      id: "client:client", clientId: "client", clientShortId: "1", name: "Клиент Нигина", profileName: null, channel: "MULTI",
      clientPhone: null, firstContactAt: now, pausedUntil: null, contact: null, subscriberId: null,
      sources: [
        { id: conversationId, channel: "WHATSAPP", canReply: true, pausedUntil: null },
        { id: instagramSource, channel: "INSTAGRAM", canReply: true, pausedUntil: null },
      ],
      messages,
    });
    h.grouped = group([msg("Первое", conversationId, "WHATSAPP"), msg("Второе", instagramSource, "INSTAGRAM")]);
    mount("client:client");
    type(byLabel("Текст ответа") as HTMLTextAreaElement, "Добрый день");
    // Значок канала — на самой кнопке, виден и во время набора.
    expect(byLabel("Отправить в Instagram")).toBeTruthy();
    expect(document.querySelector('.ry-send-wrap [aria-label="Канал: Instagram"]')).toBeTruthy();
    // Пока агент печатает, клиент написал в WhatsApp — ответ всё равно в Instagram.
    h.grouped = group([msg("Первое", conversationId, "WHATSAPP"), msg("Второе", instagramSource, "INSTAGRAM"), msg("Третье", conversationId, "WHATSAPP")]);
    rerender();
    expect(h.replyTarget).toBe(instagramSource);
    expect(byLabel("Отправить в Instagram")).toBeTruthy();
    // Поле опустело — выбор снова сам: туда, где клиент писал последним.
    type(byLabel("Текст ответа") as HTMLTextAreaElement, "");
    expect(h.replyTarget).toBe(conversationId);
  });

  it("director in a grouped chat: the pause goes to EVERY channel of the conversation and says so", () => {
    h.perms = DIRECTOR;
    h.grouped = {
      id: "client:client", clientId: "client", clientShortId: "1", name: "Клиент Нигина", profileName: null, channel: "MULTI",
      clientPhone: null, firstContactAt: now, pausedUntil: null, contact: null, subscriberId: null,
      sources: [
        { id: conversationId, channel: "WHATSAPP", canReply: true, pausedUntil: null },
        { id: instagramSource, channel: "INSTAGRAM", canReply: true, pausedUntil: null },
        { id: "td_1", channel: "TELEGRAM_DIRECT", canReply: false, pausedUntil: null },
      ],
      messages: [{ role: "user", content: "Первое", at: now, sourceConversationId: conversationId, sourceChannel: "WHATSAPP" }],
    };
    mount("client:client");
    expect(h.pauseIds).toEqual([conversationId, instagramSource]);
    click(byLabel("Ещё"));
    click(item("menuitem", "Поставить бота на паузу во всех каналах"));
    click(item("menuitem", "Пауза: 2 часа"));
    expect(h.mutation).toHaveBeenCalledTimes(1);
  });

  it("shareholder sees history only: no composer, no bot control", () => {
    h.readOnly = true; h.perms = DIRECTOR;
    const html = markup();
    expect(html).toContain("Режим просмотра");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Вернуть боту");
    expect(html).toContain('aria-label="Ещё"');
    expect(h.mutation).not.toHaveBeenCalled();
  });

  it("back button only where the list is not beside the conversation", () => {
    h.narrow = true;
    expect(markup()).toContain("Назад к списку чатов");
    h.narrow = false;
    expect(markup()).not.toContain("Назад к списку чатов");
  });
});
