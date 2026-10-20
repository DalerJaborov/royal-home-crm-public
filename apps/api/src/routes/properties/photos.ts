/** Фото объекта: загрузка, порядок, удаление, цикл улучшения ИИ, архив
 * (POST /:id/photos, PATCH /:id/photos/order, DELETE /:id/photos/:photoId,
 * POST /:id/photos/:photoId/enhance[+approve|reject], GET /:id/photos/archive.zip)
 * (Г3, §1.3). Перенос verbatim. */
import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ZipArchive } from "archiver";
import type { PropertyPhoto } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { requireAuth } from "../../auth/middleware.js";
import { upload, uploadsDir, thumbsDir } from "../../upload.js";
import { MIN_PROPERTY_PHOTOS, notifyPendingReview } from "../../lib/propertyPipeline.js";
import { autoApproveIfRawReviewOff } from "../../lib/propertyReview.js";
import { resyncPhotosIfPublished } from "../../lib/siteSync.js";
import { logSystemError } from "../../lib/systemError.js";
import { logAudit } from "../../lib/audit.js";
import { loadEventPoints, recordScoreEvent } from "../../lib/scoreJournal.js";
import { requireElevation } from "../../lib/stepUp.js";
import { enhancePropertyPhoto } from "../../ai/photoEnhance.js";
import { claimAgentAiAction } from "../../lib/agentAiActionCap.js";
import { notifySourceFilesChanged } from "../../lib/propertyEditNotify.js";
import { canManageProperty, normalizePropertyAddress, parseUploadKeys, propertyEditLockBody } from "./shared.js";
import { anyParams } from "../../lib/routeParams.js";
import { memoryUploadBudget } from "../../lib/memoryUploadBudget.js";
import { extractGpsFromPhoto } from "../../lib/propertyPhotoGeo.js";
import { isInsideDushanbe } from "../../lib/geo.js";
import { sharpFromUpload } from "../../lib/heicInput.js";
import { lookupGeoPoint, snapToBuilding } from "../../lib/geoLookup.js";
import { formatGeoAddressGuess } from "./crud.js";
import { mapWithConcurrency } from "../../lib/concurrency.js";
import { removePropertyPhoto } from "../../lib/propertyPhotoRemoval.js";
import { removeMessagePhoto } from "../../lib/messagePhoto.js";

export const photosRouter = Router();

/**
 * Fix 3a (13.09.2026, аудит надёжности): защита от злоупотребления улучшением
 * фото ИИ — двумя независимыми барьерами.
 *
 * 1. ЛОК НА ФОТО. Раньше enhancedRequestedAt проставлялся только ПОСЛЕ удачного
 *    вызова (ai/photoEnhance.ts) — во время самого вызова (пока модель рисует,
 *    ENHANCE_TIMEOUT_MS там же = 60 сек) в базе не было вообще никакого следа
 *    «уже работаем», и два параллельных запроса на одно и то же фото (двойной
 *    клик, повторный сабмит формы) оба доходили до платного вызова Gemini.
 *    Теперь лок ставится ОДНИМ атомарным UPDATE ДО вызова (см. ниже) — обычный
 *    read-then-write здесь не годится по той же причине, что и в
 *    lib/aiDailyBudget.ts: между чтением и записью успевает проскочить вторая
 *    попытка. Лок действует только для СВЕЖЕГО запуска (ещё нет неодобренного
 *    результата, enhancedUrl пуст) — повторный запуск ПОВЕРХ уже готового, но
 *    ещё не одобренного результата остаётся осознанной штатной операцией (см.
 *    комментарий у самого маршрута) и своей защиты от гонки не требует: агент
 *    прямо смотрит на существующий результат и решает его заменить.
 *    2 минуты — с запасом над ENHANCE_TIMEOUT_MS (60 сек) на сетевые задержки,
 *    но достаточно коротко, чтобы упавший ПОСРЕДИ вызова запрос (краш процесса,
 *    таймаут прокси) не запирал фото на дольше пары минут — обычный (не
 *    аварийный) отказ лок снимает сам, см. ниже.
 * 2. СУТОЧНЫЙ ПОТОЛОК НА АГЕНТА (lib/agentAiActionCap.ts). 40 — на глаз (это
 *    мягкий потолок злоупотребления, не согласованная с владельцем квота):
 *    в объекте обычно 10-20 фото, у агента редко больше 3-4 объектов в работе
 *    одновременно, а 40 улучшений в сутки — это уже весь каталог за один день,
 *    что нормальная ручная работа не производит физически.
 */
/** Потолок числа фото у объекта (находка №162) — как у черновика мастера. */
const MAX_PROPERTY_PHOTOS = 60;

const ENHANCE_LOCK_WINDOW_MS = 2 * 60_000;
const ENHANCE_DAILY_LIMIT_PER_AGENT = 40;

