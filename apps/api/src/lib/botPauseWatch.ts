import { prisma } from "../db.js";

/**
 * «БОТ НА ПАУЗЕ И ЗАБЫЛИ» (Пачка 17, 12.09.2026).
 *
 * Факт прода 11.09.2026: 187 диалогов (Instagram 162, WhatsApp 25) стояли на паузе
 * бота дольше 3 суток без единого касания человеком — агент один раз ответил
 * вручную (или бот сам передал разговор после серии оффтопиков,
 * см. OFF_TOPIC_HANDOVER_PAUSE_MS в messengers/conversation.ts), пауза встала
 * фактически бессрочно, и на этом всё: клиент писал в пустоту, а никто не узнавал.
 *
 * ДВЕ СТУПЕНИ, КАК У «АГЕНТ НЕ ОТВЕЧАЕТ ПРОДАВЦУ» (lib/agentUnansweredAlarm.ts,
 * lib/agentUnansweredAlarm.ts — автопередача удалена 16.09.2026) — только здесь бот сам берёт слово на второй
 * ступени, а не карточка переезжает к другому агенту:
 *   1. `botPauseAlertHours` (по умолчанию 24 ч) — только отметка `pauseAlertSentAt`
 *      (не чаще раза в сутки на диалог); пуши агенту и руководству убраны
 *      владельцем 02.10.2026.
 *   2. `botPauseEscalateHours` (по умолчанию 72 ч) — пауза снимается сама (бот
 *      отвечает снова), Interaction на карточке (пуш руководству убран 02.10.2026). Диалог без
 *      карточки клиента эскалируется тем же порядком, только без Interaction —
 *      писать её некуда.
 *
 * ЧТО СЧИТАЕТСЯ «ЖДЁТ». Диалог стоит на паузе (`pausedUntil` в будущем — тот же
 * признак и у ручной паузы оператора, и у автоматической передачи после
 * оффтопика: разница в причине не в длительности, обе фактически бессрочные) И
 * последняя реплика в истории — от клиента: пока пауза действует, бот не
 * отвечает вовсе, так что «последняя реплика от клиента» и «человек не ответил»
 * здесь одно и то же (тот же признак, что и в lib/stuckConversations.ts).
 *
 * СХЕМА МЕНЯЛАСЬ РУКАМИ (agent-brief worktree: `prisma generate` в изолированной
 * копии запрещён — общий клиент ломает соседние сессии). Новые колонки
 * (`BotConversation.pauseAlertSentAt`, `TelegramConversation.pauseAlertSentAt`,
 * три поля `Settings`) читаются и пишутся через `$queryRaw`/`$executeRaw` —
 * типизированный клиент их не знает, пока сборщик не прогонит
 * `prisma generate` на актуальной схеме.
 *
 * ЗВОНКИ НЕ ВИДНЫ ЧЕРЕЗ ЧАТ (найдено 24.09.2026, карточка ПР-000381): «ждёт
 * ответа» здесь считалось только по последней реплике `role:'user'` в
 * `BotConversation.messages` — агент, который каждый день созванивался с
 * клиентом (Interaction type CALL), молчал только в переписке, но эскалация
 * писала «агент не ответил клиенту 73 ч» — утверждение про человека, которое
 * было прямой ложью: агент отвечал, просто по телефону, а не в чате бота.
 * Перед эскалацией (не перед первым пушем-напоминанием — тот честно говорит
 * «ждёт ответа в переписке», а не «агент бездействует») запрос проверяет,
 * не было ли после последней реплики клиента звонка с сотрудником — тем же
 * критерием «состоявшегося разговора», что и `silentClientAutoDeactivate.ts`:
 * `recordingDurationSec > 0` ИЛИ `outcome` проставлен и не `NO_ANSWER`
 * (недозвон/пустой исход агента контактом не считается).
 */

export interface BotPauseWatchSettings {
  enabled: boolean;
  /** Через сколько часов ожидания уходит первый пуш агенту. */
  alertHours: number;
  /** Через сколько часов пауза снимается сама и уходит пуш руководству. */
  escalateHours: number;
}

const DEFAULT_SETTINGS: BotPauseWatchSettings = { enabled: true, alertHours: 24, escalateHours: 72 };

/** Не чаще раза в сутки — общий порог для дедупа пуша агенту. */
const ALERT_THROTTLE_MS = 24 * 60 * 60 * 1000;

