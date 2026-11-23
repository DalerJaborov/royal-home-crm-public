/**
 * КРЮЧОК «КОММЕНТАРИЙ ЗАКРЫТ ПРИ ПРИЁМЕ КАК bot_off» (второе ревью 1b, №1).
 *
 * Приём (messengers/commentsQueue.ts — Instagram/Facebook/YouTube, lib/customerPublicCommentStore.ts — полоса ядра) при
 * выключенном боте сразу пишет строку `SKIPPED bot_off`, и номер из такого комментария терялся. Дверь номера живёт в
 * messengers/comments.ts, а тот сам импортирует оба приёма — прямой импорт обратно дал бы круг (audit:deps). Поэтому
 * приём зовёт этот крючок, а comments.ts регистрирует в нём дверь номера при загрузке (как onNewSystemError).
 * Не зарегистрирован (процесс без comments.ts) — след в логе контейнера, приём не падает.
 */
import { loadCommentPhoneLead } from "./botAnswersItself.js";

type Hook = (commentIds: readonly string[]) => Promise<unknown>;
let hook: Hook | null = null;

export function onBotOffCommentsStored(fn: Hook): void {
  hook = fn;
}

/** Приём записал строки `SKIPPED bot_off`: номер из них — в карточку (в фоне вызывающего). Не бросает. */
export async function botOffCommentsStored(commentIds: readonly string[]): Promise<void> {
  if (!commentIds.length) return;
  // Рубильник «Номер под постом: завести заявку агенту» ВЫКЛ (по умолчанию) — как до #283: ни разбора, ни строки в логе.
  if (!(await loadCommentPhoneLead())) return;
  if (!hook) {
    console.warn(`[comment-phone] дверь номера не подключена: ${commentIds.length} комментариев bot_off без разбора номера`);
    return;
  }
  try { await hook(commentIds); } catch (err) { console.error("[comment-phone] bot_off:", err instanceof Error ? err.message : err); }
}
