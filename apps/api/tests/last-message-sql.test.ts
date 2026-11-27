import { describe, expect, it } from "vitest";
import { Prisma } from "../src/generated/prisma/client.js";
import { prisma } from "../src/db.js";
import { lastMessageSql, messagesCountSql } from "../src/lib/lastMessageSql.js";

/**
 * lastMessageSql (27.11.2026) заменил `CASE WHEN jsonb_typeof(m) = 'array' THEN m -> -1 ELSE NULL END`,
 * чтобы поле переписки распаковывалось один раз, а не дважды. Смысл обязан совпасть на всех формах
 * значения, включая битые: голый `m -> -1` у строки вернул бы саму строку.
 */
const SAMPLES = [
  `'[{"role":"user","content":"a"},{"role":"assistant","content":"b"}]'`,
  `'[{"role":"user","content":"единственная"}]'`,
  `'[]'`,
  `'{"role":"user"}'`,
  `'"строка"'`,
  `'42'`,
  `'null'`,
  `NULL`,
];

describe("lastMessageSql — тот же смысл, что у прежнего CASE", () => {
  it.each(SAMPLES)("значение %s", async (literal) => {
    const m = Prisma.raw(`(${literal})::jsonb`);
    const rows = await prisma.$queryRaw<{ fresh: unknown; old: unknown; n: number; nOld: number }[]>(Prisma.sql`
      SELECT ${lastMessageSql(m)} AS fresh,
             CASE WHEN jsonb_typeof(${m}) = 'array' THEN ${m} -> -1 ELSE NULL END AS old,
             ${messagesCountSql(m)} AS n,
             CASE WHEN jsonb_typeof(${m}) = 'array' THEN jsonb_array_length(${m}) ELSE 0 END AS "nOld"`);
    expect(rows[0]!.fresh).toEqual(rows[0]!.old);
    expect(Number(rows[0]!.n)).toBe(Number(rows[0]!.nOld));
  });
});
