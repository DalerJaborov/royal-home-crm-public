import { describe, expect, it } from "vitest";
import { propertyReviewActionRow, readOnlyPultRows, summarizePultActionStatus } from "../PultActions";
import type { ActionRowData } from "../ActionRow";

const ready = { isLoading: false, isError: false };

it("акционер видит сгруппированные решения, но без вложенных и массовых мутаций", () => {
  const leaf: ActionRowData = { id: "leaf", tone: "warn", avatar: { label: "К", tone: "aqua" }, title: "Клиент", actions: [{ label: "Передать", endpoint: "/clients/1/transfer", doneMessage: "Передан", onRun: async () => true }], links: [{ label: "Открыть", href: "/clients/1" }] };
  const group: ActionRowData = { id: "group", tone: "warn", avatar: { label: "2", tone: "aqua" }, title: "Группа", actions: [], members: [leaf], bulkLabel: "Передать всех", bulkEndpoint: "/clients/transfer" };
  const [shown] = readOnlyPultRows([group]);
  expect(shown.bulkLabel).toBeUndefined();
  expect(shown.bulkEndpoint).toBeUndefined();
  expect(shown.members?.[0].actions).toEqual([]);
  expect(shown.members?.[0].links).toEqual(leaf.links);
  expect(leaf.actions).toHaveLength(1);
});

describe("очередь не принимает ошибку отдельного запроса за отсутствие решений", () => {
  it.each([0, 1, 2])("ошибка источника %i видна при остальных успешных ответах", (index) => {
    const queries = [ready, ready, ready];
    queries[index] = { isLoading: false, isError: true };
    expect(summarizePultActionStatus(queries)).toEqual({ isLoading: false, isError: true });
  });

  it("частичная ошибка сохраняется, пока другой источник ещё загружается", () => {
    expect(summarizePultActionStatus([ready, { isLoading: false, isError: true }, { isLoading: true, isError: false }]))
      .toEqual({ isLoading: true, isError: true });
  });

  it("успешные источники не показывают предупреждение", () => {
    expect(summarizePultActionStatus([ready, ready, ready])).toEqual({ isLoading: false, isError: false });
  });
});

describe("проверка материалов из пульта", () => {
  it("ведёт в настоящую карточку, не одобряет фото вслепую", () => {
    const row = propertyReviewActionRow({ id: "uuid-42", shortId: 42, title: "Квартира" });
    expect(row.actions).toEqual([]);
    expect(row.links).toEqual([{ label: "Проверить материалы", href: "/properties/42" }]);
    expect(row.title).toContain("ОБ-000042");
    expect(row.description).toContain("Квартира");
  });
});
