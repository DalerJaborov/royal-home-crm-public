import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { CONTACT_FACT_DOMAINS, MESSAGE_PHONE_MASK, type ContactProfileView } from "@royal-home/shared";
const conversationId = "00000000-0000-4000-8000-000000000001";
const h = vi.hoisted(() => ({ readOnly: false, narrow: false, mutation: vi.fn(), groupedConversation: null as unknown }));
vi.mock("../../lib/permissions", () => ({ useCan: () => () => true, useIsReadOnly: () => h.readOnly }));
vi.mock("../../store/auth", () => ({ useAuthStore: Object.assign((select: (state: unknown) => unknown) => select({ agent: { id: "actor", role: h.readOnly ? "SHAREHOLDER" : "MANAGER" }, sessionEpoch: 1 }), { getState: () => ({ agent: { id: "actor" }, sessionEpoch: 1 }), subscribe: () => () => {} }) }));
vi.mock("../../hooks/useNarrowScreen", () => ({ useNarrowScreen: () => h.narrow }));
vi.mock("../../hooks/useSellerObject", () => ({ useSellerObject: () => ({ data: null }) }));
vi.mock("../../hooks/useDraftBeforeUpdate", () => ({ useDraftBeforeUpdate: () => {} }));
vi.mock("../../hooks/useCleanChatDraft", () => ({ useCleanChatDraft: () => {} }));
vi.mock("../../store/mediaUploads", () => ({ usePendingMediaUploads: () => [] }));
vi.mock("../../hooks/useConversations", async importOriginal => {
  const original = await importOriginal<typeof import("../../hooks/useConversations")>();
  const mutation = () => ({ isPending: false, isError: false, mutate: h.mutation, mutateAsync: h.mutation });
  return {
    ...original,
    useConversation: () => ({ data: { id: conversationId, name: "Клиент", profileName: null, channel: "WHATSAPP", messages: [{ role: "user", content: "Телефон: «телефон скрыт»", at: new Date().toISOString() }], clientId: "client", clientShortId: "1", clientPhone: null, firstContactAt: new Date().toISOString(), pausedUntil: null, contact: null, subscriberId: "peer" }, isLoading: false, refetch: h.mutation }),
    useGroupedConversation: () => ({ data: h.groupedConversation, isLoading: false, isError: false, error: null, refetch: h.mutation }),
    useReplyToConversation: mutation, useSendVoiceMessage: mutation, useResumeConversationBot: mutation,
    usePauseConversationBot: mutation, useUploadConversationMediaWithProgress: () => ({ start: h.mutation, retry: h.mutation, cancel: h.mutation }),
    useAiConversationCost: () => ({ data: null }),
    isWindowClosedError: () => false,
  };
});
vi.mock("../../components/CallClientButton", () => ({ CallClientButton: () => createElement("button", null, "Позвонить") }));
vi.mock("../../components/VoiceRecordButton", () => ({ VoiceRecordButton: () => createElement("button", null, "Голосовое") }));
vi.mock("../../components/ChatPropertySend", () => ({ ChatPropertySend: ({ disabled, conversationId }: { disabled?: boolean; conversationId?: string }) => createElement("button", { disabled, "data-conversation-id": conversationId ?? "" }, "Отправить объект") }));
vi.mock("../../components/BotReplyFeedback", () => ({ BotReplyFeedback: () => createElement("button", null, "Обучить бота") }));
vi.mock("../../hooks/useContactProfile", () => ({ useSetContactCategory: () => ({ mutate: h.mutation, isPending: false, isError: false }) }));
vi.mock("../../hooks/useClients", () => ({ useSendClientMessage: () => ({ isPending: false, isError: false, mutate: h.mutation }), useSendClientVoiceMessage: () => ({ mutateAsync: h.mutation }), downloadClientConversation: h.mutation }));
vi.mock("../../hooks/useMobileUx", () => ({ useMobileUx: () => h.narrow }));
vi.mock("../../hooks/useScrollLock", () => ({ useScrollLock: () => {} }));
vi.mock("../../components/rh2/Rh2Scope", async (importOriginal) => ({ ...await importOriginal<object>(), Rh2Portal: ({ children }: { children: ReactNode }) => children }));
vi.mock("react-virtuoso", () => ({ Virtuoso: ({ data, itemContent }: { data: unknown[]; itemContent: (index: number, item: unknown) => ReactNode }) => createElement("div", null, data.map((item, index) => createElement("div", { key: index }, itemContent(index, item)))) }));
import { ClientChatPanel } from "../../components/ClientChatPanel";
import { ConversationView } from "../Messages";
import { MobileChatView } from "../../components/mobile/MobileChatView";
import { MessageText } from "../../components/MessageText";
import { TranslatableMessageText } from "../../components/MessageTranslateToggle";
import { ContactProfilePanel } from "../../components/ContactProfilePanel";

