/**
 * Разовая чистка накопленных дублей автозадач (21.09.2026, docs/TASKS.md
 * «Автозадачи не видят состоявшегося контакта»).
 *
 * До этой правки часть генераторов (lib/telephony/incomingCalls.ts на каждый
 * пропущенный входящий, lib/noAnswerStreak.ts::notifyNoAnswerEscalation на
 * каждую эскалацию) заводила новую задачу без проверки, есть ли уже открытая
 * такая же. Дедуп на запись (lib/autoTasks.ts) новые дубли останавливает, но
 * старые, уже накопленные на проде, сам не уберёт — они заведены ДО того, как
 * у них появился autoTaskKind, и upsertAutoTask увидит их как «уже закрытые»
 * только после этой чистки.
 *
 * ЧТО ДЕЛАЕТ. По каждому живому клиенту (deletedAt: null) группирует открытые
 * задачи (nextAction не пуст, completedAt пуст) ПО ТЕКСТОВОМУ ПРЕФИКСУ nextAction
 * (до первого числа/кода — «Перезвонить — клиент не ответил (попытка» и т.п.),
 * а не по autoTaskKind: у старых записей это поле пустое (миграция не задним
 * числом), и как раз ЭТИ записи чистка обязана найти. Внутри каждой группы
 * оставляет САМУЮ СВЕЖУЮ (по createdAt) запись, остальные снимает —
 * nextAction: null, nextActionDate: null, completedAt: now (тот же приём, что
 * closeAutoTasks в lib/autoTasks.ts).
 *
 * РУЧНЫЕ ЗАДАЧИ НЕ ТРОГАЕТ. Группировка идёт только по префиксам известных
 * автогенераторов (см. KNOWN_PREFIXES ниже) — свободный текст, который завёл
 * агент или ИИ-ассистент руками, ни под один префикс не подходит и в выборку
 * не попадает.
 *
 * Запуск из корня репозитория:
 *   npx tsx scripts/dedupe-auto-tasks.ts           — только показать, что изменится
 *   npx tsx scripts/dedupe-auto-tasks.ts --apply   — записать в базу
 * .env подхватывается из apps/api сам (dotenv ниже) — руками экспортировать не нужно.
 */
import "./_env.cjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prisma } from "../apps/api/src/db.js";

const APPLY = process.argv.includes("--apply");

/**
 * Известные автогенераторы — текст ДО первой переменной части (число, дата,
 * имя, код карточки). Порядок важен: первый совпавший префикс побеждает.
 * Держать в паре с AUTO_TASK_KINDS (apps/api/src/lib/autoTasks.ts) — заводишь
 * новый вид автозадачи там, добавь и сюда, иначе разовая чистка его не увидит.
 */
const KNOWN_PREFIXES: { label: string; prefix: string }[] = [
  { label: "inbound_missed_callback", prefix: "Перезвонить — клиент звонил сам и не дозвонился" },
  { label: "voicemail_callback", prefix: "Перезвонить: клиент оставил сообщение" },
  { label: "no_answer_retry", prefix: "Перезвонить — клиент не ответил (попытка" },
  { label: "no_answer_supervisor_check", prefix: "Проверить контакт с клиентом" },
  { label: "no_answer_tail_retry", prefix: "Ещё раз попробовать дозвониться" },
  { label: "chat_window_closed_call", prefix: "Написать в чат нельзя, окно закрыто" },
  { label: "chat_window_closed_wait", prefix: "Клиент ждёт ответа" },
  { label: "deal_stale_seller_add_property", prefix: "Добавьте объект по заявке" },
  { label: "deal_stale_buyer_close_deal", prefix: "Закройте сделку или обновите статус по заявке" },
];

export function matchPrefix(nextAction: string): string | null {
  for (const { label, prefix } of KNOWN_PREFIXES) {
    if (nextAction.startsWith(prefix)) return label;
  }
  return null;
}

export interface OpenTaskRow {
  id: string;
  clientId: string;
  nextAction: string | null;
  createdAt: Date;
}

/**
 * Чистая функция — вход/выход без базы, чтобы план дедупа можно было
 * проверить тестом (tests/dedupe-auto-tasks.test.ts) без поднятого Postgres.
 * `main()` ниже — тонкая обвязка поверх неё: читает из базы, печатает план,
 * и только с `--apply` пишет.
 */
