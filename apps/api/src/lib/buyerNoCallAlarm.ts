import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { createNotifications } from "./notifications.js";
import { loadHotScoreThreshold } from "./hotScoreThreshold.js";
import { isWithinAlarmHours } from "./workingHours.js";
import { dushanbeDateTimeString } from "./dushanbeTime.js";

type AlarmPayload = {
  kind: "oversight";
  title: string;
  body: string;
  url: string;
  tag: string;
};

/**
 * АЛАРМЫ ДИРЕКТОРУ ПО ТРЕБОВАНИЮ 6 (аудит 02.09.2026, docs/audit-02-09-2026/03-alarms.md §6.1).
 *
 * Два сигнала, которых не хватало:
 *   A) Покупатель ACTIVE + высокий скоринг + нет звонка через CRM ≥ N дней → (пуш директору УБРАН 02.10.2026, см. runBuyerNoCallAlarmTick).
 *      Раньше была только пассивная плитка «Высокий скоринг без прогресса» в /oversight/stalled-clients
 *      (routes/oversight.ts:39-68), пуша не было вовсе.
 *   B) Агент закрыл сделку покупателя безуспешно (POST /clients/:id/refuse) при высоком скоринге →
 *      ОТДЕЛЬНЫЙ пуш директору с акцентом на скоринг. Существующий пуш «❌ Сделка не состоялась»
 *      (lifecycle.ts:788) уходит на ЛЮБОЙ отказ без фильтра по баллу — шум; этот — точечный.
 *
 * ДЕДУП: tag `alarm-buyer-no-call-{clientId}` и `alarm-refused-high-score-{clientId}`.
 * createNotification (lib/notifications.ts:83-122) схлопывает повторные события с тем же
 * (agentId, tag) в одну строку ленты (count++, read=false) — ЭТО СХЛОПЫВАЕТ СТРОКУ, НО НЕ
 * ОГРАНИЧИВАЕТ ЧАСТОТУ: count растёт на каждый час-тик, пока причина не устранена (на проде
 * дошло до счётчика 10 у «Нет звонка 2+ дн», у соседнего аларма по объекту — до 128).
 * ВНИМАНИЕ (20.09.2026): count растёт НА ДВА за одно событие, а не на один. Строку ленты
 * пишет и вызывающий код (`await createNotifications` ниже), и ещё раз `sendPushToAgents`
 * изнутри (push.ts:259 — `void createNotifications`, без ожидания, с тем же tag). То есть
 * проценты на проде («дошло до 10», «до 128») надо делить на два, а ожидание в тесте,
 * опирающееся на count, зелёное лишь когда вторая, неожидаемая запись успела лечь.
 * Лечение вынесено отдельной строкой в docs/TASKS.md: задевает все алармы разом.
 *
 * Прежняя версия этого комментария утверждала, что дедуп по тегу уже закрывает требование
 * «не чаще раза в 24 часа» — ЭТО БЫЛО НЕВЕРНО: count ≠ ограничение частоты, он просто считает
 * тики. Настоящее ограничение — shouldAlert (lib/notifications.ts, владелец 15.09.2026): ниже,
 * перед записью в ленту, проверяем возраст последней отметки с этим tag и пропускаем тик,
 * если сутки ещё не прошли.
 *
 * ПОРОГ: Settings.hotScoreThreshold через lib/hotScoreThreshold.ts — один на всю CRM.
 * ALARM_NO_CALL_DAYS = 2 (рекомендация аудита §6.1.3 — 2 дня; STALE_CONTACT_DAYS=3
 * в oversight.ts длиннее, это отдельный сигнал).
 */

export const ALARM_NO_CALL_DAYS = 2;

/**
 * КРОН-ТИК «нет звонка N дней». Пуш и строка в ленте руководству («📵 Нет звонка
 * N+ дн: Покупатель …») УБРАНЫ по решению владельца 02.10.2026: рассылка была
 * спамом. Функция осталась заглушкой с той же сигнатурой, потому что её вызывает
 * cron.ts; список «высокий скоринг без звонка» по-прежнему читает дашборд
 * (routes/oversight.ts). Отказ с высоким скорингом (ниже) не затронут.
 */
export async function runBuyerNoCallAlarmTick(_now: Date = new Date()): Promise<{ alerted: number }> {
  return { alerted: 0 };
}

/**
 * ТРИГГЕР НА ОТКАЗ: вызывается из POST /clients/:id/refuse (lifecycle.ts) ТОЛЬКО когда
 * клиент BUYER + aiScore >= Settings.hotScoreThreshold.
 *
 * Раньше слал пуш директору немедленно, в любой час (найдено 07.09.2026 при
 * разборе «все алармы руководителю — в его часы»: это событие, не крон-тик,
 * и гейта часов не было вовсе). Само событие мгновенное и второго шанса не
 * будет — значит нельзя просто «не отправить, если сейчас не время»: аларм
 * потерялся бы навсегда. Поэтому здесь только СТАВИМ отметку (в любой час,
 * дёшево), а сам пуш шлёт отдельный часовой тик ниже, уже с проверкой часов
 * алармов — тот же приём, что и everywhere else «копится ночью, уходит с
 * началом следующего окна».
 */
