import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client, Property } from "../../types";
import type { ClientPropertyMatchEvidence } from "@royal-home/shared";

const state = vi.hoisted(() => ({ readOnly: false, send: vi.fn(), target: vi.fn(), properties: [] as unknown[] }));
vi.mock("../../hooks/useClients", () => ({
  useAssignClientToAgent: () => ({ mutateAsync: state.send }),
  useSendProperties: () => ({ mutateAsync: state.send, isPending: false }),
  useSendTarget: (...args: unknown[]) => { state.target(...args); return { data: { channel: "INSTAGRAM", channelEnabled: true, windowOpen: true, smsAvailable: false, hint: "Уйдёт в Instagram" }, isLoading: false, isError: false, refetch: vi.fn() }; },
  useClientMatch: () => ({ data: { properties: state.properties, total: 4, scanned: 100, eligible: 4, mineTotal: 1, requirementsSummary: ["2 комнаты", "до 600 000 с."], pageSize: 12 }, isLoading: false, isError: false, isFetching: false }),
}));
vi.mock("../../hooks/useProperties", () => ({ useProperties: () => ({ data: { items: [], total: 0, pageSize: 20 }, isLoading: false }), useMatchingClients: () => ({}) }));
vi.mock("../../hooks/useDistricts", () => ({ useDistricts: () => ({ data: [] }) }));
vi.mock("../../hooks/useDebouncedValue", () => ({ useDebouncedValue: (value: unknown) => value }));
vi.mock("../../hooks/useMobileUx", () => ({ useMobileUx: () => false }));
vi.mock("../../hooks/useSms", () => ({ useSmsShareProperty: () => ({}), useSmsStatus: () => ({ data: { configured: false } }) }));
vi.mock("../../lib/permissions", () => ({ useIsReadOnly: () => state.readOnly, useCan: () => () => false }));
vi.mock("../AddInteractionModal", () => ({ AddInteractionModal: () => null }));
vi.mock("../ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("./MatchClientCard", () => ({ MatchClientCard: () => null }));
vi.mock("../rh2/Rh2Sheet", () => ({ Rh2Sheet: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) => createElement("div", null, children, footer) }));
import { MatchPanel, PanelShell, SelectedMatchProperties } from "./MatchPanel";
import { SendFallback, targetReady } from "./SendFallback";

const evidence: ClientPropertyMatchEvidence = { tier: "exact", reasons: ["В пределах бюджета", "Нужное число комнат"], tradeoffs: [], unknowns: [], isMine: false, lastSentAt: null, sentCount: 0 };
function property(index: number, match: ClientPropertyMatchEvidence = evidence) {
  return { id: `property-${index}`, shortId: index, title: `Вариант номер ${index}`, price: "500000", currency: "TJS", rooms: 2, areaSqm: 60, status: "AVAILABLE", photos: [], district: { name: "Тестовый район" }, publishedOnSite: true, match, score: 99 } as unknown as Property & { match: ClientPropertyMatchEvidence };
}
function client() {
  return { id: "client", fullName: "Тестовый покупатель", requirementsNotes: null,
    interactions: [{ propertyId: "property-1", type: "SHOWING", notes: "Назначен показ" }],
    botConversation: [{ id: "ig-one", channel: "INSTAGRAM", messages: [] }, { id: "ig-two", channel: "INSTAGRAM", messages: [] }],
    telegramConversation: { id: "telegram-one", messages: [] },
  } as unknown as Client;
}
function render(children: ReactNode) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(MemoryRouter, null, children)));
}

