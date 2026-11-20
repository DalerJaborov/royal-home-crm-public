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
 *  1) из окна ушло лишнее: состояние и пауза бота, срок паузы, «Верно/Неверно»
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
      id: conversationId, name: "Продавец ПР-000894", profileName: null, channel: "INSTAGRAM", clientId: "client", clientShortId: "7",
      clientPhone: "+992900000099", firstContactAt: now, pausedUntil: h.pausedUntil, shieldPause: null, contact: null, subscriberId: "peer",
      messages: [
        { role: "user", content: `Квартира ещё продаётся? Мой номер ${MESSAGE_PHONE_MASK}`, at: now },
        { role: "assistant", content: "Да, могу прислать фото", at: now, by: { kind: "bot" }, deliveryStatus: "read" },
        { role: "assistant", content: "Добрый день, это Азиз", at: now, by: { kind: "agent", agentId: "a", agentName: "Азиз" }, deliveryStatus: "delivered" },
        { role: "assistant", content: "Отправляю адрес", by: { kind: "manual" } },
      ],
    }, isLoading: false, refetch: h.mutation }),
    useGroupedConversation: () => ({ data: h.grouped, isLoading: false, isError: false, error: null, refetch: h.mutation }),
    useReplyToConversation: (id: string | null) => { h.replyTarget = id; return mutation(); },
    useSendVoiceMessage: mutation, useResumeConversationBot: mutation,
    usePauseConversationBot: mutation, useUploadConversationMediaWithProgress: () => ({ start: h.mutation, retry: h.mutation, cancel: h.mutation }),
    useReplyFeedback: mutation,
    isWindowClosedError: () => false,
  };
});
vi.mock("../../components/CallClientButton", () => ({ CallClientButton: () => createElement("button", null, "Позвонить") }));
vi.mock("../../components/VoiceRecordButton", () => ({ VoiceRecordButton: () => createElement("button", { title: "Записать голосовое" }, "Голосовое") }));
vi.mock("../../components/ChatPropertySend", () => ({ ChatPropertySend: ({ open }: { open?: boolean }) => (open ? createElement("div", null, "Окно подбора") : null) }));
vi.mock("../../hooks/useContactProfile", () => ({ useSetContactCategory: () => ({ mutate: h.mutation, isPending: false, isError: false }) }));
import { ConversationView } from "../Messages";

function tree(id: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["customer-requests", conversationId, "actor"], []);
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
});
const click = (el: Element | null | undefined) => { expect(el, "кнопка на месте").toBeTruthy(); act(() => (el as HTMLElement).click()); };
const byLabel = (label: string) => document.querySelector(`[aria-label="${label}"]`);
const menuText = () => [...document.querySelectorAll('[role="menu"]')].map((m) => m.textContent).join(" | ");
const item = (role: string, text: string) => [...document.querySelectorAll(`[role="${role}"]`)].find((b) => b.textContent?.includes(text));
const bubble = (text: string) => [...document.querySelectorAll("[data-chat-message]")].find((b) => b.textContent?.includes(text));
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
      "Бессрочно", "Верно", "Неверно", "Выберите канал", "Время сообщения неизвестно", "ry-chat-quick", "seller-object-strip"]) {
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

  it("one round button: microphone while empty, «send» once there is text — and the reply carries no pause term", () => {
    h.perms = AGENT;
    mount();
    expect(byLabel("Отправить")).toBeNull();
    expect(document.querySelector('[title="Записать голосовое"]')).toBeTruthy();
    type(byLabel("Текст ответа") as HTMLTextAreaElement, "Здравствуйте");
    expect(document.querySelector('[title="Записать голосовое"]')).toBeNull();
    h.mutation.mockResolvedValue({ ok: true });
    click(byLabel("Отправить"));
    expect(h.mutation).toHaveBeenCalledWith({ text: "Здравствуйте" });
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

  it("message details: who answered and delivery for everyone, bot rating only for the director", () => {
    h.perms = AGENT;
    mount();
    click(bubble("Да, могу прислать фото")?.querySelector('[aria-label="Сведения о сообщении"]'));
    let sheet = document.body.textContent ?? "";
    expect(sheet).toContain("Сведения о сообщении");
    expect(sheet).toContain("Отправил");
    expect(sheet).toContain("Прочитано");
    expect(sheet).not.toContain("Верно");
    unmount();
    h.perms = DIRECTOR;
    mount();
    click(bubble("Да, могу прислать фото")?.querySelector('[aria-label="Сведения о сообщении"]'));
    sheet = document.body.textContent ?? "";
    expect(sheet).toContain("Верно");
    expect(sheet).toContain("Неверно");
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
    expect(html).not.toContain("<select");
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
