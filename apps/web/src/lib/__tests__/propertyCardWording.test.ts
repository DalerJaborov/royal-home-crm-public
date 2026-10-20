import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Карточка объекта: обычные слова и порядок на телефоне (24.09.2026, разбор
 * карточки, пункты 10, 11, 12 и G).
 *
 * Разметку целиком не отрисовать без сервера (карточка тянет десяток запросов),
 * поэтому проверяем исходник: служебных слов на экране нет, а на телефоне «Кто
 * ведёт объект» стоит раньше статистики.
 */
const src = readFileSync(fileURLToPath(new URL("../../pages/PropertyDetail.tsx", import.meta.url)), "utf8");
// Только то, что видит человек: строки JSX и строковые литералы, без комментариев.
const visible = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("карточка объекта говорит обычными словами", () => {
  it.each([
    ["удобно для демо на ревью"],
    ["конвейере подготовки"],
    ["Синхронизация…"],
    ['"Вставить"'],
    ["переместится в Корзину (Архив)"],
    ["<b>Корзина</b>"],
  ])("нет «%s»", (phrase) => {
    expect(visible).not.toContain(phrase);
  });

  it("номер объекта в шапке телефона — мелкой строкой, а не в заголовке", () => {
    expect(src).not.toContain("title={`${formatPropertyCode(property.shortId)} · ${property.title}`}");
  });

  it("поле номера собственника без служебной подписи про «полный доступ»", () => {
    expect(visible).not.toContain("право на полный доступ к объектам");
    expect(visible).toContain("Телефон собственника");
  });

  it("кнопка помощника называет, что сделает", () => {
    expect(visible).toContain("Написать черновик");
  });
});

describe("порядок блоков в просмотре", () => {
  it("«Кто ведёт объект» и «Описание» идут раньше ролика и статистики", () => {
    // Одна раскладка на ПК и телефон (06.10.2026): блоки в разметке `PropertyViewCard`,
    // вкладки с роликом и статистикой стоят под основной частью.
    const start = src.indexOf("function PropertyViewCard(");
    const end = src.indexOf("function TrashedBanner(");
    expect(start).toBeGreaterThan(0);
    const card = src.slice(start, end);
    // Заголовок «Кто ведёт объект» с 24.09.2026 рисует PropertyOwnerCard (передача и
    // принятие объекта); в просмотре он собран в `fieldsBlock` (правка на месте).
    const people = card.indexOf("{fieldsBlock}");
    const description = card.indexOf('<Card title="Описание">');
    const stats = card.indexOf("<PropertyStatsCard");
    const videoFix = card.indexOf("<PropertyVideoFixCard");
    expect(people).toBeGreaterThan(0);
    expect(people).toBeLessThan(videoFix);
    expect(description).toBeLessThan(videoFix);
    expect(videoFix).toBeLessThan(stats);
  });
});
