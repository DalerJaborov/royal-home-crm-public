import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { parsePermissionOverrides, resolvePermissions, type Role } from "@royal-home/shared";
import { sendMessage, sendMessageWithButtons, type TelegramInlineButton } from "../telegram/api.js";

/**
 * НАБЛЮДАТЕЛИ МОНТАЖА (22.09.2026).
 *
 * Монтажёр один (Settings.videoMontajerAgentId), но любой админ может включить
 * себе «Копии монтажа в Telegram» (Agent.montageCopiesTelegram) и видеть то же,
 * что уходит монтажёру. Наблюдатель остаётся просто другим чатом: бот узнаёт
 * монтажёра строго по videoMontajerAgentId (telegram/bot.ts), поэтому ответ
 * наблюдателя в очередь передачи не попадает.
 *
 * `fullName` добавлено 25.09.2026 (задание C) — раньше отдавали только
 * `{id, chatId}`, а sendToMontajer ниже подписывает копию именем текущего
 * монтажёра (montageCopyNote), не именем наблюдателя, так что поле у самого
 * наблюдателя пока не используется вызывающими — держим для будущего (например,
 * персональных логов) и потому, что дешевле взять его сразу тем же запросом.
 */
export interface MontageObserver {
  id: string;
  chatId: string;
  fullName: string;
}

export async function montageObservers(montajerAgentId: string | null): Promise<MontageObserver[]> {
  const rows = await prisma.agent.findMany({
    where: {
      montageCopiesTelegram: true,
      isActive: true,
      telegramChatId: { not: null },
      ...(montajerAgentId ? { id: { not: montajerAgentId } } : {}),
    },
    select: { id: true, telegramChatId: true, fullName: true },
    take: 50,
  });
  return rows.flatMap((r) => (r.telegramChatId ? [{ id: r.id, chatId: r.telegramChatId, fullName: r.fullName }] : []));
}

export function montageCopyNote(montajerName: string | null | undefined): string {
  return `Копия. Монтажёр: ${montajerName?.trim() || "не назначен"}`;
}

/**
 * Разослать копию всем наблюдателям. Отказ одному не мешает остальным (и не
 * трогает доставку самому монтажёру — её вызывающий делает до этого).
 */
export async function sendMontageCopies(
  montajerAgentId: string | null,
  what: string,
  deliver: (chatId: string) => Promise<void>
): Promise<void> {
  let observers: MontageObserver[];
  try {
    observers = await montageObservers(montajerAgentId);
  } catch (err) {
    void logSystemError("video-handoff", `Не удалось получить список наблюдателей монтажа: ${describeError(err)}`);
    return;
  }
  for (const observer of observers) {
    try {
      await deliver(observer.chatId);
    } catch (err) {
      void logSystemError(
        "video-handoff",
        `Копия монтажа (${what}) наблюдателю ${observer.id} не отправилась: ${describeError(err)}`
      );
    }
  }
}

export interface SendToMontajerOptions {
  /** По умолчанию true — копия наблюдателям идёт. `false` — для ответов бота на
   *  команды меню самого монтажёра («очередь», «объект N», «фото», «помощь»,
   *  «меню») и прочих реактивных ответов на ЕГО сообщения: это его диалог с
   *  ботом, а не поток контроля владельца. */
  copy?: boolean;
  /** Кнопки — ТОЛЬКО монтажёру. Наблюдателям всегда уходит голый текст (задание
   *  А, 25.09.2026): наблюдатель не должен суметь нажать за монтажёра и попасть
   *  в его очередь передачи. */
  replyMarkup?: TelegramInlineButton[][];
  /** Только для текста копии наблюдателю — упоминание объекта, если у
   *  вызывающего его нет прямо в `text` (сейчас не используется: везде номер
   *  объекта уже в самом тексте; поле оставлено по контракту задания). */
  propertyShortId?: number;
}

