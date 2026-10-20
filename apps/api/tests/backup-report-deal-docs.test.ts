import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * Отчёт о бэкапе принимает шаг «Документы сделок» (G3, 02.10.2026).
 *
 * Шаг 3в ops/backup.sh (с 02.10.2026) шлёт этот вид; без DEAL_DOCS в схеме
 * отчёт нового шага получал бы 400, и экран «Резервные копии» не показал бы
 * ни успеха, ни сбоя. Сам скрипт проверяет scripts/backup-deal-docs.test.mjs.
 */

const KEY = "test-backup-report-key-g3";
let previous: string | undefined;
const startedAt = new Date().toISOString();

beforeAll(() => {
  previous = process.env.BACKUP_REPORT_API_KEY;
  process.env.BACKUP_REPORT_API_KEY = KEY;
});

afterAll(async () => {
  if (previous === undefined) delete process.env.BACKUP_REPORT_API_KEY;
  else process.env.BACKUP_REPORT_API_KEY = previous;
  await prisma.backupRun.deleteMany({ where: { kind: "DEAL_DOCS", startedAt: new Date(startedAt) } });
  await prisma.$disconnect();
});

describe("POST /backups/report", () => {
  it("принимает вид DEAL_DOCS", async () => {
    const res = await request(app)
      .post("/api/v1/backups/report")
      .set("X-Api-Key", KEY)
      .send({ kind: "DEAL_DOCS", success: true, sizeLabel: "12M", startedAt, finishedAt: new Date().toISOString() });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  });
});
