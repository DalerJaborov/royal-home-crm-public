import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PropertyVideoFixCard } from "../PropertyVideoFixCard";
import { montajerMayUploadFinal } from "@royal-home/shared";
import type { Property } from "../../types";

/**
 * ПАНЕЛЬ МОНТАЖЁРА В КАРТОЧКЕ ОБЪЕКТА (25.09.2026, В1 спецификации
 * docs/handoff-2026-09-25-montage-control-spec.md). До этой правки
 * `PropertyVideoFixCard` для роли EDITOR не монтировался вообще —
 * `EditorPropertyDetail` его не рендерил. `viewer="montajer"` — тот же
 * компонент, короткая ветка: состояние монтажа, загрузка готового ролика в
 * своём окне (montajerMayUploadFinal), где вышел ролик. jsdom в проекте нет —
 * проверяем разметку первого рендера, как и соседний
 * PropertyVideoFixCardPlanned.test.tsx.
 */
const auth = vi.hoisted(() => ({ role: "EDITOR" as string }));
vi.mock("../../store/auth", () => ({
  useAuthStore: <T,>(select: (s: { agent: { id: string; role: string } }) => T) => select({ agent: { id: "editor1", role: auth.role } }),
}));

const HOUR = 3_600_000;

/** Окно montajerMayUploadFinal считается от настоящего Date.now() внутри
 *  компонента (не от подставного времени теста) — receivedAt/sentAt здесь
 *  обязаны идти от Date.now(), как и в соседнем PropertyVideoFixCardPlanned.test.tsx. */
function renderMontajer(property: Property) {
  // React SSR вставляет комментарии-якоря между интерполированными узлами
  // JSX (`{delivered}` и т.п.) — без зачистки строка вида «дошло 1 из 2»
  // никогда не встретится как подстрока целиком.
  return renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <PropertyVideoFixCard property={property} canEdit={false} viewer="montajer" />
    </QueryClientProvider>
  ).replace(/<!--\s*-->/g, "");
}

const basePropertyFields = {
  id: "p501",
  shortId: 501,
  type: "HOUSE",
  status: "EDITING",
  publishedChannels: [] as string[],
  videoHandoffFinalPath: null,
  videoCount: 2,
};