/**
 * ЕДИНАЯ ТОЧКА ОТПРАВКИ МОНТАЖЁРУ (25.09.2026, задание А — владелец: «хочу
 * получать те же сообщения, что и монтажёр, чтобы я контролировал»).
 *
 * До этой правки копии наблюдателям (`sendMontageCopies`) собирал КАЖДЫЙ
 * вызывающий вручную и только для исходников — контрольное «отправлено N из
 * N», снятие с монтажа, квитанция о приёме, вопрос «чей ролик», смена
 * монтажёра и ссылки сторожа досылки уходили мимо наблюдателя. Теперь любой
 * текст монтажёру идёт через эту функцию, и копия — её сквозное свойство, а не
 * то, о чём должен вспомнить каждый новый вызывающий.
 *
 * Текущий монтажёр (Settings.videoMontajerAgentId) исключается из списка
 * наблюдателей тем же способом, что и раньше (montageObservers) — если он сам
 * когда-нибудь включит себе «Копии монтажа», не дублируем ему его же сообщение.
 */
export async function sendToMontajer(chatId: string, text: string, opts: SendToMontajerOptions = {}): Promise<unknown> {
  const result =
    opts.replyMarkup && opts.replyMarkup.length > 0
      ? await sendMessageWithButtons(chatId, text, opts.replyMarkup)
      : await sendMessage(chatId, text);

  if (opts.copy === false) return result;

  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { videoMontajerAgentId: true },
  });
  const montajerAgentId = settings?.videoMontajerAgentId ?? null;
  const montajer = montajerAgentId
    ? await prisma.agent.findUnique({ where: { id: montajerAgentId }, select: { fullName: true } })
    : null;
  const copyText = `${montageCopyNote(montajer?.fullName)}\n\n${text}`;
  await sendMontageCopies(montajerAgentId, opts.propertyShortId ? `объект №${opts.propertyShortId}` : "сообщение монтажёру", (observerChatId) =>
    sendMessage(observerChatId, copyText).then(() => undefined)
  );
  return result;
}

function canModerateMontage(a: { role: string; permissions: unknown }): boolean {
  return resolvePermissions(a.role as Role, parsePermissionOverrides(a.permissions as never)).has("properties.moderate");
}

/**
 * ПОЛУЧАТЕЛИ CRM-ПУШЕЙ О МОНТАЖЕ (25.09.2026, владелец: «пуш должен идти
 * модератору, то есть админу»). Раньше алармы про зависший монтаж
 * (videoHandoffStaleAlarm.ts::alertMontageStuck) и результат публикации
 * (videoHandoff.ts::notifyVideoHandoffPublishResult) уходили ВСЕМ DIRECTOR+ADMIN
 * по одной лишь роли — директор без права модерации получал пуш, на который
 * не может отреагировать, а маркетолог с правом properties.moderate (не ADMIN)
 * не получал ничего. Круг тот же, что у модерации из Telegram
 * (listTelegramModerators, telegramModeration.ts), но БЕЗ требования
 * привязанного чата — это пуш CRM, а не сообщение в Telegram, и без флага
 * telegramModeration (тот про КАНАЛ доставки, а не про право).
 *
 * `responsibleAgentId` (опционально) — ответственный за объект (обычно
 * assignedAgentId ?? intakeAgentId ?? createdById, см. вызывающих) добавляется
 * отдельно: он не обязан иметь право модерации, но имеет право знать про свой
 * объект. Без дублей (Set) — ответственный сам может оказаться модератором.
 */
export async function montageNotificationRecipients(responsibleAgentId?: string | null): Promise<string[]> {
  const agents = await prisma.agent.findMany({
    where: { isActive: true },
    select: { id: true, role: true, permissions: true },
  });
  const moderatorIds = agents.filter(canModerateMontage).map((a) => a.id);
  return Array.from(new Set([...(responsibleAgentId ? [responsibleAgentId] : []), ...moderatorIds]));
}
