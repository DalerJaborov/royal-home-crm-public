import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { OfferAnswerAction } from "../Notifications";

/**
 * Ответ на предложение объекта коллегой в ленте уведомлений (10.11.2026, кадры
 * на стенде): статус — с сервера (после перезагрузки плашка, а не снова кнопки),
 * ответ — заметным статусом, на телефоне — своей строкой под текстом.
 */
const render = (offer: { id: string; status: string; answerable: boolean }, line = false) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(OfferAnswerAction, { offer, className: "btn pill sm", line })));

describe("ответ на предложение объекта в ленте", () => {
  it("можно ответить — две кнопки", () => {
    const html = render({ id: "o1", status: "SENT", answerable: true });
    expect(html).toContain("Отправлю клиенту");
    expect(html).toContain("Не подходит");
    expect(html).not.toContain("offer-status");
  });

  it("ответ уже дан — статусом с сервера, «отправлю» выделен", () => {
    const yes = render({ id: "o1", status: "WILL_SEND", answerable: false });
    expect(yes).toContain("offer-status ok");
    expect(yes).toContain("✅ Отправлю клиенту");
    expect(yes).not.toContain("<button");
    expect(render({ id: "o1", status: "NOT_SUITABLE", answerable: false })).toContain("🙅 Не подходит");
    expect(render({ id: "o1", status: "CLOSED", answerable: false })).toContain("у другого агента");
    expect(render({ id: "o1", status: "SENT", answerable: false })).toContain("Ответить уже нельзя");
  });

  it("на телефоне — своей строкой под текстом", () => {
    expect(render({ id: "o1", status: "SENT", answerable: true }, true)).toContain("offer-answer offer-answer-line");
  });
});