export async function alertRefusedHighScoreBuyer(client: {
  id: string;
  aiScore: number | null;
  kind: string;
}): Promise<void> {
  if (client.kind !== "BUYER") return;
  if ((client.aiScore ?? 0) < (await loadHotScoreThreshold())) return;

  await prisma.client
    .update({ where: { id: client.id }, data: { refusedHighScoreFlaggedAt: new Date() } })
    .catch((err) => console.error("[alarm] refused-high-score flag:", err));
}

/**
 * ЧАСОВОЙ ТИК: разбирает очередь, которую поставил alertRefusedHighScoreBuyer
 * выше. Дедуп — refusedHighScoreNotifiedAt свежее refusedHighScoreFlaggedAt
 * (тот же приём, что offCrmAlarmNotifiedAt/phoneAskFlaggedAt в
 * lib/agentOffCrmAlarm.ts): повторный отказ того же клиента ставит более
 * поздний флаг и снова открывает уведомление.
 */
export async function runRefusedHighScoreAlarmTick(now: Date = new Date()): Promise<{ alerted: number }> {
  if (!(await isWithinAlarmHours(now))) return { alerted: 0 };

  // «Ещё не уведомлён» отсеивается в SQL, до LIMIT (аудит Codex 04.10, CHANNEL-NEW-06): раньше
  // брались 200 карточек с отметкой отказа без порядка, а уведомлённые отбрасывались в памяти —
  // накопленные уведомлённые вытесняли свежий отказ из выборки. Сравнение двух колонок
  // Prisma-фильтром не выражается, поэтому id выбирает сырой запрос.
  const pendingIds = (
    await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM "Client"
      WHERE "refusedHighScoreFlaggedAt" IS NOT NULL
        AND ("refusedHighScoreNotifiedAt" IS NULL OR "refusedHighScoreNotifiedAt" < "refusedHighScoreFlaggedAt")
      ORDER BY "refusedHighScoreFlaggedAt" ASC
      LIMIT 200
    `)
  ).map((r) => r.id);
  if (pendingIds.length === 0) return { alerted: 0 };

  const raw = await prisma.client.findMany({
    where: { id: { in: pendingIds } },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      aiScore: true,
      refusedHighScoreFlaggedAt: true,
      refusedHighScoreNotifiedAt: true,
      // Имя агента — частью текста аларма (единый формат «когда/агент/клиент/что»,
      // решение владельца 03.09.2026). Через include, а не запросом в цикле: тик
      // разбирает до 200 карточек разом, отдельный запрос на каждую был бы N+1.
      assignedAgent: { select: { fullName: true } },
    },
  });
  const pending = raw.filter((c) => !c.refusedHighScoreNotifiedAt || c.refusedHighScoreNotifiedAt < c.refusedHighScoreFlaggedAt!);
  if (pending.length === 0) return { alerted: 0 };

  const directorIds = (
    await prisma.agent.findMany({ where: { role: { in: ["DIRECTOR", "ADMIN", "HEAD_OF_SALES"] }, isActive: true }, select: { id: true } })
  ).map((d) => d.id);
  if (directorIds.length === 0) return { alerted: 0 };

  let alerted = 0;
  for (const c of pending) {
    const tag = `alarm-refused-high-score-${c.id}`;
    const payload: AlarmPayload = {
      title: `⚠️ Отказ при высоком скоринге: ${c.fullName}`,
      // Когда/от кого(агент)/что — видно без перехода по ссылке. Время берём
      // не «сейчас», а момент самого отказа: тик мог пролежать всю ночь.
      body:
        `${dushanbeDateTimeString(c.refusedHighScoreFlaggedAt!)}, агент ${c.assignedAgent?.fullName ?? "не назначен"}: ` +
        `скоринг ${c.aiScore} — сделка закрыта безуспешно`,
      url: `/clients/${c.shortId}`,
      tag,
      kind: "oversight",
    };
    try {
      await createNotifications(directorIds, payload);
      void sendPushToAgents(directorIds, payload).catch((err) =>
        console.error("[alarm] refused-high-score push:", err)
      );
      await prisma.client.update({ where: { id: c.id }, data: { refusedHighScoreNotifiedAt: now } });
      alerted++;
    } catch (err) {
      console.error("[alarm] refused-high-score notification:", err);
    }
  }
  return { alerted };
}