import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { dushanbeDayKey } from "./aiDailyBudget.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/**
 * СУТОЧНЫЙ ПОТОЛОК ПЛАТНЫХ ИИ-ДЕЙСТВИЙ, КОТОРЫЕ ЗАПУСКАЕТ СОТРУДНИК (13.09.2026,
 * аудит надёжности — Fix 3a). Не путать с lib/aiDailyBudget.ts: та защита считает
 * ходы модели в переписке с КЛИЕНТОМ (предел на собеседника). Здесь — другая ось:
 * сколько раз САМ агент нажал кнопку, запускающую платный вызов ИИ (первое
 * применение — улучшение фото объекта, routes/properties/photos.ts). Без потолка
 * два параллельных запроса или скрипт в цикле могли бы прогнать платную модель
 * через весь каталог за минуты.
 *
 * МЯГКИЙ ПРЕДЕЛ, НЕ БИЗНЕС-ПРАВИЛО. Число подобрано на глаз (см. вызывающий код) —
 * это потолок злоупотребления, а не согласованная с владельцем квота. Если он
 * когда-нибудь начнёт мешать живой работе агента, поднять константу проще, чем
 * гадать: она в одном месте у каждого вызывающего кода.
 *
 * Тот же приём, что у AiBudgetCounter (lib/aiDailyBudget.ts): один INSERT ... ON
 * CONFLICT ... DO UPDATE, без чтения перед записью — иначе два параллельных
 * запроса одного агента (двойной клик) читают одно и то же старое значение и оба
 * проходят мимо предела.
 */
export interface AgentAiActionClaim {
  /** true — счётчик посчитал этот вызов и он ЕЩЁ в пределах суточного лимита. */
  allowed: boolean;
  /** Сколько вызовов этого действия у этого агента уже засчитано сегодня, включая этот. */
  usedToday: number;
}

/**
 * Атомарно засчитывает ОДНО действие и говорит, уложились ли ещё в дневной лимит.
 *
 * ВАЖНО: вызывать РОВНО ОДИН РАЗ на реальную попытку платного вызова, до самого
 * вызова — иначе, как и с локом в photos.ts, посчитанное и реально потраченное
 * разойдутся. Отказ базы не должен стоить агенту рабочего дня: при ошибке действие
 * молча разрешается (allowed: true), как и в aiDailyBudget.ts — предел мягкий, и
 * потеря счёта не так дорога, как остановленная без причины работа.
 */
export async function claimAgentAiAction(agentId: string, action: string, dailyLimit: number): Promise<AgentAiActionClaim> {
  const day = dushanbeDayKey();
  try {
    const rows = await prisma.$queryRaw<{ count: number }[]>(Prisma.sql`
      INSERT INTO "AgentAiActionCounter" ("id", "agentId", "action", "day", "count", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, ${agentId}, ${action}, ${day}, 1, now(), now())
      ON CONFLICT ("agentId", "action", "day")
      DO UPDATE SET "count" = "AgentAiActionCounter"."count" + 1, "updatedAt" = now()
      RETURNING "count"
    `);
    const usedToday = rows[0]?.count ?? 1;
    return { allowed: usedToday <= dailyLimit, usedToday };
  } catch (err) {
    void logSystemError(
      "ai",
      `Суточный потолок ИИ-действий агента не обновлён (${agentId}/${action}): ${describeError(err)} — действие разрешено без учёта`
    );
    return { allowed: true, usedToday: 0 };
  }
}
