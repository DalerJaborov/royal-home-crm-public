/**
 * ДОБОР КЛИЕНТОВ, ЧЕЙ НОМЕР БОТ ПРИНЯЛ, А КАРТОЧКА НЕ ПОЯВИЛАСЬ (разовый, 14.11.2026).
 *
 * Причина — четыре дыры сторожа «номер есть — карточки нет», починенные в той же ветке
 * (lib/phoneLeadWatchdog.ts, messengers/conversation.ts::acceptLead). Новые номера после
 * выката сторож берёт сам; этот скрипт добирает то, что потерялось ДО выката.
 *
 * Логика — целиком в lib/phoneLeadWatchdog.ts::backfillPhonesWithoutLead (та же дверь,
 * что у тика: привязка к известной карточке или тихий приём acceptLead, без сообщений
 * клиенту). Сотрудник узнаёт о каждой новой карточке штатным push приёма.
 *
 * ЗАПУСК (из apps/api, DATABASE_URL прода — только по «да» владельца):
 *     npx tsx scripts/phone-leads-backfill-14-11.ts               — сухой прогон: только отчёт
 *     npx tsx scripts/phone-leads-backfill-14-11.ts --days=14     — окно (по умолчанию 14 суток)
 *     npx tsx scripts/phone-leads-backfill-14-11.ts --apply       — выполнить
 *
 * С --apply пишет рядом файл phone-leads-backfill-<время>.json: какие карточки заведены и
 * какие диалоги привязаны. ОТКАТ по нему: для каждой строки outcome=accepted — карточку
 * clientId в Корзину (CRM → карточка → «Удалить», мягкое удаление); для outcome=attached —
 * отвязать диалог (UPDATE "BotConversation" SET "clientId"=NULL WHERE id=…). Сообщений
 * клиентам скрипт не шлёт, откатывать в переписке нечего.
 */

import "../src/loadEnv.js";
import { writeFileSync } from "node:fs";
import { prisma } from "../src/db.js";
import { backfillPhonesWithoutLead } from "../src/lib/phoneLeadWatchdog.js";

const APPLY = process.argv.includes("--apply");
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = Math.min(Math.max(Number(daysArg?.slice("--days=".length) ?? 14) || 14, 1), 30);

async function main(): Promise<void> {
  const report = await backfillPhonesWithoutLead({ apply: APPLY, windowHours: DAYS * 24 });
  console.log(`Окно ${DAYS} сут., найдено диалогов с номером без карточки: ${report.length}${APPLY ? "" : " (сухой прогон, --apply не указан)"}`);
  for (const r of report) {
    console.log([r.conversationId, r.channel, r.maskedPhone ?? "—", `тема ядра: ${r.coreTopic ?? "—"}`, `намерение: ${r.intent ?? "—"}`,
      r.action, r.reason ?? "", r.outcome ?? ""].join(" | "));
  }
  const count = (action: string) => report.filter((r) => r.action === action).length;
  console.log(`\nзавести карточку: ${count("accept")}, привязать к известной: ${count("attach")}, пропустить: ${count("skip")}`);
  if (APPLY) {
    const file = `phone-leads-backfill-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, JSON.stringify(report.filter((r) => r.outcome).map(({ conversationId, outcome, clientId }) =>
      ({ conversationId, outcome, clientId })), null, 2));
    console.log(`Журнал для отката: ${file}`);
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
