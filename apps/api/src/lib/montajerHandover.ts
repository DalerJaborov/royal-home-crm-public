import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { EDITOR_HOLDER_WHERE, dispatchToEditor, nextInQueue } from "./videoHandoff.js";
import { alertMontageStuck } from "./videoHandoffStaleAlarm.js";
import { sendToMontajer } from "./montageObservers.js";

/**
 * ОЧЕРЕДЬ МОНТАЖА ПЕРЕХОДИТ К ТЕКУЩЕМУ МОНТАЖЁРУ (решение владельца 10–11.11.2026:
 * «когда мы удаляем монтажёра, всё идёт к новому монтажёру»).
 *
 * Живой случай 10.11: монтажёра Сади заменили на Бону (Settings.videoMontajerAgentId),
 * Сади отключили. Объекты в очереди (QUEUED) и так уходят тому, кто стоит в
 * Настройках в момент выдачи места, — с ними беды нет. Беда с держателем места
 * (EDITOR_HOLDER_WHERE): его исходники уже были доставлены СТАРОМУ монтажёру
 * (`videoHandoffDeliveredAt` стоит), и сторож досылки (videoHandoffRedelivery.ts)
 * считал объект доставленным и молчал. Новый монтажёр не получал ничего, очередь
 * стояла за объектом, которого у него нет.
 *
 * Отметка «файл у монтажёра» живёт по каждому ролику и по id монтажёра
 * (PropertyVideo.montajerDeliveredToId), поэтому признак простой и точный:
 * держатель «доставлен», а хотя бы один его ролик доставлен ДРУГОМУ монтажёру,
 * не текущему. Тогда досылаем недостающее текущему (`resend: "missing"` — только
 * то, чего у него нет).
 *
 * ПОВТОР НЕ ШЛЁТ ВТОРОЙ РАЗ. dispatchToEditor при захвате гасит
 * `videoHandoffDeliveredAt`, а при успехе ставит отметки роликов на текущего
 * монтажёра — в обоих случаях признак выше перестаёт выполняться. Не дошло —
 * дальше это обычная недоставка, её досылает сторож со своей паузой и тревогами.
 *
 * Зовётся сторожем досылки раз в 5 минут — это ловит ЛЮБОЙ способ смены
 * монтажёра: экран Настроек, точку возврата настроек, правку базы руками.
 */
export async function handOverHolderToCurrentMontajer(
  currentMontajerAgentId: string,
  now: Date = new Date()
): Promise<boolean> {
  const holder = await prisma.property.findFirst({
    where: { ...EDITOR_HOLDER_WHERE, videoHandoffDeliveredAt: { not: null } },
    select: { id: true, shortId: true, videoHandoffDispatchStartedAt: true },
  });
  if (!holder) return false;
  // Живая отправка идёт прямо сейчас (её отметку гасит сама отправка) — не мешаем.
  if (
    holder.videoHandoffDispatchStartedAt &&
    now.getTime() - holder.videoHandoffDispatchStartedAt.getTime() < LIVE_DISPATCH_WINDOW_MS
  ) {
    return false;
  }
  const foreign = await prisma.propertyVideo.findFirst({
    where: {
      propertyId: holder.id,
      montajerDeliveredAt: { not: null },
      montajerDeliveredToId: { not: null },
      NOT: { montajerDeliveredToId: currentMontajerAgentId },
    },
    select: { montajerDeliveredToId: true },
  });
  if (!foreign?.montajerDeliveredToId) return false;
  const previousMontajerAgentId = foreign.montajerDeliveredToId;

  void logSystemError(
    "video-handoff",
    `Объект №${holder.shortId} был у прежнего монтажёра — передаю текущему монтажёру из Настроек`
  );
  let delivered = false;
  try {
    delivered = await dispatchToEditor(holder.id, currentMontajerAgentId);
  } catch (err) {
    void logSystemError(
      "video-handoff",
      `Объект №${holder.shortId}: передача новому монтажёру упала: ${describeError(err)} — дошлёт сторож досылки`
    );
    return false;
  }
  if (delivered) {
    // Прежнему — короткое «передан другому», только если он ещё работает:
    // уволенному в личный Telegram про объекты агентства не пишем.
    const old = await prisma.agent.findFirst({
      where: { id: previousMontajerAgentId, isActive: true },
      select: { telegramChatId: true },
    });
    if (old?.telegramChatId) {
      await sendToMontajer(old.telegramChatId, `Объект №${holder.shortId} передан другому монтажёру.`, {
        copy: true,
        propertyShortId: holder.shortId,
      }).catch(() => {});
    }
  }
  return delivered;
}

/** То же окно, что HANDOFF_DISPATCH_BUSY_WINDOW_MS в videoHandoff.ts. */
const LIVE_DISPATCH_WINDOW_MS = 15 * 60 * 1000;

/** Монтажёр в Настройках есть и работает? Отключённому ролики не уходят никогда (G4). */
export async function currentMontajerIsUsable(montajerAgentId: string | null | undefined): Promise<boolean> {
  if (!montajerAgentId) return false;
  const row = await prisma.agent.findUnique({ where: { id: montajerAgentId }, select: { isActive: true } });
  return row?.isActive === true;
}

export const NO_MONTAJER_ALARM_TAG = "video-handoff-no-montajer";
const NO_MONTAJER_ALARM_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * МОНТАЖЁРА НЕТ, А РОЛИКИ ЖДУТ — ТРЕВОГА, А НЕ ТИШИНА (11.11.2026). Монтажёра
 * сняли в Настройках или уволили (agentSettingsCleanup снимает его из
 * настройки): передавать некому. Раньше это была строка в журнале ошибок, и
 * очередь стояла молча. Теперь — тревога модераторам монтажа (пуш + CRM +
 * наблюдателям в Telegram) раз в 6 часов, пока монтажёра не выберут; ночью
 * не будим (alertMontageStuck), утром сторож повторит.
 *
 * Ничего не ждёт (ни держателя места, ни очереди) — тревоги нет.
 */
export async function alertNoMontajerIfWorkWaits(now: Date = new Date()): Promise<boolean> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { videoHandoffEnabled: true, videoMontajerAgentId: true },
  });
  if (!settings?.videoHandoffEnabled) return false;
  if (await currentMontajerIsUsable(settings.videoMontajerAgentId)) return false;
  const [holder, head, queuedCount] = await Promise.all([
    prisma.property.findFirst({ where: EDITOR_HOLDER_WHERE, select: { shortId: true } }),
    nextInQueue(),
    prisma.property.count({ where: { videoHandoffStatus: "QUEUED", deletedAt: null } }),
  ]);
  const firstShortId = holder?.shortId ?? head?.shortId ?? null;
  if (firstShortId === null) return false;
  const parts: string[] = [];
  if (holder) parts.push(`объект №${holder.shortId} ждёт монтажа`);
  if (queuedCount > 0) parts.push(`в очереди ещё ${queuedCount}`);
  return alertMontageStuck({
    shortId: firstShortId,
    title: "🎬 Монтажёр не назначен",
    body:
      `Ролики некому монтировать: ${parts.join(", ")}. ` +
      "Выберите монтажёра в Настройках → Каналы → «Монтажёр ручной передачи» — всё, что ждёт, уйдёт ему само.",
    tag: NO_MONTAJER_ALARM_TAG,
    minIntervalMs: NO_MONTAJER_ALARM_INTERVAL_MS,
    now,
  });
}
