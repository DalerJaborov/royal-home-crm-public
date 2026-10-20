/**
 * BACKFILL accountId ПО ВРЕМЕНИ ПОДКЛЮЧЕНИЯ АККАУНТА — эвристика №2 (31.08.2026).
 *
 * Предыстория: docs/instagram-unlinked-dialogs-investigation-31-08-2026.md,
 * раздел 1. `backfill-conversation-account-id.ts` (эвристика №1, уже смёржена в
 * main) заполняет `accountId` там, где у канала за всё время был РОВНО ОДИН
 * `MessengerAccount` — гадать не нужно, входящее просто не могло прийти ни к
 * кому другому. На проде это закрыло WhatsApp/Website/Facebook, но НЕ Instagram:
 * там подключено ДВА аккаунта одновременно («Royal Home Info»,
 * externalId 17841438971591101, и «Royal Home», externalId 17841477393005072),
 * и 6 старых диалогов остались с `accountId = NULL` — скрипт №1 корректно
 * отказался гадать.
 *
 * ЭТОТ СКРИПТ — отдельная, более узкая и более рискованная по допущениям
 * эвристика для ИМЕННО ЭТОГО случая (несколько аккаунтов на канал). Поэтому он
 * не правка скрипта №1, а отдельный файл: другое допущение — другая явная
 * команда запуска, другой обзор перед прогоном.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ИДЕЯ: СОПОСТАВЛЕНИЕ ПО ВРЕМЕНИ ПОДКЛЮЧЕНИЯ АККАУНТА
 * ─────────────────────────────────────────────────────────────────────────
 *
 * У каждого `MessengerAccount` есть `createdAt` — момент, когда запись СОЗДАНА
 * в БД. Проверено по коду (`messengers/accounts.ts`, `saveAccount`): запись
 * создаётся (`tx.messengerAccount.create`) только когда сотрудник добавляет
 * аккаунт в Настройках → Каналы; последующая сверка идентификаторов
 * (`reconcileInstagramAccountIds`, accounts.ts:251-310) только ОБНОВЛЯЕТ поля
 * существующей записи (`update`), новую не создаёт и `createdAt` не трогает.
 * Значит `createdAt` — надёжный прокси «когда этот аккаунт стал живым в CRM»
 * (подключение), а не случайная метка технической миграции.
 *
 * Если на момент, когда диалог получил своё первое сообщение, из двух
 * инстаграм-аккаунтов канала существовал только ОДИН — это не догадка, а
 * жёсткий факт времени: сообщение физически не могло прийти второму аккаунту,
 * потому что его ещё не существовало в системе.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * КАКУЮ МЕТКУ ДИАЛОГА БРАТЬ: createdAt, А НЕ lastMessageAt
 * ─────────────────────────────────────────────────────────────────────────
 *
 * В задании предлагались обе метки диалога — «lastMessageAt (или время самого
 * раннего сообщения, если оно осмысленнее)». Здесь осмысленнее именно раннее
 * сообщение, т.е. `BotConversation.createdAt` (запись создаётся в
 * `upsertConversation` строго на ПЕРВОЕ сообщение диалога, дальше только
 * обновляется — conversation.ts, ветка `create`).
 *
 * Причина: у Instagram отправитель приходит как IGSID — идентификатор,
 * привязанный к ПАРЕ «подписчик + НАШ аккаунт, которому он пишет», а не только
 * к подписчику (см. `lib/ownAccountGuard.ts:11-15`: «в вебхуке отправитель
 * приходит как IGSID, привязанный к паре «кто кому пишет»» — тот же человек,
 * пишущий двум разным нашим аккаунтам, получает у Meta два РАЗНЫХ IGSID).
 * `BotConversation` уникален по `(channel, subscriberId)` — то есть одна
 * строка диалога = один конкретный (подписчик, наш аккаунт) — и этот аккаунт
 * физически не может смениться посреди диалога: второе сообщение того же
 * человека ДРУГОМУ нашему аккаунту создало бы ДРУГУЮ строку (другой
 * subscriberId), не апдейтило бы эту.
 *
 * Следствие: аккаунт-владелец диалога — это аккаунт, которому мог прийти
 * САМЫЙ ПЕРВЫЙ его вопрос. Если на момент `createdAt` диалога существовал
 * только один из аккаунтов канала — весь диалог, от первого до последнего
 * сообщения, принадлежит ему, даже если второй аккаунт подключили позже и
 * `lastMessageAt` диалога уже позже этой даты. Использование `lastMessageAt`
 * здесь было бы ИЗЛИШНЕ ОСТОРОЖНЫМ (ложно посчитало бы такой диалог
 * неоднозначным) — а не более безопасным, поэтому не берём его как основную
 * метку. Если это допущение (IGSID не меняется в рамках диалога) когда-либо
 * окажется неверным для какого-то диалога — цена ошибки создателя эвристики
 * есть в выводе ниже: каждое решение печатается с обоснованием, диалоги не
 * трогаются молча.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * КОГДА ЭВРИСТИКА ДАЁТ ОТВЕТ, А КОГДА — НЕТ
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Для диалога канала с несколькими аккаунтами: смотрим, сколько аккаунтов
 * этого канала существовало (createdAt <= dialog.createdAt) на момент первого
 * сообщения диалога.
 *
 *   - Ровно один существовал → ОДНОЗНАЧНО, это он. Проставляем.
 *   - Ни одного не существовало (диалог старше вообще всех аккаунтов канала —
 *     легитимно для очень старых диалогов) → эвристика не помогает, диалог
 *     остаётся NULL, печатаем отдельно как «старше всех аккаунтов».
 *   - Два и более уже существовало → ОБА (или больше) уже были подключены,
 *     различить по времени нечем — это тот же тупик, что и в скрипте №1,
 *     эвристика честно не гадает и оставляет диалог как есть.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ГАРАНТИИ
 * ─────────────────────────────────────────────────────────────────────────
 *
 * - Никогда не перезаписывает уже заполненный `accountId` (выборка всегда по
 *   `accountId: null`, и `update` в момент записи повторно проверяет `null`).
 * - Не трогает каналы с одним или нулём аккаунтов — для них это уже сделал
 *   (или не смог сделать по объективной причине) скрипт №1.
 * - Идемпотентен: повторный прогон после --apply не находит диалогов с
 *   `accountId IS NULL`, которые ещё раз можно было бы решить, — не меняет
 *   ничего.
 * - Dry-run по умолчанию. `--apply` — применить. Без `--apply` не пишет
 *   НИЧЕГО.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *     npx tsx scripts/backfill-conversation-account-id-by-timestamp.ts            — показать план
 *     npx tsx scripts/backfill-conversation-account-id-by-timestamp.ts --apply    — выполнить
 */
