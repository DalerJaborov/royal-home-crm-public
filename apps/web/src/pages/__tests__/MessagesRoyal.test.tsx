import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

/**
 * «Новый вид» раздела «Чаты» (18.11.2026): та же переписка и те же действия,
 * другая разметка. Сторож того, что при переодевании ничего не потерялось и
 * права не разъехались: ответ, вложение, голос, объект, пауза бота, звонок,
 * «Ещё» (поиск, данные клиента, карточка) и быстрые ответы.
 */
const conversationId = "00000000-0000-4000-8000-000000000002";
const now = new Date().toISOString();
const h = vi.hoisted(() => ({ readOnly: false, narrow: false, mutation: vi.fn(), pausedUntil: null as string | null, grouped: null as unknown }));
vi.mock("../../lib/permissions", () => ({ useCan: () => () => true, useIsReadOnly: () => h.readOnly }));
vi.mock("../../store/auth", () => ({ useAuthStore: Object.assign((select: (state: unknown) => unknown) => select({ agent: { id: "actor", role: h.readOnly ? "SHAREHOLDER" : "MANAGER" }, sessionEpoch: 1 }), { getState: () => ({ agent: { id: "actor" }, sessionEpoch: 1 }), subscribe: () => () => {} }) }));
vi.mock("../../hooks/useNarrowScreen", () => ({ useNarrowScreen: () => h.narrow }));
vi.mock("../../hooks/useSellerObject", () => ({ useSellerObject: () => ({ data: null }) }));
vi.mock("../../hooks/useCleanChatDraft", () => ({ useCleanChatDraft: () => {} }));
vi.mock("../../store/mediaUploads", () => ({ usePendingMediaUploads: () => [] }));
vi.mock("../../hooks/useConversations", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../hooks/useConversations")>();
  const mutation = () => ({ isPending: false, isError: false, mutate: h.mutation, mutateAsync: h.mutation });
  return {
    ...original,
    useConversation: () => ({ data: {
      id: conversationId, name: "Нигина Юсуфи", profileName: null, channel: "INSTAGRAM", clientId: "client", clientShortId: "7",
      clientPhone: "+992900000099", firstContactAt: now, pausedUntil: h.pausedUntil, shieldPause: null, contact: null, subscriberId: "peer",
      messages: [
        { role: "user", content: "Квартира ещё продаётся?", at: now },
        { role: "assistant", content: "Да, могу прислать фото", at: now, by: { kind: "bot" } },
        { role: "assistant", content: "Добрый день, это Азиз", at: now, by: { kind: "agent", agentId: "a", agentName: "Азиз" } },
        { role: "assistant", content: "Отправляю адрес", at: now, by: { kind: "manual" } },
      ],
    }, isLoading: false, refetch: h.mutation }),
    useGroupedConversation: () => ({ data: h.grouped, isLoading: false, isError: false, error: null, refetch: h.mutation }),
    useReplyToConversation: mutation, useSendVoiceMessage: mutation, useResumeConversationBot: mutation,
    usePauseConversationBot: mutation, useUploadConversationMediaWithProgress: () => ({ start: h.mutation, retry: h.mutation, cancel: h.mutation }),
    isWindowClosedError: () => false,
  };
});
vi.mock("../../components/CallClientButton", () => ({ CallClientButton: () => createElement("button", null, "Позвонить") }));
vi.mock("../../components/VoiceRecordButton", () => ({ VoiceRecordButton: () => createElement("button", null, "Голосовое") }));
vi.mock("../../components/ChatPropertySend", () => ({ ChatPropertySend: () => createElement("button", null, "Отправить объект") }));
vi.mock("../../components/BotReplyFeedback", () => ({ BotReplyFeedback: () => createElement("button", null, "Обучить бота") }));
vi.mock("../../hooks/useContactProfile", () => ({ useSetContactCategory: () => ({ mutate: h.mutation, isPending: false, isError: false }) }));
import { ConversationView } from "../Messages";

function royal(id = conversationId) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["customer-requests", conversationId, "actor"], []);
  return renderMarkup(createElement(QueryClientProvider, { client },
    createElement(MemoryRouter, null, createElement(ConversationView, { id, onBack: () => {}, clean: true, royal: true })) as ReactNode));
}

describe("Чаты в новом виде", () => {
  it("keeps every operator action of the conversation", () => {
    h.readOnly = false; h.narrow = false; h.pausedUntil = null; h.mutation.mockClear();
    const html = royal();
    expect(html).toContain('class="ry-chat-head"');
    for (const label of ["Текст ответа", "Прикрепить фото или видео", "Голосовое", "Отправить объект", "Позвонить",
      "Бот отвечает. Поставить на паузу", 'aria-label="Ещё"', 'aria-label="Отправить"', "Ответ ставит бота на паузу:"]) {
      expect(html, label).toContain(label);
    }
    expect(html).toContain("Обучить бота");
    expect(h.mutation).not.toHaveBeenCalled();
  });

  it("shows one strip of quick replies from people's own short replies, never the bot's", () => {
    h.readOnly = false; h.narrow = false; h.pausedUntil = null;
    const html = royal();
    const strip = html.slice(html.indexOf("ry-chat-quick"), html.indexOf("ry-chat-compose"));
    expect(strip).toContain("Отправляю адрес");
    expect(strip).toContain("Добрый день, это Азиз");
    expect(strip).not.toContain("Да, могу прислать фото");
    expect(html.match(/ry-chat-quick"/g)?.length).toBe(1);
  });

  it("a paused bot is returned by the same header button", () => {
    h.readOnly = false; h.pausedUntil = "2099-01-01T00:00:00Z";
    const html = royal();
    expect(html).toContain("Бот на паузе. Вернуть боту");
    expect(html).not.toContain("Ответ ставит бота на паузу:");
    h.pausedUntil = null;
  });

  it("shareholder sees history only: no composer, no bot control, no quick replies", () => {
    h.readOnly = true; h.narrow = false; h.mutation.mockClear();
    const html = royal();
    expect(html).toContain("Режим просмотра");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Поставить на паузу");
    expect(html).not.toContain("Вернуть боту");
    expect(html).not.toContain("ry-chat-quick");
    expect(html).toContain('aria-label="Ещё"');
    expect(h.mutation).not.toHaveBeenCalled();
  });

  it("back button only where the list is not beside the conversation", () => {
    h.readOnly = false; h.narrow = true;
    expect(royal()).toContain("Назад к списку чатов");
    h.narrow = false;
    expect(royal()).not.toContain("Назад к списку чатов");
  });

  it("grouped client history: no group-wide bot control and no quick replies until a reply channel is chosen", () => {
    h.readOnly = false; h.narrow = false;
    h.grouped = {
      id: "client:client", clientId: "client", clientShortId: "1", name: "Клиент", profileName: null, channel: "MULTI",
      messages: [{ role: "assistant", content: "Короткий ответ", at: now, by: { kind: "agent", agentId: "a", agentName: "Азиз" }, sourceConversationId: conversationId, sourceChannel: "WHATSAPP" }],
      clientPhone: null, firstContactAt: now, pausedUntil: null, contact: null, subscriberId: null,
      sources: [{ id: conversationId, channel: "WHATSAPP", canReply: true, pausedUntil: null }],
    };
    try {
      const html = royal("client:client");
      expect(html).toContain("Общий чат");
      expect(html).toContain("Куда ответить");
      expect(html).not.toContain("Поставить на паузу");
      expect(html).not.toContain("ry-chat-quick");
    } finally {
      h.grouped = null;
    }
  });
});
