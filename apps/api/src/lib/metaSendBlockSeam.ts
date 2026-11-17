/**
 * ТОЧКА ПОДКЛЮЧЕНИЯ «META ЗАПРЕТИЛА ОТПРАВКУ» (шаг 1b, 18.11.2026).
 *
 * Метку блокировки аккаунта (код 368 и родня) ставит одна дверь отправки `callGraph` — это делает отдельный PR #273
 * (ветка fix/meta-policy-block-18-11: `isAccountSendBlocked` и `isMetaSendBlockError` в lib/metaSendBlock.ts). В main его
 * пока нет, поэтому здесь — тонкая обёртка с тем же смыслом, и все места шага 1b читают блокировку ТОЛЬКО через неё:
 *  - lib/customerDmAgentTurn.ts — при блоке личных модель не зовётся, клиенту ничего не уходит, тревогу шлёт #273;
 *  - messengers/comments.ts (номер из комментария) — блок личных → запасной путь (публичный ответ), блок комментариев →
 *    только заявка с пометкой, сразу в раздачу.
 * TODO(#273): после вливания #273 заменить тела двух функций вызовами isAccountSendBlocked / isMetaSendBlockError
 * (сигнатуры совпадают) — вызывающие и тесты (через vi.mock этого модуля) не меняются.
 */
export type MetaSendSurface = "dm" | "comment";

/** Аккаунт временно не может отправлять на этой поверхности. До #273 — всегда false (прежнее поведение). */
export async function accountSendBlocked(_account: { accountId: string | null; channel: string }, _surface: MetaSendSurface = "dm",
  _now: Date = new Date()): Promise<boolean> {
  return false;
}

/** Отправка отклонена потому, что аккаунт заблокирован (ошибка #273). До #273 — таких ошибок нет. */
export function isSendBlockError(err: unknown): boolean {
  return err instanceof Error && err.name === "MetaSendBlockedError";
}

/** Причина HELD хода ядра при блоке личных: намеренное молчание (одну тревогу шлёт #273, человек видит входящее в CRM). */
export const META_SEND_BLOCKED_REASON = "meta_send_blocked";
