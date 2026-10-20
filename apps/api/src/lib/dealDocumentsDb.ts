import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";

/**
 * Доступ к таблице `DealDocument` через $queryRaw/$executeRaw (Пачка 14, 11.09.2026).
 *
 * По условиям задания в worktree запрещено гонять `prisma generate` (пишет в общий
 * `node_modules`, ломает соседние сессии) — сгенерированный Prisma Client в этой
 * копии репозитория не знает ни модель `DealDocument`, ни новые колонки `Deal`
 * (`realtorPayoutAt`/`realtorPayoutById`/`realtorPayoutNote`). Миграция
 * (prisma/migrations/20260911190000_deal_documents_and_payout) написана руками и
 * содержит настоящую схему; здесь — минимальный типобезопасный слой поверх
 * `$queryRaw`/`$executeRaw`, СТРОГО с параметрами через теговый шаблон (никогда
 * `$queryRawUnsafe`/конкатенацию строк — тот же урок, что у К13,
 * lib/aiDailyBudget.ts), чтобы код компилировался и работал уже сейчас. Сборщику
 * НУЖНО прогнать `npx prisma generate` (и убедиться, что миграция применена) —
 * после этого весь слой можно заменить на обычные `prisma.dealDocument.*` /
 * `prisma.deal.update({ data: { realtorPayoutAt... } })`, он оставлен отдельным
 * файлом именно для лёгкой замены.
 */

export type DealDocumentKindDb = "OWNERSHIP" | "CONTRACT" | "PASSPORT" | "RECEIPT" | "OTHER";

export interface DealDocumentRow {
  id: string;
  dealId: string;
  kind: DealDocumentKindDb;
  fileName: string;
  originalName: string;
  mimeType: string;
  uploadedById: string;
  uploadedAt: Date;
}

export async function listDealDocuments(dealId: string): Promise<(DealDocumentRow & { uploadedByName: string })[]> {
  return prisma.$queryRaw<(DealDocumentRow & { uploadedByName: string })[]>`
    SELECT d."id", d."dealId", d."kind", d."fileName", d."originalName", d."mimeType",
           d."uploadedById", d."uploadedAt", a."fullName" AS "uploadedByName"
    FROM "DealDocument" d
    JOIN "Agent" a ON a."id" = d."uploadedById"
    WHERE d."dealId" = ${dealId}
    ORDER BY d."uploadedAt" DESC`;
}

export async function getDealDocument(id: string): Promise<DealDocumentRow | null> {
  const rows = await prisma.$queryRaw<DealDocumentRow[]>`
    SELECT "id", "dealId", "kind", "fileName", "originalName", "mimeType", "uploadedById", "uploadedAt"
    FROM "DealDocument" WHERE "id" = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

export async function createDealDocument(input: {
  dealId: string;
  kind: DealDocumentKindDb;
  fileName: string;
  originalName: string;
  mimeType: string;
  uploadedById: string;
}): Promise<DealDocumentRow> {
  const id = randomUUID();
  const uploadedAt = new Date();
  await prisma.$executeRaw`
    INSERT INTO "DealDocument" ("id", "dealId", "kind", "fileName", "originalName", "mimeType", "uploadedById", "uploadedAt")
    VALUES (${id}, ${input.dealId}, ${input.kind}::"DealDocumentKind", ${input.fileName}, ${input.originalName}, ${input.mimeType}, ${input.uploadedById}, ${uploadedAt})`;
  return { id, uploadedAt, ...input };
}

export async function deleteDealDocument(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "DealDocument" WHERE "id" = ${id}`;
}

/** Имена файлов всех документов этих сделок — чтобы стереть их с диска, когда
 *  строки уходят каскадом вместе со сделкой (C6, 02.10.2026). */
export async function listDealDocumentFileNames(dealIds: string[]): Promise<string[]> {
  if (dealIds.length === 0) return [];
  const rows = await prisma.$queryRaw<{ fileName: string }[]>`
    SELECT "fileName" FROM "DealDocument" WHERE "dealId" = ANY(${dealIds})`;
  return rows.map((r) => r.fileName);
}

/** Различные виды документов, уже загруженных на сделку — для сверки с чек-листом. */
export async function distinctUploadedKinds(dealId: string): Promise<DealDocumentKindDb[]> {
  const rows = await prisma.$queryRaw<{ kind: DealDocumentKindDb }[]>`
    SELECT DISTINCT "kind" FROM "DealDocument" WHERE "dealId" = ${dealId}`;
  return rows.map((r) => r.kind);
}

export interface DealPayoutRow {
  realtorPayoutAt: Date | null;
  realtorPayoutById: string | null;
  realtorPayoutNote: string | null;
}

export async function getDealPayout(dealId: string): Promise<DealPayoutRow | null> {
  const rows = await prisma.$queryRaw<DealPayoutRow[]>`
    SELECT "realtorPayoutAt", "realtorPayoutById", "realtorPayoutNote"
    FROM "Deal" WHERE "id" = ${dealId} LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * Даты выплаты сразу для нескольких сделок — сводка «Финансы» (routes/expenses.ts,
 * GET /summary, ночная проверка 24.09.2026, находка №206) считает выплаты сотнями
 * закрытых сделок за месяц разом, по одному запросу на сделку никто не звал бы.
 * Только выплаченные (realtorPayoutAt не null) — карта короче и без лишних null.
 */
export async function getDealPayouts(dealIds: string[]): Promise<Map<string, Date>> {
  if (dealIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ id: string; realtorPayoutAt: Date }[]>`
    SELECT "id", "realtorPayoutAt" FROM "Deal"
    WHERE "id" = ANY(${dealIds}) AND "realtorPayoutAt" IS NOT NULL`;
  return new Map(rows.map((r) => [r.id, r.realtorPayoutAt]));
}

/**
 * Отмечает комиссию выплаченной ОДНИМ условным UPDATE (находка №211): повторная
 * отметка не должна перезаписать дату, автора и комментарий первой, даже если два
 * запроса прошли предварительную проверку одновременно. Стадия и аннулирование
 * тоже в самом условии (аудит Codex 04.10.2026, №9): роут проверил COMPLETED
 * отдельным чтением, и аннулирование между ним и записью иначе проходило бы, а
 * агенту ушёл бы пуш «Комиссия выплачена» по аннулированной сделке. Вернёт дату
 * выплаты, а если сделка уже была отмечена или перестала быть закрытой (0
 * изменённых строк) — null.
 */
export async function setDealPayout(dealId: string, payoutById: string, note: string | null): Promise<Date | null> {
  const payoutAt = new Date();
  const changed = await prisma.$executeRaw`
    UPDATE "Deal" SET "realtorPayoutAt" = ${payoutAt}, "realtorPayoutById" = ${payoutById}, "realtorPayoutNote" = ${note}
    WHERE "id" = ${dealId} AND "realtorPayoutAt" IS NULL AND "stage" = 'COMPLETED' AND "annulledAt" IS NULL`;
  return changed === 1 ? payoutAt : null;
}

/** Settings.dealRequiredDocuments — text[] в Postgres. */
export async function getDealRequiredDocuments(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ dealRequiredDocuments: string[] }[]>`
    SELECT "dealRequiredDocuments" FROM "Settings" WHERE "id" = 'singleton' LIMIT 1`;
  return rows[0]?.dealRequiredDocuments ?? [];
}
