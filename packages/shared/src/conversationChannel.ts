/**
 * Русское название канала диалога с ботом (`BotConversation.channel`) — не
 * технический код на экране/в пуше (ночная проверка 24.09.2026, находка №11).
 *
 * Раньше в трёх серверных файлах (`lib/phoneLeadWatchdog.ts`,
 * `lib/clientToCandidate.ts`, `lib/stuckWork.ts`) текст для человека собирался
 * с сырым `${row.channel}` — директор и агент видели «диалог INSTAGRAM»,
 * «канал WHATSAPP» вместо «диалог Instagram». `CLIENT_SOURCE_LABELS` не
 * годится: это словарь ИСТОЧНИКА клиента (enum `ClientSource`), а не канала
 * переписки (произвольная строка), и не покрывает часть значений
 * (`TELEGRAM_DM`, `PHONE`, `LIVE_VOICE`, `YOUTUBE`).
 *
 * На сайте уже стоят два своих словаря канала для других экранов
 * (`apps/web/src/lib/channelMeta.ts`, `apps/web/src/lib/vacanciesView.ts`) —
 * их этой правкой не трогаем, оставляем как есть (см. запись в
 * docs/journal/2026-09-24-tehnicheskie-slova-na-ekranah.md).
 */
export const CONVERSATION_CHANNEL_LABELS: Record<string, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  TELEGRAM: "Telegram",
  TELEGRAM_DM: "личка Telegram",
  WHATSAPP: "WhatsApp",
  TIKTOK: "TikTok",
  YOUTUBE: "YouTube",
  WEBSITE: "сайт",
  PHONE: "телефон",
  LIVE_VOICE: "голосовой звонок",
  // Анкета кандидата, позвонившего в офис (lib/jobApplications.ts::captureCandidateFromCall).
  PHONE_CALL: "звонок в офис",
};

/** Незнакомый канал не падает и не теряется — показывается как есть. */
export function channelLabel(channel: string): string {
  return CONVERSATION_CHANNEL_LABELS[channel] ?? channel;
}
