/**
 * ВЫГРУЗКА ПАР «КЛИЕНТ → ШАБЛОН → СЛОВА МОДЕЛИ» (17.11.2026, «Один мозг» перед включением live).
 * Только чтение: ничего не пишет, никому не отправляет. Таблица CustomerAgentAnswerSample хранит пары 72 часа,
 * телефоны и ссылки в ней уже закрыты (lib/customerAgentAnswerSamples.ts). Пути наружу нет — только этот скрипт.
 *
 *   npx tsx scripts/export-answer-samples.ts                 # последние 30 пар, Markdown
 *   npx tsx scripts/export-answer-samples.ts --limit=60 --channel=FACEBOOK --status=dropped
 */
import "dotenv/config";
import { prisma } from "../src/db.js";

const arg = (name: string) => process.argv.find(item => item.startsWith(`--${name}=`))?.split("=")[1];
const limit = Math.min(Math.max(Math.trunc(Number(arg("limit") ?? 30)) || 30, 1), 200);
const channel = arg("channel")?.toUpperCase();
const status = arg("status");

async function main() {
  const now = new Date();
  const rows = await prisma.customerAgentAnswerSample.findMany({
    where: { ...(channel ? { channel } : {}), ...(status ? { status } : {}), expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" }, take: limit,
  });
  const total = await prisma.customerAgentAnswerSample.groupBy({ by: ["status", "reason"], where: { expiresAt: { gt: now } }, _count: true });
  console.log(`# Слова модели рядом с шаблоном — ${rows.length} пар\n`);
  console.log("Всего в таблице (72 ч): " + total.map(row => `${row.status}${row.reason ? `/${row.reason}` : ""} ${row._count}`).join(", ") + "\n");
  for (const [index, row] of rows.entries()) {
    console.log(`## ${index + 1}. ${row.channel}, ${row.createdAt.toISOString()} — ${row.answerMode}, ${row.status}${row.reason ? ` (${row.reason})` : ""}`);
    console.log(`**Клиент:** ${row.customerText.replace(/\n/g, " / ")}\n`);
    console.log(`**Ушло шаблоном:**\n> ${row.templateText.replace(/\n/g, "\n> ")}\n`);
    console.log(`**Модель сказала бы:**\n> ${row.modelText.replace(/\n/g, "\n> ")}\n`);
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
