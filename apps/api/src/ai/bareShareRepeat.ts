/**
 * РОЛИК ЗА РОЛИКОМ БЕЗ ЕДИНОГО СЛОВА — ПОСЛЕ ДВУХ ОТВЕТОВ МОЛЧИМ (владелец
 * 25.09.2026, выдержки живых диалогов).
 *
 * Живой случай: клиент с уже принятой заявкой (Instagram) несколько дней подряд
 * пересылал ролики, по нескольку в день, ни разу ничего не написав. Бот отвечал
 * на КАЖДЫЙ: «Маълумоти хонаатонро ба агент додем, ба зудӣ занг мезананд» —
 * десяток одинаковых по смыслу сообщений. Прежний предел
 * (countUnresolvedShareReplies, ai/replyRepeatGuard.ts) считает только ответы
 * «видео не открылось» и только у нераспознанных пересылок — сюда он не доставал.
 *
 * Здесь смотрим на самого клиента: сколько его пересылок подряд, без слов между
 * ними, уже получили ответ бота. Две — хватит: третья и дальше сохраняются в
 * переписку (агент их видит), но бот молчит, пока человек не напишет словами.
 * Спамом НЕ помечаем: это живой клиент, просто так он делится роликами.
 */

const SHARE_MARKER = /\[вложение:\s*(?:ig_reel|ig_post|reel|share|story_mention|ig_story|post)\]/giu;

/** Реплика клиента — голая пересылка: пометка вложения и больше ничего. */
export function isBareShare(content: string | null | undefined): boolean {
  const text = content ?? "";
  if (!SHARE_MARKER.test(text)) return false;
  SHARE_MARKER.lastIndex = 0;
  return text.replace(SHARE_MARKER, "").trim() === "";
}

/** Сколько ответов бота подряд даём на голые пересылки, потом молчим. */
export const MAX_BARE_SHARE_REPLIES = 2;

/**
 * Сколько голых пересылок клиента подряд (считая от конца переписки, до первой
 * его реплики со словами) уже получили ответ бота.
 */
export function bareSharesAnsweredInRow(history: { role: "user" | "assistant"; content: string }[]): number {
  let answered = 0;
  let botRepliedAfter = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "assistant") {
      botRepliedAfter = true;
      continue;
    }
    if (!isBareShare(m.content)) break;
    if (botRepliedAfter) answered++;
    botRepliedAfter = false;
  }
  return answered;
}

/** Молчать на эту пересылку? */
export function shouldStaySilentOnBareShare(
  current: string | null | undefined,
  history: { role: "user" | "assistant"; content: string }[]
): boolean {
  return isBareShare(current) && bareSharesAnsweredInRow(history) >= MAX_BARE_SHARE_REPLIES;
}
