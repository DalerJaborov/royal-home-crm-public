import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JOB_TYPE_LABELS, jobTypeLabel } from "../src/lib/stuckWork.js";

/**
 * Ночная проверка 01.10.2026, №240: тип фонового задания шёл на экран «Что не
 * доехало» и в пуш сырым кодом (`seller-photo-insight`). Теперь у каждого типа
 * очереди есть русское название, а незнакомый тип показывается общим словом.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

/** Типы, которые регистрирует очередь: `type: "x"` в обработчике и константы `*_JOB_TYPE = "x"`. */
function registeredTypes(): string[] {
  const found = new Set<string>();
  for (const file of fs.readdirSync(path.join(SRC, "jobs"))) {
    for (const m of read(`jobs/${file}`).matchAll(/^ {2}type: "([a-z]+(?:-[a-z]+)*)",$/gm)) found.add(m[1]);
    for (const m of read(`jobs/${file}`).matchAll(/_JOB_TYPE = "([a-z]+(?:-[a-z]+)*)"/g)) found.add(m[1]);
  }
  for (const file of fs.readdirSync(path.join(SRC, "lib"))) {
    if (!file.endsWith(".ts")) continue;
    for (const m of read(`lib/${file}`).matchAll(/_JOB_TYPE = "([a-z]+(?:-[a-z]+)*)"/g)) found.add(m[1]);
  }
  // Типы JSON-схем (`type: "object"` в описании ответа модели) — не задания очереди.
  for (const jsonType of ["object", "array", "string", "number", "boolean", "integer"]) found.delete(jsonType);
  return [...found].sort();
}

describe("названия типов фоновых заданий", () => {
  it("разбор исходников нашёл обработчики очереди", () => {
    expect(registeredTypes().length).toBeGreaterThanOrEqual(20);
  });

  it("у каждого типа очереди есть русское название", () => {
    const missing = registeredTypes().filter((t) => !JOB_TYPE_LABELS[t]);
    expect(missing).toEqual([]);
  });

  it("в словаре нет типов, которых очередь не знает (устаревшая строка)", () => {
    const known = new Set(registeredTypes());
    expect(Object.keys(JOB_TYPE_LABELS).filter((t) => !known.has(t))).toEqual([]);
  });

  it("название — по-русски, без латиницы и кода", () => {
    for (const [type, label] of Object.entries(JOB_TYPE_LABELS)) {
      expect(label, type).toMatch(/[А-Яа-яЁё]/);
      expect(label, type).not.toContain(type);
    }
  });

  it("незнакомый тип — общее слово, а не сырой код", () => {
    expect(jobTypeLabel("some-new-job")).toBe("Фоновое задание");
    expect(jobTypeLabel("seller-photo-insight")).toBe("Оценка фото продавца");
  });
});
