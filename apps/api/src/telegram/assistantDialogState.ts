import { prisma } from "../db.js";

/**
 * ЗАПИСЬ В СОСТОЯНИЕ РАЗГОВОРА ПОМОЩНИЦЫ — СЛИЯНИЕМ, ПОД ЗАМКОМ СТРОКИ (22.11.2026, ревью волны 2).
 *
 * В `TelegramDialogState.payload` живёт не только история (`messages`): ещё `sent` (номера своих
 * сообщений), `expenseMemory` (запомненные фото расходов и намерение «внеси расходы») и состояние
 * правки строки карточки. Раньше `saveHistory` собирал payload заново из двух полей и стирал всё
 * остальное: фото, присланные за время долгого хода модели (или за десять минут до него), пропадали,
 * и «мана акс, ворид кун» опять уходило модели без фото.
 *
 * Теперь любая запись читает свежую строку, меняет только свои поля и пишет обратно в одной
 * транзакции с замком строки (`FOR UPDATE`): два писателя (ход модели и запоминание фото) идут по
 * очереди, а не затирают друг друга. Чужое состояние чата (модерация, вопрос монтажёру) не трогаем.
 */

const DIALOG_KIND = "assistant";

export type DialogPayload = Record<string, unknown>;

export async function mergeAssistantDialog(params: {
  chatId: string;
  agentId: string;
  /** Что поменять в живом payload (для нового или чужого состояния — пустой, без `messages`). */
  change: (payload: DialogPayload) => DialogPayload;
  /** Срок жизни: от текущего срока живой строки (null — строки нет). */
  expiresAt: (live: Date | null) => Date;
}): Promise<boolean> {
  const { chatId, agentId } = params;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "TelegramDialogState" WHERE "chatId" = ${chatId} FOR UPDATE`;
    const state = await tx.telegramDialogState.findUnique({ where: { chatId } });
    const now = Date.now();
    if (state && state.kind !== DIALOG_KIND && state.expiresAt.getTime() > now) return false;
    const live = Boolean(state && state.kind === DIALOG_KIND && state.agentId === agentId && state.expiresAt.getTime() > now);
    const base: DialogPayload = live && state!.payload && typeof state!.payload === "object" && !Array.isArray(state!.payload)
      ? (state!.payload as DialogPayload)
      : { messages: [] };
    const data = {
      agentId,
      kind: DIALOG_KIND,
      payload: params.change(base) as object,
      expiresAt: params.expiresAt(live ? state!.expiresAt : null),
    };
    await tx.telegramDialogState.upsert({ where: { chatId }, create: { chatId, ...data }, update: data });
    return true;
  });
}
