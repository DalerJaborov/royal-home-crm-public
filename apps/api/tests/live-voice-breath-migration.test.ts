import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";

/**
 * Миграция «вдох и фон выключены по умолчанию» (02.10.2026) не затирает выбор
 * владельца: сбрасывается только поле, которого он никогда не касался (нет записи
 * SETTINGS_UPDATE с этим ключом). Тест гоняет настоящий текст миграции по строке
 * Settings — на чистой базе её UPDATE уже отработал вхолостую, поэтому тут повтор.
 */
const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(here, "../prisma/migrations/20261003110000_live_voice_breath_ambience_off/migration.sql"),
  "utf8"
);
// Выполняем только UPDATE: DEFAULT-ы уже стоят от накатанной миграции.
const updates = sql
  .split(";")
  .map((s) => s.replace(/^(\s*--.*\n)+/gm, "").trim())
  .filter((s) => s.startsWith("UPDATE"));

const TAG = "mig-breath-test";

async function setRow(breath: boolean, ambience: boolean) {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", liveVoiceBreathEnabled: breath, liveVoiceOfficeAmbienceEnabled: ambience },
    update: { liveVoiceBreathEnabled: breath, liveVoiceOfficeAmbienceEnabled: ambience },
  });
}
async function runMigration() {
  for (const u of updates) await prisma.$executeRawUnsafe(u);
}
async function row() {
  return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } });
}
async function audit(fields: string[]) {
  await prisma.auditLog.create({
    data: { action: "SETTINGS_UPDATE", entityType: "Settings", entityId: "singleton", agentName: TAG, meta: { fields } },
  });
}

describe("миграция breath/ambience off не затирает выбор владельца", () => {
  beforeEach(async () => {
    await prisma.auditLog.deleteMany({ where: { agentName: TAG } });
  });
  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { agentName: TAG } });
  });

  it("в тексте миграции два UPDATE, оба с условием по журналу", () => {
    expect(updates).toHaveLength(2);
    for (const u of updates) expect(u).toMatch(/NOT EXISTS/);
  });

  it("нетронутые true (прежнее умолчание) сбрасываются", async () => {
    await setRow(true, true);
    await runMigration();
    const r = await row();
    expect(r.liveVoiceBreathEnabled).toBe(false);
    expect(r.liveVoiceOfficeAmbienceEnabled).toBe(false);
  });

  it("поле, которое владелец переключал, остаётся как есть, соседнее сбрасывается", async () => {
    await setRow(true, true);
    await audit(["liveVoiceBreathEnabled"]);
    await runMigration();
    const r = await row();
    expect(r.liveVoiceBreathEnabled).toBe(true);
    expect(r.liveVoiceOfficeAmbienceEnabled).toBe(false);
  });

  it("false остаётся false, чужие записи журнала (другие ключи) не мешают", async () => {
    await setRow(false, true);
    await audit(["botEnabled", "liveVoicePrompt"]);
    await runMigration();
    const r = await row();
    expect(r.liveVoiceBreathEnabled).toBe(false);
    expect(r.liveVoiceOfficeAmbienceEnabled).toBe(false);
  });
});
