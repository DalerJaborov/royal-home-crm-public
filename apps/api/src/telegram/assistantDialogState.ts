import { createHash } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";

/**
 * ОДНА ДВЕРЬ ЗАПИСИ В СОСТОЯНИЕ РАЗГОВОРА ПОМОЩНИЦЫ — СЛИЯНИЕМ, ПОД ЗАМКОМ СТРОКИ (22.11.2026, ревью волны 2).
 *
 * В `TelegramDialogState.payload` (kind "assistant") живёт не только история (`messages`): ещё `sent`
 * (номера своих сообщений), `expenseMemory` (запомненные фото расходов и намерение «внеси расходы»),
 * `expenseFix` (правка строки карточки), `expenseFile` (вопрос «Это расходы?» про файл) и `lastUserTurn`.
 * Раньше каждый писатель собирал payload заново из своих полей и стирал чужие (фото пропадали после хода
 * модели, правка строки стирала историю фото и файл), а «прочитал — поправил — записал» без замка терял
 * запись соседа.
 *
 * Здесь любая запись: (1) вставляет пустую строку, если её нет (`INSERT … ON CONFLICT DO NOTHING`: замок
 * `FOR UPDATE` на несуществующую строку ничего не запирает, два первых писателя иначе затёрли бы друг друга);
 * (2) запирает строку; (3) отдаёт писателю свежий payload; (4) пишет то, что он вернул. Чужое живое состояние
 * чата (модерация, вопрос монтажёру, мастер объекта) не трогаем.
 *
 * Прямая запись в эту таблицу в файлах помощницы ловится сторожем
 * `apps/api/tests/assistant-dialog-state-one-door.test.ts`.
 */

const DIALOG_KIND = "assistant";

export type DialogPayload = Record<string, unknown>;

/** Живое состояние помощницы этого сотрудника (null — нет, истекло или чужое). */
export interface LiveAssistantDialog { payload: DialogPayload; expiresAt: Date }

/** Шаг писателя: `write` — что записать (нет — ничего не менять), `result` — что вернуть вызывающему. */
export interface DialogStep<T> { result: T; write?: { payload: DialogPayload; expiresAt: Date } }

/**
 * Прочитать и поправить состояние помощницы атомарно. `{ ok: false }` — в чате живёт чужое состояние
 * (другой вид разговора), его не трогаем; иначе — `result` писателя.
 */
export async function withAssistantDialog<T>(params: {
  chatId: string;
  agentId: string;
  run: (live: LiveAssistantDialog | null) => DialogStep<T>;
}): Promise<{ ok: false } | { ok: true; result: T }> {
  const { chatId, agentId } = params;
  return prisma.$transaction(async (tx) => {
    // Пустая просроченная строка-заготовка: её запирает FOR UPDATE ниже, второй писатель ждёт первого.
    const inserted = await tx.$queryRaw<{ chatId: string }[]>(Prisma.sql`
      INSERT INTO "TelegramDialogState" ("chatId", "agentId", "kind", "payload", "expiresAt", "updatedAt")
      VALUES (${chatId}, ${agentId}, ${DIALOG_KIND}, '{}'::jsonb, to_timestamp(0), now())
      ON CONFLICT ("chatId") DO NOTHING
      RETURNING "chatId"`);
    await tx.$queryRaw`SELECT 1 FROM "TelegramDialogState" WHERE "chatId" = ${chatId} FOR UPDATE`;
    const state = await tx.telegramDialogState.findUnique({ where: { chatId } });
    const now = Date.now();
    if (state && state.kind !== DIALOG_KIND && state.expiresAt.getTime() > now) return { ok: false as const };
    const live = state && state.kind === DIALOG_KIND && state.agentId === agentId && state.expiresAt.getTime() > now
      && state.payload && typeof state.payload === "object" && !Array.isArray(state.payload)
      ? { payload: state.payload as DialogPayload, expiresAt: state.expiresAt }
      : null;
    const step = params.run(live);
    if (step.write) {
      const data = { agentId, kind: DIALOG_KIND, payload: step.write.payload as Prisma.InputJsonObject, expiresAt: step.write.expiresAt };
      await tx.telegramDialogState.upsert({ where: { chatId }, create: { chatId, ...data }, update: data });
    } else if (inserted.length) {
      // Заготовка оказалась не нужна — не оставляем пустую строку. Строку вставили мы и она заперта этой
      // транзакцией, поэтому удаляем по chatId (сравнение с to_timestamp(0) зависит от пояса сессии).
      await tx.telegramDialogState.deleteMany({ where: { chatId } });
    }
    return { ok: true as const, result: step.result };
  });
}

/**
 * Поменять поля состояния помощницы слиянием. Для нового (или чужого просроченного) состояния `change`
 * получает `{ messages: [] }`. false — в чате живёт чужое состояние.
 */
export async function mergeAssistantDialog(params: {
  chatId: string;
  agentId: string;
  /** Что поменять в живом payload (для нового состояния — пустой, без истории). */
  change: (payload: DialogPayload) => DialogPayload;
  /** Срок жизни: от текущего срока живой строки (null — живой строки нет). */
  expiresAt: (live: Date | null) => Date;
}): Promise<boolean> {
  const out = await withAssistantDialog({
    chatId: params.chatId, agentId: params.agentId,
    run: (live) => ({
      result: true,
      write: { payload: params.change(live?.payload ?? { messages: [] }), expiresAt: params.expiresAt(live?.expiresAt ?? null) },
    }),
  });
  return out.ok;
}

/**
 * Поменять поля только ЖИВОГО состояния помощницы этого сотрудника (срок не продлевается). Нет живого —
 * ничего не пишем, false. `change` вернул null — тоже ничего не пишем.
 */
export async function patchLiveAssistantDialog(params: {
  chatId: string;
  agentId: string;
  change: (payload: DialogPayload) => DialogPayload | null;
}): Promise<boolean> {
  const out = await withAssistantDialog({
    chatId: params.chatId, agentId: params.agentId,
    run: (live) => {
      const next = live ? params.change(live.payload) : null;
      return next && live ? { result: true, write: { payload: next, expiresAt: live.expiresAt } } : { result: false };
    },
  });
  return out.ok && out.result;
}

/** «/new», «начать заново»: состояние помощницы стирается целиком (чужое состояние чата не трогаем). */
export async function clearAssistantDialog(chatId: string): Promise<void> {
  await prisma.telegramDialogState.deleteMany({ where: { chatId, kind: DIALOG_KIND } });
}

/**
 * Номер Telegram-сообщения последней реплики человека в истории (`payload.lastUserTurn`). Пишется вместе
 * с историей; сверяется по отпечатку текста, чтобы номер не «приклеился» к другой реплике.
 */
const turnDigest = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 16);

export function userTurnRecord(content: string, messageId: number): { messageId: number; digest: string } {
  return { messageId, digest: turnDigest(content) };
}

export function lastUserTurnMessageId(payload: DialogPayload | null, content: string): number | undefined {
  const turn = payload?.lastUserTurn as { messageId?: unknown; digest?: unknown } | null | undefined;
  if (!turn || !Number.isInteger(turn.messageId) || Number(turn.messageId) <= 0 || turn.digest !== turnDigest(content)) return undefined;
  return Number(turn.messageId);
}
