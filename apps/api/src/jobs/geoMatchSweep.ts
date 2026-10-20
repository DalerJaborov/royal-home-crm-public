import { z } from "zod";
import { prisma } from "../db.js";
import { notifyWaitingBuyersOfNewProperty } from "../lib/propertyMatchFilter.js";
import { logSystemError } from "../lib/systemError.js";
import type { JobHandler } from "./registry.js";

/**
 * ОДНО ЗАДАНИЕ НА ОБЪЕКТ (ставит lib/geoMatchSweep.ts::runNightlyGeoMatchSweepTick,
 * см. doc-comment там же про причину «страховка, не основной механизм»).
 *
 * ИДЕМПОТЕНТНО без специального кода: notifyWaitingBuyersOfNewProperty сам не
 * уведомляет дважды одного и того же клиента про один и тот же объект (дедуп
 * через Interaction-маркер «Автоподбор:») — повторный прогон этого задания
 * (падение между run и DONE) просто не найдёт новых кандидатов.
 *
 * ПОВТОРНАЯ ПРОВЕРКА АКТУАЛЬНОСТИ: между постановкой (08:05) и исполнением
 * очередь могла отстать — объект успел продаться/уйти в Корзину/сняться с
 * продажи. run() перечитывает объект и тихо завершается, если он больше не
 * AVAILABLE — это не отказ, это «уже не актуально» (тот же приём, что в
 * jobs/clientReactivation.ts).
 */
const schema = z.object({ propertyId: z.string(), dayKey: z.string() });

export const geoMatchSweepJob: JobHandler<z.infer<typeof schema>> = {
  type: "geo-match-sweep",
  schema,
  // Не событие реального времени — страховка на утро; лесенка спокойная.
  backoff: (attempt) => Math.min(2 ** attempt, 30) * 60_000,
  async run(payload) {
    const property = await prisma.property.findUnique({
      where: { id: payload.propertyId },
      select: {
        id: true,
        shortId: true,
        title: true,
        districtId: true,
        type: true,
        rooms: true,
        price: true,
        currency: true,
        areaSqm: true,
        floor: true,
        totalFloors: true,
        lat: true,
        lng: true,
        status: true,
        deletedAt: true,
      },
    });
    if (!property || property.deletedAt || property.status !== "AVAILABLE") return;
    await notifyWaitingBuyersOfNewProperty(property);
  },
  async onGiveUp(payload) {
    await logSystemError(
      "background-jobs",
      `Ночной гео-подбор (${payload.dayKey}): объект ${payload.propertyId} не обработан после всех попыток`
    );
  },
};