export function computeDedupePlan(openTasks: OpenTaskRow[]): { id: string; clientId: string; label: string; nextAction: string; createdAt: Date }[] {
  // Ожидает openTasks, отсортированные по createdAt DESC (самая свежая первой) —
  // как их и отдаёт запрос в main() ниже (orderBy: { createdAt: "desc" }).
  const groups = new Map<string, Map<string, OpenTaskRow[]>>();
  for (const task of openTasks) {
    if (!task.nextAction) continue;
    const label = matchPrefix(task.nextAction);
    if (!label) continue;
    let byLabel = groups.get(task.clientId);
    if (!byLabel) {
      byLabel = new Map();
      groups.set(task.clientId, byLabel);
    }
    const list = byLabel.get(label) ?? [];
    list.push(task);
    byLabel.set(label, list);
  }

  const toClose: { id: string; clientId: string; label: string; nextAction: string; createdAt: Date }[] = [];
  for (const byLabel of groups.values()) {
    for (const [label, tasks] of byLabel) {
      if (tasks.length <= 1) continue;
      // Первая — самая свежая (вход отсортирован по createdAt desc) — остаётся,
      // остальные снимаются.
      for (const stale of tasks.slice(1)) {
        toClose.push({ id: stale.id, clientId: stale.clientId, label, nextAction: stale.nextAction!, createdAt: stale.createdAt });
      }
    }
  }
  return toClose;
}

interface DedupeStats {
  clientsScanned: number;
  openTasksScanned: number;
  duplicateGroups: number;
  tasksClosed: number;
  closedByLabel: Record<string, number>;
}

async function main(): Promise<void> {
  const now = new Date();
  const stats: DedupeStats = {
    clientsScanned: 0,
    openTasksScanned: 0,
    duplicateGroups: 0,
    tasksClosed: 0,
    closedByLabel: {},
  };

  // Тянем только то, что нужно для группировки, — не весь Interaction. Потолка
  // выборки нарочно нет: разовый скрипт, а не эндпоинт (то же, чем
  // backfill-instagram-links.ts объясняет свой полный findMany).
  const openTasks = await prisma.interaction.findMany({
    where: {
      nextAction: { not: null },
      completedAt: null,
      client: { deletedAt: null },
    },
    select: { id: true, clientId: true, nextAction: true, createdAt: true, client: { select: { shortId: true } } },
    orderBy: { createdAt: "desc" },
  });
  stats.openTasksScanned = openTasks.length;
  stats.clientsScanned = new Set(openTasks.map((t) => t.clientId)).size;

  const shortIdByClient = new Map(openTasks.map((t) => [t.clientId, t.client.shortId]));
  const toCloseRaw = computeDedupePlan(openTasks);
  const toClose = toCloseRaw.map((item) => ({ ...item, shortId: shortIdByClient.get(item.clientId)! }));
  stats.duplicateGroups = new Set(toCloseRaw.map((t) => `${t.clientId}:${t.label}`)).size;
  for (const item of toClose) stats.closedByLabel[item.label] = (stats.closedByLabel[item.label] ?? 0) + 1;
  stats.tasksClosed = toClose.length;

  console.log(`Клиентов с автозадачами: ${stats.clientsScanned}`);
  console.log(`Открытых задач всего: ${stats.openTasksScanned}`);
  console.log(`Групп с дублями: ${stats.duplicateGroups}`);
  console.log(`Задач будет снято: ${stats.tasksClosed}`);
  console.log("По видам:", stats.closedByLabel);

  if (toClose.length > 0) {
    console.log("\nПримеры (до 20):");
    for (const item of toClose.slice(0, 20)) {
      console.log(`  ПК-${String(item.shortId).padStart(6, "0")} [${item.label}] ${item.createdAt.toISOString()}: ${item.nextAction}`);
    }
  }

  if (!APPLY) {
    console.log("\nРежим показа (--apply не передан) — ничего не изменено.");
    return;
  }

  // Пакетами — одним updateMany на все id сразу (их порядок тысяч даже на
  // проде не будет, но 1000+ id в одном IN всё равно нежелательны).
  const BATCH = 200;
  let closed = 0;
  for (let i = 0; i < toClose.length; i += BATCH) {
    const batch = toClose.slice(i, i + BATCH).map((t) => t.id);
    const result = await prisma.interaction.updateMany({
      where: { id: { in: batch } },
      data: { nextAction: null, nextActionDate: null, completedAt: now },
    });
    closed += result.count;
  }
  console.log(`\nСнято дублей: ${closed}`);
}

// Запускать main() ТОЛЬКО при прямом исполнении (`npx tsx scripts/dedupe-auto-tasks.ts`),
// не при импорте computeDedupePlan/matchPrefix тестом
// (tests/dedupe-auto-tasks-plan.test.ts) — иначе тест без поднятого стенда
// падал бы не на своей проверке, а на подключении к базе, которого не просил.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
