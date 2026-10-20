import { z } from "zod";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import type { JobHandler } from "./registry.js";

/**
 * СЛЕД В УТРЕННЕМ ОТЧЁТЕ, ЕСЛИ ДИАЛОГ НЕ РАЗОБРАЛИ ЗА СУТКИ (пачка 7, 11.09.2026;
 * переигран 20.09.2026).
 *
 * jobs/aiReplyRetry.ts (onGiveUp) снимает бота с диалога и шлёт ЕДИНСТВЕННЫЙ пуш
 * тем, кто читает переписки. Раньше здесь была ещё ступень «2 часа» — повтор того
 * же пуша агентам и эскалация руководству; владелец 20.09.2026 убрал и повторы, и
 * пуши-эскалации («руководитель всё равно видит это на своём дашборде»).
 *
 * Осталась одна ступень, "24h", и она НЕ ШЛЁТ НИ ОДНОГО ПУША: если через сутки
 * диалог всё ещё заблокирован, задание оставляет запись в журнале ошибок, и
 * назавтра она сама всплывает в утреннем отчёте директорам. Схема payload
 * по-прежнему принимает "2h" — задания этой ступени могли остаться в очереди с
 * прошлого выката, и упасть на валидации они не должны; отрабатывают они теперь
 * так же тихо, как и "24h".
 *
 * ИДЕМПОТЕНТНОСТЬ БЕЗ НОВОГО ПОЛЯ СХЕМЫ. Различить «бот всё ещё снят с ТОГО ЖЕ
 * непроходимого хода» от «оператор давно вернул бота и потом сам поставил новую,
 * ничем не связанную паузу» нечем — оба используют одно и то же pausedUntil/
 * botPausedAt (см. schema.prisma, комментарий у botPausedAt). Решение: в payload
 * кладём СНИМОК botPausedAt на момент постановки задания и на запуске сверяем его с
 * текущим значением в базе побитово. Совпало — с момента сдачи ИИ ничего не менялось,
 * это тот же самый блок. Не совпало (стало null, или другое время — операторская
 * пауза/повторная сдача переставили его) — эскалировать нечего, тихо выходим.
 */
const schema = z.object({
  conversationId: z.string(),
  /** ISO-снимок botPausedAt на момент постановки — см. докстринг выше. */
  blockedAtIso: z.string(),
  stage: z.enum(["2h", "24h"]),
});

const FOLLOWUP_BACKOFF_MS = 5 * 60 * 1000;

async function stillBlockedOnSameEpisode(conversationId: string, blockedAtIso: string) {
  const conversation = await prisma.botConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, channel: true, pausedUntil: true, botPausedAt: true },
  });
  if (!conversation) return null;
  const same =
    !!conversation.pausedUntil &&
    conversation.pausedUntil.getTime() > Date.now() &&
    (conversation.botPausedAt?.getTime() ?? null) === new Date(blockedAtIso).getTime();
  return same ? conversation : null;
}

export const aiTurnBlockedFollowupJob: JobHandler<z.infer<typeof schema>> = {
  type: "ai-turn-blocked-followup",
  schema,
  backoff: () => FOLLOWUP_BACKOFF_MS,
  async run(payload) {
    const conversation = await stillBlockedOnSameEpisode(payload.conversationId, payload.blockedAtIso);
    // Агент уже вернул бота, либо диалог сменил состояние другим путём — эскалировать нечего.
    if (!conversation) return;

    // Задание ступени «2 часа» могло остаться в очереди с прошлого выката —
    // выходим тихо: повторный пуш по этому поводу больше не шлётся.
    if (payload.stage === "2h") return;

    // stage === "24h": пуш уже был один, второй не нужен — нужен ВИДИМЫЙ СЛЕД. Обычная
    // запись через logSystemError (actionable по умолчанию, errorLogClassify.ts не знает
    // особых паттернов под этот текст) сама попадёт в errorsYesterday утреннего отчёта
    // (lib/morningNumbers.ts) на следующее утро — отдельного поля в отчёте заводить не нужно.
    void logSystemError(
      "ai",
      `Диалог (${payload.conversationId}, ${conversation.channel}) не проходит через ИИ уже СУТКИ — пуш ` +
        `персоналу остался без ответа. Откройте переписку и ответьте руками, а вернуть бота можно ` +
        `кнопкой «Вернуть боту».`
    );
  },
  async onGiveUp() {
    // Сдача самой эскалации не критична: предыдущая ступень (мгновенный пуш из
    // aiReplyRetry.onGiveUp) уже видна персоналу, тихо не повторяем попытки бесконечно.
  },
};
