/** Жизненный цикл карточки объекта: POST /, PATCH /:id, POST /:id/complete-editing,
 * DELETE /:id, POST /:id/restore, DELETE /:id/permanent (Г3, §1.3). Перенос verbatim. */
import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import {
  bulkTrashPropertiesSchema,
  propertyCreateSchema,
  propertyUpdateSchema,
  buildPropertyTitle,
  PROPERTY_PIPELINE_STATUSES,
  requiresPropertyModeration,
  PROPERTY_FIELDS_OPEN_AFTER_PUBLISH,
  agentReelLinkClosed,
  floorRuleError,
  normalizePropertyPatchForType,
  propertyFieldShown,
  MIN_PROPERTY_PHOTOS,
  isInstagramLink,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { can, canBindClient, requireAuth, requirePermission } from "../../auth/middleware.js";
import { uploadsDir } from "../../upload.js";
import {
  blockersForSale,
  closeEditingPush,
  closePendingReviewPush,
  isPipelineStatus,
  notifyEditingStarted,
  notifyPendingReview,
  publishAfterEditingComplete,
} from "../../lib/propertyPipeline.js";
import { syncPropertiesToSite } from "../../lib/siteSync.js";
import { runPostUpdateEffects, seoFieldsForUpdate } from "../../lib/propertyUpdateEffects.js";
import { notifyPropertyEditedBeforePublish } from "../../lib/propertyEditNotify.js";
import { notifyWaitingBuyersOfNewProperty } from "../../lib/propertyMatchFilter.js";
import { loadMoneyContext, toTjs } from "../../lib/money.js";
import { logSystemError } from "../../lib/systemError.js";
import { logAudit } from "../../lib/audit.js";
import { detachPropertyFromAds } from "../../lib/ads/adAllocation.js";
import { applySellerPhoneFix, planOwnerPhoneChange, type OwnerPhonePlan } from "../../lib/propertyOwnerRelink.js";
import { removeMessagePhoto } from "../../lib/messagePhoto.js";
import { normalizeDigits } from "../../ai/leadQualifier.js";
import { phoneTail } from "../../lib/clientPhones.js";
import { generateSeoFields } from "../../ai/seoGenerator.js";
import { embedAndSaveProperty, EMBEDDING_RELEVANT_FIELDS } from "../../ai/embeddings.js";
import { reelsCaptionValuesFromProperty, withPostFooter } from "../../lib/reelsCaptionTemplate.js";
import { generateReelsCaptionWithAi } from "../../ai/reelsCaptionAi.js";
import { loadEventPoints, recordScoreEvent } from "../../lib/scoreJournal.js";
import { localVideoDelete } from "../../lib/localVideoStorage.js";
import { propertyOwnedFilePaths } from "../../lib/diskCleanup.js";
import {
  skipVideoHandoffOnManualPublish,
  closeVideoHandoff,
} from "../../lib/videoHandoff.js";
import { describeError } from "../../lib/describeError.js";
import { closeWorkAfterLeavingSale } from "../../lib/propertyLeftSale.js";
import { reopenWorkAfterRestore, trashProperties, trashProperty } from "../../lib/trashProperty.js";
import {
  assignableAgentError,
  canManageProperty,
  canReassignPropertyAgents,
  geocodeInBackground,
  normalizePropertyAddress,
  propertyCreateDeniedReason,
  propertyEditLockBody,
} from "./shared.js";
import { changedPropertyFields, describePropertyChanges } from "../../lib/propertyChanges.js";
import { lookupGeoPoint, type GeoLookupResult } from "../../lib/geoLookup.js";
import { districtFromMap } from "../../lib/propertyDistrict.js";
import { attachDraftToProperty } from "./draftAttach.js";
import { findStaffPhone, staffPhoneError, STAFF_PHONE_ERROR_CODE } from "../../lib/staffPhoneGuard.js";
import { dealStageForManualStatus, propertyStatusTransitionBlock } from "../../lib/propertyStatusTransitions.js";
import { presentProperty, stripOwnerContact } from "../../lib/ownerContact.js";

import { publishPropertyUpdated } from "../../lib/livePublish.js";
import { closeAutoTasks } from "../../lib/autoTasks.js";
import { SELF_CREATED_ASSIGN_REASON } from "../../services/leads/firstCall.js";

export const crudRouter = Router();

/** Потолок сканирования «район+этаж» при проверке дублей на создании объекта
 *  (см. POST /, внутри транзакции с pg_advisory_xact_lock ниже). */
const PROPERTY_DUP_SCAN_CAP = 2000;
/** Окно «это повтор того же запроса» для объекта без адреса (находка №193). */
const PROPERTY_REPEAT_WINDOW_MS = 2 * 60_000;

/** Потолок открытых показов по одному удаляемому объекту (DELETE /:id/permanent,
 *  22.09.2026, класс «Пагинация») — реалистично единицы-десятки, предел с запасом. */
const OPEN_SHOWINGS_PER_PROPERTY_CAP = 500;

/**
 * Адрес из результата lookupGeoPoint человеческой строкой — «улица, дом», а если
 * дома нет, честно то, что нашлось грубее (микрорайон/жилой массив).
 *
 * Дом БЕЗ улицы бывает (у 1 695 домов справочника улицы нет — советские
 * микрорайоны, см. Building.street в schema.prisma): тогда «82 мкр, 14». До
 * 23.09.2026 номер здесь терялся, и все объекты одного микрорайона получали
 * один адрес «82 мкр» — а по адресу ищутся дубли.
 *
 * Экспортирована (16.09.2026): тем же приёмом достраивает адрес объекта по
 * координатам из EXIF GPS фото (lib/propertyPhotoGeo.ts) — копия этой функции
 * там не заводится (класс дефектов из CLAUDE.md: копия логики вместо самой логики).
 */
export function formatGeoAddressGuess(geo: GeoLookupResult): string | null {
  if (geo.street && geo.houseNumber) return `${geo.street}, ${geo.houseNumber}`;
  if (geo.street) return geo.street;
  const place = geo.microdistrict ?? geo.livingArea;
  if (place && geo.houseNumber) return `${place}, ${geo.houseNumber}`;
  if (geo.microdistrict) return geo.microdistrict;
  if (geo.livingArea) return geo.livingArea;
  return null;
}

/**
 * Дубль по адресу поймала блокировка ниже (см. DuplicatePropertyError) — несёт
 * саму найденную запись, чтобы внешний catch собрал тот же ответ 409, что и
 * раньше (existingPropertyId/existingShortId), не читая её из базы второй раз.
 */
class DuplicatePropertyError extends Error {
  constructor(public readonly duplicate: { id: string; shortId: number; title: string }) {
    super(`Похоже, такой объект уже есть: ${duplicate.title} (№${duplicate.shortId})`);
  }
}

/**
 * Гонка потерянного обновления (аудит надёжности 13.09.2026, находка 2, см.
 * Property.version в schema.prisma) — PATCH прислал version, но ни одна строка
 * с ним больше не совпала: кто-то уже записал поверх того, что читала эта форма.
 */
class PropertyConflictError extends Error {
  constructor() {
    super("Объект изменён другим пользователем, обновите страницу");
  }
}

/**
 * Ссылка на черновик, из которого создаётся объект (11.09.2026). Отдельной
 * схемой, а не полем propertyCreateSchema: черновик — свойство ЭТОГО запроса, а
 * не свойство объекта, и в общей схеме он немедленно протёк бы в PATCH и в
 * проверки, где ему делать нечего. Zod по умолчанию срезает неизвестные ключи,
 * поэтому в саму карточку draftId всё равно не попадёт.
 */
const createFromDraftSchema = z.object({
  draftId: z.guid().optional(),
  /** Обложка, выбранная тапом по плитке в мастере (StepMedia.tsx) — ключ
   *  отправки снимка, который должен стать первым фото объекта. Тем же
   *  доводом, что и draftId выше: свойство ЭТОГО запроса, не поля объекта. */
  coverUploadKey: z.string().min(8).max(128).optional(),
});

crudRouter.post("/", requireAuth, async (req, res) => {
  // A12 (владелец 02.10.2026): СБ объекты не заводит — см. propertyCreateDeniedReason.
  const createDenied = propertyCreateDeniedReason(req);
  if (createDenied) return res.status(403).json({ error: createDenied });
  const parsed = propertyCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const parsedDraftRef = createFromDraftSchema.safeParse(req.body);
  if (!parsedDraftRef.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsedDraftRef.error.flatten() });
  }
  const draftId = parsedDraftRef.data.draftId;
  const coverUploadKey = parsedDraftRef.data.coverUploadKey;
  const data = parsed.data;

  /**
   * ЗАКРЫТЫЙ ОБЪЕКТ БЕЗ РАЙОНА/АДРЕСА (владелец 14.09.2026): «только для своих»
   * требует ровно цену и продавца — район/адрес мастер больше не спрашивает
   * (propertyCreateSchema.superRefine пропускает их для offSite). Побочный эффект
   * решения — такой объект рискует остаться без адреса и не попасть ни на карту,
   * ни в подбор, ни в поиск по улице. Решение владельца: агент заводит объект,
   * СТОЯ В НЁМ — координаты телефона (см. propertyBaseSchema.lat/lng) и есть
   * координаты объекта, сервер сам достраивает остальное через ТОТ ЖЕ
   * lookupGeoPoint, которым уже пользуется GET /geo/lookup (lib/geoLookup.ts) —
   * копия логики здесь не заводится (класс дефектов из CLAUDE.md).
   *
   * Заполняем ТОЛЬКО пустое: адрес/район, введённые агентом руками, эта ветка не
   * трогает никогда. Координат нет или lookupGeoPoint ничего не нашёл — объект
   * создаётся как есть, ничего не выдумываем.
   */
  // Район, который говорит карта, сильнее выбранного в форме — см. шапку
  // lib/propertyDistrict.ts (случай «Шохмансур, улица Дехоти, 8», 20.09.2026).
  // Ставим ДО автозаполнения по точке ниже: там район дописывается только в пустое
  // поле, а здесь исправляется уже заполненное.
  const mapDistrict = await districtFromMap({ lat: data.lat, lng: data.lng, address: data.address });
  if (mapDistrict && data.districtId && data.districtId !== mapDistrict.id) {
    void logSystemError(
      "api",
      `Район объекта исправлен по карте: выбран другой, по адресу «${data.address ?? ""}» это ${mapDistrict.name} ` +
        `(${mapDistrict.source === "point" ? "точка внутри границы района" : `улица ${mapDistrict.street}`})`
    );
  }
  if (mapDistrict) data.districtId = mapDistrict.id;
  if ((!data.districtId || !data.address?.trim()) && data.lat !== undefined && data.lng !== undefined) {
    const geo = await lookupGeoPoint(data.lat, data.lng);
    if (!data.districtId && geo.district) {
      data.districtId = geo.district.id;
    }
    if (!data.address?.trim()) {
      const guessedAddress = formatGeoAddressGuess(geo);
      if (guessedAddress) {
        data.address = guessedAddress;
      }
    }
  }
  // Интейк-агент обязателен: рядовой агент — сам (он и принял продавца), руководитель
  // должен выбрать явно в форме.
  const isAgentRole = !can(req, "properties.editForeign");
  if (!isAgentRole && !data.intakeAgentId) {
    return res.status(400).json({ error: "Укажите, кто принял объект" });
  }

  /**
   * ЛИМИТ АКТИВНЫХ ОБЪЕКТОВ АГЕНТА (спецификация владельца, Этап 9: «освобождает
   * одно место из лимита активных объектов агента» по завершении). Считаем
   * объекты этого интейкера, ещё не вышедшие из конвейера подготовки — как
   * только объект попадает в продажу, место освобождается само (счёт живой,
   * отдельного «возврата» не требуется). 0 = лимит выключен (владелец пока не
   * назвал число — не выдумываем, ждём настройки).
   */
  const effectiveIntakeAgentId = isAgentRole ? req.agent!.id : data.intakeAgentId!;
  /**
   * Дыра 11.09.2026 (Пачка 1 п.9): id, присланный руководителем, никак не
   * проверялся — только собственный ввод рядового агента (он и так активный
   * сотрудник, раз прошёл requireAuth). Здесь единственное место, где
   * intakeAgentId вообще ПРИХОДИТ явно при создании.
   */
  if (!isAgentRole) {
    const error = await assignableAgentError(effectiveIntakeAgentId);
    if (error) return res.status(400).json({ error });
  }
  const settingsForLimit = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { propertyActiveLimit: true, reelsCaptionTemplates: true },
  });
  const propertyLimit = settingsForLimit?.propertyActiveLimit ?? 0;
  if (propertyLimit > 0) {
    const activeCount = await prisma.property.count({
      where: {
        intakeAgentId: effectiveIntakeAgentId,
        deletedAt: null,
        status: { in: [...PROPERTY_PIPELINE_STATUSES] },
      },
    });
    if (activeCount >= propertyLimit) {
      return res.status(409).json({
        error: `Лимит активных объектов исчерпан (${activeCount} из ${propertyLimit}) — сначала завершите подготовку текущих`,
      });
    }
  }

  // Координаты, выбранные вручную на карте, задаются только парой — одно поле без
  // второго игнорируем, чтобы не сохранить половину точки.
  const hasManualCoords = data.lat !== undefined && data.lng !== undefined;
  // Название формируется автоматически из типа/комнат/района — единый формат с сайтом.
  // Закрытый объект может остаться вовсе без района (см. геоблок выше) — district
  // тогда null, и buildPropertyTitle/generateSeoFields получают запасное имя.
  const district = data.districtId
    ? await prisma.district.findUnique({ where: { id: data.districtId }, select: { name: true } })
    : null;
  const title = buildPropertyTitle({ type: data.type, rooms: data.rooms, districtName: district?.name });
  // ИИ-описание — всегда в сомони (владелец, 16.09.2026: «у нас так много таких
  // ошибок» — siteSync.ts блокировал публикацию КАЖДОГО объекта в USD, потому
  // что seoGenerator честно писал "$40 000" в тексте по своим же правилам, а
  // гейт перед сайтом требует только сомони в описании. Раньше "$"/USD/доллар в
  // тексте означало «описание устарело после смены валюты», а стало — «объект
  // просто в USD», это подавляющее большинство случаев, не редкий сбой.
  // Цена/валюта самого объекта (property.price/currency) не трогаются — они
  // остаются в реальной валюте сделки для учёта, конвертация только для текста.
  const seoMoney = await loadMoneyContext();
  const seoPriceTjs = toTjs(data.price, data.currency, seoMoney);
  const seo = await generateSeoFields({
    type: data.type,
    rooms: data.rooms,
    areaSqm: data.areaSqm,
    floor: data.floor,
    totalFloors: data.totalFloors,
    price: seoPriceTjs,
    currency: "TJS",
    districtName: district?.name ?? "Душанбе",
    address: data.address ?? "",
    condition: data.condition,
    amenities: data.amenities,
    stage: data.stage,
    marketType: data.marketType,
    urgent: data.urgent ?? false,
  });
  // Форма больше не даёт вводить description вручную — сервер всегда генерирует его.
  // Но если description всё же пришёл (прямой вызов API в обход формы), уважаем его —
  // тот же принцип, что и на PATCH (см. ниже): не затираем явно присланное значение.
  // Ключ убираем из объекта целиком (не ставим undefined) — spread с явным
  // description:undefined после ...data всё равно перетёр бы значение из data.
  const { description: _generatedDescription, ...seoMetaOnly } = seo;
  const seoForCreate = data.description !== undefined ? seoMetaOnly : seo;

  // ПОДПИСЬ ДЛЯ REELS — сразу при создании. Начало и конец пишет Gemini заново
  // на каждый объект (владелец, 16.09.2026), факты собираются детерминированно
  // из карточки — см. ai/reelsCaptionAi.ts. Откажет ИИ — тот же текст, что и
  // раньше (шаблон), объект никогда не остаётся без подписи. Телефон в подписи —
  // интейкера: именно ему звонят по объекту, пока риелтор ещё не назначен.
  const intakeAgentForCaption = await prisma.agent.findUnique({
    where: { id: effectiveIntakeAgentId },
    select: { phone: true, fullName: true },
  });
  const reelsCaption = await generateReelsCaptionWithAi(
    reelsCaptionValuesFromProperty({
      type: data.type,
      rooms: data.rooms ?? null,
      areaSqm: data.areaSqm,
      floor: data.floor ?? null,
      totalFloors: data.totalFloors ?? null,
      price: data.price,
      currency: data.currency,
      condition: data.condition,
      stage: data.stage ?? null,
      marketType: data.marketType ?? null,
      districtName: district?.name ?? "Душанбе",
      phone: intakeAgentForCaption?.phone ?? null,
      agentName: intakeAgentForCaption?.fullName ?? null,
      address: data.address ?? "",
      documents: data.documents ?? null,
      windowCount: data.windowCount ?? null,
      details: data.details,
      landAreaSotka: data.landAreaSotka ?? null,
      amenities: data.amenities ?? null,
      // Цена в сомони рядом с долларами (владелец, 17.09.2026) — курс уже
      // получен парой строк выше для SEO-текста, второй раз не спрашиваем.
      money: seoMoney,
    }),
    settingsForLimit?.reelsCaptionTemplates
  );

  /**
   * ОБЪЕКТ БЕЗ КАРТОЧКИ ПРОДАВЦА В CRM (владелец 21.08.2026: «если продавца нет —
   * например сосед — создать его прямо при добавлении объекта»). SellerPicker на форме
   * связывает объект только с УЖЕ СУЩЕСТВУЮЩЕЙ карточкой (clientId выше) — а объект
   * нередко заводят по звонку соседа/знакомого, которого в CRM никогда не было. Если
   * агент вписал имя и телефон продавца руками (sellerName + ownerContact), а карточку
   * не выбрал, находим или заводим Client{kind: SELLER} сами — тем же способом поиска
   * «по последним 9 цифрам», что и остальная CRM (lib/clientPhones.ts), и тем же
   * минимальным набором полей, что и автосоздание клиента по звонку.
   *
   * Раньше ветка работала только для offSite-объектов — на обычном объекте агент
   * с продавцом-не-из-CRM упирался в тупик: выбрать некого, создать нельзя. Теперь
   * путь один для всех объектов; без данных продавца объект по-прежнему создаётся
   * и связывается карточкой позже.
   *
   * Поиск по хвосту НЕ ограничен kind=SELLER: человека, писавшего нам как покупатель
   * (или заведённого ботом покупателем по ошибке), раньше эта ветка не находила и
   * падала на unique(phone) при попытке создать вторую карточку с тем же номером.
   * Карточка SELLER предпочитается, но при её отсутствии связываем любую живую —
   * один человек = одна карточка (правило всей CRM), а продавец он или покупатель,
   * решает жизнь, не форма объекта.
   */
  /**
   * ВЫБРАНА КАРТОЧКА ПРОДАВЦА — «КОНТАКТ ВЛАДЕЛЬЦА» БЕРЁМ ИЗ НЕЁ, С СЕРВЕРА.
   *
   * Форма раньше копировала номер из выбранной карточки на клиенте — но агент без
   * права clients.viewPhone получает номер ЗАМАСКИРОВАННЫМ («+992•••••57»), и ровно
   * эти точки уезжали в ownerContact навсегда. Маска — для глаз агента; сама связь
   * «объект → карточка продавца» номер не раскрывает, поэтому честный телефон в
   * ownerContact кладёт сервер, у которого он есть. Пустой или замаскированный
   * ownerContact при выбранной карточке — не ошибка формы, а норма.
   */
  if (data.clientId) {
    const sellerCard = await prisma.client.findFirst({
      where: { id: data.clientId, deletedAt: null },
      select: { phone: true, assignedAgentId: true },
    });
    if (!sellerCard) return res.status(400).json({ error: "Карточка продавца не найдена" });
    if (!canBindClient(req, sellerCard)) {
      return res.status(403).json({ error: "Этот продавец закреплён за другим агентом" });
    }
    // Выбранная карточка с номером сотрудника (заведена до защиты) — та же дыра,
    // что и ручной ввод ниже: её телефон стал бы ownerContact в обход проверки.
    const staffSeller = await findStaffPhone([sellerCard.phone]);
    if (staffSeller) {
      return res.status(409).json({ error: staffPhoneError(staffSeller), code: STAFF_PHONE_ERROR_CODE });
    }
    if (!data.ownerContact?.trim() || data.ownerContact.includes("•")) {
      data.ownerContact = sellerCard.phone;
    }
  }

  /**
   * ИМЯ ПРОДАВЦА БОЛЬШЕ НЕ ОБЯЗАТЕЛЬНО ДЛЯ ПРИВЯЗКИ (владелец 09.09.2026).
   *
   * Раньше автопривязка требовала И имени, И телефона, а имя в форме
   * необязательно. Агент вписывал номер, имя оставлял пустым — карточка продавца
   * не заводилась, объект оставался непривязанным, и тревога «продавец без
   * объекта» била по добросовестному человеку. Телефон при этом обязателен всегда
   * (propertyCreateSchema), значит привязать есть по чему.
   *
   * Без имени карточка заводится с подписью-заглушкой того же вида, что и у
   * входящего звонка с неизвестного номера, — её потом поправит агент или ИИ.
   */
  const sellerNameForCard = data.sellerName?.trim() || "Собственник объекта";
  let autoSellerClientId: string | null = null;
  if (!data.clientId && data.ownerContact?.trim()) {
    const normalizedPhone = normalizeDigits(data.ownerContact.replace(/[^\d]/g, ""));
    const tail = phoneTail(normalizedPhone);
    if (tail.length === 9) {
      // Номер сотрудника в «контакте владельца» — тот самый прод-случай
      // (объекты №98/№99 на номере Маъруфа), до транзакции и без исключений:
      // см. lib/staffPhoneGuard.ts.
      const staffMatch = await findStaffPhone([normalizedPhone]);
      if (staffMatch) {
        return res.status(409).json({ error: staffPhoneError(staffMatch), code: STAFF_PHONE_ERROR_CODE });
      }
      autoSellerClientId = await prisma.$transaction(async (tx) => {
        const existing = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Client"
          WHERE "deletedAt" IS NULL
            AND right(regexp_replace("phone", '[^0-9]', '', 'g'), 9) = ${tail}
          ORDER BY ("kind" = 'SELLER') DESC, "createdAt" ASC
          LIMIT 1`;
        if (existing[0]) return existing[0].id;
        // Карточка в Корзине с тем же номером: живой поиск выше её не видит, а
        // unique(phone) не даст завести вторую. Привязка к восстановимой карточке
        // лучше, чем падение всего создания объекта (23.09.2026: было 500).
        const byExactPhone = await tx.client.findUnique({ where: { phone: normalizedPhone }, select: { id: true } });
        if (byExactPhone) return byExactPhone.id;
        const created = await tx.client.create({
          data: {
            fullName: sellerNameForCard,
            phone: normalizedPhone,
            source: "WALK_IN",
            kind: "SELLER",
            status: "NEW",
            currency: data.currency,
            /**
             * ХОЗЯИН У ЭТОЙ КАРТОЧКИ ИЗВЕСТЕН СРАЗУ — ЭТО ТОТ, КТО ПРИНЁС ОБЪЕКТ.
             *
             * Найдено 12.09.2026 владельцем на живом примере: он завёл объект,
             * вписал продавца на последнем шаге мастера — и через несколько
             * минут этот же продавец вернулся ему окном «Новый клиент ·
             * Принять / Отклонить», с историей «лид назначен утренней волной
             * распределения».
             *
             * Причина была здесь: карточка создавалась со status=NEW и БЕЗ
             * assignedAgentId, то есть выглядела ровно как ничейный лид с
             * улицы. Дальше её штатно подбирала волна разбора
             * (services/leads/reassignment.ts::assignPendingLeads —
             * `where: { assignedAgentId: null, status: { in: ["NEW", ...] } }`)
             * и раздавала агентам.
             *
             * Это не косметика: волна могла отдать продавца ДРУГОМУ агенту, и
             * тот, кто привёл объект, терял собственника своего же объекта.
             *
             * acceptedAt проставляем вместе с агентом: пустой acceptedAt — это
             * и есть признак «лид ждёт, пока его примут» (см.
             * services/leads/assignment.ts), а принимать тут нечего — агент
             * только что вписал этого человека руками.
             */
            assignedAgentId: effectiveIntakeAgentId,
            assignedAt: new Date(),
            acceptedAt: new Date(),
            // Не лид из очереди: окно «первый звонок за 15 минут» (firstCall.ts)
            // его не касается — 22.09.2026 крон отобрал так продавца у Нозы.
            assignReason: SELF_CREATED_ASSIGN_REASON,
          },
          select: { id: true },
        });
        return created.id;
      }).catch((err: unknown) => {
        // Гонка: ту же карточку только что завёл параллельный запрос. После
        // ошибки транзакция базы сорвана — любой запрос в ней падает, поэтому
        // победителя ищем уже вне её, ниже.
        if ((err as { code?: string }).code === "P2002") return null;
        throw err;
      });
      if (!autoSellerClientId) {
        const winner = await prisma.client.findUnique({ where: { phone: normalizedPhone }, select: { id: true } });
        autoSellerClientId = winner?.id ?? null;
      }
      /**
       * НАЙДЕННАЯ ПО НОМЕРУ КАРТОЧКА — ТЕ ЖЕ ПРАВА, ЧТО ЯВНЫЙ clientId (глубокая
       * проверка 02.10.2026, A7). Выше по номеру находится ЛЮБАЯ живая карточка,
       * и объект молча привязывался к продавцу другого агента, а ниже ему же
       * закрывалась автозадача «продавец без объекта». Явный clientId и смена
       * номера в PATCH (lib/propertyOwnerRelink.ts) это правило уже держали.
       * Своя карточка принявшего объект привязывается всегда — её только что
       * мог завести и сам этот запрос; ничейная (лид без агента) — тоже: отбирать
       * её не у кого, а номер агент вписал сам.
       */
      if (autoSellerClientId) {
        const card = await prisma.client.findUnique({
          where: { id: autoSellerClientId },
          select: { assignedAgentId: true },
        });
        if (card?.assignedAgentId && card.assignedAgentId !== effectiveIntakeAgentId && !canBindClient(req, card)) {
          return res.status(403).json({ error: "Этот номер у клиента другого агента — объект к нему не привязать" });
        }
      }
    }
  }

  // clientId уходит в отдельное поле sellerClientId (имя в Prisma-модели другое) —
  // spread ...rest ниже не должен нести его как есть, Prisma такого аргумента не знает.
  // sellerName — тоже не поле Property, использован только что выше для автосоздания
  // карточки продавца, дальше он Prisma не нужен и должен уйти из ...rest.
  /**
   * ДУБЛИ ПО АДРЕСУ ПРИ СОЗДАНИИ (docs/flow-audit-property-11-09.md #3, риск 4).
   * Раньше ничего не мешало завести один и тот же объект дважды — разные агенты
   * со слов одного продавца, повторный ручной ввод. Ключ — район + нормализованный
   * адрес + этаж + площадь с допуском ±2 м² (округляют по-разному при замере).
   * ?force=true обходит проверку, но только для руководителя (properties.editForeign):
   * «соседний подъезд с тем же названием улицы» — реальный случай, не выдумка.
   */
  /**
   * ГОНКА ПРИ СОЗДАНИИ (аудит надёжности 13.09.2026, находка 3). Проверка дубля
   * ниже раньше была обычным findMany, а create() — отдельным, ничем не
   * связанным вызовом секундами позже: два почти одновременных запроса на один
   * и тот же реальный объект (два агента со слов одного продавца) оба читали
   * «дублей нет» ДО того, как второй из них успевал закоммититься, и оба
   * создавали карточку. Уникального ограничения тут не поставить — «дубль»
   * нечёткий (адрес + допуск ±2 м² по площади), поэтому вместо него —
   * `pg_advisory_xact_lock`: блокировка по ключу район+этаж+адрес, снятая сама
   * при коммите/откате транзакции. Второй запрос с тем же ключом ждёт коммита
   * первого и уже СВОИМ findMany (внутри той же транзакции, после снятия
   * блокировки) видит его свежую строку — гонки между чтением и записью не
   * остаётся. `force=true` (properties.editForeign) по-прежнему обходит только
   * сам ОТКАЗ по дублю, не блокировку: два force-запроса всё равно сериализуются,
   * просто оба проходят проверку.
   */
  const normalizedAddress = data.address ? normalizePropertyAddress(data.address) : "";
  // Вынесено ИЗ транзакции ниже: sellerClientId нужен и ПОСЛЕ неё (закрытие
  // договорённости продавца чуть дальше по файлу), а переменная, объявленная
  // внутри async-колбэка $transaction, наружу не видна (та же ловушка, что и
  // priceActuallyChanged в PATCH — см. комментарий там).
  const { clientId: sellerClientId, sellerName: _sellerName, ...rest } = data;
  let property = await prisma.$transaction(async (tx) => {
    if (normalizedAddress) {
      const lockKey = `property-dup:${data.districtId}:${data.floor ?? "null"}:${normalizedAddress}`;
      // $executeRaw, НЕ $queryRaw (проверено прогоном тестов, 13.09.2026):
      // pg_advisory_xact_lock возвращает void, а драйверный адаптер Prisma 7
      // (@prisma/adapter-pg) не умеет десериализовать колонку типа void через
      // $queryRaw — падает `DriverAdapterError: UnsupportedNativeDataType`
      // внутри транзакции, и запрос виснет до таймаута теста (P2010, "Failed to
      // deserialize column of type 'void'"). $executeRaw результат не
      // разбирает вовсе (возвращает только число задетых строк) — это ровно тот
      // случай, для которого он существует: SQL ради побочного эффекта, а не
      // ради значения.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

      // Потолок выборки внутри транзакции с advisory-lock (22.09.2026, класс
      // «Пагинация») — смысл проверки не меняется, только защита от неограниченного
      // сканирования: один район+этаж реалистично не набирает тысяч активных
      // объектов, и в норме этот предел не задевается. Если задет — проверка на
      // дубль честно проходит только по первым PROPERTY_DUP_SCAN_CAP, а не молча
      // читает всё; аномалия уходит в журнал ошибок, а не тонет в тишине.
      const sameDistrictFloor = await tx.property.findMany({
        where: { deletedAt: null, districtId: data.districtId, floor: data.floor ?? null },
        select: { id: true, shortId: true, title: true, address: true, areaSqm: true },
        take: PROPERTY_DUP_SCAN_CAP,
      });
      if (sameDistrictFloor.length >= PROPERTY_DUP_SCAN_CAP) {
        void logSystemError(
          "api",
          `Проверка дублей объекта: в районе/этаже больше ${PROPERTY_DUP_SCAN_CAP} активных объектов — сверка прошла по первым ${PROPERTY_DUP_SCAN_CAP}`
        );
      }
      const duplicate = sameDistrictFloor.find(
        (p) =>
          p.address &&
          normalizePropertyAddress(p.address) === normalizedAddress &&
          Math.abs(Number(p.areaSqm) - data.areaSqm) <= 2
      );
      if (duplicate && !(req.query.force === "true" && can(req, "properties.editForeign"))) {
        throw new DuplicatePropertyError(duplicate);
      }
    }

    // ПОВТОР ЗАПРОСА БЕЗ АДРЕСА (находка №193). Закрытый объект («только для
    // своих») может не иметь адреса, и проверка выше его пропускает: сетевой
    // повтор или повтор из офлайн-очереди без Idempotency-Key создавал вторую
    // такую же карточку. Ключ повтора — тот же человек, те же параметры и тот же
    // собственник за последние две минуты; блокировка по человеку и собственнику
    // не даёт двум одновременным повторам пройти оба. Руководитель может
    // обойти проверку тем же ?force=true, что и дубль по адресу.
    if (!normalizedAddress) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`property-repeat:${req.agent!.id}:${phoneTail(data.ownerContact ?? "")}`}))`;
      const repeat = await tx.property.findFirst({
        where: {
          deletedAt: null,
          createdById: req.agent!.id,
          createdAt: { gte: new Date(Date.now() - PROPERTY_REPEAT_WINDOW_MS) },
          canonicalAddress: "",
          type: data.type,
          price: data.price,
          currency: data.currency,
          areaSqm: data.areaSqm,
          rooms: data.rooms ?? null,
          floor: data.floor ?? null,
          ownerContact: data.ownerContact ?? null,
          offSite: data.offSite ?? false,
        },
        select: { id: true, shortId: true, title: true },
        orderBy: { createdAt: "desc" },
      });
      if (repeat && !(req.query.force === "true" && can(req, "properties.editForeign"))) {
        throw new DuplicatePropertyError(repeat);
      }
    }

    return tx.property.create({
      data: {
        ...rest,
        title,
        // Канонный адрес — считается один раз при сохранении (см. комментарий у
        // normalizePropertyAddress) и используется точным равенством в проверке
        // «этот адрес уже заведён» на шаге «Где» (routes/properties/duplicateCheck.ts).
        canonicalAddress: normalizedAddress,
        sellerClientId: sellerClientId ?? autoSellerClientId ?? null,
        ...seoForCreate,
        reelsCaption,
        // НОВЫЙ ОБЪЕКТ НЕ В ПРОДАЖЕ (решение владельца 02.08.2026). Он входит в
        // конвейер подготовки: проверка карточки → фото → видео → монтаж. Последний
        // этап — монтажёр публикует видео-обзор в Instagram и вставляет ссылку в
        // карточку; только после этого объект выходит в продажу.
        //
        // ИСКЛЮЧЕНИЕ — НЕСАЙТОВЫЙ ОБЪЕКТ (offSite, решение владельца 18.08.2026,
        // docs/plan-18-08-private-listings-and-video.md §1). Он никогда не идёт на сайт
        // и не проходит модерацию видео с монтажом — сам конвейер существует ради
        // публикации, а публикации не будет.
        //
        // НО ФОТОГРАФИИ ЕМУ ВСЁ РАВНО НУЖНЫ (владелец 09.09.2026). Раньше такой объект
        // создавался сразу в AVAILABLE и мог стоять «в продаже» с нулём снимков: пока
        // подбор его не видел, это было терпимо — нашёл бы его только тот агент,
        // который сам же и завёл. Теперь подбор его предлагает (lib/propertyMatchFilter.ts),
        // и без этого шага он начал бы рассылать пустые карточки в ту же секунду, как
        // их заводят. Поэтому offSite проходит ОДИН этап конвейера — «ожидает фото», —
        // и выходит в продажу сам, как только снимков станет шесть
        // (routes/properties/photos.ts). Модерация, видео и монтаж его по-прежнему
        // не касаются.
        //
        // Форма создания статус не спрашивает вовсе (его нет в propertyCreateSchema),
        // поэтому других исключений здесь нет и быть не может. Перенос старых
        // объявлений идёт мимо этого маршрута — прямой записью в базу, где умолчание
        // колонки AVAILABLE.
        //
        // НАХОДКА 12.09.2026 (сквозной тест добавления объекта на проде): здесь стояло
        // безусловное PENDING_REVIEW для сайтового объекта, хотя фотографии в этот
        // момент ещё физически не существуют — они приезжают из черновика ЧЕРЕЗ
        // attachDraftToProperty НИЖЕ, уже после этой записи (см. draftId). На проде
        // это давало два объекта с нулём фото в очереди проверки маркетинга,
        // просроченных на 7 и 17 дней, а стадия «Ждут фото» показывала 0 — смотреть
        // там было нечего, хотя объекты без единого снимка реально существовали.
        // Здесь фотографий заведомо ещё нет ни у offSite, ни у обычного объекта —
        // ставим AWAITING_PHOTOS всегда. Обычный объект (не offSite) переводится в
        // PENDING_REVIEW сразу после переноса файлов черновика, КОГДА уже известно,
        // сколько снимков реально доехало (см. блок attachDraftToProperty ниже).
        status: "AWAITING_PHOTOS",
        offSite: data.offSite ?? false,
        // Риелтор (assignedAgentId) при создании НЕ назначается — он появится
        // автоматически в момент сделки (агент клиента, выбравшего объект).
        // Интейк-агента рядовой агент не выбирает — им становится он сам.
        intakeAgentId: isAgentRole ? req.agent!.id : data.intakeAgentId!,
        createdById: req.agent!.id,
        // geocodedAt — отметка АВТОГЕОКОДЕРА, а не «когда появились координаты»:
        // ручной пин обязан оставлять её пустой, иначе фоновый джоб его затрёт
        // (см. jobs/geocode.ts, условие OR: [{ lat: null }, { geocodedAt: { not: null } }]).
        //
        // Раньше здесь было исключение: адрес, достроенный сервером ПО ТОЧКЕ,
        // ставил отметку «не человек» на саму точку (23.09.2026, пункт 11 Nur:
        // «точка на карте сбивается»). Достроен адрес, а точку поставил агент, и
        // первая же загрузка фото после создания (routes/properties/photos.ts)
        // переносила её на координаты из снимка: условие там то же, что у
        // джоба. Точка из запроса всегда принадлежит человеку.
        ...(hasManualCoords ? { geocodedAt: null } : {}),
      },
      include: { district: true, photos: true },
    });
  }).catch((err) => {
    if (err instanceof DuplicatePropertyError) {
      res.status(409).json({
        error: err.message,
        existingPropertyId: err.duplicate.id,
        existingShortId: err.duplicate.shortId,
      });
      return null;
    }
    throw err;
  });
  if (!property) return;

  /**
   * ПОДВАЛ ПОДПИСИ — ПОСЛЕ СОЗДАНИЯ, А НЕ ДО (23.09.2026). Номер объекта
   * присваивает база, и до этой строки его не существует: подпись собрана выше
   * без него. Дописываем подвал одним обновлением — генерацию не повторяем, у
   * неё платный вызов модели.
   */
  const captionWithFooter = withPostFooter(property.reelsCaption ?? "", property.shortId);
  property = await prisma.property.update({
    where: { id: property.id },
    data: { reelsCaption: captionWithFooter },
    include: { district: true, photos: true },
  });

  /**
   * КТО ЗАВЁЛ КАРТОЧКУ — В ЖУРНАЛ ДЕЙСТВИЙ (12.09.2026). Раньше здесь записи не
   * было, хотя правка, удаление и восстановление объекта её пишут. Автор
   * восстанавливался только по полям самой карточки (`createdById`/`createdAt`),
   * а они исчезают вместе с ней: после удаления навсегда в журнале оставалась
   * запись «удалил такой-то», и ни одной — «завёл такой-то». Журнал обязан
   * переживать сущность, иначе спор о том, чей это был объект, разбирать нечем.
   */
  // «Добавьте объект по заявке…» (lib/dealStalePipeline.ts) — повод исчез, у
  // продавца появился объект (21.09.2026, lib/autoTasks.ts).
  if (property.sellerClientId) {
    void closeAutoTasks(property.sellerClientId, ["deal_stale_seller_add_property"]).catch((err) =>
      console.error("[объект] автозакрытие «добавьте объект»:", err instanceof Error ? err.message : err)
    );
  }

  logAudit(req, "PROPERTY_CREATED", "Property", property.id, {
    shortId: property.shortId,
    title: property.title,
    address: property.address,
    status: property.status,
    offSite: property.offSite,
    intakeAgentId: property.intakeAgentId,
  });

  /**
   * ФАЙЛЫ ЧЕРНОВИКА ПЕРЕЕЗЖАЮТ В КАРТОЧКУ (11.09.2026). Снимки и ролики агент
   * отдал ещё на первом шаге мастера, пока заполнял остальные, — они уже лежат на
   * диске в готовом виде, и переезд создаёт только строки (см.
   * routes/properties/draftAttach.ts). Черновик после этого удаляется той же
   * транзакцией: оставить его значило бы предложить агенту при следующем заходе
   * «продолжить» с уже перенесёнными файлами и залить их второй раз.
   *
   * Ответ отдаём с актуальным списком фотографий: без этого карточка открывалась
   * бы пустой ровно до следующего обновления, хотя снимки уже на месте.
   */
  /**
   * ЧЕСТНЫЙ ОТЧЁТ О ФАЙЛАХ МАСТЕРА (07.10.2026): сколько файлов доехало и сколько
   * нет. Клиент показывает «не дошло N файлов — добавьте в карточке» вместо
   * молчаливого успеха. Поле необязательное и только прибавляется к прежнему
   * ответу — старые клиенты его просто не читают. Есть только когда пришёл draftId.
   */
  let mediaReport: {
    attached: { photos: number; videos: number };
    skipped: { photos: number; videos: number };
    error?: string;
  } | null = null;
  if (draftId) {
    const attached = await attachDraftToProperty(draftId, req.agent!.id, property, req.agent!.id, coverUploadKey);
    mediaReport = {
      attached: { photos: attached.photos, videos: attached.videos },
      skipped: { photos: attached.skippedPhotos, videos: attached.skippedVideos },
      ...(attached.reason === "error" || attached.reason === "not-found" || attached.reason === "foreign"
        ? {
            error:
              attached.reason === "error"
                ? "Файлы из мастера не удалось перенести — добавьте их в карточке объекта"
                : "Черновик с файлами не найден — добавьте фото и видео в карточке объекта",
          }
        : {}),
    };
    if (attached.photos > 0) {
      property.photos = await prisma.propertyPhoto.findMany({
        where: { propertyId: property.id },
        orderBy: { order: "asc" },
      });
      /**
       * СТАТУС ПО ФАКТУ, А НЕ ПО НАМЕРЕНИЮ (находка 12.09.2026, см. комментарий у
       * status при create() выше). Ровно здесь, а не раньше — потому что раньше
       * фотографий из черновика ещё нет ни строкой: они появляются только что,
       * переездом файлов (attachDraftToProperty). Отдельным update, а не в той же
       * транзакции — сам переезд уже закоммитился своей транзакцией (и никогда не
       * бросает, см. комментарий в draftAttach.ts), досчитывать статус можно и
       * нужно только после того, как переезд подтверждён.
       *
       * offSite сюда сознательно не заходит: у него «ждут фото» — не промежуточный
       * шаг перед проверкой, а весь конвейер целиком (объект никогда не идёт на
       * PENDING_REVIEW, в AVAILABLE его переводит routes/properties/photos.ts при
       * шести снимках) — проверка property.offSite ниже это и защищает.
       */
      if (!property.offSite && property.status === "AWAITING_PHOTOS") {
        property.status = "PENDING_REVIEW";
        await prisma.property.update({ where: { id: property.id }, data: { status: "PENDING_REVIEW" } });
      } else if (property.offSite && property.status === "AWAITING_PHOTOS" && property.photos.length >= MIN_PROPERTY_PHOTOS) {
        // Закрытый объект с фото из мастера (23.09.2026). Раньше он навсегда
        // оставался «Ждут фото»: в продажу его переводит только ДОЗАГРУЗКА на
        // карточку (routes/properties/photos.ts), а фото из черновика приезжают
        // переездом файлов, мимо неё. Подбор (status AVAILABLE) его не видел.
        property.status = "AVAILABLE";
        await prisma.property.update({
          where: { id: property.id },
          data: { status: "AVAILABLE", stageEnteredAt: new Date() },
        });
      }
    }
  }

  // Ручной выбор точнее автоугадывания — при нём фоновый геокодер не трогаем.
  // Закрытый объект без адреса (см. геоблок выше) форвард-геокодировать нечем —
  // координат ждать неоткуда, пропускаем без ошибки. Район не обязателен
  // (24.09.2026): задание ищет по адресу и само дописывает район в пустое поле.
  if (!hasManualCoords && property.address) {
    geocodeInBackground(property.id);
  }
  // СЕМАНТИЧЕСКИЙ ВЕКТОР — фоново, не блокируя ответ на создание карточки (та же
  // философия, что у geocodeInBackground выше). embedAndSaveProperty никогда не
  // бросает: отказ Gemini не должен ронять создание объекта.
  void embedAndSaveProperty(property.id);
  /* Здесь закрывалась договорённость «Объект принят» — механизм обязательных
     окон удалён 13.09.2026, закрывать нечего. Сама привязка объекта к продавцу
     (sellerClientId) выше не изменилась. */
  // Royal Score: «Объект добавлен» — таблица владельца, п. 18. intakeAgentId уже
  // обязателен на этой ветке (проверка выше), sourceId = id объекта защищает от
  // повторного начисления, если создание вызовут второй раз с тем же id (не бывает
  // в норме, но правило Fair Play «одно действие — одни баллы» безусловное).
  {
    const points = await loadEventPoints();
    recordScoreEvent({
      agentId: property.intakeAgentId!,
      kind: "property_added",
      delta: points.property_added,
      reason: `Объект добавлен: ${property.title}`,
      sourceId: property.id,
    });
  }
  // Новый объект всегда попадает на проверку маркетинга/директора/админа — то есть
  // всем с правом properties.moderate (то же право, что даёт кнопку «Одобрить»).
  // Раньше об этом никто не узнавал, пока не заглянет в список сам.
  if (property.status === "PENDING_REVIEW") {
    void notifyPendingReview(property.id, property.shortId, property.title).catch((err) =>
      console.error("[push] новый объект на проверку:", err)
    );
  }
  // Несайтовый объект создаётся сразу в AVAILABLE, минуя конвейер (см. status выше) —
  // единственное место создания, где карточка может стать AVAILABLE в этот же запрос.
  if (property.status === "AVAILABLE") {
    void notifyWaitingBuyersOfNewProperty(property).catch((err) =>
      console.error("[автоподбор] новый объект создан сразу в продаже:", err instanceof Error ? err.message : err)
    );
  }

  // Автопубликации у объекта в конвейере нет: пока не сняли видео, публиковать
  // нечего, и попытка кончилась бы отказом сайта на каждом созданном объекте.
  //
  // НЕСАЙТОВЫЙ ОБЪЕКТ (offSite) СЮДА НЕ ПОПАДАЕТ НИКОГДА — тот же инвариант, что и
  // в bulk-sync/siteSync.ts: он выходит в AVAILABLE в обход конвейера (см. выше), но
  // это не значит «готов к публикации», это значит «публикации не будет вовсе».
  if (isPipelineStatus(property.status) || property.offSite) {
    publishPropertyUpdated({ propertyId: property.id, agentId: property.assignedAgentId, stage: property.status, actorId: req.agent!.id });
    return res.status(201).json({ ...presentProperty(property, req), ...(mediaReport ? { media: mediaReport } : {}) });
  }

  // Автопубликация сразу при создании — по решению директора. Best-effort и молча:
  // у свежесозданного объекта обычно ещё нет фото (их грузят отдельным запросом
  // следом) или цена/валюта не финализирована — syncPropertiesToSite сам откажет
  // публикацию в таком случае (см. проверки там), это ожидаемо, а не ошибка.
  // Агент просто нажмёт «Опубликовать» вручную позже, когда объект будет готов.
  void syncPropertiesToSite([property], "publish")
    .then((result) => {
      if (!result.ok) return;
      const failed = result.results.find((r) => !r.ok);
      if (!failed) {
        return prisma.property.update({ where: { id: property.id }, data: { publishedOnSite: true } });
      }
    })
    .catch((err) => console.error(`[siteSync] Автопубликация объекта ${property.id}:`, err instanceof Error ? err.message : err));
  publishPropertyUpdated({ propertyId: property.id, agentId: property.assignedAgentId, stage: property.status, actorId: req.agent!.id });
  res.status(201).json({ ...presentProperty(property, req), ...(mediaReport ? { media: mediaReport } : {}) });
});

