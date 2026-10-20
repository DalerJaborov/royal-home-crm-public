/**
 * BACKFILL accountId У СТАРЫХ ДИАЛОГОВ (разовый, 31.08.2026).
 *
 * Предыстория: docs/instagram-unlinked-dialogs-investigation-31-08-2026.md,
 * раздел 1 (Гипотеза A). Миграция `20260815085607_messenger_accounts` добавила
 * `BotConversation.accountId` как обычную nullable-колонку БЕЗ backfill.
 * С тех пор поле заполняется только «лениво» — при СЛЕДУЮЩЕМ входящем
 * сообщении в диалог (messengers/conversation.ts, upsertConversation,
 * update: { ...(accountId ? { accountId } : {}) }). Диалог, в котором человек
 * замолчал ДО 15.08.2026 и с тех пор не написал снова, навсегда остаётся с
 * accountId = NULL — не баг, а просто «не успел долиться» после миграции.
 *
 * КАК ЖИВОЙ КОД ОПРЕДЕЛЯЕТ accountId. Через resolveIncomingAccount
 * (messengers/accounts.ts): по получателю ИЗ ВЕБХУКА (externalId) ищется
 * MessengerAccount канала, чей externalId/messagingId/extraExternalIds
 * совпадает. Для старых диалогов у нас НЕТ сохранённого externalId вебхука —
 * его никогда не писали в BotConversation, реконструировать нечем. Повторять
 * эту логику здесь означало бы гадать, а именно этого просит избегать задание.
 *
 * Поэтому backfill использует единственный БЕЗОПАСНЫЙ частный случай той же
 * логики: если у канала за всё время существует РОВНО ОДИН MessengerAccount —
 * гадать не нужно, входящее просто не могло прийти ни к кому другому, это и
 * есть то же самое сопоставление, что сделал бы resolveIncomingAccount, только
 * без входного externalId (он у единственного счёта один). Если у канала НЕТ ни
 * одного аккаунта — резолвер живого кода сам вернул бы null (работа на старых
 * настройках), значит NULL и есть правильное значение, трогать нечего. Если у
 * канала НЕСКОЛЬКО аккаунтов — какой из них получил именно это старое
 * сообщение, знает только исходный вебхук, которого нет: это ЗАКОНЧЕННАЯ
 * неоднозначность, а не «пока не разобрались» — такие диалоги скрипт не трогает
 * и отдельно перечисляет в выводе, ничего не додумывая.
 *
 * ЧТО ДЕЛАЕТ. Для каждого канала с ровно одним MessengerAccount проставляет его
 * id всем диалогам этого канала с accountId IS NULL. Никогда не трогает диалоги,
 * где accountId уже заполнен (даже если он не совпадает с единственным
 * аккаунтом — так не бывает при текущей схеме, но перезаписывать чужое значение
 * не будем ни при каких условиях). Диалоги без Client не теряют и не получают
 * ничего лишнего: скрипт трогает только колонку accountId.
 *
 * ИДЕМПОТЕНТНОСТЬ. Повторный запуск ничего не меняет: выборка всегда идёт по
 * accountId IS NULL, а после первого --apply таких диалогов (для однозначных
 * каналов) не останется.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *     npx tsx scripts/backfill-conversation-account-id.ts            — показать, что будет сделано
 *     npx tsx scripts/backfill-conversation-account-id.ts --apply    — выполнить
 *
 * Без --apply не пишет НИЧЕГО.
 */
import { prisma } from "../src/db.js";

type AccountRow = { id: string; channel: string; title: string; externalId: string };

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const accounts: AccountRow[] = await prisma.messengerAccount.findMany({
    select: { id: true, channel: true, title: true, externalId: true },
  });

  const byChannel = new Map<string, AccountRow[]>();
  for (const a of accounts) {
    const list = byChannel.get(a.channel) ?? [];
    list.push(a);
    byChannel.set(a.channel, list);
  }

  // Диалоги без accountId, сгруппированные по каналу — считаем сразу все, чтобы
  // и однозначные, и неоднозначные каналы попали в один отчёт.
  const nullGrouped = await prisma.botConversation.groupBy({
    by: ["channel"],
    where: { accountId: null },
    _count: { _all: true },
  });

  console.log("Диалоги с accountId IS NULL по каналам:");
  for (const g of nullGrouped) {
    console.log(`  ${g.channel}: ${g._count._all}`);
  }
  if (nullGrouped.length === 0) {
    console.log("  (таких нет — backfill не нужен)");
    return;
  }

  let totalToFix = 0;
  const skippedAmbiguous: string[] = [];
  const skippedNoAccount: string[] = [];
  const plan: Array<{ channel: string; accountId: string; accountTitle: string; count: number }> = [];

  for (const g of nullGrouped) {
    const channelAccounts = byChannel.get(g.channel) ?? [];
    if (channelAccounts.length === 0) {
      skippedNoAccount.push(g.channel);
      continue;
    }
    if (channelAccounts.length > 1) {
      skippedAmbiguous.push(
        `${g.channel} (${g._count._all} диалог(ов), аккаунтов: ${channelAccounts
          .map((a) => `«${a.title}» ${a.externalId}`)
          .join(", ")})`
      );
      continue;
    }
    const only = channelAccounts[0]!;
    plan.push({ channel: g.channel, accountId: only.id, accountTitle: only.title, count: g._count._all });
    totalToFix += g._count._all;
  }

  console.log("\nБудет проставлено (единственный аккаунт канала — сопоставление однозначно):");
  if (plan.length === 0) console.log("  (нечего)");
  for (const p of plan) {
    console.log(`  ${p.channel} → «${p.accountTitle}» (${p.accountId}): ${p.count} диалог(ов)`);
  }

  console.log("\nПропущено — у канала НЕСКОЛЬКО аккаунтов, кому из них принадлежит старое");
  console.log("сообщение, определить нечем (нет сохранённого externalId вебхука):");
  if (skippedAmbiguous.length === 0) console.log("  (нет таких)");
  for (const line of skippedAmbiguous) console.log(`  ${line}`);

  console.log("\nПропущено — у канала нет ни одного MessengerAccount (NULL и так корректен,");
  console.log("это работа на старых настройках Settings, как и в resolveIncomingAccount):");
  if (skippedNoAccount.length === 0) console.log("  (нет таких)");
  for (const ch of skippedNoAccount) console.log(`  ${ch}`);

  console.log(`\nИтого будет обновлено диалогов: ${totalToFix}`);

  if (!apply) {
    console.log(totalToFix > 0 ? "\nЗапустите с --apply, чтобы применить." : "\nМенять нечего.");
    return;
  }

  for (const p of plan) {
    // where: accountId null повторно — на случай, если между расчётом плана и
    // записью что-то успело проставить поле само (ленивая простановка живым
    // кодом на входящем сообщении). Не перезаписываем то, что появилось само.
    const res = await prisma.botConversation.updateMany({
      where: { channel: p.channel, accountId: null },
      data: { accountId: p.accountId },
    });
    console.log(`  ${p.channel}: обновлено ${res.count} (план был ${p.count})`);
  }
  console.log("\nГотово.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