photosRouter.post("/:id/photos", requireAuth, anyParams(memoryUploadBudget), anyParams(upload.array("photos", 30)), async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  const lock = propertyEditLockBody(req, property);
  if (lock) return res.status(409).json(lock);
  /**
   * ОБЪЕКТ В КОРЗИНЕ ФОТО НЕ ПРИНИМАЕТ (docs/TASKS.md, Пачка D).
   *
   * Раньше запрос тихо проходил: файлы сохранялись на диск и в базу, но
   * карточка в Корзине их никому не показывает — снимки просто терялись
   * молча. 409, а не 404: объект СУЩЕСТВУЕТ (иначе выше уже ответили бы
   * «не найден»), просто в этом состоянии операция запрещена — тот же смысл,
   * что у 409 при чужом ключе загрузки чуть ниже.
   */
  if (property.deletedAt) {
    return res.status(409).json({ error: "Объект удалён, фото не принимаются. Сначала восстановите его из Корзины." });
  }

  const files = (req.files as Express.Multer.File[]) ?? [];
  const parsedKeys = parseUploadKeys(req.body?.uploadKeys, files.length);
  if (!parsedKeys.ok) return res.status(400).json({ error: parsedKeys.error });
  const uploadKeys = parsedKeys.keys;

  /**
   * ПОВТОР ПОСЛЕ ОБРЫВА СВЯЗИ НЕ ДОЛЖЕН СОЗДАВАТЬ ВТОРЫЕ КОПИИ.
   *
   * Очередь загрузки на клиенте (web: lib/uploadQueue.ts) повторяет пачку, если
   * не дождалась ответа. А «не дождалась» и «не сохранилось» — разные вещи: связь
   * рвётся и ПОСЛЕ того, как снимки уже записаны, но ДО того, как ответ дошёл до
   * телефона. Без ключа такой повтор задваивал бы всю пачку, и «ничего не
   * пропадает» превращалось бы в «всё задваивается».
   *
   * Ищем БЕЗ фильтра по объекту, хотя чужую запись отдавать нельзя. Причина в
   * том, что индекс уникален на всю таблицу: отфильтруй мы по своей карточке —
   * ключ, занятый чужой, не нашёлся бы, дошёл до вставки и положил запрос
   * пятисотой ошибкой. А на 5xx очередь повторяет отправку, то есть повторяла бы
   * вечно. Поэтому чужой ключ обнаруживаем сами и отвечаем внятным отказом.
   */
  const alreadyStored = uploadKeys?.length
    ? await prisma.propertyPhoto.findMany({ where: { uploadKey: { in: uploadKeys } } })
    : [];
  const foreign = alreadyStored.find((p) => p.propertyId !== property.id);
  if (foreign) {
    return res.status(409).json({ error: "Ключ загрузки уже использован другим объектом" });
  }
  const storedByKey = new Map(alreadyStored.map((p) => [p.uploadKey!, p]));

  const currentCount = await prisma.propertyPhoto.count({ where: { propertyId: property.id } });
  // order нового фото строится от максимума, а не от числа снимков (аудит 04.10.2026,
  // PROP-01): после удаления из середины (или обложки) count совпадал с order живого
  // фото, и сортировка «только по order» становилась неоднозначной, а обложка спорной.
  const maxOrder = (await prisma.propertyPhoto.aggregate({ where: { propertyId: property.id }, _max: { order: true } }))._max.order;
  const orderBase = maxOrder === null || maxOrder === undefined ? 0 : maxOrder + 1;

  /**
   * ГЕОЛОКАЦИЯ ПО ФОТО (EXIF GPS, владелец 16.09.2026) — читаем координаты из
   * ПЕРВОГО же снимка пачки, у которого они есть: агент снимает объект стоя в
   * нём, все кадры пачки практически в одной точке, усреднять или сверять
   * между собой незачем. `needsGeoBackfill` — тот же инвариант, что у
   * jobs/geocode.ts: не трогаем координаты, которые агент поставил вручную
   * (`geocodedAt` пуст у ручного пина), перезаписываем только пустые или
   * прошлый результат автогеокодера. Извлечение не бросает исключений само
   * (см. lib/propertyPhotoGeo.ts) — оборачивать в try/catch здесь не нужно.
   */
  const needsGeoBackfill = property.lat === null || property.geocodedAt !== null;
  let gpsPoint: { lat: number; lng: number } | null = null;

  /**
   * ЧТО НАДО ОБРАБОТАТЬ (22.09.2026, оптимизация под нагрузкой). Раньше пачка из
   * 10-20 фото шла строго последовательно: декод → два encode подряд → вставка в
   * базу, и только потом следующее фото — вся пачка ждала диск и Prisma по кругу,
   * ничего не работало одновременно. Порядок ('order' у фото, а значит обложка и
   * порядок на сайте) обязан остаться ТЕМ ЖЕ, что и при последовательной обработке
   * — поэтому позиция каждого нового фото (order = orderBase + его номер среди
   * НОВЫХ, в порядке файлов пачки) считается здесь же, ДО параллельной обработки,
   * а не по тому, какой воркер закончил первым.
   */
  interface PendingPhoto {
    fileIndex: number;
    file: Express.Multer.File;
    uploadKey: string | null;
    order: number;
  }
  const toProcess: PendingPhoto[] = [];
  for (let i = 0; i < files.length; i++) {
    const uploadKey = uploadKeys?.[i] ?? null;
    const known = uploadKey ? storedByKey.get(uploadKey) : undefined;
    if (known) continue;
    toProcess.push({ fileIndex: i, file: files[i], uploadKey, order: orderBase + toProcess.length });
  }

  // ПОТОЛОК ЧИСЛА ФОТО НА ОБЪЕКТ (находка №162) — тот же, что у черновика мастера
  // (routes/properties/drafts.ts::MAX_DRAFT_PHOTOS): иначе объект без предела
  // копил снимки до исчерпания диска. Повтор уже сохранённой пачки (toProcess
  // пуст) потолок не задевает.
  if (currentCount + toProcess.length > MAX_PROPERTY_PHOTOS) {
    return res.status(400).json({
      error: `У объекта может быть не больше ${MAX_PROPERTY_PHOTOS} фото, сейчас уже ${currentCount}`,
    });
  }

  // GPS ищем СТРОГО последовательно и до параллельной обработки: нужен первый (по
  // порядку файлов пачки) снимок с координатами, а не тот, чей декод EXIF закончился
  // первым — иначе одна и та же пачка отдавала бы разную точку от запуска к запуску.
  if (needsGeoBackfill) {
    for (const item of toProcess) {
      // Разбираем ОРИГИНАЛЬНЫЙ буфер, а не то, что легло на диск: перекодирование
      // в WebP ниже EXIF не сохраняет.
      const point = await extractGpsFromPhoto(item.file.buffer);
      // Снимок сделан не в Душанбе (24.09.2026) — фото из галереи с прошлой
      // поездки, пересланное из другого города, битый тег: объект туда не
      // переносим, смотрим следующий кадр пачки.
      if (point && isInsideDushanbe(point.lat, point.lng)) {
        gpsPoint = point;
        break;
      }
    }
  }

  /**
   * ПРЕДЕЛ ОДНОВРЕМЕННЫХ ФОТО (22.09.2026). Не безлимитный Promise.all — decode+
   * encode в sharp занимает поток libuv (см. UV_THREADPOOL_SIZE в
   * docker-compose.prod.yml), и десяток фото сразу разом упёрся бы в тот же пул
   * потоков, что диск и криптография. 2-3 — тот же порядок, что у остальных мест с
   * mapWithConcurrency (lib/concurrency.ts), достаточно, чтобы диск и Prisma не
   * простаивали между фото, но не десятки декодов разом.
   */
  const PHOTO_UPLOAD_CONCURRENCY = 3;
  const createdPhotos = await mapWithConcurrency(toProcess, PHOTO_UPLOAD_CONCURRENCY, async (item) => {
    const id = randomUUID();
    const filename = `${id}.webp`;
    const fullPath = path.join(uploadsDir, filename);
    const thumbPath = path.join(thumbsDir, filename);

    /**
     * ОДИН ДЕКОД НА ДВА ВЫХОДА (21.09.2026, аудит памяти — контейнер API 506 МБ
     * из 768 МБ ещё в простое). Было: `sharp(file.buffer)` дважды — libvips
     * декодировал один и тот же снимок (часто 12+ мегапикселей с телефона) с
     * нуля для полной версии и ещё раз для миниатюры, удваивая пиковую память на
     * КАЖДОЕ фото пачки. `sharp(buf).clone()` — штатный приём sharp именно для
     * этого случая: вход декодируется один раз, `clone()` даёт вторую независимую
     * цепочку операций поверх уже декодированных пикселей, не трогая исходный
     * буфер повторно. `.rotate()` без аргументов — поворот по EXIF-тегу
     * ориентации; sharp не пишет метаданные в webp-вывод по умолчанию, и без
     * явного поворота снимок с телефона (ориентация в теге, не в пикселях) лёг бы
     * на бок на сайте и в карточке. Полная версия ограничена 2560px по длинной
     * стороне: клиент сжимает фото перед отправкой, но HEIC и прочие форматы,
     * которые он не умеет сжать, идут оригиналом — без потолка декодер получал
     * бы на выходе то же огромное изображение, только в webp.
     *
     * ДВА ВЫХОДА — ПАРАЛЛЕЛЬНО (22.09.2026). Полный и миниатюра шли строго друг за
     * другом (await, потом await) — а `clone()` для того и существует, чтобы обе
     * ветки писали каждая в свой файл одновременно поверх одного декода. Диск и
     * libuv ждут друг друга меньше, а память та же: второй decode по-прежнему не
     * происходит.
     */
    // HEIC с iPhone sharp сам не читает — разбор в lib/heicInput.ts.
    // Битый файл с типом «картинка» (находка №162) — отказ клиента, а не сбой
    // сервера: 400 «не похож на фото» вместо 500 и записи в журнал ошибок. Ловим
    // ТОЛЬКО разбор и запись снимка; сбой базы ниже по-прежнему идёт как был.
    try {
      const pipeline = (await sharpFromUpload(item.file.buffer)).rotate();
      await Promise.all([
        pipeline.clone().resize(2560, 2560, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toFile(fullPath),
        // Миниатюра для карточек каталога. 800px (а не 400) — карточки на ретина-
        // экранах (DPR 2-3) при ширине ~300-400px требуют 2× пикселей, иначе 400px
        // растягивается и мылит. withoutEnlargement — не апскейлить мелкие оригиналы.
        pipeline.clone().resize(800, undefined, { withoutEnlargement: true }).webp({ quality: 80 }).toFile(thumbPath),
      ]);
    } catch (err) {
      await Promise.all([fs.rm(fullPath, { force: true }), fs.rm(thumbPath, { force: true })]).catch(() => {});
      // ЧТО ИМЕННО ПРИШЛО ВМЕСТО ФОТО (13.10.2026, ОБ-000160): с iPhone агента
      // четыре «IMG_*.jpg» подряд получили «не похож на фото», и понять, битый
      // ли это файл, HEIC под чужим именем или пустой обрубок от Safari, было
      // нечем — сам файл не сохраняется, а клиент пишет только наш же текст
      // отказа. Размер, тип и первые байты отвечают на этот вопрос без файла.
      const head = item.file.buffer.subarray(0, 16).toString("hex");
      void logSystemError(
        "api",
        `Фото «${item.file.originalname}» объекта ${property.id} не прочитано: ${err instanceof Error ? err.message : String(err)}. ` +
          `Размер ${item.file.buffer.length} байт, тип «${item.file.mimetype}», начало файла ${head || "пусто"}`,
        { dedupKey: `photo-unreadable:${property.id}:${item.file.originalname}` }
      );
      return { fileIndex: item.fileIndex, photo: null, badName: item.file.originalname };
    }

    const photo = await prisma.propertyPhoto.create({
      data: {
        propertyId: property.id,
        url: `/uploads/${filename}`,
        thumbUrl: `/uploads/thumbs/${filename}`,
        order: item.order,
        uploadKey: item.uploadKey,
      },
    });
    return { fileIndex: item.fileIndex, photo, badName: null };
  });

  // Хоть один файл не фото — не принимаем пачку целиком: хорошие снимки, уже
  // записанные параллельными воркерами, откатываем (строки и файлы), чтобы повтор
  // исправленной пачки не задвоил их.
  const unreadable = createdPhotos.find((c) => c.photo === null);
  if (unreadable) {
    const done = createdPhotos.flatMap((c) => (c.photo ? [c.photo] : []));
    if (done.length > 0) {
      await prisma.propertyPhoto.deleteMany({ where: { id: { in: done.map((d) => d.id) } } });
      await Promise.all(
        done.flatMap((d) => [
          fs.rm(path.join(uploadsDir, path.basename(d.url)), { force: true }),
          d.thumbUrl ? fs.rm(path.join(thumbsDir, path.basename(d.thumbUrl)), { force: true }) : null,
        ])
      ).catch(() => {});
    }
    return res.status(400).json({ error: `Файл «${unreadable.badName ?? "без имени"}» не похож на фото — выберите снимок ещё раз` });
  }

  /** Только созданные сейчас — по ним считаются автовозврат и синхронизация. */
  const created: PropertyPhoto[] = createdPhotos.flatMap((c) => (c.photo ? [c.photo] : []));
  const createdByFileIndex = new Map(createdPhotos.flatMap((c) => (c.photo ? [[c.fileIndex, c.photo] as const] : [])));
  // Что отдаём клиенту: и созданные сейчас, и уже лежавшие с прошлой попытки —
  // в исходном порядке файлов пачки, как и при последовательной обработке.
  const stored: PropertyPhoto[] = [];
  for (let i = 0; i < files.length; i++) {
    const uploadKey = uploadKeys?.[i] ?? null;
    const known = uploadKey ? storedByKey.get(uploadKey) : undefined;
    stored.push(known ?? createdByFileIndex.get(i)!);
  }

  /**
   * ЗАПИСЬ КООРДИНАТ/РАЙОНА/АДРЕСА ИЗ EXIF — тем же lookupGeoPoint, которым
   * уже пользуется закрытый объект без адреса (routes/properties/crud.ts) и
   * GET /geo/lookup: копия логики поиска района по точке здесь не заводится.
   *
   * updateMany с тем же условием, что у jobs/geocode.ts (lat: null ИЛИ
   * geocodedAt не пуст) — на случай гонки: пока грузились фото, агент мог сам
   * поставить точку на карте, и её нельзя тихо затереть снимком, сделанным
   * раньше. Район/адрес заполняем, только если они ещё пустые — ручной ввод
   * агента эта ветка не трогает никогда, ровно как в crud.ts.
   */
  if (created.length > 0 && gpsPoint) {
    // Сбой справочника/базы здесь НЕ роняет загрузку (02.10.2026): фото уже
    // записаны, а ответ 500 на повторе дал бы пустой `created` — статус «Ждём
    // фото» → «На проверке» больше не сработал бы никогда. Отказ уходит в журнал.
    try {
      const geo = await lookupGeoPoint(gpsPoint.lat, gpsPoint.lng);
      // Точка снимка упала в нескольких метрах от стены (тротуар, дорога — GPS в
      // доме гуляет) — объект ставим на сам дом, как и мастер (28.09.2026).
      const point = snapToBuilding(gpsPoint, geo);
      const data: { lat: number; lng: number; geocodedAt: Date; districtId?: string; address?: string; canonicalAddress?: string } = {
        lat: point.lat,
        lng: point.lng,
        geocodedAt: new Date(),
      };
      if (!property.districtId && geo.district) data.districtId = geo.district.id;
      if (!property.address?.trim()) {
        const guessedAddress = formatGeoAddressGuess(geo);
        if (guessedAddress) {
          data.address = guessedAddress;
          // Ключ дублей считается там же, где пишется адрес (02.10.2026).
          data.canonicalAddress = normalizePropertyAddress(guessedAddress);
        }
      }
      await prisma.property.updateMany({
        where: { id: property.id, OR: [{ lat: null }, { geocodedAt: { not: null } }] },
        data,
      });
    } catch (err) {
      void logSystemError("api", `Точка объекта ${property.id} по фото не выставлена: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Только если что-то действительно появилось: повтор, целиком попавший в уже
  // сохранённое, не должен заново выкладывать объект на сайт.
  if (created.length > 0) void resyncPhotosIfPublished(property.id, "новые фото");
  // Хронология объекта (владелец 23.09.2026: «все правки в хронологию»).
  if (created.length > 0) {
    logAudit(req, "PROPERTY_PHOTOS_ADDED", "Property", property.id, { shortId: property.shortId, count: created.length });
  }

  // ДОСЛАННЫЕ ФОТО — модераторам в Telegram (22.09.2026). Только к объекту, который
  // проверку уже прошёл: на проверке и в «Ждём фото» снимки и так смотрят целиком.
  if (created.length > 0 && !property.offSite && property.status !== "PENDING_REVIEW" && property.status !== "AWAITING_PHOTOS") {
    void import("../../lib/telegramModeration.js")
      .then((m) => m.notifyTelegramPhotoBatch(property.id, created.map((ph) => ph.id)))
      .catch((err) => console.error("[telegram-moderation] досланные фото:", err));
  }

  // АВТОВОЗВРАТ «ФОТО»: агент дозагрузил снимки, пока объект ждал новые
  // (спецификация: «После повторной загрузки — статус обратно «На проверке»,
  // ответственный обратно Маркетинг»). Владелец 05.08.2026: минимум 6 фото
  // обязателен — дозагрузка ниже порога не должна тихо возвращать объект на
  // проверку, будто он снова готов.
  if (created.length > 0 && property.status === "AWAITING_PHOTOS" && currentCount + created.length >= MIN_PROPERTY_PHOTOS) {
    /**
     * НЕСАЙТОВЫЙ ОБЪЕКТ ВЫХОДИТ В ПРОДАЖУ СРАЗУ (владелец 09.09.2026). Он проходит
     * ровно один этап конвейера — «ожидает фото», — потому что подбор теперь его
     * предлагает и пустая карточка ушла бы клиенту. Модерации, видео и монтажа у
     * него нет: конвейер существует ради публикации, а публикации не будет.
     */
    const nextStatus = property.offSite ? "AVAILABLE" : "PENDING_REVIEW";
    await prisma.property.update({
      where: { id: property.id },
      data: {
        status: nextStatus,
        stageEnteredAt: new Date(),
        reviewRejectionReason: null,
        reviewRejectionVoiceUrl: null,
        reviewRejectionVoiceTranscript: null,
      },
    });
    // На проверку маркетингу несайтовый объект не идёт — ни баллов за доработку,
    // ни уведомления. Ответ маршрута при этом остаётся прежним (полный список
    // фотографий ниже): менять его форму ради одной ветки нельзя, клиент обязан
    // видеть повтор как успех.
    const responsibleId = property.offSite
      ? null
      : property.intakeAgentId ?? property.assignedAgentId ?? property.createdById;
    if (responsibleId) {
      const points = await loadEventPoints();
      recordScoreEvent({
        agentId: responsibleId,
        kind: "property_rework_fixed",
        delta: points.property_rework_fixed,
        reason: "Новые фото загружены — объект возвращён на проверку",
        sourceId: `reject-${property.id}-photos-${property.photosRejectionCount}`,
      });
    }
    // Симметрично видео-автовозврату (см. videoAutoRevert в PATCH /:id ниже): маркетинг
    // должен узнать, что появилась работа, а не выяснять это, заглянув в список руками.
    if (!property.offSite) {
      void notifyPendingReview(property.id, property.shortId, property.title).catch((err) =>
        console.error("[push] объект на проверку (фото):", err)
      );
    }
  }

  // Проверка исходников выключена (25.09.2026): объект на проверке добрал фото
  // до минимума, видео уже есть — CRM одобряет сама (lib/propertyReview.ts).
  if (created.length > 0 && property.status === "PENDING_REVIEW") {
    void autoApproveIfRawReviewOff(property.id).catch((err) => console.error("[конвейер] автоодобрение после фото:", err));
  }

  // Фото изменились — монтажёру (если ролик у него) или модератору (07.10.2026).
  if (created.length > 0) void notifySourceFilesChanged(property.id, "photos", `добавлено ${created.length}`, req.agent!.id);

  // Всё, что по итогам запроса лежит в базе, — включая пришедшее с прошлой
  // попытки. Клиент обязан увидеть повтор как успех, иначе очередь будет
  // повторять его вечно.
  res.status(201).json(stored);
});

/** Новый порядок фото объекта: body { photoIds } — полный список id в нужном
 * порядке. Первое фото становится главным (order 0 — обложка в CRM и на сайте:
 * siteSync шлёт photos по order asc). */
// Потолок тот же, что у загрузки (MAX_PROPERTY_PHOTOS): со старым max(50) объект с 51-60
// снимками не мог сменить обложку и порядок, любой PATCH давал 400 (аудит 04.10.2026, APROP01).
const photoOrderSchema = z.object({ photoIds: z.array(z.guid()).min(1).max(MAX_PROPERTY_PHOTOS) });

/** Ответ на правку фото/видео объекта, который лежит в Корзине (D13, 02.10.2026). */
const TRASHED_PROPERTY_MEDIA_MESSAGE = "Объект удалён — сначала восстановите его из Корзины.";

photosRouter.patch("/:id/photos/order", requireAuth, async (req, res) => {
  const parsed = photoOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const property = await prisma.property.findUnique({
    where: { id: req.params.id },
    include: { photos: { select: { id: true } } },
  });
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  const lock = propertyEditLockBody(req, property);
  if (lock) return res.status(409).json(lock);
  // Объект в Корзине — фото не трогаем (D13, 02.10.2026), как и загрузку выше.
  if (property.deletedAt) return res.status(409).json({ error: TRASHED_PROPERTY_MEDIA_MESSAGE });

  // Полное совпадение множеств: нельзя молча потерять или подмешать чужое фото.
  const existing = new Set(property.photos.map((p) => p.id));
  const ids = parsed.data.photoIds;
  if (ids.length !== existing.size || ids.some((id) => !existing.has(id))) {
    return res.status(400).json({ error: "Список фото не совпадает с фото объекта" });
  }

  await prisma.$transaction(
    ids.map((photoId, idx) =>
      prisma.propertyPhoto.update({ where: { id: photoId }, data: { order: idx } })
    )
  );
  const photos = await prisma.propertyPhoto.findMany({
    where: { propertyId: property.id },
    orderBy: { order: "asc" },
  });

  // До этого фикса смена главного фото/порядка после публикации молча
  // расходилась с сайтом — приходилось нажимать «Опубликовать» заново.
  void resyncPhotosIfPublished(property.id, "новый порядок фото");
  logAudit(req, "PROPERTY_PHOTOS_REORDERED", "Property", property.id, { shortId: property.shortId });

  res.json(photos);
});

photosRouter.delete("/:id/photos/:photoId", requireAuth, async (req, res) => {
  const photo = await prisma.propertyPhoto.findUnique({ where: { id: req.params.photoId } });
  if (!photo || photo.propertyId !== req.params.id) {
    return res.status(404).json({ error: "Фото не найдено" });
  }
  const property = await prisma.property.findUnique({ where: { id: photo.propertyId } });
  if (!property || !canManageProperty(req, property)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  const lock = propertyEditLockBody(req, property);
  if (lock) return res.status(409).json(lock);
  // Объект в Корзине — фото не трогаем (D13, 02.10.2026), как и загрузку выше.
  if (property.deletedAt) return res.status(409).json({ error: TRASHED_PROPERTY_MEDIA_MESSAGE });

  // Тело удаления — lib/propertyPhotoRemoval.ts: тем же путём фото отклоняют из Telegram.
  await removePropertyPhoto(photo, property, req.agent!.id);
  logAudit(req, "PROPERTY_PHOTO_DELETED", "Property", property.id, { shortId: property.shortId });
  void notifySourceFilesChanged(property.id, "photos", "удалено 1", req.agent!.id);

  res.status(204).send();
});

/**
 * УЛУЧШЕНИЕ ФОТО ИИ (пункт 7 очереди, 23.08.2026) — три эндпоинта: запуск,
 * одобрение, отклонение.
 *
 * requireElevation — на ВСЕХ трёх, сверх обычного canManageProperty ниже: это
 * дорогой вызов ИИ и (у approve) запись, заменяющая фото, которое видит
 * клиент, — тот же уровень подтверждения личности, что у изменения
 * сотрудников и Настроек (routes/agents.ts, routes/settings.ts). Доступ к
 * самому объекту — canManageProperty, как и у остальных операций с фото этой
 * карточки (POST/DELETE /:id/photos выше) — не ослабляем существующую защиту.
 */
photosRouter.post("/:id/photos/:photoId/enhance", requireAuth, requireElevation, async (req, res) => {
  const photo = await prisma.propertyPhoto.findUnique({ where: { id: req.params.photoId } });
  if (!photo || photo.propertyId !== req.params.id) {
    return res.status(404).json({ error: "Фото не найдено" });
  }
  const property = await prisma.property.findUnique({ where: { id: photo.propertyId } });
  if (!property || !canManageProperty(req, property)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  // Замок монтажа и Корзина — как у остальных операций с фото (D13, 02.10.2026):
  // улучшение подменяет снимок, который монтажёр уже взял в работу.
  const enhanceLock = propertyEditLockBody(req, property);
  if (enhanceLock) return res.status(409).json(enhanceLock);
  // Объект в Корзине — фото не трогаем (D13, 02.10.2026), как и загрузку выше.
  if (property.deletedAt) return res.status(409).json({ error: TRASHED_PROPERTY_MEDIA_MESSAGE });

  // Рубильник — на СЕРВЕРЕ, а не только в интерфейсе (тот же приём, что и у
  // ИИ-ассистента, routes/ai.ts): спрятанная кнопка защищает от случайного
  // нажатия, а не от прямого запроса.
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { propertyPhotoEnhanceEnabled: true },
  });
  if (settings?.propertyPhotoEnhanceEnabled !== true) {
    return res.status(403).json({ error: "Улучшение фото выключено в Настройках" });
  }

  // Суточный потолок на агента — ПЕРЕД локом и вызовом: нет смысла занимать
  // лок фото ради запроса, который всё равно будет отклонён по лимиту.
  const cap = await claimAgentAiAction(req.agent!.id, "property-photo-enhance", ENHANCE_DAILY_LIMIT_PER_AGENT);
  if (!cap.allowed) {
    return res.status(429).json({ error: `Суточный лимит улучшений фото исчерпан (${ENHANCE_DAILY_LIMIT_PER_AGENT}/день)` });
  }

  // ЛОК: свежий запуск (ещё нет неодобренного результата) — атомарный UPDATE
  // ДО вызова, а не после (см. докстринг у объявления роутера выше). Условие
  // "не занято" — либо лока не было, либо он старше ENHANCE_LOCK_WINDOW_MS
  // (застрявший после краша/таймаута запрос отпускает фото сам, без починки руками).
  // Запуск ПОВЕРХ уже готового неодобренного результата (photo.enhancedUrl задан)
  // лок не проверяет — это осознанная штатная операция (см. очистку файлов ниже).
  if (!photo.enhancedUrl) {
    const lockCutoff = new Date(Date.now() - ENHANCE_LOCK_WINDOW_MS);
    const claimed = await prisma.propertyPhoto.updateMany({
      where: {
        id: photo.id,
        OR: [{ enhancedRequestedAt: null }, { enhancedRequestedAt: { lt: lockCutoff } }],
      },
      data: { enhancedRequestedAt: new Date(), enhancedRequestedBy: req.agent!.id },
    });
    if (claimed.count === 0) {
      return res.status(409).json({ error: "Улучшение этого фото уже выполняется — подождите" });
    }
  }

  // Повторный запуск поверх ЕЩЁ НЕ рассмотренного результата — предыдущий
  // кандидат теряет смысл (заменится новым), и его файлы иначе осиротели бы
  // на диске навсегда: PropertyPhoto хранит только последнюю пару enhanced*.
  await Promise.all([
    photo.enhancedUrl ? fs.rm(path.join(uploadsDir, path.basename(photo.enhancedUrl)), { force: true }) : null,
    photo.enhancedThumbUrl
      ? fs.rm(path.join(uploadsDir, "thumbs", path.basename(photo.enhancedThumbUrl)), { force: true })
      : null,
  ]);

  const result = await enhancePropertyPhoto(photo.id, req.agent!.id);
  if (!result.ok || !result.photo) {
    // Лок снимаем ТОЛЬКО если он наш и результата так и не появилось — иначе
    // затёрли бы enhancedRequestedAt у результата, который этим же вызовом уже
    // сохранился (enhancePropertyPhoto пишет enhancedUrl+enhancedRequestedAt
    // одним update при успехе, см. ai/photoEnhance.ts). Без явного снятия лока
    // обычный (не аварийный) отказ ИИ держал бы агента без ретрая до
    // ENHANCE_LOCK_WINDOW_MS — 2 минуты того не стоят.
    if (!photo.enhancedUrl) {
      await prisma.propertyPhoto.updateMany({
        where: { id: photo.id, enhancedUrl: null },
        data: { enhancedRequestedAt: null, enhancedRequestedBy: null },
      });
    }
    return res.status(502).json({ error: result.error ?? "Не удалось улучшить фото" });
  }
  logAudit(req, "PROPERTY_PHOTO_ENHANCE_REQUESTED", "PropertyPhoto", photo.id, {});
  res.json(result.photo);
});

/** Одобрение: улучшенная версия становится действующим фото — с бэкапом того,
 *  что было в url/thumbUrl, в original* (только если бэкапа ещё нет — второе
 *  одобрение подряд не должно затирать САМЫЙ первый оригинал более свежей
 *  "оригинальной" версией). С этого момента вся остальная CRM (галерея,
 *  синхронизация с сайтом) продолжает читать url/thumbUrl как раньше — ей не
 *  нужно знать про существование улучшения. */
photosRouter.post("/:id/photos/:photoId/enhance/approve", requireAuth, requireElevation, async (req, res) => {
  const photo = await prisma.propertyPhoto.findUnique({ where: { id: req.params.photoId } });
  if (!photo || photo.propertyId !== req.params.id) {
    return res.status(404).json({ error: "Фото не найдено" });
  }
  const property = await prisma.property.findUnique({ where: { id: photo.propertyId } });
  if (!property || !canManageProperty(req, property)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  const approveLock = propertyEditLockBody(req, property);
  if (approveLock) return res.status(409).json(approveLock);
  // Объект в Корзине — фото не трогаем (D13, 02.10.2026), как и загрузку выше.
  if (property.deletedAt) return res.status(409).json({ error: TRASHED_PROPERTY_MEDIA_MESSAGE });
  if (!photo.enhancedUrl || !photo.enhancedThumbUrl) {
    return res.status(409).json({ error: "Улучшенного варианта нет" });
  }

  // РЕШЕНИЕ ОДИН РАЗ (аудит 04.10.2026, APROP03): переход «есть улучшенный вариант E»
  // в «E стал действующим» идёт условным updateMany по тому же enhancedUrl, что прочитан
  // выше. Параллельное «отклонить» уже могло стереть E и обнулить поля: безусловная
  // запись подставила бы в url несуществующий файл.
  const claimed = await prisma.propertyPhoto.updateMany({
    where: { id: photo.id, enhancedUrl: photo.enhancedUrl, enhancedThumbUrl: photo.enhancedThumbUrl },
    data: {
      originalUrl: photo.originalUrl ?? photo.url,
      originalThumbUrl: photo.originalThumbUrl ?? photo.thumbUrl,
      url: photo.enhancedUrl,
      thumbUrl: photo.enhancedThumbUrl,
      enhancedUrl: null,
      enhancedThumbUrl: null,
      enhancedRequestedAt: null,
      enhancedRequestedBy: null,
    },
  });
  if (claimed.count === 0) return res.status(409).json({ error: "По улучшенному фото уже принято решение — обновите страницу" });
  const updated = await prisma.propertyPhoto.findUniqueOrThrow({ where: { id: photo.id } });

  // ПРЕЖНЯЯ УЛУЧШЕННАЯ ВЕРСИЯ — СИРОТА (находка №187). Бэкап оригинала при втором
  // одобрении не перезаписывается, а действующий url меняется: файл, который
  // был действующим (прошлая улучшенная версия), больше никуда не записан.
  // Оригинал (originalUrl) и всё, чем ещё пользуется другая строка фото, не трогаем.
  const staleFiles: { url: string; thumb: boolean }[] = [];
  if (photo.originalUrl && photo.url !== photo.originalUrl) staleFiles.push({ url: photo.url, thumb: false });
  if (photo.originalThumbUrl && photo.thumbUrl && photo.thumbUrl !== photo.originalThumbUrl) {
    staleFiles.push({ url: photo.thumbUrl, thumb: true });
  }
  for (const stale of staleFiles) {
    const stillUsed = await prisma.propertyPhoto.count({
      where: {
        OR: [
          { url: stale.url },
          { thumbUrl: stale.url },
          { originalUrl: stale.url },
          { originalThumbUrl: stale.url },
          { enhancedUrl: stale.url },
          { enhancedThumbUrl: stale.url },
        ],
      },
    });
    if (stillUsed > 0) continue;
    await fs.rm(path.join(stale.thumb ? thumbsDir : uploadsDir, path.basename(stale.url)), { force: true }).catch(() => {});
    if (!stale.thumb) await removeMessagePhoto(stale.url).catch(() => {});
  }

  void resyncPhotosIfPublished(property.id, "улучшенное фото одобрено");
  logAudit(req, "PROPERTY_PHOTO_ENHANCE_APPROVED", "PropertyPhoto", photo.id, {});
  res.json(updated);
});

/** Отклонение: просто стирает enhanced*-поля и их файлы с диска, url/thumbUrl
 *  (действующее фото) не трогает вовсе. */
photosRouter.post("/:id/photos/:photoId/enhance/reject", requireAuth, requireElevation, async (req, res) => {
  const photo = await prisma.propertyPhoto.findUnique({ where: { id: req.params.photoId } });
  if (!photo || photo.propertyId !== req.params.id) {
    return res.status(404).json({ error: "Фото не найдено" });
  }
  const property = await prisma.property.findUnique({ where: { id: photo.propertyId } });
  if (!property || !canManageProperty(req, property)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }

  // СНАЧАЛА УСЛОВНАЯ ЗАПИСЬ, ПОТОМ ФАЙЛЫ (аудит 04.10.2026, APROP03). Раньше файлы
  // стирались по снимку, прочитанному выше, а затем безусловно обнулялись поля: если
  // параллельное «одобрить» за это время сделало E действующим url, фото оставалось
  // ссылкой на удалённый файл. Теперь поля обнуляются только если enhancedUrl всё ещё
  // тот же, и файлы удаляются лишь после успешного перехода.
  const cleared = await prisma.propertyPhoto.updateMany({
    where: { id: photo.id, enhancedUrl: photo.enhancedUrl },
    data: { enhancedUrl: null, enhancedThumbUrl: null, enhancedRequestedAt: null, enhancedRequestedBy: null },
  });
  if (cleared.count === 0) return res.status(409).json({ error: "По улучшенному фото уже принято решение — обновите страницу" });

  if (photo.enhancedUrl) await fs.rm(path.join(uploadsDir, path.basename(photo.enhancedUrl)), { force: true });
  if (photo.enhancedThumbUrl) {
    await fs.rm(path.join(uploadsDir, "thumbs", path.basename(photo.enhancedThumbUrl)), { force: true });
  }
  const updated = await prisma.propertyPhoto.findUniqueOrThrow({ where: { id: photo.id } });

  logAudit(req, "PROPERTY_PHOTO_ENHANCE_REJECTED", "PropertyPhoto", photo.id, {});
  res.json(updated);
});

/** Все фото объекта одним ZIP — «Скачать всё» на карточке. Фото лежат на диске
 * сервера (не в R2), поэтому стримим напрямую из uploadsDir через createReadStream —
 * archiver собирает архив на лету и пишет в res, весь файл целиком в память не
 * попадает. Тот же доступ, что и на остальные операции с фото этого объекта. */
photosRouter.get("/:id/photos/archive.zip", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({
    where: { id: req.params.id },
    include: { photos: { orderBy: { order: "asc" } } },
  });
  if (!property) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });
  if (!property.photos.length) return res.status(400).json({ error: "Фото не загружены" });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="photos-${property.shortId}.zip"`);

  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on("error", (err: Error) => {
    void logSystemError("storage", `Архив фото объекта ${property.id} не собран: ${err.message}`);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);

  property.photos.forEach((photo, i) => {
    const filePath = path.join(uploadsDir, path.basename(photo.url));
    archive.append(createReadStream(filePath), { name: `photo-${i + 1}${path.extname(filePath) || ".webp"}` });
  });

  await archive.finalize();
});