function renderToStaticMarkup(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["customer-requests", conversationId, "actor"], [{
    id: "request", conversationId, requestKind: "HUMAN", lifecycleRevision: "revision-1",
    lifecycleStatus: "QUEUED", assignedAgentId: null, topic: "Нужна помощь сотрудника",
  }]);
  return renderMarkup(createElement(QueryClientProvider, { client }, node));
}

function desktop(clean: boolean) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ConversationView, { id: conversationId, onBack: () => {}, clean })));
}
describe("read-only chat actors", () => {
  for (const readOnly of [true, false]) {
    it(`client-card chat preserves history and translations for ${readOnly ? "shareholder" : "operator"}`, () => {
      h.readOnly = readOnly; h.narrow = false; h.mutation.mockClear();
      const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ClientChatPanel, {
        clientId: "client", clientShortId: 1, clientName: "Клиент", onClose: () => {}, autoFocusReply: true,
        conversations: [{ id: conversationId, channel: "WHATSAPP", pausedUntil: null, messages: [
          { role: "user", content: "Ман хона мехоҳам", translatedRu: "Хочу квартиру", at: new Date().toISOString() },
          { role: "assistant", content: "Ответ бота" },
          { role: "user", content: "Непереведённое сообщение: мехоҳам", at: new Date().toISOString() },
        ] }],
      })));
      expect(html).toContain("Хочу квартиру");
      expect(html).toContain("Как сказал клиент");
      expect(html).toContain("Непереведённое сообщение");
      if (readOnly) {
        expect(html).toContain("Режим просмотра");
        expect(html).not.toContain("<textarea");
        expect(html).not.toContain("Голосовое");
        expect(html).not.toContain("Обучить бота");
        expect(html).not.toContain("Показать перевод на русский");
      } else {
        expect(html).toContain("<textarea");
        expect(html).toContain("Голосовое");
        expect(html).toContain("Обучить бота");
        expect(html).toContain("Показать перевод на русский");
      }
      expect(h.mutation).not.toHaveBeenCalled();
    });
  }
  for (const clean of [true, false]) {
    it(`shareholder cannot compose or manage the bot in ${clean ? "Clean" : "legacy desktop"}`, () => {
      h.readOnly = true; h.narrow = false;
      const html = desktop(clean);
      expect(html).toContain("Режим просмотра");
      expect(html).not.toContain('<textarea');
      expect(html).not.toContain("Прикрепить фото или видео");
      expect(html).not.toContain("Голосовое");
      expect(html).not.toContain("Отправить объект");
      expect(html).not.toContain("Поставить на паузу");
      expect(html).toContain("Найти в переписке");
    });
  }
  it("ordinary operator keeps reply, attachment, voice, object and bot controls", () => {
    h.readOnly = false; h.narrow = false;
    const html = desktop(true);
    for (const label of ["Текст ответа", "Прикрепить фото или видео", "Голосовое", "Отправить объект", "Поставить на паузу"]) expect(html).toContain(label);
  });
  for (const readOnly of [true, false]) {
    it(`${readOnly ? "shareholder" : "operator"} has correct actions in the legacy phone fallback`, () => {
      h.readOnly = readOnly; h.narrow = true;
      const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(MobileChatView, { id: conversationId, onBack: () => {} })));
      if (readOnly) {
        expect(html).toContain("Режим просмотра");
        expect(html).not.toContain('<textarea');
        expect(html).not.toContain("Отправить объект");
        expect(html).not.toContain("Голосовое");
      } else {
        expect(html).toContain('<textarea');
        expect(html).toContain("Отправить объект");
        expect(html).toContain("Голосовое");
      }
    });
  }
  it("a masked number remains readable without creating an outgoing call action", () => {
    const html = renderToStaticMarkup(createElement(MessageText, { content: `Телефон: ${MESSAGE_PHONE_MASK}`, clientId: "client", readOnly: true }));
    expect(html).toContain("Номер скрыт");
    expect(html).not.toContain("button");
  });
  it("does not initiate any mutation while rendering a read-only conversation", () => {
    h.readOnly = true; h.narrow = false; h.mutation.mockClear(); desktop(true);
    expect(h.mutation).not.toHaveBeenCalled();
  });
  it("shows a pending customer request to a shareholder without transition actions", () => {
    h.readOnly = true; h.narrow = false; h.mutation.mockClear();
    const html = desktop(true);
    expect(html).toContain("Нужна помощь сотрудника");
    expect(html).not.toContain("Принять в работу");
    expect(html).not.toContain("Закрыть запрос");
    expect(h.mutation).not.toHaveBeenCalled();
  });
  it("retains customer request actions for the operator", () => {
    h.readOnly = false; h.narrow = false;
    const html = desktop(true);
    expect(html).toContain("Нужна помощь сотрудника");
    expect(html).toContain("Принять в работу");
    expect(html).toContain("Закрыть запрос");
  });
  it("keeps grouped client history read-only for shareholders and preserves operator source controls", () => {
    const groupedConversation = {
      id: "client:client", clientId: "client", clientShortId: "1", name: "Клиент", profileName: null,
      channel: "MULTI", messages: [{ role: "user", content: "Старое сообщение", at: new Date().toISOString(), sourceConversationId: conversationId, sourceChannel: "WHATSAPP" }],
      clientPhone: null, firstContactAt: new Date().toISOString(), pausedUntil: null, contact: null, subscriberId: null,
      sources: [{ id: conversationId, channel: "WHATSAPP", canReply: true, pausedUntil: null }],
    };
    h.groupedConversation = groupedConversation;
    h.readOnly = true; h.narrow = false; h.mutation.mockClear();
    const readonlyHtml = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ConversationView, { id: "client:client", onBack: () => {}, clean: true })));
    expect(readonlyHtml).toContain("Старое сообщение");
    expect(readonlyHtml).toContain("Режим просмотра");
    expect(readonlyHtml).not.toContain("Отправить объект");
    expect(readonlyHtml).not.toContain("Поставить на паузу");
    expect(h.mutation).not.toHaveBeenCalled();

    h.readOnly = false;
    const operatorHtml = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ConversationView, { id: "client:client", onBack: () => {}, clean: true })));
    expect(operatorHtml).toContain("Куда ответить");
    expect(operatorHtml).toContain("Отправить объект");
    expect(operatorHtml).toContain(`data-conversation-id=""`);
    h.groupedConversation = null;
  });
  it("permits an existing translation as local reading, but cannot request a new translation", () => {
    const message = { role: "user" as const, content: "Ман хона мехоҳам", at: new Date().toISOString() };
    const untranslated = renderToStaticMarkup(createElement(TranslatableMessageText, { content: message.content, message, conversationId: "chat", readOnly: true }));
    expect(untranslated).not.toContain("Показать перевод на русский");
    const translated = renderToStaticMarkup(createElement(TranslatableMessageText, { content: message.content, message: { ...message, translatedRu: "Хочу квартиру" }, conversationId: "chat", readOnly: true }));
    expect(translated).toContain("Хочу квартиру");
    expect(translated).toContain("Как сказал клиент");
  });
  it("retains contact facts without category-edit controls", () => {
    const contact = { id: "profile", category: "BUYER", categorySetAt: null, categoryHistory: [], displayName: "Клиент", nameSource: null, language: null, firstSeenAt: new Date().toISOString(), channels: [], inboundMessages: 1, facts: Object.fromEntries(CONTACT_FACT_DOMAINS.map(domain => [domain, []])), pendingLinks: [] } as unknown as ContactProfileView;
    const readOnly = renderToStaticMarkup(createElement(ContactProfilePanel, { contact, readOnly: true }));
    expect(readOnly).toContain("Клиент");
    expect(readOnly).not.toContain("Исправить");
    const editable = renderToStaticMarkup(createElement(ContactProfilePanel, { contact, readOnly: false }));
    expect(editable).toContain("Исправить");
  });
});
