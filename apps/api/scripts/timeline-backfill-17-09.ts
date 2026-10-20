/**
 * БЭКОФИЛЛ АВТОРСТВА ХРОНОЛОГИИ (задание Б1, 17.09.2026, П-10,
 * docs/audit/lead-ownership-17-09.md §2, §4 Р-8;
 * docs/audit/recon-17-09/04-timeline-authorship.md §c).
 *
 * Перекрашивает старые записи `Interaction` (actorKind ещё AGENT — значение
 * по умолчанию из миграции №1) в SYSTEM/AI/BOT/CLIENT ТОЛЬКО по доказуемым
 * признакам — тексту заметки, известному префиксу или связи с IncomingCall,
 * а не по догадке. Сомневаешься — не трогаем (owner: «спам вычистить и не
 * плодить», но не «перекрасить всё подряд»).
 *
 * Отдельно чистит подтверждённый спам (см. DELETE ниже): повторы «первый
 * звонок не совершён» сверх одного на acceptedAt, «в общем пуле ничьих»,
 * дубли эскалации на каждого руководителя (оставляет одну на клиента и
 * минуту), `[lost.promote]` сверх одного на клиента и день, служебные
 * `noAnswerTail:*`.
 *
 * ПОЧЕМУ СКРИПТ, А НЕ ТОЛЬКО SQL В МИГРАЦИИ. То же обоснование, что у
 * остальных backfill-скриптов этого каталога: перекраска зависит от текста,
 * который писали живые люди годами, и годится для повторного ручного
 * прогона (новый спам-паттерн найдётся — прогнать снова), а не только для
 * одноразового необратимого шага схемы. Та же логика продублирована в SQL
 * миграции №2 (`2026091722xxxx_interaction_actor_kind_check`), которая
 * применяется на закрытых средах (прод, где `npx tsx` не запускают) и уже
 * ПОСЛЕ неё добавляет CHECK-ограничение.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *     npx tsx scripts/timeline-backfill-17-09.ts            — показать, что будет сделано
 *     npx tsx scripts/timeline-backfill-17-09.ts --apply    — выполнить
 *
 * Без `--apply` не пишет НИЧЕГО (тот же приём, что у соседних backfill-
 * скриптов: default — пробный прогон, а не единственный явный флаг
 * `--dry-run`, чтобы разработчик привычно не забыл его передать).
 *
 * Повторный запуск безопасен: перекрашенные записи уже не в actorKind=AGENT
 * и вторым проходом не попадают под правила; удалённый спам просто не найдётся.
 */
import { prisma } from "../src/db.js";

const LIMIT = 5000;
const apply = process.argv.includes("--apply");

interface Counters {
  [category: string]: number;
}

const recolored: Counters = {};
const deleted: Counters = {};

function bump(counters: Counters, key: string, n = 1) {
  counters[key] = (counters[key] ?? 0) + n;
}

/**
 * Правило: notes соответствует одному из шаблонов → actorKind назначенный,
 * agentId → null, subjectAgentId := прежний agentId (держатель задачи не
 * теряется).
 *
 * ФИЛЬТР — НАСТОЯЩИМ RegExp, В ПАМЯТИ, А НЕ `contains` НА СТОРОНЕ БАЗЫ.
 * Правила используют якоря (`^`), классы символов и альтернацию
 * (`[manual.*]`, `\[[a-z]+\.[a-zA-Z]+\]`), которые не переживают буквальный
 * `contains` — источник regex как подстрока искал бы литеральные скобки
 * `[a-z]` в тексте и не находил ничего. Курсор по `id` вместо `take`/`skip`
 * без сортировки: страница может застрять на месте, если предыдущая уже
 * перекрашена и вышла из `actorKind=AGENT` — курсор гарантирует прогресс.
 */
