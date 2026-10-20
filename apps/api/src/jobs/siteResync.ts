import { z } from "zod";
import { logSystemError } from "../lib/systemError.js";
import { runSiteResyncAttempt } from "../lib/siteSync.js";
import { enqueueDirectorAlert } from "../lib/directorAlertQueue.js";
import { prisma } from "../db.js";
import type { JobHandler } from "./registry.js";

/**
 * Досылка изменений опубликованного объекта на сайт (чертёж Б5, 27.08.2026).
 * Ставится из lib/siteSync.ts (resyncPhotosIfPublished); dedupeKey на объект
 * схлопывает шквал правок в один прогон. Вся логика — в runSiteResyncAttempt;
 * здесь адаптер к контракту очереди.
 *
 * Идемпотентность: досылка — upsert полного снимка объекта на стороне сайта,
 * повторный прогон шлёт то же самое.
 */
const schema = z.object({ propertyId: z.string(), context: z.string() });

export const siteResyncJob: JobHandler<z.infer<typeof schema>> = {
  type: "site-resync",
  schema,
  // Сайт на том же VPS: отказ — это либо его деплой (минуты), либо настоящая
  // поломка. 2м → 4м → 8м → 16м.
  backoff: (attempt) => Math.min(2 ** attempt, 16) * 60_000,
  run: (payload) => runSiteResyncAttempt(payload.propertyId, payload.context),
  async onGiveUp(payload) {
    await logSystemError(
      "site-sync",
      `Объект не дошёл до сайта после всех попыток (${payload.context}) — витрина разъехалась с CRM`,
      { url: `/properties/${payload.propertyId}` }
    );
    /**
     * СТРОКА ДИРЕКТОРУ, А НЕ ТОЛЬКО ЖУРНАЛ (docs/flow-audit-property-11-09.md #9,
     * Пачка 9 #7) — раньше отказ фоновой досылки правок после всех 5 попыток
     * уходил только в logSystemError («Здоровье системы», который открывает не
     * каждый), хотя ровно тот же отказ при выходе из монтажа («Готово»,
     * publishAfterEditingComplete) уже шлёт enqueueDirectorAlert. Витрина и CRM
     * разъехались одинаково больно в обоих случаях — уведомление должно быть
     * одинаковым.
     */
    const property = await prisma.property.findUnique({
      where: { id: payload.propertyId },
      select: { title: true, shortId: true },
    });
    void enqueueDirectorAlert({
      title: "⚠️ Объект разъехался с сайтом",
      body: `${property?.title ?? "Объект"} — досылка изменений (${payload.context}) не прошла после всех попыток`,
      url: property ? `/properties/${property.shortId}` : undefined,
      tag: `site-resync-give-up-${payload.propertyId}`,
      recipientPermission: "properties.moderate",
    });
  },
};
