import { beforeEach, describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CallClientButton } from "../CallClientButton";
const actor = vi.hoisted(() => ({ role: "AGENT", readOnly: false }));
vi.mock("../../store/auth", () => ({ useAuthStore: (select: (state: { agent: typeof actor }) => unknown) => select({ agent: actor }) }));
beforeEach(() => { actor.role = "AGENT"; actor.readOnly = false; });

/**
 * Прод 11.09.2026, iPhone iOS 18.7 Safari, главная: "undefined is not an object
 * (evaluating 'o.includes')" — стек начинался в CallClientButton (см. коммит
 * b49bb78d). Причина: phone был типизирован как обязательная string, а
 * Client.phone в БД nullable (лид без номера) — вызывающие места (AgentHome.tsx
 * и его телефонный двойник, слитый в него 06.10.2026) передавали client.phone напрямую без "?? ''", и
 * phone.includes("•") падал в самом рендере.
 *
 * jsdom в проекте не установлен (см. vitest.config.ts), поэтому это не тест
 * поведения по клику, а тест того, что ИМЕННО падало: сам факт рендера с
 * "плохими" значениями не должен бросать исключение. renderToString делает
 * только синхронный первый проход рендера (без эффектов, без сетевых
 * запросов React Query) — этого достаточно, чтобы поймать регрессию класса
 * "o.includes на undefined/null в рендере".
 */
function renderWithQueryClient(node: React.ReactElement): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderToString(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

describe("CallClientButton — не падает без телефона", () => {
  it("акционер не может звонить через клиентскую или кандидатскую кнопку", () => {
    actor.role = "SHAREHOLDER";
    expect(renderWithQueryClient(<CallClientButton clientId="client" phone="•••" />)).toBe("");
    expect(renderWithQueryClient(<CallClientButton candidateId="candidate" phone="•••" />)).toBe("");
  });
  it("серверный readOnly закрывает вызов и до обновления сохранённой роли", () => {
    actor.readOnly = true;
    expect(renderWithQueryClient(<CallClientButton clientId="client" phone="+992501234567" />)).toBe("");
  });
  it("рендерится с phone === undefined и без clientId (лид без номера)", () => {
    expect(() => renderWithQueryClient(<CallClientButton clientId={null} phone={undefined} />)).not.toThrow();
  });

  it("рендерится с phone === null и без clientId", () => {
    expect(() => renderWithQueryClient(<CallClientButton clientId={undefined} phone={null} />)).not.toThrow();
  });

  it("рендерится с phone === undefined и с clientId (карточка уже есть, номер ещё не назван)", () => {
    expect(() =>
      renderWithQueryClient(<CallClientButton clientId="11111111-1111-1111-1111-111111111111" phone={undefined} />)
    ).not.toThrow();
  });

  it("рендерится с замаскированным номером без clientId — показывает неактивную кнопку", () => {
    const html = renderWithQueryClient(<CallClientButton clientId={null} phone="+992•••••57" />);
    expect(html).toContain("cursor-not-allowed");
  });

  it("обычный номер без clientId — звонка с личного телефона нет, кнопка неактивна (29.09.2026)", () => {
    const html = renderWithQueryClient(<CallClientButton clientId={undefined} phone="+992501234567" />);
    expect(html).not.toContain("tel:");
    expect(html).toContain("cursor-not-allowed");
  });

  it("анкета кандидата — активная кнопка звонка через станцию, без tel:", () => {
    const html = renderWithQueryClient(
      <CallClientButton candidateId="22222222-2222-2222-2222-222222222222" phone="+992110001037" variant="full" />
    );
    expect(html).toContain("data-call-button");
    expect(html).not.toContain("tel:");
  });

  it("рендерится с clientId и валидным телефоном — активная кнопка звонка через CRM", () => {
    expect(() =>
      renderWithQueryClient(
        <CallClientButton clientId="11111111-1111-1111-1111-111111111111" phone="+992501234567" variant="full" />
      )
    ).not.toThrow();
  });
});