crudRouter.patch("/:id", requireAuth, async (req, res) => {
  const parsed = propertyUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const existing = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.deletedAt) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, existing)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  // Поля, которых у типа нет (этаж у дома, «новостройка» у участка), не
  // сохраняются, а при смене типа очищаются (владелец 08.10.2026,
  // packages/shared/src/propertyTypeFields.ts).
  parsed.data = normalizePropertyPatchForType(parsed.data, existing);
  // Этаж не выше этажности — сверяем с тем, что уже лежит в карточке: правка
  // одного этажа без этажности иначе прошла бы мимо проверки схемы.
  const floorError = propertyFieldShown(parsed.data.type ?? existing.type, "floor") && floorRuleError(
    parsed.data.floor !== undefined ? parsed.data.floor : existing.floor,
    parsed.data.totalFloors !== undefined ? parsed.data.totalFloors : existing.totalFloors
  );
  if (floorError) {
    return res.status(400).json({ error: floorError, details: { formErrors: [], fieldErrors: { floor: [floorError] } } });
  }

  /**
   * ЧТО РЕАЛЬНО МЕНЯЕТСЯ (23.09.2026). Форма шлёт карточку целиком, поэтому и
   * замок, и хронология, и платный пересчёт SEO смотрят на этот список, а не на
   * «поле пришло в запросе». version — служебное поле запроса, не колонка.
   * clientId — тоже не колонка (см. ниже, где он снимается), иначе он попадал
   * бы в список «изменилось» и включал замок монтажа на пустом месте.
   */
  const changedFields = changedPropertyFields(
    Object.fromEntries(Object.entries(parsed.data).filter(([k]) => k !== "version" && k !== "clientId")),
    existing as unknown as Record<string, unknown>
  );

  // ЦЕНА ПРОДАННОГО ОБЪЕКТА — ТОЛЬКО РУКОВОДСТВУ (глубокая проверка 02.10.2026,
  // D12). Выгрузка бухгалтерии (routes/expenses.ts) берёт soldPrice ?? price и
  // валюту объекта: агент, поправивший их после закрытия сделки, менял сумму в
  // отчёте, а сделка оставалась прежней. Правка руководителя попадает в журнал
  // изменений карточки тем же путём, что и остальные поля.
  if (
    existing.status === "SOLD" &&
    changedFields.some((f) => f === "soldPrice" || f === "currency" || f === "price") &&
    !can(req, "properties.editForeign")
  ) {
    return res.status(403).json({ error: "Цену и валюту проданного объекта исправляет руководитель" });
  }

  // ЗАМОК ПОСЛЕ ПУБЛИКАЦИИ (владелец 07.10.2026, правило — @royal-home/shared
  // propertyEditLocked): агент не меняет опубликованный объект, кроме статуса
  // (зарезервирован / продан / снят) — остальное через заявку директору или
  // админу. На проверке и на монтаже правка открыта, а монтажёр и модератор
  // получают уведомление «было → стало» (lib/propertyEditNotify.ts ниже).
  if (changedFields.some((f) => !(PROPERTY_FIELDS_OPEN_AFTER_PUBLISH as readonly string[]).includes(f))) {
    const lock = propertyEditLockBody(req, existing);
    if (lock) return res.status(409).json(lock);
  }

  /**
   * ДО ОДОБРЕНИЯ ССЫЛКУ НА РОЛИК АГЕНТ НЕ ВСТАВЛЯЕТ (23.09.2026, аудит к
   * стабильной версии, правило — @royal-home/shared agentReelLinkClosed).
   * Ссылка — пропуск в продажу (blockersForSale ниже): агент вписывал любую
   * ссылку на проверке или на этапе фото и уводил объект в продажу мимо
   * монтажа. С «Ждём видео» ссылку вставляет сам агент, как и было.
   */
  if (
    changedFields.includes("instagramUrl") &&
    agentReelLinkClosed(existing.status, can(req, "properties.editForeign") || can(req, "properties.moderate"))
  ) {
    return res.status(403).json({
      error: "Ссылку на ролик можно вставить после одобрения объекта.",
    });
  }

  // «Продано»/«Снято» вручную с открытой сделкой — рассинхронизация: объект уходит из
  // продажи, а сделка остаётся висеть на CONTRACT_SIGNED/NEGOTIATION/... и никогда не
  // попадёт в завершённые/отменённые (и в комиссию). Правильный путь — завершить или
  // отменить саму сделку (см. PATCH /deals/:id), она сама переставит статус объекта.
  //
  // RESERVED → AVAILABLE — тот же случай (глубокая проверка 02.10.2026, D11):
  // резерв держит живая сделка, снятый руками он выставлял объект «в продажу»
  // второму покупателю, а сделка первого висела. Снимает резерв отмена сделки.
  if (
    parsed.data.status !== undefined &&
    parsed.data.status !== existing.status &&
    (["SOLD", "WITHDRAWN"].includes(parsed.data.status) ||
      (existing.status === "RESERVED" && parsed.data.status === "AVAILABLE"))
  ) {
    const activeDeal = await prisma.deal.findFirst({
      where: { propertyId: existing.id, stage: { notIn: ["COMPLETED", "CANCELLED"] } },
      select: { id: true },
    });
    if (activeDeal) {
      return res.status(409).json({
        error: "У объекта есть открытая сделка — завершите или отмените её, статус объекта обновится сам",
      });
    }
  }

  /**
   * ПЕРЕХОДЫ, КОТОРЫХ НЕТ НИ В ОДНОЙ ТАБЛИЦЕ (находка №182). Раньше их отсекал
   * только список статусов на экране: прямой PATCH ставил «Резерв»/«Продано» без
   * сделки и возвращал объект из продажи в любой этап подготовки. Правила — в
   * lib/propertyStatusTransitions.ts, право на шаг конвейера проверяется ниже.
   */
  if (parsed.data.status !== undefined && parsed.data.status !== existing.status) {
    const block = propertyStatusTransitionBlock(existing.status, parsed.data.status, can(req, "properties.moderate"));
    if (block) return res.status(block.status).json({ error: block.error });
    // «Резерв»/«Продано» ставит сделка. Руками — только если сделка под этим
    // статусом уже есть (резерв — живая, «Продано» — завершённая).
    const dealNeeded = dealStageForManualStatus(parsed.data.status);
    if (dealNeeded) {
      const deal = await prisma.deal.findFirst({
        where: {
          propertyId: existing.id,
          ...(dealNeeded === "SOLD" ? { stage: "COMPLETED" } : { stage: { notIn: ["COMPLETED", "CANCELLED"] } }),
        },
        select: { id: true },
      });
      if (!deal) {
        return res.status(409).json({
          error: "Резерв и продажу оформляет сделка: заведите её, статус объекта обновится сам.",
        });
      }
    }
  }

  /**
   * КОНВЕЙЕР ДВИГАЕТ МАРКЕТИНГ, А НЕ ТОТ, КТО ЗАВЁЛ ОБЪЕКТ (дыра 16.08.2026).
   *
   * Кнопки «Одобрить»/«Запросить новые» закрыты правом properties.moderate, но
   * этот PATCH их обходил: агенту хватало выбрать «Монтаж» в списке статусов —
   * объект уходил мимо проверки маркетинга целиком, а монтажёр получал пуш
   * «фото и видео одобрены» про материалы, которых никто не видел.
   *
   * Что остаётся агенту, описано один раз в @royal-home/shared
   * (PROPERTY_AGENT_TRANSITIONS): вернуть объект на проверку после доработки,
   * закрыть монтаж выходом в продажу и снять объект с продажи. Проверяем ЯВНЫЙ
   * статус из запроса: автовозврат по видео и автопубликация из монтажа ниже —
   * решения сервера, и они укладываются в те же разрешённые переходы.
   */
  if (
    parsed.data.status !== undefined &&
    requiresPropertyModeration(existing.status, parsed.data.status) &&
    !can(req, "properties.moderate")
  ) {
    return res.status(403).json({
      error:
        "Этот шаг конвейера — за маркетингом: объект двигают кнопки «Одобрить» и «Запросить новые материалы».",
    });
  }

  // ВЫХОД ИЗ КОНВЕЙЕРА ПОДГОТОВКИ. Последний этап — монтажёр публикует видео-обзор
  // в Instagram и вставляет ссылку в карточку (решение владельца 02.08.2026). Пока
  // ссылки нет, объект в продажу не выходит: именно на этом шаге работа и обрывалась
  // чаще всего, а карточка при этом уже считалась готовой.
  //
  // Проверяем ТОЛЬКО переход из конвейера: объект, который уже был в продаже, этому
  // требованию не подчиняется — отменённая сделка возвращает статус AVAILABLE, и
  // старая карточка без ссылки не должна блокировать отмену сделки.
  //
  // WITHDRAWN — тоже вход в продажу «с нуля», а не «уже был в продаже»: он нарочно
  // не входит в isPipelineStatus (это не этап подготовки), но собственник мог снять
  // объект давно, фото/ссылка с тех пор протухли или вовсе не собирались — находка
  // 13.09.2026, без этой строки возврат из WITHDRAWN пропускал проверку готовности
  // целиком (см. requiresPropertyModeration выше — та же дыра была и в праве).
  if (parsed.data.status === "AVAILABLE" && (isPipelineStatus(existing.status) || existing.status === "WITHDRAWN")) {
    const photoCount = await prisma.propertyPhoto.count({ where: { propertyId: existing.id } });
    const instagramUrl =
      parsed.data.instagramUrl !== undefined ? parsed.data.instagramUrl : existing.instagramUrl;
    const blockers = blockersForSale({ instagramUrl, photoCount });
    if (blockers.length > 0) {
      return res.status(409).json({
        error: `Объект не готов к продаже: ${blockers.join(", ")}. Последний шаг подготовки — видео-обзор в Instagram и ссылка на него в карточке.`,
      });
    }
  }

  // Обратный переход из SOLD запрещён, если по объекту уже есть ЗАКРЫТАЯ сделка.
  // Иначе объект возвращался в продажу, по нему заводилась вторая сделка, её тоже
  // закрывали — и комиссия по одному и тому же объекту попадала в отчёты дважды.
  if (
    parsed.data.status !== undefined &&
    existing.status === "SOLD" &&
    parsed.data.status !== "SOLD"
  ) {
    const completed = await prisma.deal.count({
      where: { propertyId: existing.id, stage: "COMPLETED" },
    });
    if (completed > 0) {
      return res.status(409).json({
        error:
          "Объект продан по закрытой сделке — вернуть его в продажу нельзя. " +
          "Если сделка была ошибочной, заведите объект заново или обратитесь к директору.",
      });
    }
  }

  /**
   * clientId — поле ТОЛЬКО создания (ночная проверка 24.09.2026): в POST выше связь
   * с карточкой продавца уходит в колонку sellerClientId, а колонки clientId у
   * Property нет. propertyUpdateSchema наследует поле из propertyBaseSchema, и
   * PATCH с clientId в теле доезжал до Prisma как есть — 500 вместо ответа.
   * Снимаем его здесь, там же, где ниже снимается version; на связь с продавцом
   * PATCH никогда не влиял, так что поведение не меняется — только код ответа.
   */
  const { clientId: _sellerClientId, ...data } = parsed.data;

  // Скрытый номер владельца форма получает пустым и шлёт обратно `null` — правка
  // этажа стирала номер собственника у того, кому он не показан (аудит 23.09.2026,
  // №31). Кому номер скрыт, тот его и не меняет: поле отбрасывается целиком.
  if (data.ownerContact !== undefined && stripOwnerContact(existing, req.agent!.id, can(req, "properties.viewOwners")).ownerContactHidden) {
    delete data.ownerContact;
  }

  if (data.ownerContact?.trim() && phoneTail(data.ownerContact) !== phoneTail(existing.ownerContact ?? "")) {
    // Тот же запрет, что и на создании (см. lib/staffPhoneGuard.ts) — объекты
    // №41/№44 на проде получили номер сотрудника в контакт владельца именно
    // правкой, а не только при заведении объекта. Неизменённый контакт не
    // проверяем: форма шлёт ownerContact всегда, и те же №41/№44 иначе нельзя
    // было бы поправить ни в одном поле.
    const staffMatch = await findStaffPhone([data.ownerContact]);
    if (staffMatch) {
      return res.status(409).json({ error: staffPhoneError(staffMatch), code: STAFF_PHONE_ERROR_CODE });
    }
  }

  // Новый номер собственника — карточка продавца следует за ним (24.09.2026,
  // lib/propertyOwnerRelink.ts): имя и номер в «Кто ведёт объект» от одного человека.
  const ownerPhonePlan: OwnerPhonePlan = data.ownerContact?.trim()
    ? await planOwnerPhoneChange(req, existing, data.ownerContact)
    : { kind: "none" };
  if (ownerPhonePlan.kind === "error") {
    return res.status(ownerPhonePlan.status).json({ error: ownerPhonePlan.error });
  }

  /**
   * КТО ПРИНЯЛ ОБЪЕКТ — МЕНЯЕТ ТОЛЬКО РУКОВОДСТВО.
   *
   * Схема правки собрана как «create.partial()», поэтому в неё попал и intakeAgentId,
   * а проверок на него не было ни одной. Отчёт по агентам считает долю за приём
   * объекта по ЖИВОМУ полю карточки: агенту, закрывшему сделку (он становится
   * ответственным и потому проходит canManageProperty), достаточно было прислать
   * PATCH с собственным id — и доля за приём перетекала к нему с коллеги, без следа
   * и без отказа. Молча игнорировать поле честнее, чем отвергать всю правку: форма
   * шлёт карточку целиком, и агент, поправивший этаж, не виноват.
   */
  // С 02.10.2026 (владелец, «да, по советам») — editForeign мало: маркетинг и
  // монтажёр правят чужие карточки, но приёмщика и ведущего не меняют. См.
  // canReassignPropertyAgents. Поле так же молча игнорируется.
  if (data.intakeAgentId !== undefined && data.intakeAgentId !== existing.intakeAgentId) {
    if (!canReassignPropertyAgents(req)) {
      delete data.intakeAgentId;
    } else {
      // Дыра 11.09.2026 (Пачка 1 п.9): значение, присланное руководителем, не
      // проверялось вовсе — карточка могла закрепить ответственным уволенного.
      const error = data.intakeAgentId ? await assignableAgentError(data.intakeAgentId) : null;
      if (error) return res.status(400).json({ error });
      logAudit(req, "PROPERTY_INTAKE_CHANGED", "Property", existing.id, {
        was: existing.intakeAgentId,
        becomes: data.intakeAgentId,
      });
    }
  }

  /**
   * КТО ВЕДЁТ СДЕЛКУ (assignedAgentId) — МЕНЯЕТ ТОЛЬКО РУКОВОДСТВО (дыра
   * 11.09.2026, Пачка 1 п.8 — доп. к обследованию 11.09: «любой агент с
   * доступом к объекту может PATCH {assignedAgentId: <себя>} и перехватить
   * «ведёт сделку»).
   *
   * Раньше это резал отдельный ранний гейт (`canAccessAssignedProperty(req,
   * parsed.data.assignedAgentId ?? existing.assignedAgentId ?? req.agent!.id)`),
   * но он сверял право доступа с НОВЫМ значением поля: агент с доступом к
   * объекту (интейкер/риелтор/создатель — их пускает canManageProperty выше)
   * присылал PATCH `{assignedAgentId: <себя>}`, `req.agent.id` совпадал с
   * ПРИСЫЛАЕМЫМ значением — проверка проходила сама на себя, и самоназначение
   * не отличалось от смены поля на чьё угодно другое. Симметрично intakeAgentId
   * выше: без `properties.editForeign` поле молча игнорируется (форма шлёт
   * карточку целиком, агент, поправивший этаж, не виноват), самоназначение
   * запрещено так же, как и назначение коллеги.
   */
  if (data.assignedAgentId !== undefined && data.assignedAgentId !== existing.assignedAgentId) {
    if (!canReassignPropertyAgents(req)) {
      delete data.assignedAgentId;
    } else if (data.assignedAgentId) {
      // Дыра 11.09.2026 (Пачка 1 п.9): та же проверка, что у intakeAgentId выше —
      // риелтором сделки не может стать уволенный, замороженный или не-агент.
      const error = await assignableAgentError(data.assignedAgentId);
      if (error) return res.status(400).json({ error });
    }
  }

  // АВТОВОЗВРАТ «ВИДЕО» ЖИВЁТ НЕ ЗДЕСЬ (владелец 17.08.2026). Раньше объект
  // возвращала на проверку вставка ссылки на Instagram — но на этапе «Ждём видео»
  // ждут не ссылку, а новые сырые ролики агента; ссылку делает монтажёр двумя
  // этапами позже. Теперь возврат привязан к самой загрузке видео
  // (lib/propertyPipeline.ts::revertToReviewAfterVideoUpload), симметрично фото.

  /**
   * АВТОПУБЛИКАЦИЯ ИЗ МОНТАЖА (решение владельца 05.08.2026): монтажёр вписывает
   * ссылку на Reels впервые (объект в EDITING), а фото и видео уже одобрены маркетингом —
   * объект выходит в продажу САМ, без отдельного нажатия «Готово». Проверяем
   * только когда статус в запросе не задан явно — ручной выбор статуса
   * руководителем через этот же PATCH не подменяем своим решением.
   */
  const autoPublishFromEditing =
    existing.status === "EDITING" &&
    data.status === undefined &&
    data.instagramUrl !== undefined &&
    data.instagramUrl !== null &&
    data.instagramUrl.trim().length > 0;
  let willAutoPublish = false;
  if (autoPublishFromEditing) {
    const photoCount = await prisma.propertyPhoto.count({ where: { propertyId: existing.id } });
    const blockers = blockersForSale({ instagramUrl: data.instagramUrl!, photoCount });
    if (blockers.length === 0) {
      data.status = "AVAILABLE";
      willAutoPublish = true;
    }
  }
  // ЯВНЫЙ ВЫБОР «В ПРОДАЖЕ» ИЗ МОНТАЖА — ТОТ ЖЕ ПУТЬ, ЧТО «ГОТОВО» (глубокая
  // проверка 02.10.2026, D7). Таблица агента разрешает EDITING → AVAILABLE
  // списком, готовность (ссылка на Reels, фото) проверена выше — но без этой
  // строки объект выходил в продажу мимо publishAfterEditingComplete: ни
  // записи «вышел из монтажа» (на ней стоят повторные показы и отчёт
  // маркетинга), ни пуша «опубликован», ни сайта, а место монтажёра оставалось
  // занятым этим объектом.
  if (!willAutoPublish && existing.status === "EDITING" && data.status === "AVAILABLE") {
    willAutoPublish = true;
  }

  // null — очистка точки (№184): новой точкой не считается, по ней район не ищем.
  const hasManualCoords = data.lat != null && data.lng != null;
  // Тот же разбор, что и при создании (lib/propertyDistrict.ts): правка адреса или
  // точки обязана переставить район, иначе ошибка живёт ровно столько, сколько живёт
  // карточка.
  //
  // НО ТОЛЬКО ПРАВКА АДРЕСА ИЛИ ТОЧКИ (24.09.2026). Раньше разбор шёл на КАЖДЫЙ
  // PATCH по сохранённой точке: агент правил цену — и район, выбранный им руками,
  // молча переставлялся по старой точке. А при смене адреса без новой точки
  // спрашивали ту же старую точку — геокод прежнего адреса, — и район уезжал
  // туда, откуда объект «переехал». Теперь:
  //   — прислана НОВАЯ точка (форма шлёт карточку целиком, так что прежние
  //     координаты новой точкой не считаются) — район по ней и по адресу;
  //   — сменился адрес без новой точки — только по адресу: старая точка устарела;
  //   — района нет вовсе — по тому, что есть (точка, иначе адрес);
  //   — иначе карту не спрашиваем: выбор человека остаётся.
  const coordsChanged =
    hasManualCoords &&
    (existing.lat == null || existing.lng == null || Number(existing.lat) !== data.lat || Number(existing.lng) !== data.lng);
  const addressTextChanged = data.address !== undefined && data.address !== existing.address;
  // Точка — геокод прежнего адреса, новой не прислали: см. запись ниже.
  const clearStalePoint = addressTextChanged && !hasManualCoords && existing.geocodedAt != null && existing.lat != null;
  const districtEmpty = !(data.districtId ?? existing.districtId);
  const effAddress = data.address !== undefined ? data.address : existing.address;
  const mapDistrictPatch = coordsChanged
    ? await districtFromMap({ lat: data.lat, lng: data.lng, address: effAddress })
    : addressTextChanged
      ? await districtFromMap({ address: effAddress })
      : districtEmpty
        ? await districtFromMap({
            lat: existing.lat != null ? Number(existing.lat) : null,
            lng: existing.lng != null ? Number(existing.lng) : null,
            address: effAddress,
          })
        : null;
  if (mapDistrictPatch && mapDistrictPatch.id !== (data.districtId ?? existing.districtId)) {
    void logSystemError(
      "api",
      `Район объекта №${existing.shortId} исправлен по карте на ${mapDistrictPatch.name} ` +
        `(${mapDistrictPatch.source === "point" ? "точка внутри границы района" : `улица ${mapDistrictPatch.street}`})`
    );
  }
  if (mapDistrictPatch) data.districtId = mapDistrictPatch.id;
  // Пересобираем название из актуальных полей (поле убрано из формы, ведётся сервером).
  const effDistrictId = data.districtId ?? existing.districtId;
  const effDistrict = effDistrictId
    ? await prisma.district.findUnique({ where: { id: effDistrictId }, select: { name: true } })
    : null;
  const title = buildPropertyTitle({
    type: data.type ?? existing.type,
    rooms: data.rooms !== undefined ? data.rooms : existing.rooms,
    districtName: effDistrict?.name,
  });
  // Если поменялось что-то, от чего зависит SEO-текст — пересобираем его тоже
  // (см. SEO_RELEVANT_FIELDS), чтобы описание не разъезжалось с фактическими параметрами.
  // Только поля, которые реально поменялись: форма шлёт карточку целиком, и
  // раньше каждое «Сохранить» без правок гоняло платный запрос к ИИ.
  // ИИ-текст — всегда в сомони, той же причине, что и при создании выше (owner
  // 16.09.2026): metaTitle/metaDescription/h1/seoDesc идут на сайт и в поиск.
  // Сама сборка — в lib/propertyUpdateEffects.ts (общая с исполнителем заявок).
  const seo = await seoFieldsForUpdate(existing, data, effDistrict?.name, changedFields);
  const effCurrency = data.currency ?? existing.currency;
  // Тоже реальное изменение цены, даже если число не поменялось (напр. валюту
  // поменяли, а сумму нет) — иначе история молчала бы про смену валюты вовсе.
  // ВЫНЕСЕНО ИЗ транзакции ниже (12.09.2026): нужно и после неё, чтобы решить,
  // звать ли автоподбор на снижение цены (блок D плана) — переменная внутри
  // async-колбэка $transaction видна только там же, наружу не выходит.
  const priceActuallyChanged =
    (data.price !== undefined && Number(existing.price) !== data.price) || effCurrency !== existing.currency;

  /**
   * ОПТИМИСТИЧНАЯ БЛОКИРОВКА (13.09.2026, находка 2 — см. Property.version в
   * schema.prisma). version — служебное поле запроса, а не колонка объекта:
   * убираем его из того, что летит в data целиком, и пишем через increment
   * отдельно, иначе на PATCH записалось бы ровно то число, что прислал клиент, —
   * а не «на единицу больше того, что было».
   */
  const { version: clientVersion, ...dataWithoutVersion } = data;

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      if (ownerPhonePlan.kind === "fixSellerPhone") {
        await applySellerPhoneFix(tx, ownerPhonePlan, req.agent!.id, existing.shortId);
      }
      if (priceActuallyChanged) {
        await tx.priceChange.create({
          data: {
            propertyId: existing.id,
            oldPrice: existing.price,
            oldCurrency: existing.currency,
            newPrice: data.price ?? existing.price,
            newCurrency: effCurrency,
            changedById: req.agent!.id,
          },
        });
      }
      // description сюда сознательно не подмешиваем: агент мог вручную выбрать вариант
      // текста через «Сгенерировать описание (ИИ)» (см. /ai/generate-listing) — обычное
      // изменение цены/площади не должно молча затирать его выбор. metaTitle/metaDescription/
      // h1/seoDesc — чисто техническое SEO, ручного UI для них нет, их обновляем всегда.
      const { description: _seoDescription, ...seoMeta } = seo ?? {};
      // updateMany, не update(): update() принимает в where только уникальные поля,
      // а version им не является — условие «id И версия совпали» нечем выразить
      // иначе. Старый вызывающий, ещё не присылающий version (clientVersion===
      // undefined), обновляется безусловно — обратная совместимость, — но версия
      // растёт ВСЕГДА, чтобы поле стало осмысленным сразу для всех новых PATCH,
      // а не только когда каждый вызывающий на фронтенде подтянется.
      const result = await tx.property.updateMany({
        where:
          clientVersion !== undefined
            ? { id: req.params.id, version: clientVersion }
            : { id: req.params.id },
        // Каст нужен, потому что часть полей теперь принимает null (явная очистка),
        // и вывод типов перестаёт выбирать ветку Unchecked* автоматически.
        data: {
          ...dataWithoutVersion,
          title,
          // Канонный адрес пересчитываем только когда адрес реально пришёл в PATCH —
          // иначе любая правка карточки (цена, статус…) без изменения адреса
          // перетирала бы уже посчитанное значение на то же самое, лишний раз.
          ...(data.address !== undefined ? { canonicalAddress: normalizePropertyAddress(data.address) } : {}),
          ...seoMeta,
          // Ссылка на пост Instagram, вписанная руками, — тот же факт «вышел в Instagram»,
          // что отметка канала (05.10.2026, ОБ-000088): без неё сверка, фото-посты,
          // повторные показы, «Где вышел ролик» и бот монтажёра считали объект нигде
          // не опубликованным. Только добавляем; снимает отметку «Убрать из соцсетей».
          ...(isInstagramLink(data.instagramUrl) && !(existing.publishedChannels ?? []).includes("INSTAGRAM")
            ? { publishedChannels: [...(existing.publishedChannels ?? []), "INSTAGRAM"] }
            : {}),
          // Ручной пин ГАСИТ отметку автогеокодера (а не ставит её): объект мог быть
          // геокодирован раньше, и оставшаяся отметка разрешила бы джобу затереть
          // точку, поставленную человеком, — см. комментарий при создании выше.
          ...(hasManualCoords ? { geocodedAt: null } : {}),
          // Адрес сменился, а точка — догадка автогеокодера по СТАРОМУ адресу
          // (24.09.2026): стираем её сразу, в той же записи. Иначе до ответа
          // задания карта показывает прежнее место, а если новый адрес не
          // найдётся — показывает его навсегда, без единого признака ошибки.
          // Ручной пин (geocodedAt пуст) не трогаем: его ставил человек.
          ...(clearStalePoint ? { lat: null, lng: null, geocodedAt: null } : {}),
          // Отметку этапа двигаем ТОЛЬКО при смене статуса. Обновлять её на каждой
          // правке карточки нельзя: просрочка «второй день ждём фото» сбрасывалась бы
          // от исправленной опечатки в адресе, и конвейер показывал бы, что всё в срок.
          ...(data.status !== undefined && data.status !== existing.status ? { stageEnteredAt: new Date() } : {}),
          ...(ownerPhonePlan.kind === "relink" ? { sellerClientId: ownerPhonePlan.clientId } : {}),
          version: { increment: 1 },
        } as Prisma.PropertyUncheckedUpdateManyInput,
      });
      if (clientVersion !== undefined && result.count === 0) {
        throw new PropertyConflictError();
      }
      return tx.property.findUniqueOrThrow({ where: { id: req.params.id } });
    });
  } catch (err) {
    if (err instanceof PropertyConflictError) {
      return res.status(409).json({ error: err.message });
    }
    throw err;
  }

  // СЕМАНТИЧЕСКИЙ ВЕКТОР — пересчитываем фоново, только если поменялось что-то,
  // от чего зависит его текст (см. EMBEDDING_RELEVANT_FIELDS, тот же приём, что и
  // seoNeedsRefresh чуть выше). Не блокирует ответ, никогда не бросает.
  if (ownerPhonePlan.kind === "relink") {
    logAudit(req, "PROPERTY_SELLER_RELINKED", "Property", existing.id, {
      was: existing.sellerClientId,
      becomes: ownerPhonePlan.clientId,
    });
    // Как на создании: у нового продавца объект есть — задача «добавьте объект» гаснет.
    void closeAutoTasks(ownerPhonePlan.clientId, ["deal_stale_seller_add_property"]).catch((err) =>
      console.error("[объект] автозакрытие «добавьте объект»:", err instanceof Error ? err.message : err)
    );
  }

  if (EMBEDDING_RELEVANT_FIELDS.some((f) => data[f] !== undefined)) {
    void embedAndSaveProperty(updated.id);
  }

  /**
   * ИСТОРИЯ ОБЪЕКТА (спецификация владельца): каждая смена статуса и
   * ответственного пишется в журнал действий — раньше не писалась вовсе, и
   * руководитель не мог увидеть, кто и когда двигал объект по конвейеру.
   * Отдельные шаги (одобрение фото/видео, приём) уже логируются точечно выше
   * по файлу под своими action — здесь ловится ОБЩИЙ случай: любая смена
   * статуса или ответственного через обычный PATCH, включая ручную (не через
   * кнопки конвейера) правку статуса руководителем.
   */
  if (data.status !== undefined && data.status !== existing.status) {
    logAudit(req, "PROPERTY_STATUS_CHANGED", "Property", existing.id, {
      was: existing.status,
      becomes: data.status,
    });
  }
  // Остальные поля — одной записью «было → стало» (владелец 23.09.2026). Считаем
  // заново по data: сервер мог сам дописать поля выше (статус автопубликации).
  const fieldChanges = describePropertyChanges(
    changedFields,
    data as unknown as Record<string, unknown>,
    existing as unknown as Record<string, unknown>,
    changedFields.includes("districtId")
      ? new Map(
          (
            await prisma.district.findMany({
              where: { id: { in: [existing.districtId, data.districtId].filter((x): x is string => !!x) } },
              select: { id: true, name: true },
            })
          ).map((d) => [d.id, d.name])
        )
      : undefined
  );
  if (fieldChanges.length > 0) {
    logAudit(req, "PROPERTY_FIELDS_CHANGED", "Property", existing.id, { shortId: existing.shortId, changes: fieldChanges });
  }
  if (data.assignedAgentId !== undefined && data.assignedAgentId !== existing.assignedAgentId) {
    logAudit(req, "PROPERTY_ASSIGNED_AGENT_CHANGED", "Property", existing.id, {
      was: existing.assignedAgentId,
      becomes: data.assignedAgentId,
    });
  }

  // Пуш тем, кому статус адресует объект — ровно один раз за запрос: статус меняется
  // здесь единственный раз, явным PATCH, поэтому
  // сравнение «было/стало» не даёт задвоить уведомление на повторных PATCH без
  // реальной смены статуса.
  if (data.status !== undefined && data.status !== existing.status && data.status === "PENDING_REVIEW") {
    void notifyPendingReview(updated.id, updated.shortId, updated.title).catch((err) =>
      console.error("[push] объект на проверку:", err)
    );
  }
  if (data.status !== undefined && data.status !== existing.status && data.status === "EDITING") {
    void notifyEditingStarted(updated.id, updated.shortId, updated.title).catch((err) =>
      console.error("[push] объект передан в монтаж:", err)
    );
  }
  // Объект ушёл из PENDING_REVIEW/EDITING другим путём, чем кнопки конвейера ниже
  // по файлу (ручная смена статуса руководителем через этот PATCH) — гасим пуш
  // остальным модераторам/монтажёрам тем же способом, что и в кнопках.
  if (data.status !== undefined && data.status !== existing.status && existing.status === "PENDING_REVIEW") {
    void closePendingReviewPush(existing.id).catch((err) => console.error("[push] закрытие «на проверке»:", err));
  }
  if (data.status !== undefined && data.status !== existing.status && existing.status === "EDITING") {
    void closeEditingPush(existing.id).catch((err) => console.error("[push] закрытие «в монтаже»:", err));
  }
  // ПРАВКА ДО ПУБЛИКАЦИИ (владелец 07.10.2026): карточку поправили, пока она на
  // проверке или на монтаже, — модератору/монтажёру уходит «было → стало»
  // (lib/propertyEditNotify.ts). Фоном и без ожидания: отказ уйдёт в журнал, а не в 500.
  if (fieldChanges.length > 0 && (data.status === undefined || data.status === existing.status)) {
    void notifyPropertyEditedBeforePublish({
      before: {
        id: existing.id,
        shortId: existing.shortId,
        title: existing.title,
        status: existing.status,
        currency: existing.currency,
        videoHandoffStatus: existing.videoHandoffStatus,
        clipReviewStatus: existing.clipReviewStatus,
      },
      after: { status: updated.status, currency: updated.currency },
      changes: fieldChanges,
      actorId: req.agent!.id,
    });
  }
  // Объект встал в AVAILABLE напрямую этим PATCH (ручной выбор статуса маркетингом/
  // руководителем, возврат из SOLD/WITHDRAWN) — НЕ считая willAutoPublish: тот путь
  // ниже вызывает publishAfterEditingComplete, у которой уже есть свой такой же хук
  // (lib/propertyPipeline.ts), вызывать дважды не нужно.
  if (data.status !== undefined && data.status !== existing.status && data.status === "AVAILABLE" && !willAutoPublish) {
    void notifyWaitingBuyersOfNewProperty(updated).catch((err) =>
      console.error("[автоподбор] объект переведён в продажу:", err instanceof Error ? err.message : err)
    );
  }

  // СНИЖЕНИЕ ЦЕНЫ → автоподбор покупателей (блок D плана 12.09.2026) живёт теперь в
  // runPostUpdateEffects (lib/propertyUpdateEffects.ts) и вызывается ниже.

  // Адрес или район сменился — старые координаты больше не точны, перегеокодируем.
  // Но если координаты пришли вручную с картой, ручной выбор в приоритете — не трогаем.
  // Задание само прочтёт актуальный адрес и район из базы (jobs/geocode.ts).
  const addressChanged =
    addressTextChanged || (data.districtId !== undefined && data.districtId !== existing.districtId);
  if (addressChanged && !hasManualCoords && updated.address) {
    geocodeInBackground(updated.id);
  }

  // Best-effort: an object published on the site follows the CRM status both
  // ways — SOLD puts the «Продано» badge up, reverting from SOLD (deal fell
  // through) takes it down. Never blocks the response on the site being
  // reachable — see webhooks.ts for the same philosophy in reverse (site lead
  // intake never blocks on the CRM). Failures are logged via logSystemError — same
  // contract as resyncPhotosIfPublished in siteSync.ts — so they reach the
  // «Здоровье системы» screen; console.error alone never did.
  const becameSold = data.status === "SOLD" && existing.status !== "SOLD";
  const becameUnsold = data.status !== undefined && data.status !== "SOLD" && existing.status === "SOLD";
  // СНЯТИЕ С ПРОДАЖИ ТОЖЕ ОБЯЗАНО ДОЙТИ ДО САЙТА. Раньше здесь ловилась только
  // продажа: объект, снятый с продажи в CRM, продолжал висеть на royalhome.tj
  // живым объявлением — по нему звонили покупатели, а показать было нечего.
  // «Снято» на сайте не бейдж, как «Продано», а отсутствие объявления: собственник
  // ушёл, и рекламировать его квартиру мы больше не вправе.
  const becameWithdrawn = data.status === "WITHDRAWN" && existing.status !== "WITHDRAWN";
  const becameReserved = data.status === "RESERVED" && existing.status !== "RESERVED";
  // Объект из продажи вернули в подготовку (маркетинг, находка №180): объявление
  // на сайте больше не показывается покупателям так же, как при снятии.
  const enteredPipeline =
    data.status !== undefined && isPipelineStatus(data.status) && existing.status === "AVAILABLE";

  /**
   * ОБЪЕКТ ВЫШЕЛ ИЗ ПРОДАЖИ, ПОКА ОН НА МОНТАЖЕ (25.09.2026, А3) — продажа,
   * снятие с продажи или резерв, пока `videoHandoffStatus` ещё QUEUED/
   * SENT_TO_EDITOR, раньше не освобождали место монтажёра и не предупреждали
   * его: editorIsBusy() продолжал считать место занятым ИМЕННО ЭТИМ объектом,
   * и вся очередь «строго по одному» вставала за ним замертво (тот же класс,
   * что нашли 19.09.2026 у ручной публикации мимо бота — skipVideoHandoffOnManualPublish
   * выше решает его для другого пути). closeVideoHandoff сам не делает ничего,
   * если объект не в очереди — вызывать безусловно дешевле, чем повторять
   * условие статуса здесь.
   */
  /**
   * ВОЗВРАТ ИЗ МОНТАЖА НА ДОРАБОТКУ (глубокая проверка 02.10.2026, D8):
   * маркетинг вернул объект из EDITING в AWAITING_PHOTOS/AWAITING_VIDEO/
   * PENDING_REVIEW, а передача монтажёру оставалась живой — монтажёр, не
   * знающий о возврате, сдавал ролик, и приём (finalizePropertyAvailability)
   * выводил объект в продажу со старыми материалами, пропуская доработку.
   * Монтажёр получает «сняли с монтажа», место освобождается; после
   * повторного одобрения объект встанет в очередь заново тем же путём, что
   * и в первый раз.
   */
  if (existing.status === "EDITING" && data.status !== undefined && data.status !== "EDITING" && isPipelineStatus(data.status)) {
    void closeVideoHandoff(updated.id, { holdQueue: false, reason: "возвращён на доработку" }).catch((err) =>
      void logSystemError(
        "video-handoff",
        `Объект ${updated.id}: закрытие монтажа при возврате на доработку не удалось: ${describeError(err)}`
      )
    );
  }

  if (becameSold || becameWithdrawn || becameReserved) {
    // Монтаж, фото-посты, повторы и будущие показы — одной общей функцией, той же,
    // что зовут закрытие сделки и ночная сверка статуса (lib/propertyLeftSale.ts).
    // Ниже в этом файле остаётся только то, что относится к сайту.
    closeWorkAfterLeavingSale(updated.id, becameSold ? "sold" : becameWithdrawn ? "withdrawn" : "reserved");
  }

  /* Гашение «Итога объекта» при переходе в «Продан»/«Снят» убрано 13.09.2026
     вместе с механизмом окон. */
  if (existing.publishedOnSite && (becameSold || becameUnsold || becameWithdrawn || enteredPipeline)) {
    const withRelations = await prisma.property.findUnique({
      where: { id: updated.id },
      include: { district: true, photos: { orderBy: { order: "asc" } } },
    });
    if (withRelations) {
      // Снятие сильнее возврата из «Продано»: переход SOLD → WITHDRAWN — это оба
      // признака сразу, и объявление в таком случае убирается, а не оживает.
      const action = becameWithdrawn || enteredPipeline ? "unpublish" : becameSold ? "sold" : "unsold";
      void syncPropertiesToSite([withRelations], action)
        .then((result) => {
          const problem = !result.ok ? result.error : result.results.find((r) => !r.ok)?.error;
          if (!problem) {
            // Объявления на сайте больше нет — снимаем отметку, иначе карточка
            // считается опубликованной, и кнопка «Опубликовать на сайт» не
            // появится тому, кто вернёт объект в продажу.
            if (action === "unpublish") {
              return prisma.property
                .update({ where: { id: updated.id }, data: { publishedOnSite: false } })
                .then(() => undefined);
            }
            return;
          }
          console.error(`[siteSync] Статус объекта ${updated.id} не дошёл до сайта: ${problem}`);
          void logSystemError("site-sync", `Статус объекта ${updated.id} не дошёл до сайта: ${problem}`, {
            url: `/properties/${updated.id}`,
          });
        })
        .catch((err) => {
          const reason = err instanceof Error ? err.message : String(err);
          console.error(`[siteSync] Статус объекта ${updated.id}:`, reason);
          void logSystemError("site-sync", `Статус объекта ${updated.id} — ошибка синхронизации: ${reason}`, {
            url: `/properties/${updated.id}`,
          });
        });
    }
  }

  /**
   * ЭФФЕКТЫ ПОСЛЕ ПРАВКИ — вынесены в lib/propertyUpdateEffects.ts без смены поведения
   * (07.10.2026: ту же цепочку зовёт исполнитель заявок на изменение опубликованного
   * объекта). Что делает, с историей решений владельца:
   *
   *  — ЛЮБАЯ ПРАВКА ОПУБЛИКОВАННОГО ОБЪЕКТА ДОЕЗЖАЕТ ДО САЙТА (аудит №4, 27.08): смена
   *    ЦЕНЫ, описания, площади или комнат писала PriceChange в CRM, а витрина
   *    royalhome.tj показывала старую цену бессрочно. Досылка — задание site-resync (полный
   *    снимок объекта), dedupe на объект схлопывает серию правок. Статусные переходы выше
   *    не дублируются: у них свои действия (sold/unsold/unpublish).
   *  — Снижение цены → автоподбор покупателей (12.09.2026, блок D, «все да» п.5).
   *  — Факты в подписи ролика (этаж, площадь, район…) — точечно в базе сразу, в посты уходит
   *    по «Готово» (POST /:id/finish-edit, владелец 23.09.2026).
   *  — Цена в опубликованные посты Facebook/Telegram/YouTube (владелец 16.09.2026: «цена
   *    снизилась, а пост не надо добавлять второй раз»); Instagram Graph API не даёт править
   *    caption, см. lib/publishedListingSync.ts. Только на реальной смене цены.
   */
  await runPostUpdateEffects({
    existing,
    updated,
    changedFields,
    priceActuallyChanged,
    staysAvailable: data.status === undefined || data.status === "AVAILABLE",
    resyncSite: existing.publishedOnSite && !becameSold && !becameUnsold && !becameWithdrawn && !enteredPipeline,
    resyncReason: "правка карточки (PATCH)",
    awaitPriceSync: false,
  });

  // АВТОПУБЛИКАЦИЯ (см. autoPublishFromEditing выше) — тот же код-путь, что и
  // ручная кнопка «Готово»: сырое видео из R2, аудит, синхронизация с сайтом.
  if (willAutoPublish) {
    const { updated: published, siteSyncError } = await publishAfterEditingComplete(req, updated);
    // Объект мог всё ещё стоять в очереди/висеть у монтажёра через бота (lib/videoHandoff.ts) —
    // публикация этим путём (ссылка вписана руками) закрывает хендофф сама, иначе место
    // монтажёра остаётся занятым этим объектом навсегда и очередь за ним не двигается.
    void skipVideoHandoffOnManualPublish(published.id).catch((err) =>
      console.error("[video-handoff] закрытие хендоффа при автопубликации:", err)
    );
    publishPropertyUpdated({ propertyId: published.id, agentId: published.assignedAgentId, stage: published.status, actorId: req.agent!.id });
    if (siteSyncError) {
      return res.status(207).json({ ...presentProperty(published, req), siteSyncError });
    }
    return res.json(presentProperty(published, req));
  }

  publishPropertyUpdated({ propertyId: updated.id, agentId: updated.assignedAgentId, stage: updated.status, actorId: req.agent!.id });
  res.json(presentProperty(updated, req));
});

