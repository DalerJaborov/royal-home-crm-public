/**
 * РАЗОВАЯ ПОМЕТКА СТАРОГО ЭХА (13.11.2026, PR #163). НЕ ЗАПУСКАТЬ БЕЗ «ДА» ВЛАДЕЛЬЦА.
 *
 * До 13.11 эхо НАШЕГО исходящего сохранялось с ревизией нового ядра. Проверка
 * истории теперь не считает такие строки владением, но узнаёт их по пометке
 * `errorCode` (`provider_echo` / `referral_only` / `bare_template`). Строки с
 * другой пометкой (разбор упал: `pending_*`, FAILED) всё ещё держат человека.
 * Ревизию менять нельзя (триггер `customer_intake_agent_revision_immutable` не
 * трогаем); меняется ТОЛЬКО `errorCode`, и только у строк, чьё расшифрованное
 * содержимое и правда «не ввод клиента» (lib/customerIngressNonInput.ts).
 *
 * ПОЧЕМУ В src/: образ api везёт только dist/ (apps/api/Dockerfile), а внутри
 * контейнера уже есть DATABASE_URL и ключ шифрования. Файл собирается в
 * dist/ops/relabelHistoricalEchoTickets.js и запускается тем же node.
 *
 * ЗАПУСК НА СЕРВЕРЕ (из /opt/royalhome-crm; копия пишется НА ХОСТ через stdout):
 *   (/backups/crm — каталог бэкапов на хосте, тот же, что у ops/backup.sh)
 *   C="docker compose -f docker-compose.prod.yml --env-file .env.production"
 *   1) сухой прогон, ничего не пишет:
 *      $C exec -T api node dist/ops/relabelHistoricalEchoTickets.js
 *   2) правка: копия на хост ДО первой правки, отчёт — в stderr:
 *      $C exec -T api node dist/ops/relabelHistoricalEchoTickets.js --apply --backup=- \
 *        > /backups/crm/echo-relabel-$(date -u +%Y%m%dT%H%M%SZ).json
 *   3) откат по той же копии:
 *      $C exec -T api node dist/ops/relabelHistoricalEchoTickets.js --restore=- < /backups/crm/echo-relabel-<время>.json
 * Чтение — страницами по "order" (по 500), не больше --max-rows=50000 строк за
 * запуск; упёрлись в предел — предупреждение и точная добавка
 * `--after-order=<n>`, с которой следующий запуск продолжит (сухой и правка — одинаково). Строки в работе (RECEIVED/CLAIMED) не трогаются.
 * Правка — сравнение-и-замена по каждой строке: изменившаяся после чтения
 * строка остаётся как есть.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { prisma } from "../db.js";
import { decryptCustomerIngressPayload } from "../lib/customerIngressPayload.js";
import { CUSTOMER_NON_INPUT_TICKET_CODES, customerNonInputCode, customerTicketIsInputSql } from "../lib/customerIngressNonInput.js";

type Row = { eventKey: string; order: bigint; scopeKey: string; endpointScopeId: string; payloadHash: string; payloadCiphertext: string;
  processingState: string | null; errorCode: string | null };
export type RelabelEntry = { eventKey: string; processingState: string | null; errorCode: string | null; to: string };
export type RelabelReport = { scanned: number; inFlight: number; undecryptable: number; matched: RelabelEntry[]; updated: number;
  truncated: boolean; lastOrder: string | null };
const PAGE = 500;

/** `backup`: a file path, or a writer (the CLI streams it to stdout -> host file). */
export async function relabelHistoricalEchoTickets(options: { apply: boolean; backup?: string | ((json: string) => void);
  maxRows?: number; afterOrder?: bigint }): Promise<RelabelReport> {
  if (options.apply && !options.backup) throw new Error("--apply требует --backup=<файл|->: копия пишется до правки");
  const maxRows = options.maxRows ?? 50_000;
  const report: RelabelReport = { scanned: 0, inFlight: 0, undecryptable: 0, matched: [], updated: 0, truncated: false, lastOrder: null };
  let after = options.afterOrder ?? -1n;
  for (;;) {
    const limit = Math.min(PAGE, maxRows - report.scanned);
    if (limit <= 0) { report.truncated = true; break; }
    const rows = await prisma.$queryRaw<Row[]>`SELECT "eventKey","order","scopeKey","endpointScopeId","payloadHash","payloadCiphertext",
        "processingState","errorCode" FROM "CustomerPropertyIngressTicket"
      WHERE "order" > ${after} AND "intakeAgentRevisionId" IS NOT NULL AND "payloadVersion"=1 AND "payloadCiphertext" IS NOT NULL
        AND "endpointScopeId" IS NOT NULL AND "tombstonedAt" IS NULL AND ${customerTicketIsInputSql()}
      ORDER BY "order" LIMIT ${limit}`;
    if (!rows.length) break;
    after = rows[rows.length - 1].order;
    report.lastOrder = after.toString();
    report.scanned += rows.length;
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
    if (rows.length < limit) break;
  }
  if (!options.apply || !report.matched.length) return report;
  const backup = JSON.stringify({ createdAt: new Date().toISOString(), rows: report.matched }, null, 2);
  if (typeof options.backup === "function") options.backup(backup); else writeFileSync(options.backup!, backup);
  for (const entry of report.matched) {
    report.updated += await prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "errorCode"=${entry.to}
      WHERE "eventKey"=${entry.eventKey} AND "errorCode" IS NOT DISTINCT FROM ${entry.errorCode}
        AND "processingState" IS NOT DISTINCT FROM ${entry.processingState}`;
  }
  return report;
}

/** Undo from the backup JSON: only rows that still carry the label this tool set. */
export async function restoreHistoricalEchoTickets(backupJson: string): Promise<number> {
  const backup = JSON.parse(backupJson) as { rows: RelabelEntry[] };
  let restored = 0;
  for (const entry of backup.rows) {
    if (!(CUSTOMER_NON_INPUT_TICKET_CODES as readonly string[]).includes(entry.to)) continue;
    restored += await prisma.$executeRaw`UPDATE "CustomerPropertyIngressTicket" SET "errorCode"=${entry.errorCode}
      WHERE "eventKey"=${entry.eventKey} AND "errorCode"=${entry.to}`;
  }
  return restored;
}

async function main(): Promise<void> {
  const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const say = (line: string) => process.stderr.write(`${line}\n`);
  try {
    const restore = arg("restore");
    if (restore) {
      say(`восстановлено строк: ${await restoreHistoricalEchoTickets(readFileSync(restore === "-" ? 0 : restore, "utf8"))}`);
      return;
    }
    const apply = process.argv.includes("--apply"), backupArg = arg("backup"), maxRows = Number(arg("max-rows") ?? 50_000);
    const afterArg = arg("after-order");
    const report = await relabelHistoricalEchoTickets({ apply, maxRows, ...(afterArg ? { afterOrder: BigInt(afterArg) } : {}),
      backup: backupArg === "-" ? json => process.stdout.write(`${json}\n`) : backupArg });
    say(JSON.stringify({ mode: apply ? "apply" : "dry-run", scanned: report.scanned, inFlight: report.inFlight,
      undecryptable: report.undecryptable, matched: report.matched.length, updated: report.updated,
      byLabel: report.matched.reduce<Record<string, number>>((acc, row) => { const key = `${row.processingState}/${row.errorCode}`; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {}) }, null, 2));
    if (report.truncated) say(`ВНИМАНИЕ: упёрлись в предел --max-rows=${maxRows}. Продолжить с того же места: добавьте --after-order=${report.lastOrder}`);
  } catch (error) {
    say(`ошибка: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally { await prisma.$disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
