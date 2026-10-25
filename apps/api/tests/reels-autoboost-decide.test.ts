import { describe, expect, it } from "vitest";
import {
  decideReelsAutoBoost,
  FAILED_MAX_ATTEMPTS,
  FAILED_RETRY_AFTER_MS,
  unfitReason,
  type ReelFact,
  type ReelRecord,
  type ReelsAutoBoostRules,
} from "../src/lib/ads/reelsAutoBoostDecide.js";

const NOW = new Date("2026-10-23T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

const rules = (over: Partial<ReelsAutoBoostRules> = {}): ReelsAutoBoostRules => ({
  dryRun: false,
  maxActive: 30,
  maxAgeDays: 10,
  stopLossSpendUsd: 4,
  ...over,
});

const fact = (id: string, over: Partial<ReelFact> = {}): ReelFact => ({
  propertyId: `p-${id}`,
  mediaId: `m-${id}`,
  publishedAt: daysAgo(1),
  status: "AVAILABLE",
  deleted: false,
  offSite: false,
  publishedOnSite: true,
  ...over,
});

const rec = (id: string, over: Partial<ReelRecord> = {}): ReelRecord => ({
  propertyId: `p-${id}`,
  mediaId: `m-${id}`,
  status: "ACTIVE",
  createdAt: daysAgo(1),
  updatedAt: daysAgo(1),
  attempts: 1,
  spendUsd: null,
  conversations: null,
  ...over,
});

const decide = (facts: ReelFact[], records: ReelRecord[], r = rules()) =>
  decideReelsAutoBoost({ facts, records }, NOW, r);

describe("decideReelsAutoBoost — создание", () => {
  it("новый подходящий ролик → create с человеческой причиной", () => {
    const out = decide([fact("a")], []);
    expect(out).toEqual([
      expect.objectContaining({ kind: "create", mediaId: "m-a", propertyId: "p-a", reason: expect.stringMatching(/новый ролик/) }),
    ]);
  });

  it.each([
    ["объект продан", { status: "SOLD" }],
    ["объект в резерве", { status: "RESERVED" }],
    ["объект снят", { status: "WITHDRAWN" }],
    ["объект в корзине", { deleted: true }],
    ["объект закрытый", { offSite: true }],
    ["не опубликован на сайте", { publishedOnSite: false }],
  ] as const)("не создаём, если %s", (_name, over) => {
    expect(decide([fact("a", over)], [])).toEqual([]);
  });

  it("дата публикации неизвестна → не создаём (не гадаем)", () => {
    expect(decide([fact("a", { publishedAt: null })], [])).toEqual([]);
  });

  it("граница возраста: ровно maxAgeDays — ещё создаём, чуть больше — нет", () => {
    expect(decide([fact("a", { publishedAt: daysAgo(10) })], [])).toHaveLength(1);
    expect(decide([fact("a", { publishedAt: new Date(daysAgo(10).getTime() - 1000) })], [])).toEqual([]);
  });

  it("идемпотентность: любая запись об этом media id (даже PAUSED/SKIPPED/ACTIVE) — повторно не создаём", () => {
    for (const status of ["PAUSED", "SKIPPED", "ACTIVE", "PLANNED"] as const) {
      const out = decide([fact("a")], [rec("a", { status })], rules({ dryRun: true }));
      expect(out.some((a) => a.kind === "create")).toBe(false);
    }
  });

  it("FAILED повторяем не раньше чем через 6 часов и не больше трёх попыток", () => {
    const soon = rec("a", { status: "FAILED", attempts: 1, updatedAt: new Date(NOW.getTime() - FAILED_RETRY_AFTER_MS + 1000) });
    const later = rec("a", { status: "FAILED", attempts: 1, updatedAt: new Date(NOW.getTime() - FAILED_RETRY_AFTER_MS) });
    const spent = rec("a", { status: "FAILED", attempts: FAILED_MAX_ATTEMPTS, updatedAt: daysAgo(2) });
    expect(decide([fact("a")], [soon])).toEqual([]);
    expect(decide([fact("a")], [later]).map((a) => a.kind)).toEqual(["create"]);
    expect(decide([fact("a")], [spent])).toEqual([]);
  });
});

describe("decideReelsAutoBoost — пауза", () => {
  it.each([
    ["продан", { status: "SOLD" }, /продан/],
    ["в резерве", { status: "RESERVED" }, /резерве/],
    ["снят с продажи", { status: "WITHDRAWN" }, /снят с продажи/],
    ["в корзине", { deleted: true }, /корзине/],
    ["ушёл с сайта", { publishedOnSite: false }, /снят с сайта/],
    ["стал закрытым", { offSite: true }, /закрытый/],
  ] as const)("объект %s → pause", (_n, over, re) => {
    const out = decide([fact("a", over)], [rec("a")]);
    expect(out).toEqual([expect.objectContaining({ kind: "pause", mediaId: "m-a", reason: expect.stringMatching(re) })]);
  });

  it("ролик пропал из фактов (удалён из Instagram или заменён) → pause", () => {
    const out = decide([], [rec("a")]);
    expect(out).toEqual([expect.objectContaining({ kind: "pause", reason: expect.stringMatching(/снят с Instagram/) })]);
  });

  it("старше maxAgeDays → pause; ровно maxAgeDays — keep", () => {
    expect(decide([fact("a", { publishedAt: daysAgo(10) })], [rec("a")]).map((a) => a.kind)).toEqual(["keep"]);
    const old = decide([fact("a", { publishedAt: daysAgo(10.5) })], [rec("a")]);
    expect(old).toEqual([expect.objectContaining({ kind: "pause", reason: expect.stringMatching(/старше 10 дн/) })]);
  });

  it("неизвестная дата публикации у активной записи: возраст считается от создания записи", () => {
    const f = fact("a", { publishedAt: null });
    expect(decide([f], [rec("a", { createdAt: daysAgo(3) })]).map((a) => a.kind)).toEqual(["keep"]);
    expect(decide([f], [rec("a", { createdAt: daysAgo(11) })]).map((a) => a.kind)).toEqual(["pause"]);
  });

  describe("стоп-лосс", () => {
    it("потратил ровно порог и 0 переписок → pause", () => {
      const out = decide([fact("a")], [rec("a", { spendUsd: 4, conversations: 0 })]);
      expect(out).toEqual([expect.objectContaining({ kind: "pause", reason: expect.stringMatching(/стоп-лосс/) })]);
    });
    it("conversations null (нет данных) при расходе ≥ порога тоже считается нулём", () => {
      expect(decide([fact("a")], [rec("a", { spendUsd: 5, conversations: null })])[0].kind).toBe("pause");
    });
    it("не дотянул до порога → keep", () => {
      expect(decide([fact("a")], [rec("a", { spendUsd: 3.99, conversations: 0 })])[0].kind).toBe("keep");
    });
    it("есть хотя бы одна переписка → keep", () => {
      expect(decide([fact("a")], [rec("a", { spendUsd: 40, conversations: 1 })])[0].kind).toBe("keep");
    });
    it("расход неизвестен (null) → keep", () => {
      expect(decide([fact("a")], [rec("a", { spendUsd: null, conversations: 0 })])[0].kind).toBe("keep");
    });
    it("порог 0 отключает стоп-лосс", () => {
      expect(decide([fact("a")], [rec("a", { spendUsd: 100, conversations: 0 })], rules({ stopLossSpendUsd: 0 }))[0].kind).toBe("keep");
    });
  });

  it("уже PAUSED/SKIPPED/FAILED записи в решениях не участвуют", () => {
    const out = decide([fact("a", { status: "SOLD" })], [rec("a", { status: "PAUSED" }), rec("b", { status: "SKIPPED" })]);
    expect(out).toEqual([]);
  });
});

describe("decideReelsAutoBoost — лимит одновременных", () => {
  it("за лимит выходят самые старые: они паузятся, остальные keep", () => {
    const ids = ["a", "b", "c"];
    const facts = ids.map((id, i) => fact(id, { publishedAt: daysAgo(i + 1) })); // a свежее b свежее c
    const out = decide(facts, ids.map((id) => rec(id)), rules({ maxActive: 2 }));
    const byMedia = Object.fromEntries(out.map((a) => [a.mediaId, a.kind]));
    expect(byMedia).toEqual({ "m-a": "keep", "m-b": "keep", "m-c": "pause" });
    expect(out.find((a) => a.mediaId === "m-c")?.reason).toMatch(/лимит 2/);
  });

  it("новый свежий ролик вытесняет самый старый активный при полном лимите", () => {
    const facts = [fact("new", { publishedAt: daysAgo(0.1) }), fact("old", { publishedAt: daysAgo(8) }), fact("mid", { publishedAt: daysAgo(3) })];
    const out = decide(facts, [rec("old"), rec("mid")], rules({ maxActive: 2 }));
    const byMedia = Object.fromEntries(out.map((a) => [a.mediaId, a.kind]));
    expect(byMedia).toEqual({ "m-new": "create", "m-mid": "keep", "m-old": "pause" });
  });

  it("новые кандидаты сверх лимита не создаются и не пишутся", () => {
    const facts = [fact("a", { publishedAt: daysAgo(1) }), fact("b", { publishedAt: daysAgo(2) }), fact("c", { publishedAt: daysAgo(3) })];
    const out = decide(facts, [], rules({ maxActive: 2 }));
    expect(out.map((a) => a.mediaId)).toEqual(["m-a", "m-b"]);
    expect(out.every((a) => a.kind === "create")).toBe(true);
  });

  it("паузящиеся по другим причинам не занимают место в лимите", () => {
    const facts = [fact("sold", { status: "SOLD" }), fact("a"), fact("new", { publishedAt: daysAgo(0.5) })];
    const out = decide(facts, [rec("sold"), rec("a")], rules({ maxActive: 2 }));
    const byMedia = Object.fromEntries(out.map((x) => [x.mediaId, x.kind]));
    expect(byMedia).toEqual({ "m-sold": "pause", "m-a": "keep", "m-new": "create" });
  });
});

describe("decideReelsAutoBoost — пробный режим против боевого", () => {
  it("пробный: PLANNED считается «как будто активным» → keep, повторно не создаётся", () => {
    const out = decide([fact("a")], [rec("a", { status: "PLANNED" })], rules({ dryRun: true }));
    expect(out.map((a) => a.kind)).toEqual(["keep"]);
  });
  it("боевой: PLANNED — ролик без объявления → create", () => {
    const out = decide([fact("a")], [rec("a", { status: "PLANNED" })], rules({ dryRun: false }));
    expect(out).toEqual([expect.objectContaining({ kind: "create", reason: expect.stringMatching(/ещё не создано/) })]);
  });
  it("боевой: PLANNED, ставший непригодным → pause (в Meta ходить не нужно, исполнитель увидит пустой metaAdId)", () => {
    const out = decide([fact("a", { status: "SOLD" })], [rec("a", { status: "PLANNED" })], rules({ dryRun: false }));
    expect(out.map((a) => a.kind)).toEqual(["pause"]);
  });
  it("стоп-лосс по PLANNED не применяется (расхода быть не может)", () => {
    const out = decide([fact("a")], [rec("a", { status: "PLANNED", spendUsd: 99, conversations: 0 })], rules({ dryRun: true }));
    expect(out.map((a) => a.kind)).toEqual(["keep"]);
  });
});

describe("unfitReason", () => {
  it("годный объект — null", () => {
    expect(unfitReason(fact("a"))).toBeNull();
  });
  it("неизвестный статус не годится", () => {
    expect(unfitReason(fact("a", { status: "EDITING" }))).toMatch(/больше не в продаже/);
  });
});
