/**
 * ОБЛОЖКИ ОБЪЕКТА НА ДИСКЕ И В БАЗЕ (23.09.2026) — одно место для публикации
 * ролика (`videoHandoff.ts`) и разового добора старых объектов
 * (`scripts/backfill-property-covers.ts`). Две копии записи обложек разошлись
 * бы при первой же правке: папка, имя файла или поле базы.
 *
 * Оба формата кладутся в ОТКРЫТУЮ папку `/uploads/covers/`, а не рядом с
 * роликом: `handoff/` закрыт от прямой статики, его ссылки подписываются
 * маркером на сутки, и на сайте первая картинка объявления отвалилась бы
 * через день (поймано 23.09 при подготовке образца витрины).
 *
 * Имя файла — от объекта и времени, а не от ролика: у объекта без ролика
 * (добор) ролика нет, а старые файлы при перерисовке не должны подменяться на
 * лету под открытой у кого-то страницей — сайт кэширует картинку по адресу.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../../db.js";
import { propertyCoversDir } from "../../upload.js";
import { logSystemError } from "../systemError.js";
import { describeError } from "../describeError.js";
import { generateCoverPoster } from "./coverPoster.js";
import type { CoverTemplateRecord } from "./coverRegistry.js";

export interface StoredPropertyCovers {
  squareUrl: string | null;
  storyUrl: string | null;
}

/**
 * Рисует квадрат и вертикаль одним шаблоном и сохраняет оба в поля объекта.
 * `frameSource` — кадр ролика (публикация); не задан — главное фото объекта.
 * Отказ одного формата не отменяет второй и не бросает исключение: вызывающему
 * (публикация ролика, добор) обложка нужна, но никогда не ценой основной работы.
 */
export async function renderAndStorePropertyCovers(
  propertyId: string,
  template: CoverTemplateRecord,
  frameSource?: string
): Promise<StoredPropertyCovers> {
  const stamp = Date.now().toString(36);
  const result: StoredPropertyCovers = { squareUrl: null, storyUrl: null };
  await fs.mkdir(propertyCoversDir, { recursive: true });

  for (const aspect of ["square", "story"] as const) {
    const poster = await generateCoverPoster(propertyId, aspect, frameSource, undefined, template);
    if (!poster.ok || !poster.image) continue;
    const filename = `${propertyId}-${stamp}-${aspect}.jpg`;
    try {
      await fs.writeFile(path.join(propertyCoversDir, filename), poster.image);
      if (aspect === "square") result.squareUrl = `/uploads/covers/${filename}`;
      else result.storyUrl = `/uploads/covers/${filename}`;
    } catch (err) {
      void logSystemError("storage", `Обложка ${aspect} объекта ${propertyId} не записалась на диск — ${describeError(err)}`, {
        dedupKey: `cover-store-fail:${propertyId}:${aspect}`,
      });
    }
  }

  if (result.squareUrl || result.storyUrl) {
    // Оба поля — одним обновлением: объект не должен оказаться с квадратом от
    // одного шаблона и вертикалью от другого.
    await prisma.property.update({
      where: { id: propertyId },
      data: {
        ...(result.squareUrl ? { socialCoverSquareUrl: result.squareUrl } : {}),
        ...(result.storyUrl ? { socialCoverStoryUrl: result.storyUrl } : {}),
      },
    });
  }
  return result;
}