import { prisma } from "../src/db.js";

type AccountRow = { id: string; channel: string; title: string; externalId: string; createdAt: Date };
type DialogRow = { id: string; channel: string; subscriberId: string; createdAt: Date; lastMessageAt: Date | null };

function fmt(d: Date): string {
  return d.toISOString();
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const accounts: AccountRow[] = await prisma.messengerAccount.findMany({
    select: { id: true, channel: true, title: true, externalId: true, createdAt: true },
  });

  const byChannel = new Map<string, AccountRow[]>();
  for (const a of accounts) {
    const list = byChannel.get(a.channel) ?? [];
    list.push(a);
    byChannel.set(a.channel, list);
  }

  // Интересуют только каналы с НЕСКОЛЬКИМИ аккаунтами — с одним/нулём уже
  // разобрался (или не смог по объективной причине) скрипт №1.
  const ambiguousChannels = [...byChannel.entries()].filter(([, list]) => list.length > 1).map(([ch]) => ch);

  if (ambiguousChannels.length === 0) {
    console.log("Нет каналов с несколькими аккаунтами — эта эвристика не нужна (см. backfill-conversation-account-id.ts).");
    return;
  }

  console.log("Каналы с несколькими аккаунтами и их датами подключения (MessengerAccount.createdAt):");
  for (const ch of ambiguousChannels) {
    const list = [...(byChannel.get(ch) ?? [])].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    console.log(`  ${ch}:`);
    for (const a of list) {
      console.log(`    «${a.title}» (${a.externalId}) — подключён ${fmt(a.createdAt)}`);
    }
  }

  const dialogs: DialogRow[] = await prisma.botConversation.findMany({
    where: { accountId: null, channel: { in: ambiguousChannels } },
    select: { id: true, channel: true, subscriberId: true, createdAt: true, lastMessageAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`\nДиалогов с accountId IS NULL на этих каналах: ${dialogs.length}`);
  if (dialogs.length === 0) {
    console.log("Нечего решать.");
    return;
  }

  const resolved: Array<{ dialog: DialogRow; account: AccountRow; reason: string }> = [];
  const stillAmbiguous: Array<{ dialog: DialogRow; reason: string }> = [];
  const olderThanAllAccounts: Array<{ dialog: DialogRow; reason: string }> = [];

  for (const d of dialogs) {
    const list = [...(byChannel.get(d.channel) ?? [])].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    // Аккаунты, которые уже существовали на момент первого сообщения диалога.
    const existedAtCreation = list.filter((a) => a.createdAt.getTime() <= d.createdAt.getTime());

    if (existedAtCreation.length === 1) {
      const only = existedAtCreation[0]!;
      const others = list.filter((a) => a.id !== only.id);
      const reason =
        `диалог начался ${fmt(d.createdAt)} (первое сообщение), на тот момент существовал только один ` +
        `аккаунт канала — «${only.title}» (подключён ${fmt(only.createdAt)}); ` +
        others.map((o) => `«${o.title}» подключён позже, ${fmt(o.createdAt)}`).join(", ") +
        ` → второй аккаунт этому диалогу физически прийти не мог`;
      resolved.push({ dialog: d, account: only, reason });
    } else if (existedAtCreation.length === 0) {
      const reason =
        `диалог начался ${fmt(d.createdAt)} — раньше, чем был подключён любой из аккаунтов канала ` +
        `(${list.map((a) => `«${a.title}» ${fmt(a.createdAt)}`).join(", ")}); ` +
        `эвристика по времени подключения аккаунта здесь неприменима`;
      olderThanAllAccounts.push({ dialog: d, reason });
    } else {
      const reason =
        `диалог начался ${fmt(d.createdAt)} (последнее сообщение ${d.lastMessageAt ? fmt(d.lastMessageAt) : "—"}) — ` +
        `к этому моменту уже были подключены ${existedAtCreation.length} аккаунта(ов) канала ` +
        `(${existedAtCreation.map((a) => `«${a.title}» с ${fmt(a.createdAt)}`).join(", ")}) — ` +
        `различить по времени нечем, нужен сохранённый externalId вебхука, которого нет`;
      stillAmbiguous.push({ dialog: d, reason });
    }
  }

  console.log(`\nБудет проставлено (единственный аккаунт существовал на момент первого сообщения): ${resolved.length}`);
  for (const r of resolved) {
    console.log(`  диалог ${r.dialog.id} (subscriberId ${r.dialog.subscriberId}) → «${r.account.title}» (${r.account.id})`);
    console.log(`    почему: ${r.reason}`);
  }

  console.log(`\nСтарше всех аккаунтов канала — эвристика не применима: ${olderThanAllAccounts.length}`);
  for (const r of olderThanAllAccounts) {
    console.log(`  диалог ${r.dialog.id} (subscriberId ${r.dialog.subscriberId})`);
    console.log(`    почему: ${r.reason}`);
  }

  console.log(`\nВСЁ ЕЩЁ НЕОДНОЗНАЧНО — оба (или больше) аккаунта уже были подключены: ${stillAmbiguous.length}`);
  for (const r of stillAmbiguous) {
    console.log(`  диалог ${r.dialog.id} (subscriberId ${r.dialog.subscriberId})`);
    console.log(`    почему: ${r.reason}`);
  }

  console.log(`\nИтого будет обновлено диалогов: ${resolved.length}`);

  if (!apply) {
    console.log(resolved.length > 0 ? "\nЗапустите с --apply, чтобы применить." : "\nМенять нечего.");
    return;
  }

  for (const r of resolved) {
    // where: accountId null повторно — на случай, если между расчётом плана и
    // записью диалог получил новое сообщение и accountId проставился сам
    // (ленивая простановка живым кодом, conversation.ts upsertConversation).
    // Не перезаписываем то, что появилось само.
    const res = await prisma.botConversation.updateMany({
      where: { id: r.dialog.id, accountId: null },
      data: { accountId: r.account.id },
    });
    console.log(`  диалог ${r.dialog.id}: обновлено ${res.count} (ожидалось 1)`);
  }
  console.log("\nГотово.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