beforeEach(() => { state.readOnly = false; state.send.mockClear(); state.target.mockClear(); state.properties = [property(1), property(2), property(3), property(4)]; });
describe("buyer matching workflow", () => {
  it("keeps off-page selections identifiable and individually removable without current catalog rows", () => {
    const html = render(createElement(SelectedMatchProperties, { items: [{ id: "off-page", label: "№184 · Квартира у парка" }], disabled: false, onRemove: vi.fn() }));
    expect(html).toContain('aria-label="Состав выбранной подборки"');
    expect(html).toContain('aria-label="Убрать из подборки: №184 · Квартира у парка"');
    expect(html).toContain("Перед отправкой проверьте состав");
    expect(html).not.toContain("disabled");
  });
  it("locks selected-item removal during a pending send and hides an empty tray", () => {
    expect(render(createElement(SelectedMatchProperties, { items: [], disabled: false, onRemove: vi.fn() }))).toBe("");
    const html = render(createElement(SelectedMatchProperties, { items: [{ id: "one", label: "№184" }], disabled: true, onRemove: vi.fn() }));
    expect(html).toContain('disabled=""');
  });
  it("keeps the batch action footer in the inline surface", () => {
    const html = render(createElement(PanelShell, { variant: "inline", open: true, title: "Подбор", onClose: vi.fn(), children: "Объекты", footer: createElement("button", null, "Подготовить выбранные") }));
    expect(html).toContain('aria-label="Выбранные объекты"');
    expect(html).toContain("Подготовить выбранные");
  });
  it("shows the first three in overview, actual reasons and a single expand action without fabricated percentages", () => {
    const html = render(createElement(MatchPanel, { mode: "client", client: client(), open: true, onClose: vi.fn(), variant: "inline", overviewLimit: 3 }));
    expect(html).toContain("Вариант номер 3");
    expect(html).not.toContain("Вариант номер 4");
    expect(html).toContain("Показать все · 4");
    expect(html).toContain("В пределах бюджета");
    expect(html).not.toContain("99%");
    expect(html).not.toContain('role="button"');
    expect(html).toContain("Показано 3 из 4 вариантов");
    expect(html).toContain("Проверено в базе: 100");
    expect(html).toContain('aria-label="Ответственный за объекты"');
    expect(html).not.toContain("Все подходящие");
    expect(html).toContain("client-match-grid");
    expect(state.send).not.toHaveBeenCalled();
  });
  it("does not duplicate the buyer's long request inside overview matching", () => {
    const html = render(createElement(MatchPanel, { mode: "client", client: { ...client(), requirementsNotes: "Длинное пожелание клиента" }, open: true, onClose: vi.fn(), variant: "inline", overviewLimit: 3 }));
    expect(html).not.toContain("Длинное пожелание клиента");
  });
  it("does not call a showing or note an offer, but shows authoritative sending receipts", () => {
    state.properties = [property(1), property(2, { ...evidence, sentCount: 1, lastSentAt: "2026-10-20T10:00:00Z" })];
    const html = render(createElement(MatchPanel, { mode: "client", client: client(), open: true, onClose: vi.fn(), variant: "inline" }));
    expect(html.match(/Отправляли/g)).toHaveLength(1);
  });
  it("lets a writer select only linked conversations without exposing recipient addresses", () => {
    const html = render(createElement(MatchPanel, { mode: "client", client: client(), open: true, onClose: vi.fn(), variant: "inline" }));
    expect(html).toContain('value="ig-one"');
    expect(html).toContain('value="ig-two"');
    expect(html).toContain('value="tg_telegram-one"');
    expect(html).toContain("Канал отправки");
  });
  it("read-only card retains matching but removes all outbound and showing actions", () => {
    const html = render(createElement(MatchPanel, { mode: "client", client: client(), open: true, onClose: vi.fn(), variant: "inline", readOnly: true }));
    expect(html).toContain("Вариант номер 1");
    expect(html).not.toContain("Канал отправки");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("Назначить показ");
    expect(state.target).toHaveBeenCalledWith("client", undefined, false);
  });
});
describe("manual sharing preparation", () => {
  it("unknown channel status is not permission to send", () => { expect(targetReady(undefined)).toBe(false); });
  it("renders the complete selectable message before any real delivery", () => {
    const html = render(createElement(SendFallback, { clientId: "client", message: "Пока не отправлено", smsAvailable: true, fallback: { text: "Посмотрите объект\nhttps://example.test/listing", links: [{ propertyId: "property", shortId: 1, url: "https://example.test/listing" }] } }));
    expect(html).toContain("Предпросмотр сообщения клиенту");
    expect(html).toContain("Скопировать текст");
    expect(html).toContain("По СМС · 1");
    expect(html).toContain("https://example.test/listing");
    expect(state.send).not.toHaveBeenCalled();
  });
  it("read-only account cannot create an external handoff", () => {
    state.readOnly = true;
    const html = render(createElement(SendFallback, { clientId: "client", message: "Пока не отправлено", smsAvailable: true, fallback: { text: "Подборка", links: [] } }));
    expect(html).toBe("");
  });
});
