import { expect, it } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Rh2CommentCard } from "../Rh2CommentCard";
import type { InstagramCommentItem } from "../../hooks/useInstagramComments";

/** Actual card rendering; SSR does not execute a mutation or claim to test a browser click. */
function card(overrides: Partial<InstagramCommentItem>): string {
  const item: InstagramCommentItem = {
    id: "synthetic-comment", commentId: "synthetic-provider-comment", channel: "INSTAGRAM",
    mediaId: "synthetic-post", parentId: null, authorName: "fixture", text: "Тестовый комментарий",
    status: "PENDING", note: null, replyText: null, repliedAt: null, hiddenAt: null,
    dmText: null, dmSentAt: null, attempts: 0, createdAt: "2026-10-14T00:00:00Z", post: null,
    ...overrides,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return renderToString(<QueryClientProvider client={queryClient}>
    <Rh2CommentCard item={item} busy={false} canModerate={true} onModerate={() => {}} />
  </QueryClientProvider>).replace(/<!-- -->/g, "");
}

it("confirmed YouTube rejection is truthful and offers neither restore nor public reply", () => {
  const html = card({ channel: "YOUTUBE", status: "HIDDEN", note: "youtube_rejected; spam" });
  expect(html).toContain("Отклонён YouTube");
  expect(html).toContain("Возврат из CRM не поддерживается");
  expect(html).not.toContain("Вернуть подписчикам");
  expect(html).not.toContain("Ответить публично от имени агентства");
  expect(html).not.toContain("Автор по-прежнему видит");
});

it("legacy Meta hiding remains reversible but does not claim a current visibility receipt", () => {
  const html = card({ channel: "FACEBOOK", status: "HIDDEN", note: "manual_hide" });
  expect(html).toContain("Ранее отмечен скрытым в CRM");
  expect(html).toContain("Текущая видимость не подтверждена");
  expect(html).toContain("Вернуть подписчикам");
  expect(html).not.toContain("Автор по-прежнему видит");
});

it("a confirmed Meta hide retains the existing restore control", () => {
  const html = card({ channel: "FACEBOOK", status: "HIDDEN", note: "moderation_hidden; manual_hide" });
  expect(html).toContain("Скрыт от подписчиков");
  expect(html).toContain("Вернуть подписчикам");
  expect(html).not.toContain("Ранее отмечен скрытым");
});

it.each(["INSTAGRAM", "FACEBOOK", "YOUTUBE"])("stored DELETED in %s cannot offer reply/restore/hide", (channel) => {
  const html = card({ channel, status: "DELETED", note: "competitor_ad" });
  expect(html).not.toContain("Ответить публично от имени агентства");
  expect(html).not.toContain("Вернуть подписчикам");
  expect(html).not.toContain("Скрыть от подписчиков");
  expect(html).not.toContain("Отклонить в YouTube");
  expect(html).toContain("Ранее отмечен удалённым в CRM");
});

it.each(["INSTAGRAM", "FACEBOOK"])("confirmed deletion in %s retains its receipt label", (channel) => {
  const html = card({ channel, status: "DELETED", note: "moderation_deleted; spam" });
  expect(html).toContain("Удалён");
  expect(html).not.toContain("Ранее отмечен удалённым в CRM");
  expect(html).not.toContain("Ответить публично от имени агентства");
});

it("a live YouTube comment offers rejection with no restore promise", () => {
  const html = card({ channel: "YOUTUBE" });
  expect(html).toContain("Отклонить в YouTube");
  expect(html).toContain("Ответить публично от имени агентства");
  expect(html).not.toContain("Вернуть подписчикам");
});

it("an unsupported channel does not obtain controls from a recognized status", () => {
  const html = card({ channel: "WEBSITE", status: "HIDDEN", note: "moderation_hidden; spam" });
  expect(html).not.toContain("Вернуть подписчикам");
  expect(html).not.toContain("Ответить публично от имени агентства");
  expect(html).not.toContain("Автор по-прежнему видит");
  expect(html).toContain("Текущая видимость не подтверждена");
});