/**
 * «Готово» у монтажёра — спецификация владельца, Этап 7/9: «нажать кнопку
 * «Готово»» завершает подготовку объекта; после этого CRM «снимает
 * ответственность со всех сотрудников; статус объекта → «Активный объект»;
 * публикует объект на сайте... освобождает одно место из лимита активных
 * объектов агента».
 *
 * «СНИМАЕТ ОТВЕТСТВЕННОСТЬ» — не отдельное поле для очистки: пока объект в
 * конвейере (EDITING), «ответственный» — это РОЛЬ (PROPERTY_STAGE_OWNER),
 * а не конкретный сотрудник в отдельной колонке. Как только статус выходит
 * из конвейера, роль-ответственность снимается сама — ей просто больше не по
 * чему определяться. intakeAgentId не трогаем: это агент, принявший объект,
 * его доля в комиссии сделки не связана с этапом подготовки.
 *
 * «ОСВОБОЖДАЕТ МЕСТО В ЛИМИТЕ» — тоже не отдельное действие: лимит
 * (propertyActiveLimit выше) считает объекты интейкера ЖИВЫМ запросом по
 * PROPERTY_PIPELINE_STATUSES, и место освобождается самим фактом смены
 * статуса на AVAILABLE — без него.
 *
 * ПУБЛИКАЦИЯ — синхронно и честно, а не best-effort, как при создании:
 * создание случается на пустой карточке, где отказ ожидаем (нет фото), а
 * «Готово» — намеренное завершающее действие монтажёра, который должен
 * узнать, если сайт объект не принял, а не увидеть в CRM «опубликован»
 * молча разошедшийся с реальностью.
 */
