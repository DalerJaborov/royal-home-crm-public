import { describe, expect, it, vi } from "vitest";

/**
 * Дубли по адресу при создании объекта (docs/flow-audit-property-11-09.md #3,
 * Пачка 9). Ключ дедупликации — normalizePropertyAddress (routes/properties/
 * shared.ts): регистр, лишние пробелы и типичная пунктуация не должны превращать
 * один и тот же дом в два разных объекта только из-за того, что агенты
 * напечатали адрес по-разному.
 *
 * Мокаем db.js — файл не должен трогать настоящую базу (её в этом worktree нет),
 * а normalizePropertyAddress — чистая функция, ей база не нужна вовсе.
 */
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: vi.fn() } }));
vi.mock("../src/jobs/enqueue.js", () => ({ enqueueBackgroundJob: vi.fn() }));

import { normalizePropertyAddress } from "../src/routes/properties/shared.js";

describe("normalizePropertyAddress — ключ дедупликации объекта", () => {
  it("регистр и лишние пробелы не создают разных ключей", () => {
    expect(normalizePropertyAddress("Рудаки  12")).toBe(normalizePropertyAddress("рудаки 12"));
  });

  it("типичная пунктуация (точки, запятые, №, кавычки) не участвует в ключе", () => {
    expect(normalizePropertyAddress("Рудаки, д.12, кв. 5")).toBe(normalizePropertyAddress("Рудаки д 12 кв 5"));
    expect(normalizePropertyAddress('ул. Айни, №12 «Лотос»')).toBe(normalizePropertyAddress("ул Айни 12 Лотос"));
  });

  it("разные дома дают разные ключи", () => {
    expect(normalizePropertyAddress("Рудаки 12")).not.toBe(normalizePropertyAddress("Рудаки 14"));
  });

  it("обрезает начальные/конечные пробелы", () => {
    expect(normalizePropertyAddress("  Сомони 5  ")).toBe(normalizePropertyAddress("Сомони 5"));
  });
});

/**
 * Единый вид сокращений (15.09.2026, точная проверка дублей на шаге «Где»,
 * решение владельца: «пусть механизм будет быстрым и правильным, чтобы от себя
 * не придумывал, что это дубль» — список правил ЯВНЫЙ, каждое отдельным тестом).
 */
describe("normalizePropertyAddress — сокращения (единый канонный вид)", () => {
  it('"ул." и "улица" — один и тот же токен', () => {
    expect(normalizePropertyAddress("ул. Рудаки 12")).toBe(normalizePropertyAddress("улица Рудаки 12"));
  });

  it('"мкр"/"мкрн" — "микрорайон"', () => {
    expect(normalizePropertyAddress("30 мкр, дом 5")).toBe(normalizePropertyAddress("30 микрорайон дом 5"));
    expect(normalizePropertyAddress("30 мкрн, дом 5")).toBe(normalizePropertyAddress("30 микрорайон дом 5"));
  });

  it('"пр."/"просп." — "проспект"', () => {
    expect(normalizePropertyAddress("пр. Сомони 1")).toBe(normalizePropertyAddress("проспект Сомони 1"));
    expect(normalizePropertyAddress("просп. Сомони 1")).toBe(normalizePropertyAddress("проспект Сомони 1"));
  });

  it('служебное "д." перед номером дома убирается целиком', () => {
    expect(normalizePropertyAddress("Рудаки д.12")).toBe(normalizePropertyAddress("Рудаки 12"));
  });

  it('"д" НЕ перед числом — обычное слово, не вырезается (например, часть топонима)', () => {
    expect(normalizePropertyAddress("Рудаки д Замок")).not.toBe(normalizePropertyAddress("Рудаки Замок"));
  });

  it("сокращения работают вместе, а не по отдельности", () => {
    expect(normalizePropertyAddress('ул. Айни, д.12, кв. 5')).toBe(normalizePropertyAddress("улица Айни 12 кв 5"));
  });
});
