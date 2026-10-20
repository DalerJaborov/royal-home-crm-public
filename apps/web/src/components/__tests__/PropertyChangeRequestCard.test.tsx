import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PROPERTY_CHANGE_KINDS, PROPERTY_CHANGE_KIND_LABELS } from "@royal-home/shared";
import { PropertyChangeRequestCard, ResultBlock } from "../PropertyChangeRequestCard";
import { UNPUBLISH_EMPTY_HINT } from "../../lib/propertyChangeRequestView";
import type { Property } from "../../types";

/**
 * Первый рендер блока «Изменить после публикации» (07.10.2026): jsdom в проекте нет,
 * поэтому смотрим разметку renderToString. Правила видимости — в
 * lib/__tests__/propertyChangeRequestView.test.ts; здесь — что блок рисует в каждом режиме.
 */
/** renderToString вставляет `<!-- -->` между соседними текстовыми узлами — для сверки текста убираем. */
function ssr(node: React.ReactElement) {
  return renderToString(node).replace(/<!-- -->/g, "");
}

function render(mode: "author" | "decider" | null, publishedChannels: string[]) {
  const property = {
    id: "p1",
    shortId: 82,
    status: "AVAILABLE",
    price: "95000.00",
    currency: "TJS",
    publishedChannels,
  } as unknown as Property;
  return renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <PropertyChangeRequestCard property={property} mode={mode} />
    </QueryClientProvider>
  );
}

describe("PropertyChangeRequestCard", () => {
  it("режим автора: заголовок, пояснение и по кнопке на каждый вид заявки", () => {
    const html = render("author", ["YOUTUBE"]);
    expect(html).toContain("Изменить после публикации");
    expect(html).toContain("Сами менять опубликованную карточку нельзя");
    for (const kind of PROPERTY_CHANGE_KINDS) {
      expect(html).toContain(`data-kind="${kind}"`);
      expect(html).toContain(PROPERTY_CHANGE_KIND_LABELS[kind]);
    }
    expect(html).toContain("Мои заявки по объекту");
  });

  it("«Убрать из соцсетей» неактивна и объясняет почему, когда отметок нет", () => {
    const empty = render("author", []);
    const at = empty.indexOf('data-kind="UNPUBLISH"');
    // атрибуты кнопки стоят в одном открывающем теге: disabled — до и после data-kind
    const tagStart = empty.lastIndexOf("<button", at);
    const tagEnd = empty.indexOf(">", at);
    expect(empty.slice(tagStart, tagEnd)).toContain("disabled");
    expect(empty).toContain(UNPUBLISH_EMPTY_HINT);

    const filled = render("author", ["YOUTUBE"]);
    const at2 = filled.indexOf('data-kind="UNPUBLISH"');
    const tag2 = filled.slice(filled.lastIndexOf("<button", at2), filled.indexOf(">", at2));
    expect(tag2).not.toContain("disabled");
    expect(filled).not.toContain(UNPUBLISH_EMPTY_HINT);
  });

  it("режим решателя: заявки, а не готовые кнопки автора", () => {
    const html = render("decider", ["YOUTUBE"]);
    expect(html).toContain("Заявки на изменение");
    expect(html).not.toContain("Изменить после публикации");
    expect(html).not.toContain("data-kind=");
  });

  it("нет режима (неопубликованный объект, нет права) — ничего не рисуется", () => {
    expect(render(null, ["YOUTUBE"])).toBe("");
  });
});

describe("ResultBlock — итог после «Принять»", () => {
  const view = {
    applied: ["Цена на сайте обновлена"],
    manual: [{ channel: "INSTAGRAM", text: "поправьте цену в подписи Reels" }],
    remakeQueued: true,
    failed: null,
  };

  it("сделанное — галочками, остаток — отдельным блоком «Руками»", () => {
    const html = ssr(<ResultBlock result={view} mode="decider" />);
    expect(html).toContain("✓ Цена на сайте обновлена");
    expect(html).toContain("Руками");
    expect(html).toContain("Instagram: поправьте цену в подписи Reels");
    expect(html).toContain("перемонтаж");
  });

  it("автору тот же остаток назван «Придётся сделать руками»", () => {
    expect(ssr(<ResultBlock result={view} mode="author" />)).toContain("Придётся сделать руками");
  });

  it("без остатка блока «Руками» нет", () => {
    expect(ssr(<ResultBlock result={{ ...view, manual: [] }} mode="decider" />)).not.toContain("Руками");
  });

  it("сбой — красным с текстом ошибки и подсказкой директору", () => {
    const failed = { applied: [], manual: [], remakeQueued: false, failed: "Facebook не ответил" };
    const html = ssr(<ResultBlock result={failed} mode="decider" />);
    expect(html).toContain("Facebook не ответил");
    expect(html).toContain("Можно сделать это самому");
  });
});
