import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * СТОРОЖ: СТРАНИЦА ПО `skip` СОРТИРУЕТСЯ С ДОБИВКОЙ ПО `id` (02.10.2026).
 *
 * Владелец: «во многих местах нет кнопки пагинации, которая работает
 * корректно». Одна из причин — порядок без уникального хвоста. Список
 * «Реклама» сортировался по `lastSyncedAt`, а одна синхронизация пишет всем
 * объявлениям одно и то же время; журнал безопасности — по
 * `securityReviewedAt`, который у всех непроверенных пуст. Postgres волен
 * отдавать равные строки в любом порядке на каждый запрос, и `OFFSET 20`
 * второй страницы показывал часть первой, а часть строк не показывал никогда.
 *
 * Правило: у каждого `findMany` со `skip` последний ключ сортировки — `id`.
 * Сторож читает исходники: находит `skip:` и смотрит на ближайший `orderBy`
 * того же вызова.
 */

const SRC_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated") continue;
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("страницы со skip сортируются с добивкой по id", () => {
  it("у каждого findMany со skip есть id в orderBy", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC_ROOT)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        // `skip: 1` у курсора Prisma и `skip: (req) => …` у ограничителя
        // запросов — не страницы по смещению.
        if (!/^\s*skip: \(?[a-zA-Z(]/.test(line) || /skip: \(req\)/.test(line)) return;
        const window = lines.slice(Math.max(0, i - 12), i);
        const orderIdx = window.map((l) => l.includes("orderBy:")).lastIndexOf(true);
        if (orderIdx === -1) return;
        const orderLine = window[orderIdx];
        // Сортировка внутри include (фото по order) не та — ищем ту, что
        // на уровне самого вызова: её отступ меньше или равен отступу skip.
        const indent = (s: string) => s.length - s.trimStart().length;
        if (indent(orderLine) > indent(line)) return;
        if (!/\bid: "(asc|desc)"/.test(orderLine)) {
          offenders.push(`${path.relative(SRC_ROOT, file)}:${i + 1 - (window.length - orderIdx)} ${orderLine.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