crudRouter.post("/:id/complete-editing", requireAuth, async (req, res) => {
  const property = await prisma.property.findUnique({
    where: { id: req.params.id },
    include: { district: true, photos: { orderBy: { order: "asc" } } },
  });
  if (!property || property.deletedAt) return res.status(404).json({ error: "Объект не найден" });
  if (!canManageProperty(req, property)) return res.status(403).json({ error: "Недостаточно прав" });

  if (property.status !== "EDITING") {
    return res.status(409).json({ error: "Кнопка «Готово» доступна только на этапе «Монтаж»" });
  }
  const blockers = blockersForSale({ instagramUrl: property.instagramUrl, photoCount: property.photos.length });
  if (blockers.length > 0) {
    return res.status(409).json({ error: `Объект не готов: ${blockers.join(", ")}` });
  }

  const updated = await prisma.property.update({
    where: { id: property.id },
    data: { status: "AVAILABLE", stageEnteredAt: new Date() },
    include: { district: true, photos: { orderBy: { order: "asc" } } },
  });

  const { updated: published, siteSyncError } = await publishAfterEditingComplete(req, updated);
  // См. комментарий у аналогичного вызова в автопубликации PATCH выше — та же
  // защита от навсегда занятого места монтажёра, только для ручной кнопки «Готово».
  void skipVideoHandoffOnManualPublish(published.id).catch((err) =>
    console.error("[video-handoff] закрытие хендоффа при «Готово»:", err)
  );
  publishPropertyUpdated({ propertyId: published.id, agentId: published.assignedAgentId, stage: published.status, actorId: req.agent!.id });
  if (siteSyncError) {
    return res.status(207).json({ ...presentProperty(published, req), siteSyncError });
  }
  res.json(presentProperty(published, req));
});

