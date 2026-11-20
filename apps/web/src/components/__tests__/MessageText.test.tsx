import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MESSAGE_PHONE_MASK } from "@royal-home/shared";
import { MessageText } from "../MessageText";

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

  it("без карточки клиента — «Номер скрыт», а не мёртвая «Позвонить»", () => {
    const html = render(<MessageText content={content} clientId={null} rh2 />);
    expect(html).toContain("Номер скрыт");
    expect(html).not.toContain("Позвонить");
    expect(html).not.toContain(MESSAGE_PHONE_MASK);
  });

  it("цифр номера нет ни в одном варианте — кнопка набирает карточку, номер не печатается", () => {
    for (const clientId of ["client", null]) {
      expect(render(<MessageText content={content} clientId={clientId} />)).not.toMatch(/\d{9}/);
    }
  });
});
