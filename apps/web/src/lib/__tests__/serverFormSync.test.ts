import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serverRefillPatch } from "../serverFormSync";

/**
 * НАСТРОЙКИ НЕ СТИРАЮТ НАБРАННОЕ, НО НЕ СОХРАНЁННОЕ (глубокая проверка
 * 02.10.2026, F3).
 *
 * Формы вкладок держали поля в своём состоянии и перезаливали их эффектом
 * `useEffect(() => { setX(settings.x) }, [settings])`. Любая правка настроек
 * (соседний тумблер, соседнее «Сохранить») кладёт в кэш НОВЫЙ объект, опрос раз
 * в 60 с — тоже: эффект срабатывал и молча возвращал набранные поля к старым
 * значениям. Теперь поле перезаливается, только если сервер поменял ИМЕННО его
 * и человек это поле не трогал.
 */
describe("serverRefillPatch — какие поля формы перезалить с сервера", () => {
  it("первая загрузка — заливаются все поля", () => {
    expect(serverRefillPatch({ a: "1", b: "2" }, undefined, { a: "", b: "" })).toEqual({ a: "1", b: "2" });
  });

  it("сервер прислал те же значения (соседний тумблер, опрос) — набранное не трогается", () => {
    const server = { start: "09:30", end: "18:00" };
    expect(serverRefillPatch({ ...server }, server, { start: "08:00", end: "18:00" })).toEqual({});
  });

  it("сервер поменял поле, которое человек не трогал — оно обновляется", () => {
    const last = { start: "09:30", end: "18:00" };
    expect(serverRefillPatch({ start: "09:30", end: "19:00" }, last, { start: "08:00", end: "18:00" })).toEqual({
      end: "19:00",
    });
  });

  it("сервер поменял поле, которое человек уже правит — набранное остаётся", () => {
    const last = { start: "09:30" };
    expect(serverRefillPatch({ start: "10:00" }, last, { start: "08:00" })).toEqual({});
  });

  it("число из мгновенного отклика и та же строка в поле — одно значение", () => {
    expect(serverRefillPatch({ minutes: 15 } as Record<string, unknown>, { minutes: "10" }, { minutes: "15" })).toEqual({});
  });

  it("сравнивает значения, а не объекты: списки и вложенные записи", () => {
    const last = { words: ["а", "б"] };
    expect(serverRefillPatch({ words: ["а", "б"] }, last, { words: ["а", "б", "в"] })).toEqual({});
    expect(serverRefillPatch({ words: ["а"] }, last, { words: ["а", "б"] })).toEqual({ words: ["а"] });
  });
});

/**
 * Сторож класса: ни одна форма настроек и профиля больше не перезаливает поля
 * эффектом по всему объекту настроек/профиля целиком.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = [
  "pages/Profile.tsx",
  ...fs
    .readdirSync(path.join(SRC, "pages/settings"))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => `pages/settings/${f}`),
];

describe("формы настроек не перезаливаются по объекту целиком", () => {
  it("нет эффектов с зависимостью [settings] / [profile] / [data], которые ставят поля формы", () => {
    const found: string[] = [];
    for (const rel of FILES) {
      const text = fs.readFileSync(path.join(SRC, rel), "utf8").replace(/\r\n/g, "\n");
      const re = /useEffect\(\(\) => \{((?:(?!useEffect\()[\s\S])*?)\}, \[(settings|profile|data)\]\);/g;
      for (const m of text.matchAll(re)) {
        if (/\bset[A-Z]\w*\(/.test(m[1])) {
          const line = text.slice(0, m.index).split("\n").length;
          found.push(`${rel}:${line}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