/**
 * МАССОВОЕ УДАЛЕНИЕ В КОРЗИНУ (владелец 03.09.2026) — галочки в списке объектов
 * умели только публикацию, а чистить каталог приходилось по одной карточке.
 *
 * Право то же, что у одиночного удаления (`properties.delete`): массовая кнопка
 * не должна открывать агенту то, чего ему не даёт обычная. Пообъектной проверки
 * canManageProperty здесь сознательно нет — её нет и у DELETE /:id, и разная
 * строгость двух входов в одно и то же действие путала бы сильнее, чем помогала;
 * агент без права удаления по-прежнему идёт через заявку (deleteRequests.ts).
 *
 * ⚠️ ПОРЯДОК РЕГИСТРАЦИИ: путь статичный и односегментный. Пересечений нет
 * (POST /:id в crud не объявлен, остальные POST — двухсегментные), но объявлен
 * он всё равно ДО DELETE /:id — рядом с тем, что делает то же самое.
 */
crudRouter.post("/bulk-trash", requireAuth, requirePermission("properties.delete"), async (req, res) => {
  const parsed = bulkTrashPropertiesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }

  const results = await trashProperties(parsed.data.ids, req.agent!.id);

  // Журнал — построчно и тем же действием TRASH, что и одиночное удаление:
  // история объекта не должна зависеть от того, каким входом его удалили.
  for (const item of results.filter((r) => r.ok)) {
    logAudit(req, "TRASH", "Property", item.id, {
      shortId: item.shortId,
      title: item.title,
      publishedOnSite: item.publishedOnSite,
      bulk: true,
    });
  }

  const trashed = results.filter((r) => r.ok).length;
  for (const item of results.filter((r) => r.ok)) {
    publishPropertyUpdated({ propertyId: item.id, actorId: req.agent!.id, stage: "TRASHED" });
  }
  res.json({
    trashed,
    failed: results.length - trashed,
    // status — служебное поле одиночного входа, наружу не отдаём.
    results: results.map(({ id, shortId, title, ok, error }) => ({ id, shortId, title, ok, error })),
  });
});

