// @vitest-environment jsdom
import { act, createElement } from "react";
import * as ReactDomClient from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSegment, ConversationListItem, ConversationsPage } from "../../hooks/useConversations";

/**
 * СПИСОК ЧАТОВ (владелец 26.11.2026): «Все» первая вкладка, подгрузка при прокрутке без кнопки, вход в «Архив»,
 * кружок с фото или буквой (у безымянных метка интереса). Отрисованный список в новом виде, без сети.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../lib/permissions", () => ({ useCan: () => () => true, useIsReadOnly: () => false }));
vi.mock("../../store/auth", () => ({
  useAuthStore: Object.assign((select: (state: unknown) => unknown) => select({ agent: { id: "actor", role: "DIRECTOR" }, sessionEpoch: 1 }), {
    getState: () => ({ agent: { id: "actor" }, sessionEpoch: 1 }),
    subscribe: () => () => {},
  }),
}));
import { ConversationList } from "../Messages";

// jsdom не знает IntersectionObserver: заглушка запоминает наблюдателей, чтобы «прокрутить» вручную.
type Observed = { callback: IntersectionObserverCallback; target: Element | null; disconnected: boolean };
let observers: Observed[] = [];
class FakeObserver {
  record: Observed;
  constructor(callback: IntersectionObserverCallback) { this.record = { callback, target: null, disconnected: false }; observers.push(this.record); }
  observe(target: Element) { this.record.target = target; }
  disconnect() { this.record.disconnected = true; }
  unobserve() {}
  takeRecords() { return []; }
}
const reachEnd = () => {
  const live = observers.filter((o) => !o.disconnected && o.target);
  for (const o of live) act(() => o.callback([{ isIntersecting: true, target: o.target! } as IntersectionObserverEntry], {} as IntersectionObserver));
  return live.length;
};

const now = new Date().toISOString();
function item(over: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    id: "c1", channel: "WHATSAPP", name: "Ситора Ахмедова", clientShortId: null,
    lastMessage: { role: "user", content: "Можно завтра?", by: undefined }, lastMessageAt: now,
    paused: false, awaitingHumanSince: null, pausedSince: null, unread: false, unreadCount: 0, messagesCount: 3,
    accountId: null, accountTitle: null, agentAttentionRequestedAt: null, ...over,
  };
}
function page(items: ConversationListItem[], over: Partial<ConversationsPage> = {}): ConversationsPage {
  return {
    items, total: items.length, page: 1, pageSize: 40, channels: [], accounts: [], archiveEnabled: true,
    counts: { all: items.length, needsHuman: 0, paused: 0, mine: 0, archived: 7 },
    alerts: { longestWaitingHuman: null, pausedOverDay: { count: 0, names: [] } }, ...over,
  };
}

let root: ReactDomClient.Root | null = null;
let host: HTMLDivElement | null = null;
const spies = { onSegmentChange: vi.fn(), onLoadMore: vi.fn() };

function props(over: Partial<Parameters<typeof ConversationList>[0]> = {}): Parameters<typeof ConversationList>[0] {
  return {
    clean: true, royal: true, data: page([item()]), isLoading: false, searchInput: "", onSearchChange: () => {},
    channel: undefined, onChannelChange: () => {}, accountId: undefined, onAccountChange: () => {},
    segment: "all" as ChatSegment, onSegmentChange: spies.onSegmentChange, selectedId: null, onSelect: () => {},
    onLoadMore: spies.onLoadMore, hasMore: false, loadingMore: false, ...over,
  };
}
function mount(over: Partial<Parameters<typeof ConversationList>[0]> = {}) {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = ReactDomClient.createRoot(host);
  }
  act(() => root!.render(createElement(ConversationList, props(over))));
  return host;
}

beforeEach(() => {
  observers = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
  spies.onSegmentChange.mockReset();
  spies.onLoadMore.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null; host = null;
  document.body.innerHTML = "";
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

describe("порядок вкладок", () => {
  it("«Все» стоит первой и выбрана, затем «Ждут» и «Мои»", () => {
    const el = mount();
    const tabs = [...el.querySelectorAll('[data-segment]')].map((b) => b.getAttribute("data-segment"));
    expect(tabs).toEqual(["all", "needsHuman", "mine"]);
    expect(el.querySelector('[data-segment="all"]')?.getAttribute("aria-checked")).toBe("true");
    expect(el.querySelector('[data-segment]')?.textContent).toMatch(/^Все/);
  });
});

describe("подгрузка при прокрутке", () => {
  it("кнопки «Показать ещё» нет ни в каком состоянии", () => {
    for (const over of [{ hasMore: true }, { hasMore: true, loadingMore: true }, { hasMore: false }]) {
      const el = mount({ ...over, data: page([item()], { total: 90 }) });
      expect(el.textContent).not.toContain("Показать ещё");
    }
  });

  it("полоска в конце списка просит следующую порцию, когда её видно", () => {
    const el = mount({ hasMore: true, data: page([item()], { total: 90 }) });
    expect(el.querySelector('[data-testid="chat-load-more"]')).toBeTruthy();
    expect(spies.onLoadMore).not.toHaveBeenCalled();
    expect(reachEnd()).toBe(1);
    expect(spies.onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("пока порция едет: серые строки, наблюдатель выключен; показано всё: полоски нет", () => {
    const loading = mount({ hasMore: true, loadingMore: true, data: page([item()], { total: 90 }) });
    expect(loading.querySelector('[data-testid="chat-skeleton"]')).toBeTruthy();
    expect(reachEnd()).toBe(0);
    const done = mount({ hasMore: false });
    expect(done.querySelector('[data-testid="chat-load-more"]')).toBeNull();
    expect(done.querySelector('[data-testid="chat-skeleton"]')).toBeNull();
  });

  it("коротком списке после порции наблюдатель создаётся заново: подгрузка не застревает", () => {
    mount({ hasMore: true, data: page([item()], { total: 90 }) });
    reachEnd();
    const before = observers.length;
    // Пришла порция, полоска всё ещё на виду: новый наблюдатель сообщит об этом сам.
    mount({ hasMore: true, data: page([item(), item({ id: "c2", name: "Рустам" })], { total: 90 }) });
    expect(observers.length).toBeGreaterThan(before);
    reachEnd();
    expect(spies.onLoadMore).toHaveBeenCalledTimes(2);
  });

  it("ошибка загрузки не раскручивает подгрузку: при ошибке наблюдатель выключен", () => {
    mount({ hasMore: true, error: new Error("сеть"), data: page([item()], { total: 90 }) });
    expect(reachEnd()).toBe(0);
  });
});

describe("кружок собеседника", () => {
  const html = (over: Partial<ConversationListItem>) => renderToStaticMarkup(createElement(ConversationList, props({ data: page([item(over)]) })));

  it("фото из канала показывается картинкой, без фото кружок с буквой", () => {
    expect(html({ avatarUrl: "/photo/x.webp?a=1&e=2&k=3&v=a" })).toContain('<img src="/photo/x.webp?a=1&amp;e=2&amp;k=3&amp;v=a"');
    const letter = html({ name: "Фарида", avatarUrl: null });
    expect(letter).not.toContain("<img");
    expect(letter).toMatch(/ry-avatar[^>]*>Ф</);
  });

  it("цвет кружка держится за avatarSeed, а не за именем", () => {
    const tone = (over: Partial<ConversationListItem>) => html(over).match(/data-tone="(a\d)"/)?.[1];
    expect(tone({ name: "Аня", avatarSeed: "profile-1" })).toBe(tone({ name: "Совсем другое имя", avatarSeed: "profile-1" }));
    const tones = new Set(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"].map((seed) => tone({ avatarSeed: seed })));
    expect(tones.size).toBeGreaterThan(1);
  });

  it("безымянный: в кружке метка интереса, бюджет в строке, у продающего значок", () => {
    const row = html({
      name: "Ищет 2к · Шохмансур", unnamed: true, interest: { title: "Ищет 2к · Шохмансур", budget: "до 650 тыс.", badge: "2к", kind: "buy" },
    });
    expect(row).toContain("Ищет 2к · Шохмансур");
    expect(row).toMatch(/ry-avatar[^>]*>2к</);
    expect(row).toContain("до 650 тыс.");
    expect(row).not.toContain("ry-chat-kind");
    const seller = html({ name: "Продаёт 3к · Сино", unnamed: true, interest: { title: "Продаёт 3к · Сино", budget: null, badge: "3к", kind: "sell" } });
    expect(seller).toContain('aria-label="Продаёт"');
  });

  it("с настоящим именем метка интереса не подменяет букву", () => {
    const row = html({ name: "Фарида", unnamed: false, interest: { title: "Ищет 1к", budget: "до 100 тыс.", badge: "1к", kind: "buy" } });
    expect(row).toMatch(/ry-avatar[^>]*>Ф</);
    expect(row).not.toContain("до 100 тыс.");
  });
});

describe("архив", () => {
  it("вход «Архив · N» виден только во вкладке «Все» без поиска и по нажатию открывает архив", () => {
    const el = mount();
    const entry = el.querySelector('[data-testid="chat-archive-entry"]') as HTMLButtonElement;
    expect(entry.textContent).toContain("Архив");
    expect(entry.textContent).toContain("7");
    act(() => entry.click());
    expect(spies.onSegmentChange).toHaveBeenCalledWith("archive");

    expect(mount({ segment: "needsHuman" }).querySelector('[data-testid="chat-archive-entry"]')).toBeNull();
    expect(mount({ segment: "all", searchInput: "Рустам" }).querySelector('[data-testid="chat-archive-entry"]')).toBeNull();
    expect(mount({ data: page([item()], { archiveEnabled: false }) }).querySelector('[data-testid="chat-archive-entry"]')).toBeNull();
    expect(mount({ data: page([item()], { counts: { all: 1, needsHuman: 0, paused: 0, mine: 0, archived: 0 } }) }).querySelector('[data-testid="chat-archive-entry"]')).toBeNull();
  });

  it("внутри архива шапка объясняет правило и возвращает ко всем", () => {
    const el = mount({ segment: "archive" });
    const back = el.querySelector('[data-testid="chat-archive-back"]') as HTMLButtonElement;
    expect(back.textContent).toContain("Архив · 7");
    expect(back.textContent).toContain("Поиск находит");
    expect(el.querySelector('[data-testid="chat-archive-entry"]')).toBeNull();
    act(() => back.click());
    expect(spies.onSegmentChange).toHaveBeenCalledWith("all");
  });

  it("пустой архив говорит об этом словами", () => {
    const el = mount({ segment: "archive", data: page([], { counts: { all: 0, needsHuman: 0, paused: 0, mine: 0, archived: 0 } }) });
    expect(el.textContent).toContain("В архиве пусто");
  });
});