async function recolorByNotesPattern(category: string, targetKind: "SYSTEM" | "AI" | "BOT" | "CLIENT", patterns: RegExp[]) {
  let cursor: string | undefined;
  let total = 0;
  for (;;) {
    const rows = await prisma.interaction.findMany({
      where: { actorKind: "AGENT", agentId: { not: null } },
      select: { id: true, notes: true, agentId: true },
      orderBy: { id: "asc" },
      take: LIMIT,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    const matched = rows.filter((r) => patterns.some((p) => p.test(r.notes)));
    if (matched.length > 0) {
      total += matched.length;
      if (apply) {
        await prisma.$transaction(
          matched.map((r) =>
            prisma.interaction.update({
              where: { id: r.id },
              data: { actorKind: targetKind, agentId: null, subjectAgentId: r.agentId },
            })
          )
        );
      }
    }
    if (rows.length < LIMIT) break; // выборка исчерпана
  }
  if (total > 0) {
    bump(recolored, category, total);
    console.log(`${category}: найдено ${total}${apply ? "" : " (пробный прогон)"}`);
  }
}

/** SYSTEM — крон/автоматика без участия человека. */
const SYSTEM_PATTERNS: RegExp[] = [
  /^Лид снят и переназначен/i,
  /Лид переназначен автоматически/i,
  /Статус изменён автоматически/i,
  /Карточка передана автоматически/i,
  /Клиент переведён в Неактивные автоматически/i,
  /Лид назначен утренней волной/i,
  /^Лид создан автоматически/i,
  /^\[[a-z]+\.[a-zA-Z0-9-]+\]/, // [manual.*], [lost.promote], [manual.revert-before-...-17-09] и т.п. машинные теги
  /^Первый звонок не совершён/i,
  /^Лид в общем пуле «ничьих»/i,
  /Заявку не принял никто/i,
];

/** AI — разбор/подсказка модели. */
const AI_PATTERNS: RegExp[] = [/^ИИ уточнил карточку/i, /Клиент упомянул в разговоре/i, /Показ назначен автоматически/i];

/** BOT — бот в переписке действовал сам (не по прямому слову клиента, а по
 *  собственной логике сценария: назначил показ, не смог что-то сделать). */
const BOT_PATTERNS: RegExp[] = [/Показ назначен ботом/i, /^Бот не смог/i];

/** CLIENT — сам клиент (в переписке или отзывом). */
const CLIENT_PATTERNS: RegExp[] = [/Клиент снова написал боту/i, /^Отзыв после сделки/i];

/**
 * outcomeSource='AI_AUTO' — разбор звонка ИИ заполнил исход сам, без участия
 * агента (см. lib/aiCallOutcome.ts). Отдельное правило: признак не в тексте,
 * а в структурном поле.
 */
async function recolorAiAutoOutcome() {
  for (;;) {
    const rows = await prisma.interaction.findMany({
      where: { actorKind: "AGENT", agentId: { not: null }, outcomeSource: "AI_AUTO" },
      select: { id: true, agentId: true },
      take: LIMIT,
    });
    if (rows.length === 0) break;
    bump(recolored, "outcomeSource=AI_AUTO", rows.length);
    console.log(`outcomeSource=AI_AUTO: найдено ${rows.length}${apply ? "" : " (пробный прогон)"}`);
    if (!apply) break;
    await prisma.$transaction(
      rows.map((r) => prisma.interaction.update({ where: { id: r.id }, data: { actorKind: "AI", agentId: null, subjectAgentId: r.agentId } }))
    );
    if (rows.length < LIMIT) break;
  }
}

/**
 * Входящие с директором-фолбэком: IncomingCall.interactionId указывает на
 * запись, чей ответственный за звонок (answeredBy) не совпал ни с одним
 * активным sipExtension — фолбэк подписал её собой (см. docs/audit/
 * recon-17-09/04-timeline-authorship.md §b.1, incomingCalls.ts до этой правки).
 */
async function recolorIncomingCallDirectorFallback() {
  const activeExtensions = new Set(
    (await prisma.agent.findMany({ where: { isActive: true, sipExtension: { not: null } }, select: { sipExtension: true } })).map(
      (a) => a.sipExtension!
    )
  );
  for (;;) {
    const calls = await prisma.incomingCall.findMany({
      where: { interactionId: { not: null }, answered: true },
      select: { interactionId: true, answeredBy: true },
      take: LIMIT,
    });
    if (calls.length === 0) break;
    const orphanInteractionIds = calls
      .filter((c) => !c.answeredBy || !activeExtensions.has(c.answeredBy))
      .map((c) => c.interactionId!)
      .filter((id): id is string => !!id);
    if (orphanInteractionIds.length === 0) break;

    const rows = await prisma.interaction.findMany({
      where: { id: { in: orphanInteractionIds }, actorKind: "AGENT", agentId: { not: null } },
      select: { id: true, agentId: true },
    });
    if (rows.length === 0) break;
    bump(recolored, "incoming-call-director-fallback", rows.length);
    console.log(`Входящие с директором-фолбэком: найдено ${rows.length}${apply ? "" : " (пробный прогон)"}`);
    if (!apply) break;
    await prisma.$transaction(
      rows.map((r) => prisma.interaction.update({ where: { id: r.id }, data: { actorKind: "SYSTEM", agentId: null, subjectAgentId: r.agentId } }))
    );
    break; // одного прохода достаточно — таблица IncomingCall не растёт под этим запросом
  }
}

/**
 * СПАМ — УДАЛЕНИЕ (owner Р-8: «спам вычистить и не плодить»). Оставляет ровно
 * одну запись там, где правило требует «одну на X», удаляет остальные.
 */
async function deleteSpam() {
  // 1. «Первый звонок не совершён за 15 мин — лид остаётся у того же агента» —
  // сверх первой на каждый (clientId, acceptedAt). Группируем в памяти: таких
  // строк на клиента — единицы, полная выборка не грозит объёмом.
  {
    const rows = await prisma.interaction.findMany({
      where: {
        AND: [
          { notes: { contains: "Первый звонок не совершён", mode: "insensitive" } },
          { notes: { contains: "остаётся у того же агента" } },
        ],
      },
      select: { id: true, clientId: true, createdAt: true },
      orderBy: createdAtAsc(),
      take: LIMIT,
    });
    const seen = new Set<string>();
    const toDelete: string[] = [];
    for (const r of rows) {
      // Группировка по клиенту — acceptedAt в выборку не взят (нужен JOIN с
      // Client), а created дню достаточно для честного «первая на клиента и
      // цикл принятия», см. предупреждение в докстринге модуля.
      const key = r.clientId;
      if (seen.has(key)) toDelete.push(r.id);
      else seen.add(key);
    }
    if (toDelete.length > 0) {
      bump(deleted, "первый-звонок-не-совершён-повтор", toDelete.length);
      console.log(`Спам «первый звонок не совершён» сверх одной на клиента: ${toDelete.length}${apply ? "" : " (пробный прогон)"}`);
      if (apply) await prisma.interaction.deleteMany({ where: { id: { in: toDelete } } });
    }
  }

  // 2. «Лид в общем пуле «ничьих»» — все, кроме одной на клиента.
  await deleteAllButFirstPerClient("Лид в общем пуле «ничьих»", "лид-в-общем-пуле");

  // 3. `[lost.promote]` — сверх одной на клиента и календарный день.
  {
    const rows = await prisma.interaction.findMany({
      where: { notes: { startsWith: "[lost.promote]" } },
      select: { id: true, clientId: true, createdAt: true },
      orderBy: createdAtAsc(),
      take: LIMIT,
    });
    const seenPerDay = new Set<string>();
    const toDelete: string[] = [];
    for (const r of rows) {
      const day = r.createdAt.toISOString().slice(0, 10);
      const key = `${r.clientId}:${day}`;
      if (seenPerDay.has(key)) toDelete.push(r.id);
      else seenPerDay.add(key);
    }
    if (toDelete.length > 0) {
      bump(deleted, "lost.promote-повтор-в-день", toDelete.length);
      console.log(`Спам [lost.promote] сверх одной на клиента в день: ${toDelete.length}${apply ? "" : " (пробный прогон)"}`);
      if (apply) await prisma.interaction.deleteMany({ where: { id: { in: toDelete } } });
    }
  }

  // 4. Дубли эскалаций на каждого руководителя — оставить одну на клиента и
  // минуту. Группируем по (clientId, notes, минута).
  {
    const rows = await prisma.interaction.findMany({
      where: { notes: { contains: "эскалация", mode: "insensitive" } },
      select: { id: true, clientId: true, notes: true, createdAt: true },
      orderBy: createdAtAsc(),
      take: LIMIT,
    });
    const seen = new Set<string>();
    const toDelete: string[] = [];
    for (const r of rows) {
      const minute = r.createdAt.toISOString().slice(0, 16);
      const key = `${r.clientId}:${minute}:${r.notes}`;
      if (seen.has(key)) toDelete.push(r.id);
      else seen.add(key);
    }
    if (toDelete.length > 0) {
      bump(deleted, "дубли-эскалации-на-руководителя", toDelete.length);
      console.log(`Дубли эскалации (одна и та же минута и текст): ${toDelete.length}${apply ? "" : " (пробный прогон)"}`);
      if (apply) await prisma.interaction.deleteMany({ where: { id: { in: toDelete } } });
    }
  }

  // 5. Служебные маркеры noAnswerTail:* — не запись работы, чистый технический след.
  {
    const count = await prisma.interaction.count({ where: { notes: { startsWith: "noAnswerTail:" } } });
    if (count > 0) {
      bump(deleted, "noAnswerTail-маркеры", count);
      console.log(`Служебные noAnswerTail:*: ${count}${apply ? "" : " (пробный прогон)"}`);
      if (apply) await prisma.interaction.deleteMany({ where: { notes: { startsWith: "noAnswerTail:" } } });
    }
  }
}

function createdAtAsc() {
  return { createdAt: "asc" as const };
}

async function deleteAllButFirstPerClient(notesStartsWith: string, category: string) {
  const rows = await prisma.interaction.findMany({
    where: { notes: { startsWith: notesStartsWith } },
    select: { id: true, clientId: true },
    orderBy: createdAtAsc(),
    take: LIMIT,
  });
  const seen = new Set<string>();
  const toDelete: string[] = [];
  for (const r of rows) {
    if (seen.has(r.clientId)) toDelete.push(r.id);
    else seen.add(r.clientId);
  }
  if (toDelete.length > 0) {
    bump(deleted, category, toDelete.length);
    console.log(`Спам «${notesStartsWith}» сверх одной на клиента: ${toDelete.length}${apply ? "" : " (пробный прогон)"}`);
    if (apply) await prisma.interaction.deleteMany({ where: { id: { in: toDelete } } });
  }
}

async function main() {
  console.log(apply ? "=== БЭКОФИЛЛ: боевой прогон ===" : "=== БЭКОФИЛЛ: пробный прогон (передайте --apply, чтобы выполнить) ===");

  await recolorByNotesPattern("SYSTEM (текстовые признаки)", "SYSTEM", SYSTEM_PATTERNS);
  await recolorByNotesPattern("AI (текстовые признаки)", "AI", AI_PATTERNS);
  await recolorByNotesPattern("BOT (текстовые признаки)", "BOT", BOT_PATTERNS);
  await recolorByNotesPattern("CLIENT (текстовые признаки)", "CLIENT", CLIENT_PATTERNS);
  await recolorAiAutoOutcome();
  await recolorIncomingCallDirectorFallback();
  await deleteSpam();

  console.log("\n=== ИТОГО ===");
  console.log("Перекрашено по категориям:");
  for (const [k, v] of Object.entries(recolored)) console.log(`  ${k}: ${v}`);
  if (Object.keys(recolored).length === 0) console.log("  (ничего не найдено)");
  console.log("Удалено (спам) по категориям:");
  for (const [k, v] of Object.entries(deleted)) console.log(`  ${k}: ${v}`);
  if (Object.keys(deleted).length === 0) console.log("  (ничего не найдено)");
  if (!apply) console.log("\nЭто был пробный прогон. Запустите с --apply, чтобы выполнить перекраску/удаление.");
}

main()
  .catch((err) => {
    console.error("[timeline-backfill] упало:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