export async function loadBotPauseWatchSettings(): Promise<BotPauseWatchSettings> {
  const rows = await prisma.$queryRaw<
    { botPauseWatchEnabled: boolean | null; botPauseAlertHours: number | null; botPauseEscalateHours: number | null }[]
  >`SELECT "botPauseWatchEnabled", "botPauseAlertHours", "botPauseEscalateHours" FROM "Settings" WHERE id = 'singleton'`;
  const row = rows[0];
  if (!row) return DEFAULT_SETTINGS;
  return {
    enabled: row.botPauseWatchEnabled ?? DEFAULT_SETTINGS.enabled,
    alertHours: row.botPauseAlertHours ?? DEFAULT_SETTINGS.alertHours,
    escalateHours: row.botPauseEscalateHours ?? DEFAULT_SETTINGS.escalateHours,
  };
}

export type PauseWatchStage = "none" | "alert" | "escalate";

/** Чистое правило порогов — проверяется тестом без базы. */
export function pauseWatchStageFor(
  waitingHours: number,
  cfg: Pick<BotPauseWatchSettings, "alertHours" | "escalateHours">
): PauseWatchStage {
  if (waitingHours >= cfg.escalateHours) return "escalate";
  if (waitingHours >= cfg.alertHours) return "alert";
  return "none";
}

/** true, если пуш «клиент ждёт» можно слать снова (не чаще раза в сутки). */
export function canSendPauseAlert(lastSentAt: Date | null, now: Date = new Date()): boolean {
  if (!lastSentAt) return true;
  return now.getTime() - lastSentAt.getTime() >= ALERT_THROTTLE_MS;
}

export interface PausedWaitingRow {
  id: string;
  source: "bot" | "telegram";
  channel: string | null;
  name: string | null;
  clientId: string | null;
  clientShortId: number | null;
  clientFullName: string | null;
  assignedAgentId: string | null;
  lastMessageAt: Date;
  pauseAlertSentAt: Date | null;
}

interface RawPausedRow {
  id: string;
  channel: string | null;
  name: string | null;
  clientId: string | null;
  lastMessageAt: Date;
  pauseAlertSentAt: Date | null;
  clientShortId: number | null;
  clientFullName: string | null;
  assignedAgentId: string | null;
}

/** Предел выборки — как у соседних тиков, один тяжёлый час не держит колом весь цикл. */
const ROW_LIMIT = 300;

async function findPausedWaitingRows(cutoff: Date): Promise<PausedWaitingRow[]> {
  const [bot, tg] = await Promise.all([
    prisma.$queryRaw<RawPausedRow[]>`
      SELECT c.id, c.channel, c.name, c."clientId", c."lastMessageAt", c."pauseAlertSentAt",
             cl."shortId" AS "clientShortId", cl."fullName" AS "clientFullName", cl."assignedAgentId" AS "assignedAgentId"
        FROM "BotConversation" c
        LEFT JOIN "Client" cl ON cl.id = c."clientId" AND cl."deletedAt" IS NULL
       WHERE c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now()
         AND jsonb_typeof(c.messages) = 'array' AND jsonb_array_length(c.messages) > 0
         AND (c.messages -> (jsonb_array_length(c.messages) - 1) ->> 'role') = 'user'
         AND c."lastMessageAt" IS NOT NULL AND c."lastMessageAt" <= ${cutoff}
         AND c."optedOutAt" IS NULL
       ORDER BY c."lastMessageAt" ASC
       LIMIT ${ROW_LIMIT}
    `,
    prisma.$queryRaw<RawPausedRow[]>`
      SELECT c.id, NULL::text AS channel, c.username AS name, c."clientId", c."lastMessageAt", c."pauseAlertSentAt",
             cl."shortId" AS "clientShortId", cl."fullName" AS "clientFullName", cl."assignedAgentId" AS "assignedAgentId"
        FROM "TelegramConversation" c
        LEFT JOIN "Client" cl ON cl.id = c."clientId" AND cl."deletedAt" IS NULL
       WHERE c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now()
         AND jsonb_typeof(c.messages) = 'array' AND jsonb_array_length(c.messages) > 0
         AND (c.messages -> -1 ->> 'role') = 'user'
         AND c."lastMessageAt" IS NOT NULL AND c."lastMessageAt" <= ${cutoff}
       ORDER BY c."lastMessageAt" ASC
       LIMIT ${ROW_LIMIT}
    `,
  ]);
  return [
    ...bot.map((r): PausedWaitingRow => ({ ...r, source: "bot" as const })),
    ...tg.map((r): PausedWaitingRow => ({ ...r, source: "telegram" as const })),
  ];
}

