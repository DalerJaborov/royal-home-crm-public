import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MESSAGE_PHONE_MASK, maskPhonesForReader } from "@royal-home/shared";
import { MessageText, NO_CARD_TITLE } from "../MessageText";

vi.mock("../../store/auth", () => ({ useAuthStore: (select: (state: { agent: { role: string; readOnly: boolean } }) => unknown) => select({ agent: { role: "AGENT", readOnly: false } }) }));
vi.mock("../../hooks/useActiveCall", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useActiveCall")>()),
  useActiveCallValue: () => ({ data: null }),
}));

/**
 * «ПОЗВОНИТЬ» ВНУТРИ РЕПЛИКИ (кадр владельца 20.11.2026, iPhone, чат продавца).
 * Клиент продиктовал номер — сервер закрыл его маской, на месте маски стоит кнопка
 * звонка. Обёртка кнопки была блочным `div`: фраза рвалась, и «Позвонить» вставала
 * отдельной строкой с пустой строкой над ней — выглядело мусором. Теперь обёртка
 * строчная. А без карточки клиента звонить некуда — вместо мёртвой серой кнопки слова.
 */
function render(node: React.ReactElement): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe("MessageText — кнопка звонка на месте скрытого номера", () => {
  const content = `5этаж 86кв район 112 мк после ремонта\n${MESSAGE_PHONE_MASK}`;

  it("кнопка внутри строки: обёртка span, не блочный div", () => {
    const html = render(<MessageText content={content} clientId="client" rh2 />);
    expect(html).toContain("Позвонить");
    expect(html).toMatch(/<span[^>]*data-msg-call="true"/);
    expect(html).not.toMatch(/<div[^>]*data-msg-call/);
    expect(html).not.toContain(MESSAGE_PHONE_MASK);
  });

  it("без карточки клиента — «Номер скрыт» с причиной подсказкой, а не мёртвая «Позвонить»", () => {
    const html = render(<MessageText content={content} clientId={null} rh2 />);
    expect(html).toContain("Номер скрыт");
    expect(html).toContain(`title="${NO_CARD_TITLE}"`);
    expect(NO_CARD_TITLE).toMatch(/примите лид, чтобы позвонить/);
    expect(html).not.toContain("Позвонить<");
    expect(html).not.toContain(MESSAGE_PHONE_MASK);
  });

  it("настоящий номер из реплики (закрытый сервером тем же правилом) не печатается ни в одном варианте", () => {
    // Вход — живая реплика с номером; закрывает его то же общее правило, что сервер
    // (packages/shared maskPhonesForReader → lib/messageAttachments.ts).
    const raw = "5этаж 86кв район 112 мк после ремонта, звоните 93 555 12 34";
    const masked = maskPhonesForReader(raw);
    expect(masked.masked).toBe(true);
    for (const clientId of ["client", null]) {
      const html = render(<MessageText content={masked.text} clientId={clientId} />);
      expect(html.replace(/\D/g, " ")).not.toMatch(/93\s*555\s*12\s*34|935551234/);
      expect(html).not.toMatch(/\d{9}/);
    }
  });
});
