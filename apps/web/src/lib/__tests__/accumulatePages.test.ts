import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mergePageSlots, putPage, type PageSlots } from "../accumulatePages";

/**
 * Лента «Показать ещё» не замирает (аудит 23.09.2026, №38).
 *
 * После «Показать ещё» перечитанная страница выбрасывалась, а первая не
 * перечитывалась: новые чаты, звонки, клиенты не появлялись до смены фильтра.
 */
type Row = { id: string };
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));

describe("сборка ленты из страниц", () => {
  it("свежая первая страница после «Показать ещё» попадает в ленту", () => {
    let slots: PageSlots<Row> = new Map([[1, rows("a", "b")]]);
    slots = putPage(slots, 2, rows("c", "d"));
    // Пришло новое сообщение: всё сдвинулось на одну строку вниз.
    slots = putPage(slots, 1, rows("new", "a"));
    expect(mergePageSlots(slots).map((r) => r.id)).toEqual(["new", "a", "c", "d"]);
  });

  it("перечитанная вторая страница заменяет свою, а не выбрасывается и не задваивается", () => {
    let slots: PageSlots<Row> = new Map([[1, rows("a", "b")]]);
    slots = putPage(slots, 2, rows("c", "d"));
    slots = putPage(slots, 2, rows("b", "c"));
    expect(mergePageSlots(slots).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("строки без id не теряются", () => {
    const slots: PageSlots<string> = new Map([
      [2, ["x"]],
      [1, ["y", "x"]],
    ]);
    expect(mergePageSlots(slots)).toEqual(["y", "x", "x"]);
  });
});

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("живые ленты держат свежую первую страницу", () => {
  for (const file of [
    "../../pages/Messages.tsx",
    "../../pages/Clients.tsx",
    "../../pages/Calls.tsx",
    "../../pages/Comments.tsx",
    "../../pages/Properties.tsx",
  ]) {
    it(file, () => {
      const calls = read(file).match(/useAccumulatedPages\([\s\S]*?\);/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call).toMatch(/Head\?\.items|headPage\?\.items/);
    });
  }
});
