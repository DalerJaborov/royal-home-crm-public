import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { httpStatusMessage } from "../httpStatusMessage";

/**
 * Код ответа на экране — не текст для человека (ночная проверка 01.10.2026,
 * №236). Раньше «Ошибка запроса: 500» / «Ошибка 502» показывались, когда сервер
 * не прислал своего текста; теперь код превращается в слова.
 */
describe("httpStatusMessage", () => {
  it("в тексте нет цифр кода и нет слова HTTP — для любого кода", () => {
    for (const status of [0, 400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504, 599, 200]) {
      const text = httpStatusMessage(status);
      expect(text, String(status)).not.toMatch(/\d{3}|HTTP/);
      expect(text, String(status)).toMatch(/[А-Яа-яЁё]/);
    }
  });

  it("разные стороны сбоя называются по-разному", () => {
    expect(httpStatusMessage(500)).toContain("Сбой на сервере");
    expect(httpStatusMessage(502)).toContain("временно недоступен");
    expect(httpStatusMessage(503)).toContain("временно недоступен");
    expect(httpStatusMessage(504)).toContain("не ответил вовремя");
    expect(httpStatusMessage(413)).toContain("слишком большой");
    expect(httpStatusMessage(404)).toContain("Не найдено");
    expect(httpStatusMessage(418)).toContain("не принял запрос");
  });
});

describe("сторож: код ответа не подставляется в текст для человека", () => {
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(full);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
    });

  it("нет шаблонов «Ошибка запроса: ${status}» и «Ошибка ${status}»", () => {
    const bad: string[] = [];
    for (const file of walk(SRC)) {
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (/`Ошибка(?: запроса:)? \$\{[^}]*status[^}]*\}`/i.test(line)) bad.push(`${path.relative(SRC, file)}:${i + 1}`);
        });
    }
    expect(bad).toEqual([]);
  });
});
