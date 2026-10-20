/**
 * ПОКАЗЫВАТЬ ЛИ «ПУБЛИКАЦИЯ ЗАПЛАНИРОВАНА» В КАРТОЧКЕ ОБЪЕКТА (24.09.2026).
 *
 * Принятый ролик уходит в сети не сразу, а в свой час расстановки (сервер,
 * lib/publishSchedule.ts). Раньше строка с этим часом и кнопкой «Опубликовать
 * сейчас» была только у объекта, который ещё нигде не вышел. А готовый ролик на
 * замену грузят как раз в уже вышедший (панель «Что-то не так с роликом»):
 * новый ролик вставал в расписание, карточка молчала, и владелец с телефона
 * решил, что файл «куда-то в другое место уходит».
 *
 * Теперь строка есть и у вышедшего объекта, пока его новый ролик принят и ждёт
 * своего часа. После выхода слот остаётся в прошлом, и строка гаснет сама.
 */
export function isPublishPlanned(
  property: {
    videoHandoffFinalPath?: string | null;
    videoHandoffStatus?: string | null;
    scheduledPublishAt?: string | null;
    publishedChannels?: string[] | null;
  },
  now: number
): boolean {
  // Только принятый ролик (24.09.2026, проверка по классам): пока объект
  // открыт под замену (SENT_TO_EDITOR — файл ещё в пути), час прежнего ролика
  // уже ничего не обещает, а «Опубликовать сейчас» сервер отклонит.
  if (!property.videoHandoffFinalPath || !property.scheduledPublishAt || property.videoHandoffStatus !== "RECEIVED") return false;
  if ((property.publishedChannels ?? []).length === 0) return true;
  return new Date(property.scheduledPublishAt).getTime() > now;
}

/** Подпись вместо «На монтаже», пока принятый ролик ждёт своего часа (29.09.2026):
 *  «На монтаже» читалось как «монтажёр ещё работает», хотя ролик уже одобрен. */
export function plannedStatusLabel(
  property: Parameters<typeof isPublishPlanned>[0] & { status?: string | null },
  now: number,
  formatTime: (iso: string) => string
): string | null {
  if (property.status !== "EDITING" || !isPublishPlanned(property, now) || !property.scheduledPublishAt) return null;
  return `Будет опубликовано в ${formatTime(property.scheduledPublishAt)}`;
}