/** Удаление объекта — только ADMIN (директор проходит автоматически). Мягкое:
 * объект уходит в Корзину (deletedAt), снимается с сайта, но запись/фото остаются
 * на диске — «Восстановить» в Корзине возвращает всё как было. Физически стереть
 * можно только оттуда же, отдельной кнопкой (см. DELETE /:id/permanent).
 * Объект со сделками удалять нельзя — Deal.propertyId обязателен (FK без каскада),
 * да и терять историю сделок нельзя.
 *
 * Само удаление (проверка сделок, снятие с сайта, deletedAt) живёт в
 * lib/trashProperty.ts: тот же путь проходит одобрение заявки агента
 * (routes/properties/deleteRequests.ts), и второй копии этой логики быть не
 * должно — см. комментарий там и урок trashClient.ts. */
crudRouter.delete("/:id", requireAuth, requirePermission("properties.delete"), async (req, res) => {
  const result = await trashProperty(req.params.id, req.agent!.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  logAudit(req, "TRASH", "Property", result.property.id, {
    shortId: result.property.shortId,
    title: result.property.title,
    publishedOnSite: result.property.publishedOnSite,
  });
  publishPropertyUpdated({ propertyId: result.property.id, actorId: req.agent!.id, stage: "TRASHED" });
  res.status(204).send();
});

/** Восстановление объекта из Корзины — только ADMIN. Публикация на сайте
 * сознательно не возвращается автоматически: снятие с сайта было осознанным
 * действием при удалении, повторную публикацию решают отдельно кнопкой.
 *
 * publishedOnSite сбрасываем в false здесь же (ночная проверка 24.09.2026,
 * №128): trashProperties снимает объявление с сайта, но не трогает эту
 * отметку (её заголовок сам объясняет почему — расчёт был на restore), а
 * restore её тоже не трогал — карточка выходила из Корзины с
 * publishedOnSite: true при том, что на сайте объявления уже нет. Кнопка на
 * карточке показывала «Снять с публикации» вместо «Опубликовать», а первая
 * же правка карточки (PATCH) видела publishedOnSite: true и молча
 * досылала объект на сайт через resyncPhotosIfPublished — тот же довод, что
 * у сброса флага при WITHDRAWN выше по файлу. */
crudRouter.post("/:id/restore", requireAuth, requirePermission("properties.delete"), async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.id } });
  if (!property || !property.deletedAt) return res.status(404).json({ error: "Объект не найден в корзине" });

  await prisma.property.update({
    where: { id: property.id },
    data: { deletedAt: null, deletedById: null, publishedOnSite: false },
  });

  // Очередь монтажа и публикация принятого ролика — тем же списком, что и у
  // «Откатить» удаление сайтом (lib/trashProperty.ts::reopenWorkAfterRestore).
  await reopenWorkAfterRestore(property);

  logAudit(req, "RESTORE", "Property", property.id, { shortId: property.shortId, title: property.title });
  publishPropertyUpdated({ propertyId: property.id, agentId: property.assignedAgentId, stage: property.status, actorId: req.agent!.id });
  res.status(204).send();
});

