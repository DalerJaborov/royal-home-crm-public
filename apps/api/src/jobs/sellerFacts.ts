import { z } from "zod";
import { refreshSellerFacts } from "../ai/sellerFactsExtract.js";
import { logSystemError } from "../lib/systemError.js";
import { SELLER_FACTS_JOB_TYPE } from "../lib/sellerFacts.js";
import type { JobHandler } from "./registry.js";

/**
 * Разбор фактов об объекте продавца (владелец 21.09.2026) — ставится
 * lib/sellerFacts.ts::scheduleSellerFactsRefresh по новой реплике продавца или
 * готовой расшифровке звонка, с дребезгом 15 минут.
 *
 * Отказ ИИ заданием НЕ бросается: факты просто остаются прежними, а следующая
 * пачка сообщений поставит разбор заново (callAiText уже сделал свой единственный
 * повтор и записал отказ в журнал). Бросает только сбой базы — на него один повтор.
 *
 * Идемпотентность — у refreshSellerFacts: граница факта сдвигается одной записью
 * вместе с фактами, повтор после падения разберёт тот же вход.
 */
const schema = z.object({
  clientId: z.string(),
  firstAt: z.string().optional(),
});

export const sellerFactsJob: JobHandler<z.infer<typeof schema>> = {
  type: SELLER_FACTS_JOB_TYPE,
  schema,
  backoff: () => 5 * 60_000,
  async run(payload) {
    await refreshSellerFacts(payload.clientId);
  },
  async onGiveUp(payload) {
    await logSystemError("ai", `Факты объекта продавца ${payload.clientId} не обновлены: сбой базы на обеих попытках`);
  },
};
