import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TransferRequestView } from "@royal-home/shared";
import { TransferDialog } from "./TransferConfirmWindow";
import { INVALIDATION } from "../lib/liveEvents";

/** Окно директора «РОП передал карточку» (16.11.2026): что видит директор и какие решения ему даны. */
const base: TransferRequestView = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "PROPERTY",
  status: "PENDING",
  targetTitle: "Объект №123 · 2-комн., Сомони",
  targetShortId: 123,
  targetId: "00000000-0000-4000-8000-000000000002",
  fromAgent: { id: "a", fullName: "Прежний Хозяин" },
  toAgent: { id: "b", fullName: "Получатель Тест" },
  requestedBy: { id: "c", fullName: "Ноза РОП" },
  reason: "Агент в отпуске",
  createdAt: "2026-11-16T08:00:00.000Z",
  decidedAt: null,
  decisionNote: null,
  resultNote: null,
};

function render(request: TransferRequestView, more = 0) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TransferDialog request={request} more={more} onLater={() => undefined} />
    </QueryClientProvider>
  );
}

describe("окно директора о передаче РОП", () => {
  it("показывает что, от кого и кому, кто передал и причину, и два решения простыми словами", () => {
    const html = render(base);
    expect(html).toContain("Руководитель продаж передал объект");
    expect(html).toContain("Объект №123");
    expect(html).toContain("Прежний Хозяин");
    expect(html).toContain("Получатель Тест");
    expect(html).toContain("Ноза РОП");
    expect(html).toContain("Агент в отпуске");
    expect(html).toContain("Подтвердить");
    expect(html).toContain("Отклонить");
    expect(html).toContain("вернуть объект прежнему хозяину");
    expect(html).toContain("Не ответите — передача останется");
  });

  it("для клиента заголовок про клиента, и счётчик «ещё N» при очереди", () => {
    const html = render({ ...base, kind: "CLIENT", targetTitle: "Клиент Иван" }, 2);
    expect(html).toContain("Руководитель продаж передал клиента");
    expect(html).toContain("ещё 2");
  });

  it("живое событие transfer.pending обновляет запросы, объекты и клиентов", () => {
    const keys = INVALIDATION["transfer.pending"].map((k) => k[0]);
    expect(keys).toEqual(expect.arrayContaining(["transfer-requests", "properties", "clients"]));
  });
});
