import { afterAll, describe, expect, it } from "vitest";
import { parseContactCategoryHistory } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { mergeContactProfiles } from "../src/lib/contactProfiles.js";

/**
 * СЛИЯНИЕ ДОСЬЕ НЕ ТЕРЯЕТ ПРЕЖНИЕ РОЛИ ЧЕЛОВЕКА (CONTACT01, аудит 04.10.2026).
 *
 * Слияние переносило текущую категорию, но не categoryHistory и categorySetAt:
 * история смен (кем человек был раньше) оставалась только в слитой записи-
 * надгробии, а читатели (карточка, промт бота) берут её у выжившего. Человек,
 * раньше покупавший, а теперь продающий, терял прежнюю роль и дату смены.
 */

const created: string[] = [];
const at = (day: number) => new Date(Date.UTC(2026, 8, day, 10, 0, 0)).toISOString();

async function profile(data: { category: string; history?: object[]; setAt?: string | null }): Promise<string> {
  const row = await prisma.contactProfile.create({
    data: {
      category: data.category,
      categoryHistory: (data.history ?? []) as object[],
      categorySetAt: data.setAt ? new Date(data.setAt) : null,
    },
    select: { id: true },
  });
  created.push(row.id);
  return row.id;
}

afterAll(async () => {
  await prisma.contactProfileMerge.deleteMany({ where: { OR: [{ targetId: { in: created } }, { sourceId: { in: created } }] } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: created } } });
});

describe("mergeContactProfiles: история ролей", () => {
  it("целевое досье пустое, у источника BUYER→SELLER: у выжившего обе записи по порядку и дата смены", async () => {
    const target = await profile({ category: "UNKNOWN" });
    const source = await profile({
      category: "SELLER",
      history: [
        { category: "BUYER", at: at(1), source: "model" },
        { category: "SELLER", at: at(5), source: "model" },
      ],
      setAt: at(5),
    });

    expect(await mergeContactProfiles({ targetId: target, sourceId: source, reason: "TEST" })).toBe(true);

    const row = await prisma.contactProfile.findUniqueOrThrow({ where: { id: target } });
    expect(row.category).toBe("SELLER");
    expect(parseContactCategoryHistory(row.categoryHistory).map((h) => h.category)).toEqual(["BUYER", "SELLER"]);
    expect(row.categorySetAt?.toISOString()).toBe(at(5));
  });

  it("обе истории непустые: сливаются по времени без дублей, категория и дата выжившего не меняются", async () => {
    const shared = { category: "BUYER", at: at(2), source: "model" };
    const target = await profile({
      category: "BUYER",
      history: [shared, { category: "BUYER", at: at(9), source: "agent" }],
      setAt: at(9),
    });
    const source = await profile({
      category: "SELLER",
      history: [shared, { category: "SELLER", at: at(4), source: "model" }],
      setAt: at(4),
    });

    await mergeContactProfiles({ targetId: target, sourceId: source, reason: "TEST" });

    const row = await prisma.contactProfile.findUniqueOrThrow({ where: { id: target } });
    const history = parseContactCategoryHistory(row.categoryHistory);
    expect(history.map((h) => `${h.category}@${h.at}`)).toEqual([
      `BUYER@${at(2)}`,
      `SELLER@${at(4)}`,
      `BUYER@${at(9)}`,
    ]);
    expect(row.category).toBe("BUYER");
    expect(row.categorySetAt?.toISOString()).toBe(at(9));
  });

  it("история источника попадает в снимок слияния", async () => {
    const target = await profile({ category: "UNKNOWN" });
    const source = await profile({
      category: "SELLER",
      history: [{ category: "SELLER", at: at(3), source: "model" }],
      setAt: at(3),
    });
    await mergeContactProfiles({ targetId: target, sourceId: source, reason: "TEST" });
    const log = await prisma.contactProfileMerge.findFirstOrThrow({ where: { targetId: target, sourceId: source } });
    const snapshot = log.snapshot as { categoryHistory?: unknown[] };
    expect(snapshot.categoryHistory).toHaveLength(1);
  });
});