describe("PropertyVideoFixCard — режим монтажёра (viewer=\"montajer\")", () => {
  it("1) SENT_TO_EDITOR, 2 исходника (1 дошёл): монтаж, исходники, загрузка — но ни одной staff-кнопки", () => {
    const property = {
      ...basePropertyFields,
      videoHandoffStatus: "SENT_TO_EDITOR",
      videoHandoff: {
        status: "SENT_TO_EDITOR",
        queuePosition: null,
        heldAt: null,
        holdReason: null,
        sentAt: new Date(Date.now() - HOUR).toISOString(),
        deliveredAt: null,
        dispatchAttempts: 1,
        dispatchStartedAt: null,
        receivedAt: null,
        scheduledPublishAt: null,
        scheduledPublishReason: null,
        montajer: { id: "editor1", fullName: "Монтажёр панели" },
        finalVideoUrl: null,
        clipReview: { status: "NONE", requestedAt: null, decidedAt: null, decidedBy: null, comment: null },
        videos: [
          { id: "v1", name: "raw-1.mp4", sizeBytes: 1024, durationSec: null, hasAudio: null, delivered: true },
          { id: "v2", name: "raw-2.mp4", sizeBytes: 2048, durationSec: null, hasAudio: null, delivered: false },
        ],
      },
    } as unknown as Property;

    const html = renderMontajer(property);

    expect(html).toContain("Монтаж");
    expect(html).toContain("Исходники: дошло 1 из 2");
    expect(html).toContain("Загрузить готовый ролик");
    expect(html).toContain("Выбрать файл");
    expect(html).toContain("Прислать исходники заново");

    expect(html).not.toContain("Вернуть монтажёру");
    expect(html).not.toContain("Обновить подписи");
    expect(html).not.toContain("Убрать из соцсетей");
    expect(html).not.toContain("Истории Instagram");
    expect(html).not.toContain("Загрузить и выпустить сразу");
    expect(html).not.toContain("Опубликовать сейчас");
  });

  it("1б) QUEUED, отправки ещё не было: «ждут отправки», без «дошло 0 из N» и красных ✗ (ОБ-000160)", () => {
    const property = {
      ...basePropertyFields,
      videoHandoffStatus: "QUEUED",
      videoHandoff: {
        status: "QUEUED",
        queuePosition: 2,
        heldAt: null,
        holdReason: null,
        sentAt: null,
        deliveredAt: null,
        dispatchAttempts: 0,
        dispatchStartedAt: null,
        receivedAt: null,
        scheduledPublishAt: null,
        scheduledPublishReason: null,
        montajer: null,
        finalVideoUrl: null,
        clipReview: { status: "NONE", requestedAt: null, decidedAt: null, decidedBy: null, comment: null },
        videos: [
          { id: "v1", name: "IMG_1515.MOV", sizeBytes: 1024, durationSec: 113, hasAudio: true, delivered: false },
          { id: "v2", name: "IMG_1511.MOV", sizeBytes: 2048, durationSec: 8, hasAudio: true, delivered: false },
        ],
      },
    } as unknown as Property;

    const html = renderMontajer(property);

    expect(html).toContain("Исходники: 2, ждут отправки монтажёру");
    expect(html).not.toContain("дошло 0 из 2");
    expect(html).not.toContain("✗");
  });

  it("2) RECEIVED час назад, без публикаций, ролик одобрен: «Ваш ролик» и «Загрузить готовый ролик»", () => {
    const property = {
      ...basePropertyFields,
      videoHandoffStatus: "RECEIVED",
      videoHandoff: {
        status: "RECEIVED",
        queuePosition: null,
        heldAt: null,
        holdReason: null,
        sentAt: new Date(Date.now() - 2 * HOUR).toISOString(),
        deliveredAt: null,
        dispatchAttempts: 1,
        dispatchStartedAt: null,
        receivedAt: new Date(Date.now() - HOUR).toISOString(),
        scheduledPublishAt: null,
        scheduledPublishReason: null,
        montajer: { id: "editor1", fullName: "Монтажёр панели" },
        finalVideoUrl: "/uploads/handoff/p501-1.mp4",
        clipReview: { status: "APPROVED", requestedAt: null, decidedAt: null, decidedBy: "Директор", comment: null },
        videos: [],
      },
    } as unknown as Property;

    const html = renderMontajer(property);

    expect(html).toContain("Ваш ролик");
    expect(html).toContain("Загрузить готовый ролик");
    expect(html).toContain("Выбрать файл");
  });

  it("3) RECEIVED 4 часа назад — окно закрыто: нет «Выбрать файл», есть предупреждение про 3 часа", () => {
    const property = {
      ...basePropertyFields,
      videoHandoffStatus: "RECEIVED",
      videoHandoff: {
        status: "RECEIVED",
        queuePosition: null,
        heldAt: null,
        holdReason: null,
        sentAt: new Date(Date.now() - 5 * HOUR).toISOString(),
        deliveredAt: null,
        dispatchAttempts: 1,
        dispatchStartedAt: null,
        receivedAt: new Date(Date.now() - 4 * HOUR).toISOString(),
        scheduledPublishAt: null,
        scheduledPublishReason: null,
        montajer: { id: "editor1", fullName: "Монтажёр панели" },
        finalVideoUrl: "/uploads/handoff/p501-1.mp4",
        clipReview: { status: "APPROVED", requestedAt: null, decidedAt: null, decidedBy: "Директор", comment: null },
        videos: [],
      },
    } as unknown as Property;

    const html = renderMontajer(property);

    expect(html).not.toContain("Выбрать файл");
    expect(html).toContain("в течение 3 часов после приёма");
  });

  it("4) RECEIVED час назад, но уже вышел (YOUTUBE) — нет «Выбрать файл»", () => {
    const property = {
      ...basePropertyFields,
      videoHandoffStatus: "RECEIVED",
      publishedChannels: ["YOUTUBE"],
      videoHandoff: {
        status: "RECEIVED",
        queuePosition: null,
        heldAt: null,
        holdReason: null,
        sentAt: new Date(Date.now() - 2 * HOUR).toISOString(),
        deliveredAt: null,
        dispatchAttempts: 1,
        dispatchStartedAt: null,
        receivedAt: new Date(Date.now() - HOUR).toISOString(),
        scheduledPublishAt: null,
        scheduledPublishReason: null,
        montajer: { id: "editor1", fullName: "Монтажёр панели" },
        finalVideoUrl: "/uploads/handoff/p501-1.mp4",
        clipReview: { status: "APPROVED", requestedAt: null, decidedAt: null, decidedBy: "Директор", comment: null },
        videos: [],
      },
    } as unknown as Property;

    const html = renderMontajer(property);

    expect(html).not.toContain("Выбрать файл");
  });
});

describe("montajerMayUploadFinal — правило окна (те же 5 случаев, что в апи-тесте раздела 1)", () => {
  const nowMs = Date.now();

  it("SENT_TO_EDITOR — всегда true", () => {
    expect(montajerMayUploadFinal({ videoHandoffStatus: "SENT_TO_EDITOR", receivedAt: null, publishedChannels: [] }, nowMs)).toBe(true);
  });

  it("RECEIVED час назад, без публикаций — true", () => {
    expect(
      montajerMayUploadFinal(
        { videoHandoffStatus: "RECEIVED", receivedAt: new Date(nowMs - HOUR).toISOString(), publishedChannels: [] },
        nowMs
      )
    ).toBe(true);
  });

  it("RECEIVED 4 часа назад — окно вышло, false", () => {
    expect(
      montajerMayUploadFinal(
        { videoHandoffStatus: "RECEIVED", receivedAt: new Date(nowMs - 4 * HOUR).toISOString(), publishedChannels: [] },
        nowMs
      )
    ).toBe(false);
  });

  it("RECEIVED час назад, но уже опубликован — false", () => {
    expect(
      montajerMayUploadFinal(
        { videoHandoffStatus: "RECEIVED", receivedAt: new Date(nowMs - HOUR).toISOString(), publishedChannels: ["YOUTUBE"] },
        nowMs
      )
    ).toBe(false);
  });

  it("NONE — false", () => {
    expect(montajerMayUploadFinal({ videoHandoffStatus: "NONE", receivedAt: null, publishedChannels: [] }, nowMs)).toBe(false);
  });
});
