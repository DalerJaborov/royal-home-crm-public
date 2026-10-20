import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { createNotifications, shouldAlert } from "./notifications.js";
import { isWithinAlarmHours } from "./workingHours.js";
import { montageCopyNote, sendMontageCopies, montageNotificationRecipients } from "./montageObservers.js";
import { sendMessage } from "../telegram/api.js";
import { EDITOR_HOLDER_WHERE } from "./videoHandoff.js";

/**
 * АЛАРМ «ПЕРЕДАЧА ВИДЕО МОНТАЖЁРУ ЗАВИСЛА» (найдено 16.09.2026: объект №96,
 * тестовый ролик, ушёл монтажёру 11.09.2026 и провисел в `SENT_TO_EDITOR` пять
 * дней. Очередь в lib/videoHandoff.ts строго по одному (`editorIsBusy()`) — пока
 * этот статус не закрыт, ВСЕ следующие объекты (в тот раз — №99 и №102) тихо
 * копятся в `QUEUED` и ни разу не уходят монтажёру в Telegram. Ни одной записи в
 * ErrorLog не было: зависшая передача — не ошибка с точки зрения кода, поэтому
 * никто не узнал, пока владелец не заметил сам по конкретному объекту.
 *
 * Этот модуль — тот самый сигнал, которого не хватило. Паттерн — как у
 * sellerNoPropertyAlarm.ts: isWithinAlarmHours (директора не будим ночью),
 * shouldAlert (не чаще раза в сутки на объект), DIRECTOR+ADMIN по роли.
 *
 * ПОРОГ 24 ЧАСА, не меньше: обычная передача закрывается монтажёром в течение
 * рабочего дня, а тик уважает часы алармов — ночная отправка не поднимет тревогу
 * до утра сама по себе. Меньший порог просто добавит шум по объектам, которые
 * монтажёр забирает на следующий день как обычно. Исходники, которые НЕ ДОШЛИ до
 * монтажёра, ждать сутки не должны — про них кричит сторож досылки
 * (lib/videoHandoffRedelivery.ts) через ту же alertMontageStuck, гораздо раньше.
 */
const STALE_HOURS = 24;
const STALE_MS = STALE_HOURS * 60 * 60 * 1000;
const ALERT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * ОДНА ТРЕВОГА РУКОВОДИТЕЛЮ ПРО МОНТАЖ (23.09.2026) — уведомление в CRM, пуш
 * директору и админу, копия наблюдателям монтажа в Telegram. Вынесена из тика
 * ниже, чтобы «монтажёр не ответил за сутки» и «исходники не дошли до
 * монтажёра» кричали одним и тем же голосом, а не второй — строкой в журнале,
 * которую никто не читает.
 *
 * Сама решает, можно ли сейчас: вне часов алармов и чаще `minIntervalMs` на
 * тег — false, и следующий тик попробует снова (shouldAlert не тратится).
 */
export async function alertMontageStuck(input: {
  shortId: number;
  title: string;
  body: string;
  tag: string;
  minIntervalMs: number;
  now: Date;
}): Promise<boolean> {
  if (!(await isWithinAlarmHours(input.now))) return false;
  // Получатели — модераторы (25.09.2026, задание G, владелец: «пуш должен идти
  // модератору, то есть админу»), не любой DIRECTOR/ADMIN по одной роли —
  // см. докстринг montageNotificationRecipients.
  const directorIds = await montageNotificationRecipients();
  if (directorIds.length === 0) return false;
  if (!(await shouldAlert(input.tag, input.minIntervalMs, input.now))) return false;

  const payload = {
    kind: "oversight" as const,
    title: input.title,
    body: input.body,
    url: `/properties/${input.shortId}`,
    tag: input.tag,
    level: "CRITICAL" as const,
  };
  try {
    await createNotifications(directorIds, payload);
    void sendPushToAgents(directorIds, payload).catch((err) => console.error("[alarm] montage push:", err));
  } catch (err) {
    console.error("[alarm] montage notification:", err);
    return false;
  }
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
  const montajer = settings?.videoMontajerAgentId
    ? await prisma.agent.findUnique({ where: { id: settings.videoMontajerAgentId }, select: { fullName: true } })
    : null;
  // Наблюдателям монтажа — то же в Telegram, каждому отдельно
  // (sendMontageCopies ловит отказ на каждого и пишет его в журнал).
  await sendMontageCopies(
    settings?.videoMontajerAgentId ?? null,
    `напоминание по объекту ${input.shortId}`,
    (chatId) => sendMessage(chatId, `${montageCopyNote(montajer?.fullName)}\n\n${input.title}\n${input.body}`).then(() => undefined)
  );
  return true;
}

export async function runVideoHandoffStaleAlarmTick(now: Date = new Date()): Promise<{ alerted: number }> {
  if (!(await isWithinAlarmHours(now))) return { alerted: 0 };

  const cutoff = new Date(now.getTime() - STALE_MS);
  const stuck = await prisma.property.findMany({
    // Ручное ожидание готового ролика (videoHandoffManualSince) монтажёру не
    // уходило — «монтажёр не прислал» про него неправда; снимает его сторож досылки.
    where: { ...EDITOR_HOLDER_WHERE, videoHandoffSentAt: { lt: cutoff } },
    select: { id: true, shortId: true, videoHandoffSentAt: true },
  });
  if (stuck.length === 0) return { alerted: 0 };

  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { videoMontajerAgentId: true },
  });
  const montajer = settings?.videoMontajerAgentId
    ? await prisma.agent.findUnique({ where: { id: settings.videoMontajerAgentId }, select: { fullName: true } })
    : null;

  // Сколько объектов ждёт своей очереди за зависшим — та же немая очередь,
  // которую увидел бы монтажёр, если бы её тут не разблокировали руками.
  const queuedCount = await prisma.property.count({ where: { videoHandoffStatus: "QUEUED", deletedAt: null } });

  let alerted = 0;
  for (const p of stuck) {
    const hoursStuck = p.videoHandoffSentAt
      ? Math.floor((now.getTime() - p.videoHandoffSentAt.getTime()) / (60 * 60 * 1000))
      : STALE_HOURS;
    const queueNote = queuedCount > 0 ? ` За ним встали в очередь ещё ${queuedCount} объект(ов) — они тоже не уходят монтажёру, пока этот висит.` : "";
    const sent = await alertMontageStuck({
      shortId: p.shortId,
      title: `🎬 Монтаж завис: объект №${p.shortId}`,
      body: `${montajer?.fullName ?? "Монтажёр"} не прислал готовый ролик уже ${hoursStuck} ч.${queueNote}`,
      tag: `video-handoff-stale-${p.id}`,
      minIntervalMs: ALERT_MIN_INTERVAL_MS,
      now,
    });
    if (sent) alerted++;
  }
  return { alerted };
}
