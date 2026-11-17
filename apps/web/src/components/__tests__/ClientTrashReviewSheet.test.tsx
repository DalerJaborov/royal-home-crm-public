import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { ClientTrashReviewSheet } from "../ClientTrashReviewSheet";

/**
 * «Разбор удалённого клиента» (владелец 16.11.2026): шторка в Архиве показывает, кто удалил, чей клиент
 * был, причину, журнал и историю, а кнопка «Позвонить» есть только у того, у кого есть право.
 * jsdom в проекте нет — как и соседние тесты, смотрим на первый проход рендера; шторка и кнопка заменены
 * заглушками (портал и сеть в renderToString не работают).
 */
const state = vi.hoisted(() => ({ granted: new Set<string>(), data: null as unknown }));

vi.mock("../../lib/permissions", () => ({ useCan: () => (id: string) => state.granted.has(id) }));
vi.mock("../../hooks/useClients", () => ({
  useClientTrashReview: () => ({ data: state.data, isLoading: false, isError: false, refetch: () => undefined }),
}));
vi.mock("../rh2/Rh2Sheet", () => ({
  Rh2Sheet: ({ title, children, footer }: { title: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) => (
    <div>
      <h2>{title}</h2>
      {children}
      <footer>{footer}</footer>
    </div>
  ),
}));
vi.mock("../CallClientButton", () => ({
  CallClientButton: ({ clientId, phone, label }: { clientId?: string; phone?: string; label?: string }) => (
    <button data-call={clientId} data-phone={phone}>
      {label}
    </button>
  ),
}));
vi.mock("../InteractionTimeline", () => ({
  InteractionTimeline: ({ interactions }: { interactions: { id: string; notes: string }[] }) => (
    <ul>{interactions.map((i) => <li key={i.id}>{i.notes}</li>)}</ul>
  ),
}));

function review(overrides: Record<string, unknown> = {}) {
  return {
    client: {
      id: "c1",
      shortId: 12,
      fullName: "Клиент Тестов",
      kind: "BUYER",
      status: "CONTACTED",
      createdAt: "2026-11-01T10:00:00.000Z",
      deletedAt: "2026-11-10T10:00:00.000Z",
      deletedBy: { id: "d1", fullName: "Директор Иванов" },
      deletedAutomatically: false,
      owner: { id: "a1", fullName: "Агент Петров" },
    },
    deleteRequest: {
      reason: "DUPLICATE",
      reasonLabel: "Дубль — этот человек уже есть в CRM другой карточкой",
      comment: null,
      status: "APPROVED",
      requestedBy: { id: "a1", fullName: "Агент Петров" },
      createdAt: "2026-11-09T10:00:00.000Z",
      decidedBy: { id: "d1", fullName: "Директор Иванов" },
      decidedAt: "2026-11-10T10:00:00.000Z",
      decisionNote: null,
    },
    audit: [{ id: "x1", action: "TRASH", label: "Удалил в Корзину", agentName: "Директор Иванов", createdAt: "2026-11-10T10:00:00.000Z" }],
    interactions: [{ id: "i1", notes: "Звонил, не отвечает" }],
    interactionsTotal: 1,
    canCall: true,
    ...overrides,
  };
}

function render() {
  return renderToString(<ClientTrashReviewSheet clientId="c1" phone="+992•••••57" onClose={() => undefined} />);
}

beforeEach(() => {
  state.granted = new Set(["archive.view", "clients.callArchived"]);
  state.data = review();
});

describe("ClientTrashReviewSheet", () => {
  it("показывает, кто удалил, чей клиент был, причину, журнал и историю", () => {
    const html = render();
    expect(html).toContain("Разбор: Клиент Тестов");
    expect(html).toContain("Директор Иванов");
    expect(html).toContain("Агент Петров");
    expect(html).toContain("Дубль");
    expect(html).toContain("Удалил в Корзину");
    expect(html).toContain("Звонил, не отвечает");
  });

  it("кнопка «Позвонить клиенту» с маской номера — только при праве и canCall", () => {
    expect(render()).toContain("Позвонить клиенту");
    expect(render()).toContain('data-phone="+992•••••57"');
    state.granted = new Set(["archive.view"]);
    expect(render()).not.toContain("Позвонить клиенту");
    state.granted = new Set(["archive.view", "clients.callArchived"]);
    state.data = review({ canCall: false });
    expect(render()).not.toContain("Позвонить клиенту");
  });

  it("без заявки на удаление честно пишет, что причины нет", () => {
    state.data = review({ deleteRequest: null });
    expect(render()).toContain("Причина не указана");
  });

  it("удаление автоматикой подписано как «Автоматически»", () => {
    const base = review();
    state.data = review({ client: { ...base.client, deletedBy: null, deletedAutomatically: true } });
    expect(render()).toContain("Автоматически");
  });
});
