import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { floorsFromDescription, parseRegistryList, parseRegistryProjectPage, registryProjectUrl } from "../src/lib/constructionRegistry/parse.js";

/**
 * Разбор данных реестра на образцах с memor.pro (20.11.2026): список (12 строк) и две страницы объекта (зелёная и красная).
 * Образцы лежат в tests/fixtures; контактов в них нет, номер управления замаскирован.
 */
const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("список реестра", () => {
  const raw = JSON.parse(fx("memor-list-sample.json")) as unknown;
  it("разбирает все строки образца, цвета известны", () => {
    const { items, skipped } = parseRegistryList(raw);
    expect(skipped).toBe(0);
    expect(items).toHaveLength(12);
    expect(new Set(items.map((i) => i.color))).toEqual(new Set(["green", "yellow", "red"]));
    expect(items.every((i) => i.hash.length === 32 && i.sourceId)).toBe(true);
  });
  it("ключ — поле id (qaror у садика совпадает с домом)", () => {
    const rows = [
      { id: "1-2020", qaror: "1-2020", lat: 38.55, lng: 68.75, color_status: "green", category: "residential" },
      { id: "1-2020-Б", qaror: "1-2020", lat: 38.55, lng: 68.75, color_status: "green", category: "educational" },
    ];
    expect(parseRegistryList(rows).items.map((i) => i.sourceId)).toEqual(["1-2020", "1-2020-Б"]);
  });
  it("не список — ошибка; битые строки считаются, а не теряются молча", () => {
    expect(() => parseRegistryList({ error: "x" })).toThrow();
    const { items, skipped } = parseRegistryList([
      { id: "a", lat: 38.55, lng: 68.75, color_status: "green" },
      { id: "b", lat: 0, lng: 0, color_status: "green" },
      { id: "c", lat: 38.55, lng: 68.75, color_status: "purple" },
      { id: "a", lat: 38.55, lng: 68.75, color_status: "green" },
    ]);
    expect(items).toHaveLength(1);
    expect(skipped).toBe(3);
  });
  it("хэш меняется вместе со значимым полем", () => {
    const a = parseRegistryList([{ id: "a", lat: 38.55, lng: 68.75, color_status: "green" }]).items[0]!.hash;
    const b = parseRegistryList([{ id: "a", lat: 38.55, lng: 68.75, color_status: "red" }]).items[0]!.hash;
    expect(a).not.toBe(b);
  });
});

describe("страница объекта", () => {
  it("зелёный: адрес, этажность, блок, шесть готовых документов, без предупреждения", () => {
    const p = parseRegistryProjectPage(fx("memor-page-green.html"));
    expect(p.address).toBe("кӯчаи Р.Набиев №12");
    expect(p.floors).toBe(14);
    expect(p.blocks).toEqual(["Блок А"]);
    expect(p.documents).toHaveLength(6);
    expect(p.documents.every((d) => d.ready)).toBe(true);
    expect(p.warning).toBeNull();
  });
  it("красный: документы не готовы, есть предупреждение, блоков нет", () => {
    const p = parseRegistryProjectPage(fx("memor-page-red.html"));
    expect(p.address).toContain("Назаршоев");
    expect(p.documents.some((d) => !d.ready)).toBe(true);
    expect(p.documents.some((d) => d.ready)).toBe(true);
    expect(p.warning).toContain("шартномаи ҳиссагузорӣ");
    expect(p.blocks).toEqual([]);
  });
  it("не выдумывает: пустая страница даёт пустой результат", () => {
    const p = parseRegistryProjectPage("<html><body>ничего</body></html>");
    expect(p).toEqual({ address: null, description: null, floors: null, blocks: [], documents: [], warning: null });
  });
  it("этажность", () => {
    expect(floorsFromDescription("Бинои истиқоматии 14 (чордаҳ) ошёна")).toBe(14);
    expect(floorsFromDescription("жилой дом 9 этажей")).toBe(9);
    expect(floorsFromDescription("Биноҳои баландошёна")).toBeNull();
    expect(floorsFromDescription(null)).toBeNull();
  });
});

describe("адрес страницы", () => {
  it("только домен реестра", () => {
    expect(registryProjectUrl("1-2020/")).toBe("https://www.memor.pro/sokhtmon/1-2020/");
    expect(registryProjectUrl("Talimi/1-2020-Б/")).toContain("/sokhtmon/Talimi/");
    expect(() => registryProjectUrl("https://evil.example/x")).toThrow();
  });
});
