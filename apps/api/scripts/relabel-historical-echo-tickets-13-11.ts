/**
 * РАЗОВАЯ ПОМЕТКА СТАРОГО ЭХА (13.11.2026, PR #163). НЕ ЗАПУСКАТЬ БЕЗ «ДА» ВЛАДЕЛЬЦА.
 *
 * До 13.11 эхо НАШЕГО исходящего сохранялось с ревизией нового ядра. Проверка
 * истории теперь не считает такие строки владением, но узнаёт их по пометке
 * `errorCode='provider_echo'` (или `referral_only` / `bare_template`). Строки, у
 * которых пометка другая (разбор упал: `pending_*`, FAILED и т. п.), всё ещё
 * держат человека. Ревизию менять нельзя (триггер
 * `customer_intake_agent_revision_immutable`, его не трогаем); меняется ТОЛЬКО
 * `errorCode`, и только у строк, чьё расшифрованное содержимое и правда эхо /
 * отметка рекламы / эхо шаблона (lib/customerIngressNonInput.ts).
 *
 * ЗАПУСК (внутри контейнера api на сервере: нужен .env с DATABASE_URL и ключом шифрования):
 *     npx tsx scripts/relabel-historical-echo-tickets-13-11.ts                      - сухой прогон, ничего не пишет
 *     npx tsx scripts/relabel-historical-echo-tickets-13-11.ts --apply --backup=/path/backup.json
 *     npx tsx scripts/relabel-historical-echo-tickets-13-11.ts --restore=/path/backup.json
 * `--apply` без `--backup=` отказывается работать; копия пишется ДО первой правки.
 * Строки в работе (RECEIVED/CLAIMED) не трогаются: их пометит собственный разбор.
 * Повторный запуск безопасен: уже помеченные строки не выбираются.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { prisma } from "../src/db.js";
import { decryptCustomerIngressPayload } from "../src/lib/customerIngressPayload.js";
import { CUSTOMER_NON_INPUT_TICKET_CODES, customerNonInputCode, customerTicketIsInputSql } from "../src/lib/customerIngressNonInput.js";

type Row = { eventKey: string; order: bigint; scopeKey: string; endpointScopeId: string; payloadHash: string; payloadCiphertext: string;
  processingState: string | null; errorCode: string | null };
export type RelabelEntry = { eventKey: string; processingState: string | null; errorCode: string | null; to: string };
export type RelabelReport = { scanned: number; inFlight: number; undecryptable: number; matched: RelabelEntry[]; updated: number };

export async function relabelHistoricalEchoTickets(options: { apply: boolean; backupPath?: string; limit?: number }): Promise<RelabelReport> {
  if (options.apply && !options.backupPath) throw new Error("--apply требует --backup=<файл>: копия пишется до правки");
  const rows = await prisma.$queryRaw<Row[]>`SELECT "eventKey","order","scopeKey","endpointScopeId","payloadHash","payloadCiphertext",
      "processingState","errorCode" FROM "CustomerPropertyIngressTicket"
    WHERE "intakeAgentRevisionId" IS NOT NULL AND "payloadVersion"=1 AND "payloadCiphertext" IS NOT NULL AND "endpointScopeId" IS NOT NULL
      AND "tombstonedAt" IS NULL AND ${customerTicketIsInputSql()}
    ORDER BY "order" LIMIT ${options.limit ?? 50_000}`;
  const report: RelabelReport = { scanned: rows.length, inFlight: 0, undecryptable: 0, matched: [], updated: 0 };
  for (const row of rows) {
    let code: string | null;
    try {
      code = customerNonInputCode(decryptCustomerIngressPayload({ version: 1, eventKey: row.eventKey, order: row.order.toString(),
        scopeKey: row.scopeKey, endpointScopeId: row.endpointScopeId, payloadHash: row.payloadHash }, row.payloadCiphertext));
    } catch { report.undecryptable++; continue; }
    if (!code) continue;
    if (row.processingState === "RECEIVED" || row.processingState === "CLAIMED") { report.inFlight++; continue; }
    report.matched.push({ eventKey: row.eventKey, processingState: row.processingState, errorCode: row.errorCode, to: code });
  }
  if (!options.apply || !report.matched.length) return report;
  writeFileSync(options.backupPath!, JSON.stringify({ createdAt: new Date().toISOString(), rows: report.matched }, null, 2));
  for (const entry of report.matched) {
    // Compare-and-set: a row that changed since the scan is left alone.
    report.updated += await prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "errorCode"=${entry.to}
      WHERE "eventKey"=${entry.eventKey} AND "errorCode" IS NOT DISTINCT FROM ${entry.errorCode}
        AND "processingState" IS NOT DISTINCT FROM ${entry.processingState}`;
  }
  return report;
}

/** Undo from the backup: only rows that still carry the label this script set. */
export async function restoreHistoricalEchoTickets(backupPath: string): Promise<number> {
  const backup = JSON.parse(readFileSync(backupPath, "utf8")) as { rows: RelabelEntry[] };
  let restored = 0;
  for (const entry of backup.rows) {
    if (!(CUSTOMER_NON_INPUT_TICKET_CODES as readonly string[]).includes(entry.to)) continue;
    restored += await prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "errorCode"=${entry.errorCode}
      WHERE "eventKey"=${entry.eventKey} AND "errorCode"=${entry.to}`;
  }
  return restored;
}

async function main() {
  const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  try {
    const restore = arg("restore");
    if (restore) { console.log(`восстановлено строк: ${await restoreHistoricalEchoTickets(restore)}`); return; }
    const apply = process.argv.includes("--apply");
    const report = await relabelHistoricalEchoTickets({ apply, backupPath: arg("backup") });
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", scanned: report.scanned, inFlight: report.inFlight,
      undecryptable: report.undecryptable, matched: report.matched.length, updated: report.updated,
      byLabel: report.matched.reduce<Record<string, number>>((acc, row) => { const key = `${row.processingState}/${row.errorCode}`; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {}) }, null, 2));
  } finally { await prisma.$disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
