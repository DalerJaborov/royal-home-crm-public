import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PropertyVideoFixCard } from "../PropertyVideoFixCard";
import { isPublishPlanned } from "../../lib/publishPlanned";
import type { Property } from "../../types";

/**
 * «Загрузить готовый ролик» в уже вышедший объект (владелец 24.09.2026, ОБ-000132:
 * «не могу добавить готовый ролик, куда-то в другое место уходит»). Ролик
 * принимался и вставал в расписание, а карточка молчала: строка «Публикация
 * запланирована» была только у объекта, который ещё нигде не вышел. jsdom в
 * проекте нет — проверяем правило и разметку первого рендера.
 */
// Роль — через подмену стора: renderToString читает у zustand начальное
// состояние (снимок сервера), setState до рендера он не видит.
const auth = vi.hoisted(() => ({ role: "ADMIN" as string }));
vi.mock("../../store/auth", () => ({
  useAuthStore: <T,>(select: (s: { agent: { id: string; role: string } }) => T) => select({ agent: { id: "a1", role: auth.role } }),
}));

const HOUR = 3_600_000;
const now = Date.parse("2026-09-24T10:45:00Z");

describe("isPublishPlanned", () => {
  const base = { videoHandoffFinalPath: "/uploads/handoff/x.mp4", videoHandoffStatus: "RECEIVED" };

  it("объект ещё нигде не вышел — строка есть, как и раньше", () => {
    expect(isPublishPlanned({ ...base, publishedChannels: [], scheduledPublishAt: new Date(now - HOUR).toISOString() }, now)).toBe(true);
  });

  it("уже вышел, новый ролик ждёт своего часа — строка есть", () => {
    expect(
      isPublishPlanned({ ...base, publishedChannels: ["YOUTUBE", "TIKTOK"], scheduledPublishAt: new Date(now + 4 * HOUR).toISOString() }, now)
    ).toBe(true);
  });

  it("уже вышел, час выхода в прошлом — строка гаснет", () => {
    expect(
      isPublishPlanned({ ...base, publishedChannels: ["YOUTUBE", "TIKTOK"], scheduledPublishAt: new Date(now - HOUR).toISOString() }, now)
    ).toBe(false);
  });

  it("уже вышел, но ролик ещё не принят (ждём монтажёра) — строки нет", () => {
    expect(
      isPublishPlanned(
        { ...base, videoHandoffStatus: "SENT_TO_EDITOR", publishedChannels: ["YOUTUBE"], scheduledPublishAt: new Date(now + HOUR).toISOString() },
        now
      )
    ).toBe(false);
  });

  it("ещё не вышел, но объект открыт под замену (файл в пути) — строки нет: час прежнего ролика ничего не обещает", () => {
    expect(
      isPublishPlanned({ ...base, videoHandoffStatus: "SENT_TO_EDITOR", publishedChannels: [], scheduledPublishAt: new Date(now + HOUR).toISOString() }, now)
    ).toBe(false);
  });

  it("нет принятого ролика или часа — строки нет", () => {
    expect(isPublishPlanned({ ...base, videoHandoffFinalPath: null, publishedChannels: [], scheduledPublishAt: new Date(now).toISOString() }, now)).toBe(false);
    expect(isPublishPlanned({ ...base, publishedChannels: [], scheduledPublishAt: null }, now)).toBe(false);
  });
});

const property = {
  id: "p132",
  shortId: 132,
  type: "HOUSE",
  status: "AVAILABLE",
  publishedChannels: ["YOUTUBE", "TIKTOK"],
  videoHandoffStatus: "RECEIVED",
  videoHandoffFinalPath: "/uploads/handoff/new.mp4",
  scheduledPublishAt: new Date(Date.now() + 4 * HOUR).toISOString(),
  scheduledPublishReason: "Час пик по тепловой карте.",
} as unknown as Property;

function renderAs(role: string) {
  auth.role = role;
  return renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <PropertyVideoFixCard property={property} canEdit />
    </QueryClientProvider>
  );
}

describe("PropertyVideoFixCard — вышедший объект с новым роликом в расписании", () => {
  it("«Публикация запланирована» и «Опубликовать сейчас» стоят сразу под загрузкой готового ролика", () => {
    const html = renderAs("ADMIN");
    const upload = html.indexOf("Загрузить готовый ролик");
    const planned = html.indexOf("Публикация запланирована");
    const captions = html.indexOf("Обновить подписи");
    expect(upload).toBeGreaterThan(-1);
    expect(planned).toBeGreaterThan(upload);
    expect(captions).toBeGreaterThan(planned);
    expect(html).toContain("туда, где объект ещё не вышел");
    expect(html).toContain("Опубликовать сейчас");
    expect(html).toContain("Час пик по тепловой карте.");
  });

  it("руководителю — «Загрузить и выпустить сразу» рядом с загрузкой по расписанию (владелец 24.09.2026)", () => {
    const html = renderAs("ADMIN");
    expect(html).toContain("Загрузить и выпустить сразу");
    expect(html).toContain("По расписанию");
  });

  it("агенту без права «Опубликовать сейчас» — только «Выбрать файл», без кнопок, которые ответят отказом", () => {
    const html = renderAs("AGENT");
    expect(html).toContain("Выбрать файл");
    expect(html).not.toContain("Загрузить и выпустить сразу");
    expect(html).not.toContain("Опубликовать сейчас");
  });
});

/* Истории Instagram — тот же requireMarketingRole на сервере, что и
   «Опубликовать сейчас» (24.09.2026, проверка по классам): раньше блок висел по
   одному canEdit, и ответственный агент нажимал кнопки, отвечавшие отказом. */
describe("PropertyVideoFixCard — истории только тем, кому сервер их разрешает", () => {
  it("руководителю — «Карточку объекта в истории» и «Ролик в истории»", () => {
    const html = renderAs("ADMIN");
    expect(html).toContain("Карточку объекта в истории");
    expect(html).toContain("Ролик в истории");
  });

  it("агенту — ни одной кнопки историй", () => {
    const html = renderAs("AGENT");
    expect(html).not.toContain("Карточку объекта в истории");
    expect(html).not.toContain("Ролик в истории");
  });

  it("объект без ролика и не на монтаже: блок всё равно на месте, но без кнопок маркетинга (07.10.2026)", () => {
    auth.role = "AGENT";
    const bare = { ...property, publishedChannels: [], videoHandoffFinalPath: null, videoHandoffStatus: "NONE", status: "AVAILABLE" } as unknown as Property;
    const html = renderToString(
      <QueryClientProvider client={new QueryClient()}>
        <PropertyVideoFixCard property={bare} canEdit />
      </QueryClientProvider>
    );
    expect(html).toContain("Ролик и соцсети");
    expect(html).toContain("Вернуть монтажёру");
    expect(html).toContain("Загрузить готовый ролик");
    expect(html).not.toContain("Опубликовать сейчас");
    expect(html).not.toContain("Карточку объекта в истории");
  });
});