/**
 * true, если контакт был — после последней реплики клиента в чате случился
 * состоявшийся звонок с сотрудником, и этот звонок сам не старше окна
 * эскалации. Чистая функция, проверяется тестом без базы (см. doc-comment
 * модуля, карточка ПР-000381).
 *
 * `now`/`escalateHoursWindow` — правка ревью 24.09.2026. `lastCallAt` приходит
 * из fetchLastCallContactByClient как МАКСИМУМ по ВСЕЙ истории звонков клиента,
 * а не только по недавним. Без этой проверки один звонок сразу после реплики
 * клиента (даже случившийся, скажем, две недели назад) навсегда блокировал
 * эскалацию — «diалог забыт», ради которого модуль и создан, только с другой
 * причиной: раньше терялись диалоги без ЛЮБОГО касания, теперь терялся бы
 * диалог с ОДНИМ старым звонком и молчанием агента все дни после. Тот же
 * порог, что у самой эскалации (`escalateHours`, cfg): звонок внутри этого
 * окна — контакт был недавно, эскалация подождёт; звонок старше — контакт был
 * настолько давно, что уже не отменяет факт «сейчас клиент ждёт ответа».
 */
export function hadCallContactAfter(
  lastMessageAt: Date,
  lastCallAt: Date | null,
  now: Date,
  escalateHoursWindow: number
): boolean {
  if (!lastCallAt) return false;
  if (lastCallAt.getTime() <= lastMessageAt.getTime()) return false;
  const callAgeHours = (now.getTime() - lastCallAt.getTime()) / 3_600_000;
  if (callAgeHours > escalateHoursWindow) {
    console.warn(
      `[бот на паузе] звонок сотрудника был ${callAgeHours.toFixed(1)} ч назад — старше окна эскалации ` +
        `(${escalateHoursWindow} ч), эскалацию он больше не блокирует`
    );
    return false;
  }
  return true;
}

/** Последний состоявшийся звонок сотрудника по каждому клиенту из пачки —
 *  ОДНИМ запросом (groupBy), не в цикле: кандидатов до 2×ROW_LIMIT, отдельный
 *  запрос на каждого был бы тем самым N+1, которого тут не должно быть. */
async function fetchLastCallContactByClient(clientIds: string[]): Promise<Map<string, Date>> {
  if (clientIds.length === 0) return new Map();
  const rows = await prisma.interaction.groupBy({
    by: ["clientId"],
    where: {
      clientId: { in: clientIds },
      type: "CALL",
      agentId: { not: null },
      // Тот же критерий «состоявшегося разговора», что в silentClientAutoDeactivate.ts:
      // недозвон (outcome = NO_ANSWER) и звонок без проставленного итога (outcome = null)
      // контактом не считаются — notIn по nullable-колонке их и не ловит.
      OR: [{ recordingDurationSec: { gt: 0 } }, { outcome: { notIn: ["NO_ANSWER"] } }],
    },
    _max: { createdAt: true },
  });
  const map = new Map<string, Date>();
  for (const row of rows) {
    if (row._max.createdAt) map.set(row.clientId, row._max.createdAt);
  }
  return map;
}

async function markAlerted(row: PausedWaitingRow, at: Date): Promise<void> {
  if (row.source === "bot") {
    await prisma.$executeRaw`UPDATE "BotConversation" SET "pauseAlertSentAt" = ${at} WHERE id = ${row.id}`;
  } else {
    await prisma.$executeRaw`UPDATE "TelegramConversation" SET "pauseAlertSentAt" = ${at} WHERE id = ${row.id}`;
  }
}

/** Снимает паузу — бот снова отвечает сам (typed update: pausedUntil/botPausedAt уже
 *  в схеме, миграция под них не нужна). */
async function clearPause(row: PausedWaitingRow): Promise<void> {
  if (row.source === "bot") {
    await prisma.botConversation.update({ where: { id: row.id }, data: { pausedUntil: null, botPausedAt: null } });
  } else {
    await prisma.telegramConversation.update({ where: { id: row.id }, data: { pausedUntil: null, botPausedAt: null } });
  }
}

function displayNameOf(row: PausedWaitingRow): string {
  return row.clientFullName ?? row.name ?? "клиент без имени";
}

/** Ступень 1: только отметка `pauseAlertSentAt` — чтобы не пересчитывать диалог каждый тик.
 *  Владелец 02.10.2026: пуш и запись в ленту («⏸️ Диалог на паузе без агента») убраны —
 *  информационное уведомление не нужно; пауза и эскалация на 72 ч остались. */
