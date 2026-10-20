/**
 * УДАЛЕНИЕ ФОТО ОБЪЕКТА — одно для CRM (DELETE /properties/:id/photos/:photoId)
 * и Telegram-модерации («Отклонить» досланное фото, lib/telegramModeration).
 * Вынесено из роута 22.09.2026 без изменения поведения: уборка файлов, пересинхрон
 * сайта и возврат объекта в «Ждём фото», если снимков стало меньше минимума.
 */
import path from "node:path";
import fs from "node:fs/promises";
import type { Property, PropertyPhoto } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { uploadsDir } from "../upload.js";
import { MIN_PROPERTY_PHOTOS } from "./propertyPipeline.js";
import { resyncPhotosIfPublished, syncPropertiesToSite } from "./siteSync.js";
import { logSystemError } from "./systemError.js";
import { logSystemAudit } from "./audit.js";
import { removeMessagePhoto } from "./messagePhoto.js";
import { sendPushToAgent } from "../push.js";
import { logTimeline } from "./timeline.js";

export async function removePropertyPhoto(photo: PropertyPhoto, property: Property, actorId: string): Promise<void> {
  await prisma.propertyPhoto.delete({ where: { id: photo.id } });

  // Файлы улучшения ИИ (enhanced*/original*) — те же уровни диска, что и
  // основные url/thumbUrl, просто под другими именами; без уборки здесь
  // объект удаляется, а его резервная и неодобренная копии остаются на диске
  // навсегда. Дедуп по имени файла: original* иногда совпадает с url (когда
  // фото так и не улучшали), а force:true на несуществующем файле — no-op.
  const filesToRemove = new Set(
    [photo.url, photo.enhancedUrl, photo.originalUrl].filter((u): u is string => !!u).map((u) => path.basename(u))
  );
  const thumbsToRemove = new Set(
    [photo.thumbUrl, photo.enhancedThumbUrl, photo.originalThumbUrl]
      .filter((u): u is string => !!u)
      .map((u) => path.basename(u))
  );
  await Promise.all([
    ...[...filesToRemove].map((f) => fs.rm(path.join(uploadsDir, f), { force: true })),
    ...[...thumbsToRemove].map((f) => fs.rm(path.join(uploadsDir, "thumbs", f), { force: true })),
  ]);
  // Та же уборка, что и при удалении объекта целиком: без неё JPEG-копия для
  // мессенджеров остаётся на диске навсегда.
  await removeMessagePhoto(photo.url);

  void resyncPhotosIfPublished(property.id, "удаление фото");

  /**
   * БАГ (прод №90, docs/flow-audit-property-11-09.md #1): удаление фото не
   * проверяло минимум и не возвращало объект в конвейер — «В продаже» с 0 фото
   * показывался клиентам как есть. Живая сделка (RESERVED «Договор» из «Итога
   * показа» или полноценный Deal) — не трогаем: снимать объект с продажи, пока
   * по нему уже идут переговоры, хуже, чем временно показать его с неполным
   * набором фото.
   */
  if (property.status === "AVAILABLE" || property.status === "RESERVED") {
    const remaining = await prisma.propertyPhoto.count({ where: { propertyId: property.id } });
    if (remaining < MIN_PROPERTY_PHOTOS) {
      const activeDeal = await prisma.deal.findFirst({
        where: { propertyId: property.id, stage: { notIn: ["COMPLETED", "CANCELLED"] } },
        select: { id: true },
      });
      if (!activeDeal) {
        const was = property.status;
        await prisma.property.update({
          where: { id: property.id },
          data: { status: "AWAITING_PHOTOS", stageEnteredAt: new Date() },
        });
        logSystemAudit("PROPERTY_STATUS_CHANGED", "Property", property.id, {
          was,
          becomes: "AWAITING_PHOTOS",
          reason: "photos-below-minimum",
          remainingPhotos: remaining,
        });

        // Сайт — best-effort, тот же приём, что у syncStatusToSite
        // (lib/propertyAutoStatus.ts) и PATCH /properties/:id: недоступный
        // сайт не повод держать объект без фото в продаже в CRM.
        if (property.publishedOnSite) {
          void (async () => {
            try {
              const withRelations = await prisma.property.findUnique({
                where: { id: property.id },
                include: { district: true, photos: { orderBy: { order: "asc" } } },
              });
              if (!withRelations) return;
              const result = await syncPropertiesToSite([withRelations], "unpublish");
              const problem = !result.ok ? result.error : result.results.find((r) => !r.ok)?.error;
              if (!problem) {
                await prisma.property.update({ where: { id: property.id }, data: { publishedOnSite: false } });
                return;
              }
              void logSystemError("site-sync", `Снятие объекта ${property.id} с сайта (фото ниже минимума) не дошло: ${problem}`, {
                url: `/properties/${property.shortId}`,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              void logSystemError("site-sync", `Снятие объекта ${property.id} с сайта (фото ниже минимума): ${message}`, {
                url: `/properties/${property.shortId}`,
              });
            }
          })();
        }

        const responsibleId = property.intakeAgentId ?? property.assignedAgentId ?? property.createdById;
        if (property.sellerClientId && responsibleId) {
          // Актор — кто фактически удалил фото (requireAuth гарантирует
          // req.agent на этом роуте); ответственный за объект уже получает
          // пуш ниже независимо от того, он ли нажал «Удалить».
          await logTimeline({
            clientId: property.sellerClientId,
            actor: { kind: "agent", agentId: actorId },
            type: "STATUS_CHANGE",
            propertyId: property.id,
            notes: `Объект «${property.title}» вернулся на этап «Ждём фото»: после удаления осталось ${remaining} из ${MIN_PROPERTY_PHOTOS} минимально нужных.`,
          });
        }
        if (responsibleId) {
          void sendPushToAgent(responsibleId, {
            title: "🏠 Объект снят с продажи: мало фото",
            body: `${property.title} — после удаления фото осталось ${remaining} из ${MIN_PROPERTY_PHOTOS}, объект вернулся на этап «Ждём фото»`,
            url: `/properties/${property.shortId}`,
            tag: `property-photos-below-min-${property.id}`,
          }).catch((err) => console.error("[push] фото ниже минимума:", err instanceof Error ? err.message : err));
        }
      }
    }
  }

}
