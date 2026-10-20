import { describe, expect, it, vi } from "vitest";

/**
 * ГРУППЫ ДУБЛЕЙ — ТРАНЗИТИВНАЯ СВЯЗНОСТЬ (аудит Codex 04.10.2026, ACCESS-09).
 *
 * Так было: жадное слияние брало у группы ключа ПЕРВЫЙ уже известный индекс и
 * дописывало остальных только туда. Клиенты A(тел1, tgsolo), B(тел2, tgbridge),
 * C(тел1, tgbridge), D(тел2) — один человек по цепочке, а выходило
 * [[A,C],[B,D,C]]: C в двух группах, в дайджесте «2 пары» вместо одной.
 */

const clients: Array<Record<string, unknown>> = [];
vi.mock("../src/db.js", () => ({
  prisma: {
    $disconnect: vi.fn(),
    client: {
      count: vi.fn(async () => clients.length),
      findMany: vi.fn(async () => clients),
    },
  },
}));

const { findDuplicateClientGroups } = await import("../src/lib/duplicateClients.js");

function mk(id: string, phone: string, tg: string | null, minute: number) {
  return {
    id,
    fullName: id,
    phone,
    status: "NEW",
    source: "TELEGRAM",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)),
    telegramChatId: null,
    telegramUsername: tg,
    assignedAgent: null,
    _count: { interactions: 0, deals: 0 },
  };
}

describe("findDuplicateClientGroups", () => {
  it("мост между двумя уже собранными группами объединяет всё в одну группу", async () => {
    clients.length = 0;
    clients.push(
      mk("A", "+992900000001", "tgsolo", 1),
      mk("B", "+992900000002", "tgbridge", 2),
      mk("C", "+992900000001", "tgbridge", 3),
      mk("D", "+992900000002", null, 4)
    );
    const found = await findDuplicateClientGroups();
    if (found.overLimit) throw new Error("overLimit");
    expect(found.groups).toHaveLength(1);
    expect(found.groups[0].clients.map((c) => c.id)).toEqual(["A", "B", "C", "D"]);
    const idx = new Set(["A", "B", "C", "D"].map((id) => found.clientToGroup.get(id)));
    expect(idx.size).toBe(1);
  });

  it("независимые пары остаются двумя группами, одиночки не попадают", async () => {
    clients.length = 0;
    clients.push(
      mk("A", "+992900000001", null, 1),
      mk("B", "+992900000001", null, 2),
      mk("C", "+992900000003", null, 3),
      mk("D", "+992900000003", null, 4),
      mk("E", "+992900000005", null, 5)
    );
    const found = await findDuplicateClientGroups();
    if (found.overLimit) throw new Error("overLimit");
    expect(found.groups.map((g) => g.clients.map((c) => c.id))).toEqual([["A", "B"], ["C", "D"]]);
    expect(found.clientToGroup.get("A")).toBe(found.clientToGroup.get("B"));
    expect(found.clientToGroup.get("A")).not.toBe(found.clientToGroup.get("C"));
    expect(found.clientToGroup.has("E")).toBe(false);
  });
});