async function alertStage(row: PausedWaitingRow, now: Date): Promise<void> {
  await markAlerted(row, now);
}

async function escalateStage(row: PausedWaitingRow, waitingHours: number): Promise<void> {
  const hours = Math.round(waitingHours);
  await clearPause(row);

  // Пуш руководству «🤖 Пауза бота снята автоматически» убран владельцем 02.10.2026:
  // пауза снимается, запись в карточку клиента остаётся.
  if (row.clientId && row.assignedAgentId) {
    await prisma.interaction
      .create({
        data: {
          clientId: row.clientId,
          agentId: row.assignedAgentId,
          type: "SYSTEM",
          notes: `Пауза снята автоматически: в переписке ${hours} ч не было ответа сотрудника, пока бот молчал — бот снова отвечает сам.`,
        },
      })
      .catch((err) => console.error("[бот на паузе] запись о снятии:", err instanceof Error ? err.message : err));
  }
}

export interface BotPauseWatchResult {
  alerted: number;
  escalated: number;
}

/** ТИК КРОНА — раз в час (см. cron.ts). */
export async function runBotPauseWatchTick(now: Date = new Date()): Promise<BotPauseWatchResult> {
  const cfg = await loadBotPauseWatchSettings();
  if (!cfg.enabled) return { alerted: 0, escalated: 0 };

  const cutoff = new Date(now.getTime() - cfg.alertHours * 3_600_000);
  const rows = await findPausedWaitingRows(cutoff);
  if (rows.length === 0) return { alerted: 0, escalated: 0 };

  // Звонки не видны через чат (см. doc-comment модуля, ПР-000381) — карта
  // «клиент → последний состоявшийся звонок» одним запросом на всю пачку,
  // а не в цикле по строкам.
  const clientIds = [...new Set(rows.map((r) => r.clientId).filter((id): id is string => id != null))];
  const lastCallByClient = await fetchLastCallContactByClient(clientIds);

  let alerted = 0;
  let escalated = 0;
  for (const row of rows) {
    const waitingHours = (now.getTime() - row.lastMessageAt.getTime()) / 3_600_000;
    const stage = pauseWatchStageFor(waitingHours, cfg);
    try {
      if (stage === "escalate") {
        const lastCallAt = row.clientId ? (lastCallByClient.get(row.clientId) ?? null) : null;
        if (hadCallContactAfter(row.lastMessageAt, lastCallAt, now, cfg.escalateHours)) {
          // Контакт был, просто по телефону — паузу не снимаем и не эскалируем:
          // на следующем тике снова проверим по актуальному lastMessageAt/звонкам.
          continue;
        }
        await escalateStage(row, waitingHours);
        escalated++;
      } else if (stage === "alert" && canSendPauseAlert(row.pauseAlertSentAt, now)) {
        await alertStage(row, now);
        alerted++;
      }
    } catch (err) {
      console.error("[бот на паузе] тик:", err instanceof Error ? err.message : err);
    }
  }
  return { alerted, escalated };
}

/** Утренние числа: `MorningNumbers.botPausedNoReply24h` — см. lib/morningNumbers.ts.
 *  Фиксированный порог в 24 часа независимо от настройки — честный ежедневный
 *  градусник, тот же приём, что у sellersWithoutPropertyOver7Days. */
export async function countBotPausedNoReply24h(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 3_600_000);
  const [bot, tg] = await Promise.all([
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n
        FROM "BotConversation" c
       WHERE c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now()
         AND jsonb_typeof(c.messages) = 'array' AND jsonb_array_length(c.messages) > 0
         AND (c.messages -> (jsonb_array_length(c.messages) - 1) ->> 'role') = 'user'
         AND c."lastMessageAt" IS NOT NULL AND c."lastMessageAt" <= ${cutoff}
         AND c."optedOutAt" IS NULL
    `,
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n
        FROM "TelegramConversation" c
       WHERE c."pausedUntil" IS NOT NULL AND c."pausedUntil" > now()
         AND jsonb_typeof(c.messages) = 'array' AND jsonb_array_length(c.messages) > 0
         AND (c.messages -> -1 ->> 'role') = 'user'
         AND c."lastMessageAt" IS NOT NULL AND c."lastMessageAt" <= ${cutoff}
    `,
  ]);
  return Number(bot[0]?.n ?? 0) + Number(tg[0]?.n ?? 0);
}
