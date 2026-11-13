/**
 * Разовая разгрузка (13.11.2026): клиенты, чей ход бота закончился HELD без ответа до выкатки «сторожа молчания»
 * (customerTurnSilence.ts). Что делает: находит такие диалоги и шлёт ответственному ту же уведомление «Ответьте вручную».
 * Клиентам НИЧЕГО не отправляет, бота не запускает, тикеты не меняет. Пишет только строки уведомлений и отметки
 * ProcessedMessage (по одной на диалог и 30-минутное окно).
 *
 * Сухой прогон по умолчанию (только печатает список). Реальная рассылка: добавить --apply.
 * Окно: --hours=N (по умолчанию 24). Запуск на проде — только с «да» владельца.
 *   npx tsx scripts/notify-unanswered-held-turns-13-11.ts --hours=24
 *   npx tsx scripts/notify-unanswered-held-turns-13-11.ts --hours=24 --apply
 *
 * Резервная копия перед --apply (на сервере): pg_dump таблиц Notification и ProcessedMessage; откат — удалить строки
 * Notification с tag LIKE 'customer-turn-unanswered-%' и ProcessedMessage с channel='customer-turn-notify' за время запуска.
 */
import "dotenv/config";
import { prisma } from "../src/db.js";
import { CUSTOMER_TURN_INTENDED_SILENCE, reportUnansweredCustomerTurn } from "../src/lib/customerTurnSilence.js";

const apply = process.argv.includes("--apply");
const hours = Number(process.argv.find(arg => arg.startsWith("--hours="))?.split("=")[1] ?? 24);

async function main() {
  const rows = await prisma.$queryRaw<Array<{ eventKey: string; errorCode: string; receivedAt: Date; conversationId: string | null }>>`
    SELECT DISTINCT ON (t."conversationId") t."eventKey", t."errorCode", t."receivedAt", t."conversationId"
    FROM "CustomerPropertyIngressTicket" t
    WHERE t."processingState"='HELD' AND t."tombstonedAt" IS NULL AND t."intakeAgentRevisionId" IS NOT NULL AND t."conversationId" IS NOT NULL
      AND t."receivedAt" > now() - make_interval(hours => ${hours})
      AND t."errorCode" IS NOT NULL AND t."errorCode" NOT IN (${prismaList(CUSTOMER_TURN_INTENDED_SILENCE)})
      AND NOT EXISTS (SELECT 1 FROM "CustomerPropertyIngressTicket" x WHERE x."scopeKey"=t."scopeKey" AND x."endpointScopeId"=t."endpointScopeId"
        AND x."order">t."order" AND x."processingState" IN ('PLANNED','RECEIVED','CLAIMED'))
      AND NOT EXISTS (SELECT 1 FROM "CustomerOutboxPart" p WHERE p."ticketEventKey"=t."eventKey")
    ORDER BY t."conversationId", t."order" DESC`;
  console.log(`${apply ? "РАССЫЛКА" : "СУХОЙ ПРОГОН"}: диалогов без ответа за ${hours} ч: ${rows.length}`);
  for (const row of rows) {
    console.log(` ${row.receivedAt.toISOString()}  ${row.errorCode}  чат ${row.conversationId}`);
    if (apply) await reportUnansweredCustomerTurn(row.eventKey, row.errorCode);
  }
  if (!apply) console.log("Ничего не отправлено. Для рассылки добавьте --apply.");
  await prisma.$disconnect();
}
// Prisma.join без импорта типов: список коротких фиксированных строк из кода, не ввод.
import { Prisma } from "../src/generated/prisma/client.js";
function prismaList(values: readonly string[]) { return Prisma.join([...values]); }
main().catch(error => { console.error(error); process.exit(1); });