/** Безвозвратное удаление — только из Корзины (объект уже должен быть в deletedAt),
 * только ADMIN. Стирает запись, фото на диске и отвязывает взаимодействия — именно
 * этим шагом раньше был обычный DELETE, теперь он доступен только как вторая,
 * осознанная кнопка «Удалить навсегда», чтобы сервер не копил мусор в Корзине вечно. */
crudRouter.delete("/:id/permanent", requireAuth, requirePermission("properties.purge"), async (req, res) => {
  const property = await prisma.property.findUnique({
    where: { id: req.params.id },
    include: {
      photos: { orderBy: { order: "asc" } },
      // Видео поднимаем ДО удаления записи: PropertyVideo уходит каскадом
      // (ON DELETE CASCADE), и вместе с ним пропадает единственная ссылка на файл
      // в закрытом хранилище — storageKey. Сами файлы при этом остаются на диске
      // навсегда, до 30 роликов на объект. Тот же урок уже был с папкой uploads/msg ниже.
      videos: { select: { id: true, storageKey: true } },
      _count: { select: { deals: true } },
    },
  });
  if (!property || !property.deletedAt) return res.status(404).json({ error: "Объект не найден в корзине" });
  if (property._count.deals > 0) {
    return res.status(409).json({ error: "У объекта есть сделки — удалить навсегда нельзя" });
  }

  /**
   * ЗАДАЧА С ПОКАЗОМ ПО УДАЛЁННОМУ ОБЪЕКТУ (07.09.2026, разведка «осиротевшие
   * спутники»). Interaction.propertyId ниже нулится у ВСЕХ записей — история,
   * FK без каскада. Но если по объекту ещё висел незакрытый показ (nextAction,
   * задача в календаре), тот превращался в пустую строку: клиент есть, дата
   * есть, а какой объект и куда ехать — было только в propertyId, который
   * только что обнулили. Отменяем такие показы явно, тем же приёмом, что и
   * applyCancellation (lib/showingBooking.ts): nextAction: null, declinedAt,
   * след в notes, гашение «Итога показа» — иначе показ навсегда остаётся в
   * календаре без единого слова о том, что случилось.
   */
  const now = new Date();
  const openShowings = await prisma.interaction.findMany({
    where: { propertyId: property.id, nextAction: { not: null }, completedAt: null },
    select: { id: true, notes: true },
    take: OPEN_SHOWINGS_PER_PROPERTY_CAP,
  });
  if (openShowings.length >= OPEN_SHOWINGS_PER_PROPERTY_CAP) {
    void logSystemError(
      "api",
      `Удаление объекта навсегда (${property.id}): открытых показов больше ${OPEN_SHOWINGS_PER_PROPERTY_CAP} — сняты только первые`
    );
  }

  /**
   * РЕКЛАМА ОБЪЕКТА (ревью 03.10.2026, п. 3). Связи «объявление → объект» (AdProperty)
   * каскадом стирались вместе с объектом, а Ad.propertyId обнулялся даже при живых
   * связях: доля удалённого объекта навсегда перекладывалась на соседей. Теперь в той же
   * транзакции объявления отвязываются явно (lib/ads/adAllocation.ts): остальные связи
   * сохраняются, основной объект пересчитывается, assetCount не уменьшается — объявление
   * встаёт в «нужна проверка», а не тихо переписывает деньги.
   */
  const detachedAds = await prisma.$transaction(async (tx) => {
    await tx.interaction.updateMany({ where: { propertyId: property.id }, data: { propertyId: null } });
    for (const s of openShowings) {
      await tx.interaction.update({
        where: { id: s.id },
        data: {
          nextAction: null,
          declinedAt: now,
          notes: `${s.notes}\nОбъект удалён навсегда — показ снят с календаря`,
        },
      });
    }
    const detached = await detachPropertyFromAds(tx, property.id);
    await tx.property.delete({ where: { id: property.id } });
    return detached;
  });
  for (const d of detachedAds) {
    logAudit(req, "UPDATE", "Ad", d.adId, {
      reason: "property-purged",
      propertyId: property.id,
      shortId: property.shortId,
      remainingProperties: d.remaining,
      primaryPropertyId: d.propertyId,
      manual: d.manual,
    });
  }

  if (openShowings.length > 0) {
    await prisma.pendingSummary
      .updateMany({
        where: { kind: "meeting", subjectId: { in: openShowings.map((s) => s.id) }, doneAt: null },
        data: { doneAt: now },
      })
      .catch((err) =>
        logSystemError(
          "api",
          `«Итог показа» по удалённому навсегда объекту не погашен (${property.id}): ${err instanceof Error ? err.message : err}`
        )
      );
  }

  for (const photo of property.photos) {
    await fs.rm(path.join(uploadsDir, path.basename(photo.url)), { force: true });
    await fs.rm(path.join(uploadsDir, "thumbs", path.basename(photo.thumbUrl)), { force: true });
    // JPEG-копия для мессенджеров — производная от оригинала и без него не нужна.
    // Пока её тут не убирали, папка uploads/msg росла навсегда.
    await removeMessagePhoto(photo.url);
    /**
     * УЛУЧШЕННАЯ И ИСХОДНАЯ КОПИИ ФОТО (аудит №4, 27.08). Улучшение ждёт решения
     * агента в enhancedUrl, а после одобрения оригинал переезжает в originalUrl —
     * оба варианта с миниатюрами. Их тут не удаляли: единственные ссылки на файлы
     * (строки PropertyPhoto) стирались вместе с объектом, и файлы оставались на
     * диске VPS навсегда, уже неопознаваемые. Тот же урок, что с uploads/msg выше.
     */
    for (const extra of [photo.enhancedUrl, photo.originalUrl]) {
      if (extra) await fs.rm(path.join(uploadsDir, path.basename(extra)), { force: true });
    }
    for (const extraThumb of [photo.enhancedThumbUrl, photo.originalThumbUrl]) {
      if (extraThumb) await fs.rm(path.join(uploadsDir, "thumbs", path.basename(extraThumb)), { force: true });
    }
  }

  // Сжатый ролик карточки — тоже локальный файл, и ссылок на него после
  // удаления строки не остаётся (аудит №4, 27.08).
  if (property.clipVideoUrl) {
    await fs.rm(path.join(uploadsDir, "video", path.basename(property.clipVideoUrl)), { force: true });
  }
  // Файлы удалённого автомонтажа (04.09.2026) — колонки autoMontageUrl/
  // autoMontageCoverUrl оставлены в схеме сиротами ради старых объектов, и
  // именно у них файл ещё может лежать на диске. Локальная уборка вместо
  // импорта из удалённой lib/reelsAutoMontage.ts.
  for (const legacyUrl of [property.autoMontageUrl, property.autoMontageCoverUrl]) {
    if (legacyUrl?.startsWith("/uploads/")) {
      await fs.rm(path.join(uploadsDir, legacyUrl.replace(/^\/uploads\//, "")), { force: true });
    }
  }

  // Финал приёма ролика (uploads/handoff) и обе обложки ChatGPT (uploads/covers)
  // (Б8, 25.09.2026) — до этой правки удаление навсегда стирало запись, но эти
  // три файла оставались на диске без единой ссылки. Правило Корзины здесь
  // НЕ действует: это осознанное «удалить навсегда» той же кнопкой, которая
  // объект уже держала в Корзине.
  const ownedFiles = propertyOwnedFilePaths(property);
  for (const file of ownedFiles) {
    await fs.rm(file, { force: true }).catch((err) =>
      logSystemError("storage", `Объект ${property.shortId}: файл ${path.basename(file)} не удалён — ${describeError(err)}`)
    );
  }

  // Видео на диске — тем же порядком, что и в DELETE /:id/videos/:videoId: сначала
  // запись, потом файл. Отказ хранилища не должен ронять уже совершённое удаление,
  // поэтому без await — но и молчать о нём нельзя, иначе место на диске утекает тихо.
  for (const video of property.videos) {
    void localVideoDelete(video.storageKey).catch((err) =>
      logSystemError(
        "storage",
        `Видео объекта ${property.shortId} (${video.storageKey}) не удалено из хранилища: ${err instanceof Error ? err.message : String(err)}`
      )
    );
  }

  logAudit(req, "PERMANENT_DELETE", "Property", property.id, {
    shortId: property.shortId,
    title: property.title,
    videosRemoved: property.videos.length,
    filesRemoved: ownedFiles.length,
  });
  res.status(204).send();
});
