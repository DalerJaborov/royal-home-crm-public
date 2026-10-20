import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";

/**
 * Ночная проверка, №196–199 (миграция 20261001120000_night_e_indexes):
 * индексы под фоновые выборки существуют в базе, а схема и миграции не
 * расходятся — `prisma migrate diff` базы (после `migrate deploy`) и
 * schema.prisma пуст. Частичные индексы Prisma не описывает и в diff не
 * видит, поэтому наличие и условие WHERE проверяются здесь отдельно.
 */
const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function indexDef(name: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ${name}`;
  return rows[0]?.indexdef ?? null;
}

describe("индексы ночной проверки (№196–199)", () => {
  it.each([
    ["Notification_tag_createdAt_idx", '(tag, "createdAt")'],
    ["Notification_createdAt_idx", '("createdAt")'],
    ["PendingDirectorAlert_tag_createdAt_idx", '(tag, "createdAt")'],
    ["RoyalScoreEvent_sourceId_idx", '("sourceId")'],
    ["PendingSummary_doneAt_dismissedAt_dueAt_idx", '("doneAt", "dismissedAt", "dueAt")'],
  ])("%s есть и построен по нужным столбцам", async (name, columns) => {
    const def = await indexDef(name);
    expect(def, `индекса ${name} нет — миграция не применена`).not.toBeNull();
    expect(def).toContain(columns);
  });

  it.each([
    ["Interaction_transcriptionStage_partial_idx", '"transcriptionStage" IS NOT NULL'],
    ["Client_phoneAskFlaggedAt_partial_idx", '"phoneAskFlaggedAt" IS NOT NULL'],
    ["Client_refusedHighScoreFlaggedAt_partial_idx", '"refusedHighScoreFlaggedAt" IS NOT NULL'],
    ["Client_sellerDeclaredPropertyCountAt_partial_idx", '"sellerDeclaredPropertyCountAt" IS NOT NULL'],
    ["Client_buyerDesiredPropertyCountAt_partial_idx", '"buyerDesiredPropertyCountAt" IS NOT NULL'],
  ])("частичный индекс %s есть и с условием WHERE", async (name, predicate) => {
    const def = await indexDef(name);
    expect(def, `индекса ${name} нет — миграция не применена`).not.toBeNull();
    expect(def).toContain("WHERE");
    expect(def).toContain(predicate);
  });

  it("схема и миграции не расходятся: prisma migrate diff пуст", () => {
    // Строка команды идёт через shell — работает и с .cmd-обёрткой на Windows.
    const out = execSync("npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script", {
      cwd: API_DIR,
      env: process.env,
      encoding: "utf8",
      timeout: 90_000,
    });
    expect(out).toContain("-- This is an empty migration.");
  }, 120_000);
});
