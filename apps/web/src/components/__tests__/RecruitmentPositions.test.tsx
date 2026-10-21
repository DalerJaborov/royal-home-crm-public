import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecruitmentPosition } from "@royal-home/shared";
import { createRecruitmentCatalogFixture } from "../../../tests/fixtures/recruitment-catalog";

const state = vi.hoisted(() => ({
  readOnly: false, canManage: true, editing: null as RecruitmentPosition | null,
  queries: vi.fn(), mutation: vi.fn(),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial === null ? state.editing : typeof initial === "function" ? initial() : initial, vi.fn()],
}));
vi.mock("../../lib/permissions", () => ({
  useCan: () => (permission: string) => permission !== "settings.manage" || state.canManage,
  useIsReadOnly: () => state.readOnly,
}));
vi.mock("../../store/auth", () => ({ useAuthStore: (selector: (value: unknown) => unknown) => selector({ agent: { id: "test-manager" }, sessionEpoch: 1 }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (config: { queryKey: string[]; enabled: boolean }) => {
    state.queries(config);
    const catalog = createRecruitmentCatalogFixture();
    return { data: { items: config.queryKey[0] === "recruitment-templates" ? catalog.templates : catalog.positions }, isPending: false, isError: false };
  },
  useMutation: () => ({ isPending: false, mutate: state.mutation }),
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));
import { RecruitmentPositions } from "../RecruitmentPositions";

beforeEach(() => {
  state.readOnly = false; state.canManage = true; state.editing = null;
  state.queries.mockClear(); state.mutation.mockClear();
});

describe("vacancy settings access and form hierarchy", () => {
  it("keeps the catalog visible but hides every write flow for a read-only profile with settings.manage", () => {
    state.readOnly = true;
    state.editing = createRecruitmentCatalogFixture().positions[0];
    const html = renderToStaticMarkup(<RecruitmentPositions />);
    expect(html).toContain("SMM-специалист / видеограф");
    expect(html).toContain("Доступен только просмотр вакансий");
    expect(html).not.toContain("Добавить вакансию");
    expect(html).not.toContain(">Изменить<");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Исправленные ответы кандидатам");
    expect(html).not.toContain("Добавить из заготовки");
    expect(state.queries.mock.calls.find(([config]) => config.queryKey[0] === "recruitment-templates")?.[0].enabled).toBe(false);
    expect(state.mutation).not.toHaveBeenCalled();
  });

  it("also hides editing without settings.manage while retaining the readable conditions", () => {
    state.canManage = false;
    const html = renderToStaticMarkup(<RecruitmentPositions />);
    expect(html).toContain("съёмка и монтаж коротких видео");
    expect(html).not.toContain("Добавить вакансию");
    expect(html).not.toContain(">Изменить<");
    expect(html).not.toContain("Исправленные ответы кандидатам");
  });

  it("keeps rules visible, technical mappings and recovery collapsed, and styles real form fields", () => {
    state.editing = createRecruitmentCatalogFixture().positions[0];
    const html = renderToStaticMarkup(<RecruitmentPositions />);
    expect(html).toContain("Что выяснить у кандидата на эту должность");
    expect(html).toContain("Можно совмещать с учёбой");
    expect(html).toContain("Публикации Instagram");
    expect(html).toContain('class="vacancy-field"');
    expect(html).toMatch(/<details class="vacancy-catalog-disclosure"><summary>Где находить отклики<\/summary>/);
    expect(html).toMatch(/<details class="vacancy-catalog-disclosure vacancy-catalog-recovery"><summary>Исправленные ответы кандидатам<\/summary>/);
    expect(html).toContain('class="vacancy-button"');
    expect(html).not.toContain('class="pill');
    expect(html).toContain("Отправить исправленные ответы ботом");
    expect(state.mutation).not.toHaveBeenCalled();
  });
});
