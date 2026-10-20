import { z } from "zod";
import { expenseWorkspaceFields } from "./expenseWorkspace.js";
import { daysOffSchema } from "./daysOff.js";
import { customerRevisionSchema } from "./customerState.js";
import {
  ROLES,
  migrateLegacyTheme,
  EXPENSE_CATEGORIES,
  PROPERTY_TYPES,
  PROPERTY_CONDITIONS,
  PROPERTY_STATUSES,
  PROPERTY_STAGES,
  MARKET_TYPES,
  PROPERTY_DETAIL_OPTIONS,
  CURRENCIES,
  CLIENT_STATUSES,
  CLIENT_KINDS,
  CLIENT_SOURCES,
  INTERACTION_TYPES,
  INTERACTION_OUTCOMES,
  DEAL_STAGES,
  DEAL_DOCUMENT_KINDS,
  LOOK_IDS,
  ABSENCE_KINDS,
  type AbsenceKind,
} from "./enums.js";
import { isMaskedClientPhone } from "./maskContacts.js";
import { normalizeInstagramUrl, isValidInstagramPostUrl } from "./instagramLink.js";
import { floorRuleError } from "./propertyFinish.js";
import { propertyFieldRequired, propertyFieldShown, stripPropertyFieldsForType } from "./propertyTypeFields.js";

/**
 * Телефон и имя сотрудника (ночная проверка 24.09.2026, №166): телефон — логин,
 * поэтому с тем же минимумом цифр, что у номера клиента и собственника
 * (hasValidPhoneDigitCount ниже), и с потолком длины; имя — с потолком.
 */
const staffPhoneSchema = z
  .string()
  .trim()
  .min(5)
  .max(32)
  .refine((v) => hasValidPhoneDigitCount(v), "Введите корректный номер телефона");
const staffNameSchema = z.string().trim().min(2).max(120);

/**
 * Ссылка на голосовую заметку — только наш путь к закрытому файлу:
 * `/me/voice-notes/<имя>` (так её отдаёт POST /me/voice-notes) или прежний
 * `/uploads/voice-notes/<имя>` у старых записей; пустая строка — «без заметки».
 * Раньше такие поля принимали любую строку до 500 знаков, и чужая ссылка
 * ложилась в карточку (ночная проверка 24.09.2026, №164).
 */
export const voiceNoteUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => v === "" || /^\/(me|uploads)\/voice-notes\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(v),
    "Неверная ссылка на голосовую заметку"
  );

export const agentCreateSchema = z.object({
  fullName: staffNameSchema,
  phone: staffPhoneSchema,
  email: z.string().email().optional(),
  role: z.enum(ROLES),
  /// Внутренний номер (SIP) — необязателен: если не указать, CRM выдаст первый
  /// свободный из пула на АТС сама (см. apps/api/src/lib/telephony/extensionPool.ts).
  /// Указывают вручную, только когда за сотрудником закреплён конкретный аппарат.
  sipExtension: z
    .string()
    .regex(/^\d{3,5}$/, "Внутренний номер — 3-5 цифр, например 1005")
    .optional(),
  /// Ник сотрудника в Instagram, без `@` (26.09.2026) — добавляется первым в
  /// список соавторов Reels при публикации его объектов
  /// (apps/api/src/lib/instagramCollaborators.ts). Необязателен: агент может
  /// быть не подключён к Instagram вовсе.
  instagramUsername: z
    .string()
    .trim()
    .max(30)
    .regex(/^[a-z0-9._]{0,30}$/i, "Только латиница, цифры, точка и подчёркивание, без @")
    .optional(),
});

/** `kpi` НЕ входит в этот схему: Fair Play (спецификация 03.08.2026) запрещает ручную
 * правку Royal Score кому бы то ни было — ни агенту, ни руководителю, ни
 * администратору. Счёт меняется только автоматически, событиями (см.
 * apps/api/src/lib/scoreJournal.ts). Раньше поле здесь разрешало PATCH-правку под
 * правом `score.override` — право снято вместе с полем. */
export const agentUpdateSchema = agentCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
  /// Внутренний SIP-номер на АТС (см. docs/telephony-sip-numbering.md), например "1005".
  /// null стирает поле (undefined в PATCH не сериализуется в JSON и ничего не меняет).
  /// Диапазон 3-5 цифр: на АТС агентства нумерация четырёхзначная с 1001, но
  /// трёхзначная встречается на малых станциях и запрещать её незачем.
  sipExtension: z
    .string()
    .regex(/^\d{3,5}$/, "Внутренний номер — 3-5 цифр, например 1005")
    .nullable()
    .optional(),
  /// На каком языке сотруднику играть подсказку о звонящем перед соединением:
  /// "tg" — таджикский, "ru" — русский, "off" — не играть ему вовсе,
  /// null — как выбрано в агентстве (Настройки → Каналы связи).
  whisperLanguage: z.enum(["tg", "ru", "off"]).nullable().optional(),
  /// Оператор первой линии: принимает звонки незнакомых номеров (решение владельца
  /// 20.09.2026). Признак обязанности, а не роли — см. Agent.takesUnknownCalls.
  takesUnknownCalls: z.boolean().optional(),
  /// null стирает ник (undefined в PATCH не сериализуется в JSON и ничего не меняет,
  /// см. agentCreateSchema выше про сам формат).
  instagramUsername: z
    .string()
    .trim()
    .max(30)
    .regex(/^[a-z0-9._]{0,30}$/i, "Только латиница, цифры, точка и подчёркивание, без @")
    .nullable()
    .optional(),
  /// «Присылать мои посты в Telegram» (28.09.2026, lib/agentSharePost.ts) — личный
  /// тумблер, руководитель ставит его сотруднику в карточке (Настройки → Сотрудники).
  sharePostTelegram: z.boolean().optional(),
  /// Личные выходные (владелец 11.10.2026): дни недели по Душанбе, 0 — воскресенье.
  /// Пусто — работает каждый день. Правило — daysOff.ts.
  weeklyDaysOff: daysOffSchema.optional(),
});

/** Самообслуживание: сотрудник меняет свои данные. Отдельно от agentUpdateSchema —
 * там роль/isActive может менять только админ, здесь это по определению исключено. */
export const meUpdateSchema = z
  .object({
    fullName: staffNameSchema.optional(),
    phone: staffPhoneSchema.optional(),
    email: z.string().email().or(z.literal("")).optional(),
  })
  // strict: неизвестные поля (например, role) — ошибка валидации, а не тихое срезание.
  .strict();

/** Тумблер «модерация в Telegram» в профиле (22.09.2026) — PATCH /me/telegram-moderation. */
export const meTelegramModerationSchema = z.object({ enabled: z.boolean() }).strict();

/** Настройки оформления, хранятся в Agent.preferences (JSON). Сохраняются целиком (PUT-семантика). */
export const uiPreferencesSchema = z
  .object({
    // Слой 4 (08.09.2026): реестр THEME_IDS теперь содержит только пару 2026, но
    // клиенты/записи в БД могут ещё присылать один из шести удалённых id (документ
    // не обновился до нового bundle в момент деплоя) — принимаем любую строку и
    // разворачиваем через migrateLegacyTheme, а не отвечаем 400.
    theme: z
      .string()
      .optional()
      .transform((v) => (v === undefined ? undefined : migrateLegacyTheme(v))),
    /** Облик интерфейса (компоновка), независим от темы (цвета). См. LOOK_IDS. */
    look: z.enum(LOOK_IDS).optional(),
    effects: z
      .object({
        /** Декоративный анимированный фон-«аврора». */
        aurora: z.boolean().optional(),
        /** Полупрозрачность и blur поверхностей («стекло»). */
        glass: z.boolean().optional(),
      })
      .optional(),
    dashboard: z
      .object({
        /** Идентификаторы скрытых виджетов дашборда (список известен только веб-клиенту). */
        hidden: z.array(z.string().max(48)).max(30).optional(),
      })
      .optional(),
    /** Personal desktop navigation order; links are resolved by the permission-filtered client registry. */
    navigation: z.object({
      desktopOrder: z.array(z.string().max(96).regex(/^\/(?:[a-z0-9][a-z0-9/-]*)?$/))
        .max(64).refine((paths) => new Set(paths).size === paths.length, "Повторяющиеся разделы").optional(),
    }).strict().optional(),
    /**
     * Наследие приветственного тура (удалён 12.08.2026, решение владельца: оверлей
     * driver.js перехватывал клики в окне входящего звонка). Клиент поле больше не
     * читает и не пишет; схема его принимает, чтобы уже лежащие в Agent.preferences
     * значения не роняли валидацию PUT /me/preferences.
     */
    onboardingCompletedAt: z.string().datetime().nullable().optional(),
    /** Идентификаторы разово скрытых подсказок/баннеров (например, промо живой темы). */
    dismissedHints: z.array(z.string().max(48)).max(50).optional(),
    security: z
      .object({
        /**
         * Автовыход из CRM при неактивности, в минутах. null/отсутствие — «никогда»
         * (текущее поведение). Применяется клиентом: по истечении таймера бездействия
         * выполняется logout (см. useIdleLogout в apps/web).
         */
        autoLogoutMinutes: z.number().int().min(5).max(1440).nullable().optional(),
      })
      .optional(),
  })
  .strict();
export type UiPreferences = z.infer<typeof uiPreferencesSchema>;

export const districtCreateSchema = z.object({
  name: z.string().min(1),
  city: z.string().default("Душанбе"),
});

/**
 * СПРАВОЧНИК ОРИЕНТИРОВ ВЕДУТ АГЕНТЫ (12.09.2026, docs/geo-match-plan-12-09.md,
 * блок J). Заводить и править может любой агент (право требуется только на
 * скрытие/удаление, см. routes/landmarks.ts) — схема поэтому не завязана на
 * право, только на форму данных.
 */
/**
 * ЗНАЧИМОСТЬ ОРИЕНТИРА (дополнение владельца 12.09.2026 к блоку J): три
 * ступени, а не произвольное число — экран предлагает «обычный/важный/очень
 * важный», а не пустое поле ввода. См. докстринг Landmark.weight в schema.prisma
 * и отбор в lib/landmarkPick.ts (apps/api), где вес участвует множителем к
 * обратному расстоянию.
 */
export const LANDMARK_WEIGHTS = [0, 50, 100] as const;
export type LandmarkWeight = (typeof LANDMARK_WEIGHTS)[number];

export const landmarkCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(80),
  address: z.string().trim().max(300).optional(),
  districtId: z.string().min(1).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Насколько широко люди понимают название — метры; пусто, если агент не задал. */
  radiusM: z.number().int().positive().max(20_000).optional(),
  /** 0/50/100 — «обычный»/«важный»/«очень важный». Пусто = 0 (обычный). */
  weight: z.union([z.literal(0), z.literal(50), z.literal(100)]).optional(),
  /** «До центра города» — отдельная строка расстояний у карточки объекта. */
  isCityCenter: z.boolean().optional(),
});
export type LandmarkCreateInput = z.infer<typeof landmarkCreateSchema>;

/** Правка — всё то же самое, но по отдельности: одно поле за раз (форма экрана
 *  правит название/категорию/точку/радиус независимо). `null` у radiusM снимает
 *  значение (см. ловушку `undefined` не сериализуется в JSON, CLAUDE.md). */
export const landmarkUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(80).optional(),
  address: z.string().trim().max(300).nullable().optional(),
  districtId: z.string().min(1).nullable().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  radiusM: z.number().int().positive().max(20_000).nullable().optional(),
  weight: z.union([z.literal(0), z.literal(50), z.literal(100)]).optional(),
  isCityCenter: z.boolean().optional(),
});
export type LandmarkUpdateInput = z.infer<typeof landmarkUpdateSchema>;

/** Текст синонима, как его печатает агент («ЦУМ», «82 мкр») — нормализация
 *  (normalizeGeoText) и запись в GeoAlias происходят на сервере. */
export const landmarkAliasCreateSchema = z.object({
  text: z.string().trim().min(1).max(120),
});
export type LandmarkAliasCreateInput = z.infer<typeof landmarkAliasCreateSchema>;

/** Расход компании. month — "YYYY-MM" (сервер приводит к первому дню месяца). */
/**
 * Расходы компании ведутся ТОЛЬКО в сомони — это отчётная валюта, в ней же считается
 * прибыль. Поля currency здесь сознательно нет: форма его никогда не спрашивала, а
 * колонка в БД создавала ложное впечатление, будто выбор есть — и заставляла
 * агрегаты конвертировать то, чего не бывает. Колонка в БД остаётся со значением
 * TJS по умолчанию (исторические записи все в сомони), но через API её не задать.
 * Если когда-нибудь понадобятся валютные расходы — возвращать поле надо вместе с
 * селектором в форме и конвертацией в Финансах, а не по отдельности.
 */
/**
 * ДЕНЬГИ НА ВХОДЕ — НЕ ТОЧНЕЕ КОПЕЙКИ.
 *
 * Денежные колонки объявлены обычным `Decimal`, а это в Postgres
 * DECIMAL(65,30): база хранит ровно то, что прислали. Форма отправляла
 * `Number("1000.456")` — и в комиссии навсегда оседали доли копейки, которые
 * потом не сходились ни в одном отчёте и всплывали в выгрузке бухгалтеру
 * тридцатью знаками после запятой.
 *
 * Схема — единственная граница, через которую деньги попадают в CRM, поэтому
 * округление живёт здесь: любая денежная сумма приводится к двум знакам ещё до
 * того, как её увидит бизнес-логика (03.09.2026).
 */
const money = () => z.number().transform((value) => Math.round(value * 100) / 100);
/** Денежная сумма, которая обязана быть больше нуля. */
const moneyPositive = () => money().pipe(z.number().positive());
/** Денежная сумма, которая может быть нулевой (например, доля приёмщика). */
const moneyNonNegative = () => money().pipe(z.number().min(0));

const expenseBaseSchema = z.object({
  ...expenseWorkspaceFields,
  category: z.enum(EXPENSE_CATEGORIES),
  // nullish, не optional: при смене категории (реклама → офис) устаревший канал/
  // сотрудника нужно уметь ЯВНО стереть — undefined выпадает из JSON и очисткой
  // не является (та же история, что у note ниже).
  source: z.enum(CLIENT_SOURCES).nullish(),
  agentId: z.guid().nullish(),
  amount: moneyPositive(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Формат месяца: ГГГГ-ММ"),
  // nullish: комментарий к расходу можно и стереть. Пока стояло просто optional,
  // очистка не сохранялась — undefined выпадает из JSON, ключа в PATCH нет.
  note: z.string().max(300).nullish(),
});

/** Что обязательно заполнить, чтобы позже можно было понять, куда ушли деньги:
 * реклама — канал (сумма без разбивки по каналам бесполезна для стоимости лида),
 * зарплата — сотрудник, офис/прочее — комментарий (иначе строка ничего не объясняет). */
export const expenseCreateSchema = expenseBaseSchema.superRefine((data, ctx) => {
  if (data.category === "ADVERTISING" && !data.source) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source"], message: "Укажите канал рекламы" });
  }
  if (data.category === "SALARY" && !data.agentId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["agentId"], message: "Укажите сотрудника" });
  }
  if ((data.category === "OFFICE" || data.category === "OTHER") && !data.note?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "Укажите комментарий — куда пошли деньги" });
  }
});

export const expenseUpdateSchema = expenseBaseSchema.partial().extend({
  /** Version read when opening the editor, not a fresh version fetched at save time. */
  version: z.number().int().nonnegative().optional(),
});

/** Объединение дубликатов: primary остаётся, duplicate вливается и удаляется. */
export const clientsMergeSchema = z
  .object({
    primaryId: z.guid(),
    duplicateId: z.guid(),
    /** Ручное объединение с карточки клиента (владелец 19.08.2026): агент сам
     *  подтверждает, что это один человек, даже если телефон/Telegram не совпали
     *  (например, клиент звонил с другого номера). Сервер по-прежнему проверяет
     *  права (clients.merge) — force снимает только автоматическую сверку
     *  контакта, не проверку доступа. */
    force: z.boolean().optional(),
  })
  .refine((d) => d.primaryId !== d.duplicateId, { message: "Нельзя объединить клиента с самим собой" });

/** Сообщения ИИ-ассистента (диалог передаётся целиком, сервер не хранит состояние). */
export const assistantRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      })
    )
    .min(1)
    .max(30),
});

/** 13 select-полей «характеристик» объекта, как на сайте (Property.details, JSON).
 * Каждое поле — строго одно из значений PROPERTY_DETAIL_OPTIONS или отсутствует
 * («—» на сайте значит «не задано» — клиент не должен присылать эту строку,
 * а просто опускать ключ). */
export const propertyDetailsSchema = z
  .object({
    balcony: z.enum(PROPERTY_DETAIL_OPTIONS.balcony).optional(),
    bathroom: z.enum(PROPERTY_DETAIL_OPTIONS.bathroom).optional(),
    ceilingHeight: z.enum(PROPERTY_DETAIL_OPTIONS.ceilingHeight).optional(),
    windows: z.enum(PROPERTY_DETAIL_OPTIONS.windows).optional(),
    heating: z.enum(PROPERTY_DETAIL_OPTIONS.heating).optional(),
    elevator: z.enum(PROPERTY_DETAIL_OPTIONS.elevator).optional(),
    parking: z.enum(PROPERTY_DETAIL_OPTIONS.parking).optional(),
    security: z.enum(PROPERTY_DETAIL_OPTIONS.security).optional(),
    yearBuilt: z.enum(PROPERTY_DETAIL_OPTIONS.yearBuilt).optional(),
    material: z.enum(PROPERTY_DETAIL_OPTIONS.material).optional(),
    internet: z.enum(PROPERTY_DETAIL_OPTIONS.internet).optional(),
    furniture: z.enum(PROPERTY_DETAIL_OPTIONS.furniture).optional(),
    appliances: z.enum(PROPERTY_DETAIL_OPTIONS.appliances).optional(),
  })
  .partial();

/**
 * Дата, которую НЕЛЬЗЯ очистить, но легко очистить по ошибке.
 *
 * `z.coerce.date()` прогоняет значение через `new Date(...)`, а `new Date(null)`
 * это 1 января 1970 года — то есть присланный null не отвергался, а МОЛЧА ставил
 * дату из прошлого века. Ошибка в интерфейсе или в стороннем вызове превращалась
 * бы в объект, «принятый в 1970-м», и заметили бы это только глазами.
 *
 * Здесь null сначала распознаётся как null, а потом отвергается с внятным текстом.
 */
const requiredDate = z
  .union([z.null(), z.coerce.date()])
  .refine((v) => v !== null, { message: "Дату нельзя очистить — только изменить" });

/**
 * Прислали дату БЕЗ времени?
 *
 * `new Date("2026-08-20")` — полночь UTC, то есть 05:00 по Душанбе. Интерфейс
 * шлёт такую строку ровно тогда, когда агент не заполнил поле времени, и код
 * дальше трактует её как «на этот день» (см. Interaction.nextActionDate).
 * Там, где время обязательно (показ), это надо отличать — иначе встреча молча
 * встаёт на пять утра, а напоминания уходят ночью.
 *
 * Признак — ровно полночь UTC. Настоящий показ в 05:00:00.000 по Душанбе
 * назначить нельзя: рабочий день начинается позже, а секунды и миллисекунды у
 * выбранного в интерфейсе времени всегда нулевые только вместе с минутами.
 */
export function isBareDate(value: Date): boolean {
  return (
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0
  );
}

/**
 * Координаты объекта — обе или ни одной (ночная проверка 24.09.2026, №184).
 * Одна широта без долготы ложилась в базу как есть, и точка на карте
 * оказывалась где угодно; очистка — тоже только обеих разом.
 */
function coordsPairIssue(
  data: { lat?: number | null; lng?: number | null },
  ctx: z.RefinementCtx
): void {
  const latSet = data.lat !== undefined && data.lat !== null;
  const lngSet = data.lng !== undefined && data.lng !== null;
  const latSent = data.lat !== undefined;
  const lngSent = data.lng !== undefined;
  if (latSet !== lngSet || latSent !== lngSent) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [latSet || latSent ? "lng" : "lat"], message: "Укажите обе координаты или ни одной" });
  }
}

const propertyBaseSchema = z.object({
  // Название больше не вводится вручную — сервер формирует его сам из типа/комнат/района
  // (buildPropertyTitle). Поле оставлено необязательным для обратной совместимости.
  title: z.string().optional(),
  type: z.enum(PROPERTY_TYPES),
  rooms: z.number().int().positive().optional(),
  areaSqm: z.number().positive(),
  /** Площадь участка в сотках — у дома и земли это главная цифра, м² строения её
   *  не заменяет (владелец 21.09.2026: «сотки» — отдельное поле объекта). */
  landAreaSotka: z.number().positive().max(100000).optional(),
  floor: z.number().int().optional(),
  totalFloors: z.number().int().optional(),
  /// Количество окон — обязательное поле карточки объекта из спецификации владельца
  /// (31.07.2026). Тип остекления в details.windows это другое: «пластиковые» не
  /// отвечает на вопрос «сколько».
  windowCount: z.number().int().min(0).max(100).optional(),
  price: moneyPositive(),
  currency: z.enum(CURRENCIES),
  /** Необязателен: закрытый объект может прийти без района — сервер достраивает
   *  его по координатам телефона (routes/properties/crud.ts). Для публичного
   *  объекта обязательность проверяется ниже, в superRefine. */
  districtId: z.guid().optional(),
  /** Необязателен по той же причине, что и район выше. */
  address: z.string().min(2).optional(),
  /** Ориентир — короткая фраза вроде «рядом с ТЦ Садбарг», «за Овиром» (пункт 10
   *  владельца, 23.09.2026): помогает покупателю и сотрудникам понять расположение
   *  объекта, когда точного адреса недостаточно. Свободный текст, необязателен. */
  landmark: z.string().trim().max(120).optional(),
  condition: z.enum(PROPERTY_CONDITIONS),
  amenities: z.array(z.string()).default([]),
  description: z.string().optional(),
  ownerContact: z.string().optional(),
  /** Заявка продавца (Client.kind === SELLER), из которой создан этот объект — нужна,
   * чтобы перенести таймер «Итог объекта» с клиента (заведён в момент исхода звонка
   * «Объект принят в работу») на карточку объекта, не сбрасывая 36-часовой отсчёт. */
  clientId: z.guid().optional(),
  /** Агент-интейкер (принял заявку продавца и отработал) — получает 0.5% со сделки.
   * Обязателен: для роли AGENT сервер молча подставляет самого создателя объекта,
   * для руководителя (ADMIN/DIRECTOR/MANAGER) должен быть выбран явно в форме —
   * см. проверку в apps/api/src/routes/properties.ts. Optional здесь только потому,
   * что схема общая для create и апдейта агентом (сервер сам его проставляет). */
  intakeAgentId: z.guid().optional(),
  /** Ссылка на видео-обзор в Instagram (Reels/пост) — необязательна: не у каждого
   * объекта сразу есть отснятое видео, дозаполняется позже через редактирование.
   * Нормализуется к каноническому виду https://www.instagram.com/reel/<CODE>/;
   * не-Instagram URL и произвольный текст отвергаются с понятной ошибкой. */
  instagramUrl: z
    .string()
    .max(300)
    .refine((v) => !v || isValidInstagramPostUrl(v), {
      message: "Ссылка должна вести на публикацию Instagram (instagram.com/reel/…, /p/… или /tv/…)",
    })
    .transform((v) => normalizeInstagramUrl(v) ?? undefined)
    .optional(),
  /** Тип документа (Договор/Техпаспорт и т.п.) — только для сотрудников, на сайт не уходит. */
  documents: z.string().max(200).optional(),
  /** Дата фактического приёма объекта в работу — по умолчанию сегодня, редактируется отдельно. */
  listingAcceptedAt: requiredDate.optional(),
  /** Координаты, выбранные вручную на карте. Если заданы — сервер сохраняет их как есть
   * и НЕ запускает фоновое геокодирование (оно бы перетёрло ручной выбор). Оба поля
   * задаются только вместе (проверяется в роуте). */
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  /** Стадия строительства — актуально для новостроек, необязательна. */
  stage: z.enum(PROPERTY_STAGES).optional(),
  /** Новостройки/Вторичка — отдельная ось от type (категория объекта). */
  marketType: z.enum(MARKET_TYPES).optional(),
  /** «Срочное объявление» — на сайте показывается бейджем; в CRM пока только хранится. */
  urgent: z.boolean().optional(),
  /** 13 select-характеристик объекта (этаж, отопление, лифт и т.п.) — как на сайте. */
  details: propertyDetailsSchema.optional(),
  /** SEO: заголовок вкладки браузера/сниппета в поиске. */
  metaTitle: z.string().max(70).optional(),
  /** SEO: описание под заголовком в выдаче поиска. */
  metaDescription: z.string().max(160).optional(),
  /** SEO: заголовок H1 страницы объекта на сайте (может отличаться от title). */
  h1: z.string().max(200).optional(),
  /** SEO-описание объекта (отдельно от description — витринного текста). */
  seoDesc: z.string().optional(),
  /** Несайтовый объект — не публикуется на сайте, минует конвейер фото/видео-модерации,
   * доступен клиенту только через приватную ссылку (см. Property.offSite в схеме
   * Prisma). Задаётся ТОЛЬКО при создании — propertyUpdateSchema его не принимает,
   * задним числом не проставляется (docs/plan-18-08-private-listings-and-video.md §1). */
  offSite: z.boolean().optional(),
  /** Имя продавца при создании объекта БЕЗ выбора существующей карточки из
   * SellerPicker — вместе с ownerContact (тут это телефон продавца) сервер сам
   * заводит или находит карточку клиента по последним 9 цифрам номера и связывает
   * через sellerClientId. С 21.08.2026 работает для ЛЮБОГО объекта, не только
   * offSite (владелец: «если продавца нет — например сосед — создать его прямо
   * при добавлении объекта»). Игнорируется, если уже выбран clientId — связь уже
   * есть, дублировать её нечем. Только при создании; propertyUpdateSchema его не
   * принимает. */
  sellerName: z.string().max(120).optional(),
});

/**
 * Обязательные поля объекта (спецификация владельца, Этап 4 «Создание объекта»):
 * «тип недвижимости, категория, адрес, район, площадь, количество комнат, этаж,
 * этажность, количество окон, цена, тип ремонта, описание объекта, контакт
 * собственника, фотографии, видео (если уже снято)». Фото/видео сюда не входят —
 * они загружаются отдельными запросами ПОСЛЕ создания карточки (архитектура
 * проекта: объект сначала сохраняется, потом получает материалы), требовать их
 * в этой схеме нечем. ОПИСАНИЕ сюда тоже не входит — оно не поле формы: сервер
 * генерирует его сам (SEO-текст, generateSeoFields) сразу при создании, точно
 * как требует спецификация («Описание... формируется автоматически»), и
 * добавлять для него отдельную ручную проверку значило бы требовать то, что
 * агент физически не заполняет.
 *
 * КОМНАТЫ/ЭТАЖ/ЭТАЖНОСТЬ/ОКНА — НЕ для участка (LAND): у земли нет этажей и окон,
 * и требовать эти поля значило бы вынуждать агента вписывать выдуманные числа.
 * Отступление от буквы спецификации ради здравого смысла — категория «Участок»
 * там же перечислена, но с этажами/окнами несовместима логически.
 */
export const propertyCreateSchema = propertyBaseSchema.superRefine((data, ctx) => {
  coordsPairIssue(data, ctx);
  // Район и адрес обязательны для любого объекта, который пойдёт на сайт и в
  // общую выдачу. Закрытый их не спрашивает: «только для своих» — это ровно
  // цена и продавец, а район с адресом сервер достраивает по координатам
  // телефона, если удалось их получить (routes/properties/crud.ts).
  if (!data.offSite) {
    if (!data.districtId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["districtId"], message: "Укажите район" });
    }
    if (!data.address || data.address.trim().length < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["address"], message: "Укажите адрес" });
    }
  }
  // Выбрана карточка продавца (clientId) — контакт собственника сервер берёт из неё
  // сам (см. routes/properties.ts): требовать его с формы значило бы заставлять
  // агента переписывать номер, которого он при маске даже не видит.
  if (!data.clientId && (!data.ownerContact || !data.ownerContact.trim())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ownerContact"], message: "Укажите контакт собственника" });
  } else if (
    data.ownerContact &&
    data.ownerContact.trim() &&
    !isMaskedClientPhone(data.ownerContact) &&
    !hasValidPhoneDigitCount(data.ownerContact)
  ) {
    // Та же проверка формата, что и у телефона клиента (clientPhoneSchema) — девять
    // значащих цифр после кода страны. Маску («+992•••••18», сервер сам подставит
    // настоящий номер из выбранной карточки продавца) не отвергаем — это не мусор.
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ownerContact"], message: "Введите корректный номер телефона" });
  }
  // ЗАКРЫТЫЙ ОБЪЕКТ СПРАШИВАЕТ РОВНО ДВА ПУНКТА — цену и продавца (владелец
  // 15.09.2026, дословно: «закрытый объект не имеет обязательных пунктов, кроме
  // как цена и продавец, чтобы было, за кем прикреплять; остальное можно не
  // делать»). Комнаты, этаж, этажность и окна дописываются потом из карточки:
  // такой объект заводят стоя в нём, между разговорами, и восемь обязательных
  // чисел означают, что его не заведут вовсе.
  //
  // Цена обязательна и без этой проверки — она обязательна для всех в
  // propertyBaseSchema. Продавец проверен выше, тоже для всех.
  //
  // Что обязательно у какого типа — одна таблица (propertyTypeFields.ts,
  // владелец 08.10.2026): у дома нет «этажа», у коммерции комнаты
  // необязательны, у участка нет ни комнат, ни этажей, ни окон. Поле, которого
  // у типа нет, сервер не проверяет и не сохраняет (transform ниже).
  if (propertyFieldShown(data.type, "floor")) {
    const floorError = floorRuleError(data.floor, data.totalFloors);
    if (floorError) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["floor"], message: floorError });
  }
  if (data.offSite) return;
  const missing: Array<[keyof typeof data & string, string]> = [
    ["rooms", "Укажите количество комнат"],
    ["floor", "Укажите этаж"],
    ["totalFloors", "Укажите этажность"],
    ["windowCount", "Укажите количество окон"],
  ];
  for (const [field, message] of missing) {
    if (propertyFieldRequired(data.type, field as "rooms") && data[field] === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    }
  }
})
  // Поля, которых у типа нет (этаж у дома, «новостройка» у участка, лифт у
  // дома), в базу не попадают, даже если старая вкладка или бот их прислали.
  .transform((data) => stripPropertyFieldsForType(data.type, data));

export const propertyUpdateSchema = propertyBaseSchema
  // offSite задаётся ТОЛЬКО при создании (см. комментарий у поля в propertyBaseSchema
  // выше) — PATCH его вообще не принимает, чтобы не потребовалась ещё одна проверка
  // «нельзя переключить задним числом» на каждом маршруте редактирования.
  .omit({ offSite: true, sellerName: true })
  .partial()
  .extend({
  status: z.enum(PROPERTY_STATUSES).optional(),
  soldPrice: moneyPositive().optional(),
  /**
   * ТОТ ЖЕ КЛАСС, ЧТО И У КЛИЕНТА (19.09.2026, см. clientUpdateSchema ниже):
   * `.partial()` не снимает `.default([])` с `amenities` в propertyBaseSchema,
   * и PATCH, который удобств не присылал вовсе, доезжал сюда с пустым списком —
   * а маршрут пишет разобранные поля в базу целиком (routes/properties/crud.ts),
   * то есть любая мелкая правка объекта молча стирала все его удобства.
   */
  amenities: z.array(z.string()).optional(),
  /**
   * Поля, которые нужно уметь ОЧИСТИТЬ. undefined в JSON не сериализуется, поэтому
   * PATCH такое поле просто не трогал: человек стирал контакт владельца, уходил с
   * фокуса, а после перезагрузки старый номер возвращался. Ровно эта же история уже
   * была с клиентом — см. clientUpdateSchema ниже.
   */
  // Проверки те же, что при создании — .nullish() добавляет только возможность
  // очистить поле, но не право положить в него что угодно.
  ownerContact: z.string().max(120).nullish(),
  landmark: z.string().trim().max(120).nullish(),
  instagramUrl: z
    .string()
    .max(300)
    .refine((v) => !v || isValidInstagramPostUrl(v), {
      message: "Ссылка должна вести на публикацию Instagram (instagram.com/reel/…, /p/… или /tv/…)",
    })
    .transform((v) => normalizeInstagramUrl(v) ?? null)
    .nullish(),
  documents: z.string().max(200).nullish(),
  landAreaSotka: z.number().positive().max(100000).nullish(),
  // Точку на карте можно и очистить (null), но только обе координаты разом —
  // см. coordsPairIssue (ночная проверка 24.09.2026, №184).
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  rooms: z.number().int().positive().nullish(),
  floor: z.number().int().nullish(),
  totalFloors: z.number().int().positive().nullish(),
  windowCount: z.number().int().min(0).max(100).nullish(),
  // Стадия строительства и «новостройка/вторичка» в базе НЕОБЯЗАТЕЛЬНЫ, и в форме у
  // них есть «— не указано —». Без .nullish() выбор этого пункта при редактировании
  // молча не сохранялся: undefined выпадает из JSON, ключа в запросе нет, старое
  // значение остаётся.
  stage: z.enum(PROPERTY_STAGES).nullish(),
  marketType: z.enum(MARKET_TYPES).nullish(),
  // listingAcceptedAt в базе NOT NULL, очищать его нечем — только менять.
  // И обязательно coerce: с карточки приходит "2026-07-25", а Prisma ждёт Date.
  listingAcceptedAt: requiredDate.optional(),
  /** Риелтор при СОЗДАНИИ объекта не назначается — он появляется автоматически
   * в момент сделки (агент клиента). Здесь оставлен как ручная корректировка
   * руководителя на карточке объекта (исключение, а не правило). */
  assignedAgentId: z.guid().nullable().optional(),
  /** Подпись под Reels — сгенерирована по шаблону при создании/перегенерации,
   *  но монтажёр правит текст руками перед публикацией; правку нужно сохранять. */
  reelsCaption: z.string().max(2000).nullish(),
  /**
   * ОПТИМИСТИЧНАЯ БЛОКИРОВКА (13.09.2026, аудит надёжности, находка 2). Форма
   * шлёт номер версии, который она прочитала при открытии карточки — сервер
   * пишет условно и отвечает 409, если версия успела измениться (см.
   * routes/properties/crud.ts). Необязательное поле: старый вызывающий, ещё не
   * присылающий его, обновляется как раньше, без проверки версии.
   */
  version: z.number().int().nonnegative().optional(),
})
  // Тот же формат-чек, что и при создании (propertyCreateSchema.superRefine) — не
  // дублируем правило «что такое телефон» второй раз буквально, дублируем только
  // вызов. Маска («+992•••••18») и null (очистка поля) проходят без проверки формата.
  .superRefine((data, ctx) => {
    coordsPairIssue(data, ctx);
    if (
      data.ownerContact &&
      data.ownerContact.trim() &&
      !isMaskedClientPhone(data.ownerContact) &&
      !hasValidPhoneDigitCount(data.ownerContact)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ownerContact"], message: "Введите корректный номер телефона" });
    }
  });

/** Минимум 9 значащих цифр (без учёта +/скобок/пробелов) — та же проверка используется
 *  и для номера собственника объекта (ownerContact) ниже, чтобы не заводить второе
 *  правило «что такое телефон» в одном проекте. */
export function hasValidPhoneDigitCount(v: string): boolean {
  return v.replace(/\D/g, "").length >= 9;
}

/** Минимум 9 значащих цифр (без учёта +/скобок/пробелов) — реальные номера в базе всегда
 *  такие (+992 и 9-значный местный номер); отсекает явный мусор вроде "abc123". */
const clientPhoneSchema = z
  .string()
  .min(5)
  // Скрытый маской номер отвергаем ОТДЕЛЬНО и раньше проверки длины: цифр в нём
  // тоже мало, но «введите корректный номер» на `+992•••••18` читается как поломка
  // CRM — сотрудник видит в поле ровно то, что ему показала сама CRM.
  .refine((v) => !isMaskedClientPhone(v), "Номер скрыт — менять его может только тот, кому он виден")
  .refine(hasValidPhoneDigitCount, "Введите корректный номер телефона");

/**
 * Желаемое место поиска покупателя — координата с радиусом (владелец 12.09.2026,
 * docs/geo-match-plan-12-09.md). Несколько мест на клиента: покупатель часто называет
 * два-три места сразу («ищу у ЦУМа или в 82-м микрорайоне»), одна точка это не покрывает.
 * Фундамент под гео-подбор объектов — сам подбор делает другой блок.
 */
const desiredPlaceSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().int().min(100).max(10000).default(1000),
  /** Как назвал место клиент или агент («ЦУМ», «82-й микрорайон»). */
  label: z.string().max(120).optional(),
});

const clientBaseSchema = z.object({
  fullName: z.string().min(2),
  /// Фамилия отдельным полем (спецификация: «имя, фамилия, телефон…» в карточке
  /// лида) — необязательна, старые карточки с именем одной строкой остаются как есть.
  lastName: z.string().max(100).optional(),
  phone: clientPhoneSchema,
  /**
   * ЗАПАСНЫЕ НОМЕРА (18.08.2026) — с которых клиент тоже может позвонить.
   *
   * Проверка та же, что у главного (clientPhoneSchema): второй номер должен быть
   * настоящим номером, иначе он бесполезен — по нему всё равно никого не узнать.
   * Заодно оттуда же приезжает запрет на замаскированный номер: сотрудник без
   * права видеть телефон не должен «сохранить» карточку с «+992•••••18» внутри.
   *
   * Потолок в десять штук — не бизнес-правило, а предохранитель: поле уходит в
   * массив Postgres и в поиск по входящему звонку, и вставленная целиком
   * телефонная книга превратила бы узнавание в перебор.
   *
   * Пустой массив разрешён и означает «очистить» — в отличие от прочих полей
   * карточки, тут не нужен null: у списка есть естественное пустое значение.
   */
  extraPhones: z.array(clientPhoneSchema).max(10).optional(),
  email: z.string().email().optional(),
  status: z.enum(CLIENT_STATUSES).default("NEW"),
  /** Вкладка, куда попадёт запись: покупатель (Клиенты) или продавец (Продавцы).
   * По умолчанию BUYER — старые вызовы без поля работают как раньше. */
  kind: z.enum(CLIENT_KINDS).default("BUYER"),
  source: z.enum(CLIENT_SOURCES),
  budgetMin: moneyPositive().optional(),
  budgetMax: moneyPositive().optional(),
  currency: z.enum(CURRENCIES).default("TJS"),
  desiredDistrictId: z.guid().optional(),
  desiredRooms: z.number().int().positive().optional(),
  /// Площадь «от» и этаж «от/до» — обязательные поля карточки лида по спецификации
  /// владельца (31.07.2026). Этаж парой, потому что самая частая просьба звучит как
  /// «не первый и не последний», и одним числом её не выразить.
  desiredAreaMin: z.number().int().positive().max(100000).optional(),
  desiredFloorMin: z.number().int().min(0).max(200).optional(),
  desiredFloorMax: z.number().int().min(0).max(200).optional(),
  desiredTotalFloors: z.number().int().min(1).max(200).optional(),
  /// Какое жильё ищет: квартира, дом, коммерция, участок.
  desiredType: z.enum(PROPERTY_TYPES).optional(),
  /// Адрес клиента: покупателю — где живёт, продавцу — адрес его объекта.
  address: z.string().max(300).optional(),
  /// Несколько желаемых мест поиска (см. desiredPlaceSchema выше) — фундамент под
  /// гео-подбор. Потолок в пять мест — предохранитель, а не бизнес-правило: столько
  /// ориентиров за один разговор клиент называет разве что в порядке исключения.
  /// Пустой массив разрешён и на PATCH означает «очистить список» — как и extraPhones
  /// выше, у списка есть естественное пустое значение, null не нужен.
  desiredPlaces: z.array(desiredPlaceSchema).max(5).optional(),
  /// «Личный лид» — агент привёл клиента сам, не через каналы компании.
  isPersonalLead: z.boolean().optional(),
  requirementsNotes: z.string().optional(),
  assignedAgentId: z.guid().optional(),
  force: z.boolean().optional(),
});

// null (очистка поля при редактировании) — тоже «границы нет», как и undefined.
const budgetRangeRefinement = (data: { budgetMin?: number | null; budgetMax?: number | null }) =>
  data.budgetMin == null || data.budgetMax == null || data.budgetMin <= data.budgetMax;
const budgetRangeIssue = {
  message: "Бюджет «от» не может быть больше бюджета «до»",
  path: ["budgetMax"],
};


// Этаж «от» не может быть выше этажа «до» — та же проверка, что у бюджета.
const floorRangeRefinement = (data: { desiredFloorMin?: number | null; desiredFloorMax?: number | null }) =>
  data.desiredFloorMin == null || data.desiredFloorMax == null || data.desiredFloorMin <= data.desiredFloorMax;
const floorRangeIssue = {
  message: "Этаж «от» не может быть больше этажа «до»",
  path: ["desiredFloorMax"],
};

export const clientCreateSchema = clientBaseSchema
  .refine(budgetRangeRefinement, budgetRangeIssue)
  .refine(floorRangeRefinement, floorRangeIssue);

/**
 * Поля, которые при редактировании можно ОЧИСТИТЬ. На создании пустое значение
 * означает «не заполнено» и просто не отправляется, а на правке пользователь должен
 * иметь возможность убрать однажды заданный бюджет, район, число комнат или заметки.
 * Пока здесь стоял только `.optional()`, форма отправляла undefined вместо null,
 * поле молча пропускалось, и старое значение оставалось в базе навсегда.
 */
export const clientUpdateSchema = clientBaseSchema
  .partial()
  .omit({ force: true })
  .extend({
    budgetMin: moneyPositive().nullish(),
    budgetMax: moneyPositive().nullish(),
    desiredDistrictId: z.guid().nullish(),
    desiredRooms: z.number().int().positive().nullish(),
    desiredAreaMin: z.number().int().positive().max(100000).nullish(),
    desiredFloorMin: z.number().int().min(0).max(200).nullish(),
    desiredFloorMax: z.number().int().min(0).max(200).nullish(),
    desiredTotalFloors: z.number().int().min(1).max(200).nullish(),
    desiredType: z.enum(PROPERTY_TYPES).nullish(),
    address: z.string().max(300).nullish(),
    requirementsNotes: z.string().nullish(),
    lastName: z.string().max(100).nullish(),
    /**
     * ПОЛЯ С ЗАВОДСКИМ ЗНАЧЕНИЕМ ПЕРЕОБЪЯВЛЕНЫ БЕЗ `.default()` (19.09.2026,
     * жалоба владельца «не получается изменять имя клиента, выдаёт ошибку» и
     * «статусы не меняются»).
     *
     * `.partial()` делает поле необязательным, но `.default()` ВНУТРИ него
     * продолжает подставлять значение, когда ключа в запросе нет — в zod это
     * не «частичный PATCH», а «PATCH с тремя лишними полями». Запрос «поменяй
     * только имя» (правка имени одним кликом в карточке, ClientDetail.tsx)
     * доезжал до маршрута как status="NEW", kind="BUYER", currency="TJS":
     * агент получал 403 «Состояние покупателя ставит CRM» и не мог
     * переименовать никого, у кого статус уже не «Новый»; руководителю правка
     * проходила, но сбрасывала статус на «Новый», писала в хронологию ложную
     * смену статуса и ставила `statusSetManuallyAt` — то есть замораживала
     * автостатусы на неделю после КАЖДОЙ правки карточки; у продавца kind
     * молча становился BUYER, и карточка пропадала из вкладки «Продавцы»;
     * долларовый бюджет пересчитывался как сомони.
     *
     * На создании (clientCreateSchema) заводские значения нужны и остаются —
     * здесь их не должно быть по определению: PATCH меняет ровно то, что
     * прислали.
     */
    status: z.enum(CLIENT_STATUSES).optional(),
    kind: z.enum(CLIENT_KINDS).optional(),
    currency: z.enum(CURRENCIES).optional(),
  })
  .refine(budgetRangeRefinement, budgetRangeIssue)
  // Та же пара проверок, что и на создании. Без неё PATCH с
  // `desiredFloorMin: 9, desiredFloorMax: 2` проходил, и подбор молча переставал
  // находить объекты. Частичность PATCH сохранена: обе границы == null (поле не
  // прислали или его очищают через null) — проверка не срабатывает.
  .refine(floorRangeRefinement, floorRangeIssue);

/**
 * Что агент подтверждает из предложения ИИ после телефонного разговора.
 *
 * Присылается ровно то, с чем агент согласился, — возможно, поправленное прямо в
 * окне: распознавание речи ошибается, и «пятьдесят» вместо «пятнадцать» должно
 * чиниться на месте, а не оставаться в карточке навсегда.
 *
 * Поля необязательные: подтвердить часть предложения — нормально. Отсутствующее
 * поле не трогается.
 *
 * ЯВНЫЙ null СТИРАЕТ ЗНАЧЕНИЕ ТОЛЬКО ПРИ `manualEdit: true`. Без этого признака
 * null значит «машина про это поле ничего не услышала»: в сохранённом предложении
 * обнулено и то, что совпало с карточкой, поэтому согласие с предложением стирало
 * из карточки бюджет, комнаты и запрос клиента (найдено владельцем 12.08.2026).
 */
export const cardSuggestionApplySchema = z.object({
  budgetMin: moneyPositive().nullish(),
  budgetMax: moneyPositive().nullish(),
  districtId: z.guid().nullish(),
  rooms: z.number().int().positive().max(20).nullish(),
  type: z.enum(PROPERTY_TYPES).nullish(),
  /** Ориентир словами клиента: «напротив кинотеатра Зебунисо», «за рынком Саховат». */
  address: z.string().max(300).nullish(),
  notes: z.string().max(2000).nullish(),
  /** Агент правил поля руками, а не просто согласился с машиной — см. выше. */
  manualEdit: z.boolean().optional(),
});

/** Руководитель вручную назначает непринятый/эскалированный лид конкретному агенту.
 *  accept=true — руководитель забирает заявку себе и сразу принимает её. */
export const clientAssignSchema = z.object({
  agentId: z.guid(),
  accept: z.boolean().optional(),
});

/** Оператор берёт диалог с ботом (Instagram/Facebook/WhatsApp) на себя или возвращает
 *  боту. pausedUntil=null — снять паузу (бот снова отвечает сам). */
export const botPauseSchema = z.object({
  pausedUntil: z.string().datetime().nullable(),
});

/**
 * Оценка ответа бота прямо в чате (17.09.2026): руководитель нажимает «Верно»/
 * «Неверно» под пузырём ответа — и правило уходит в промт сразу, без отдельного
 * экрана «Обучение бота».
 *
 * `messageKey` — `mid` реплики, если он есть, иначе `"idx:<index>"` (индекс
 * реплики в массиве `messages`) — так помечают старые записи без `mid` (см.
 * ConversationMessage в conversationMessage.ts).
 */
export const replyFeedbackSchema = z.object({
  messageKey: z.string().trim().min(1),
  verdict: z.enum(["good", "bad"]),
  note: z.string().trim().max(300).optional(),
});

/**
 * «Ждёт показ» без даты и времени сохраняется в базу, но ничего не запускает —
 * ни календаря, ни напоминания (спецификация, «Путь покупателя»: доп. п. 36
 * в docs/spec-compliance). Дата+время обязательны именно для этого исхода —
 * WAITING_CALL/WAITING_OPTIONS такой привязки не требуют, у них нет момента
 * встречи, который нужно на что-то забронировать.
 */
export const interactionCreateSchema = z
  .object({
    type: z.enum(INTERACTION_TYPES),
    propertyId: z.guid().optional(),
    notes: z.string().min(1),
    outcome: z.enum(INTERACTION_OUTCOMES).optional(),
    nextAction: z.string().optional(),
    nextActionDate: requiredDate.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.outcome === "WAITING_SHOWING" && !data.nextActionDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextActionDate"],
        message: "Укажите дату и время показа",
      });
    }
  });

/** Причина переноса/отмены показа руками из CRM — обязательный текст (решение
 *  владельца 16.08.2026: «Отменить» без причины теряет её след в карточке
 *  клиента). Короткая, но не пустая: планка в три символа пропускает «уехал» и
 *  «болен», но отсекает пустое поле и одиночный пробел/дефис. */
export const showingReasonSchema = z
  .string()
  .trim()
  .min(3, "Укажите причину — это попадёт в карточку клиента")
  .max(500);

/** Агент двигает показ руками из CRM: новое время встречи, всё остальное остаётся
 *  как есть. Объект не меняем — смена объекта это другая договорённость, её агент
 *  заводит обычной формой показа, где видно подбор и доступность. */
export const showingRescheduleSchema = z.object({
  at: requiredDate,
  reason: showingReasonSchema,
});

/** Агент снимает показ с календаря руками из CRM — причина обязательна тем же
 *  правилом, что и перенос: без неё запись в хронологии осталась бы просто
 *  «отменён», без единого слова о том, что случилось с клиентом. */
export const showingCancelSchema = z.object({
  reason: showingReasonSchema,
});

/// Причины отказа клиента — обязательный выбор при нажатии «Клиент отказался»,
/// чтобы следующий (более опытный) агент понимал контекст, а не начинал вслепую.
/// Ключи хранятся в Client.refusalReason; подписи — в REFUSAL_REASON_LABELS.
///
/// Спецификация (`docs/owner-spec-verbatim-31-07-01-08-2026.md:290-293`) требует
/// различать «купил сам» и «купил через другое агентство», и отдельно «продал
/// сам» у продавца — раньше все покупательские случаи были склеены в одну
/// BOUGHT_ELSEWHERE, а «продал сам» не существовало вовсе. BOUGHT_ELSEWHERE
/// оставлена в самом конце списка ТОЛЬКО для чтения старых записей
/// (`Client.refusalReason` — обычная строка, не enum в БД, старые значения
/// живы) — из формы отказа убрана, см. SELECTABLE_REFUSAL_REASONS.
export const REFUSAL_REASONS = [
  "EXPENSIVE",
  "WRONG_OBJECT",
  /// Добавлено 12.08.2026 (ТЗ владельца, «Завершить сделку → Без сделки», категория
  /// «Финансы»): недостаточный бюджет / не одобрили ипотеку / покупка отложена.
  "FINANCE_ISSUE",
  "CHANGED_MIND",
  /// Покупатель купил сам, без участия компании.
  "BOUGHT_SELF",
  /// Покупатель купил через другое агентство.
  "BOUGHT_VIA_OTHER_AGENCY",
  /// Добавлено 12.08.2026 (ТЗ, там же, категория «Клиент»): перестал выходить на
  /// связь — отдельно от CHANGED_MIND, потому что там клиент ЯВНО сказал «передумал»,
  /// а тут просто замолчал, и это разные истории для разбора причин потерь.
  "STOPPED_RESPONDING",
  /// Продавец продал сам, без участия компании.
  "SOLD_SELF",
  /// Продавец: сделка прошла мимо нас через другое агентство.
  "SOLD_VIA_OTHER_AGENCY",
  /// Продавец передумал продавать и снял объект.
  "WITHDRAWN_FROM_SALE",
  "NO_TRUST",
  "OTHER",
  /// Устаревшее: не различала «сам»/«другое агентство». Не выбирается заново.
  "BOUGHT_ELSEWHERE",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/// Что реально показывается в форме отказа — без устаревших значений.
export const SELECTABLE_REFUSAL_REASONS: readonly RefusalReason[] = REFUSAL_REASONS.filter(
  (r) => r !== "BOUGHT_ELSEWHERE",
);

/// Причины ПРОДАВЦА — покупателю их предлагать бессмысленно.
const SELLER_ONLY_REASONS: readonly RefusalReason[] = ["SOLD_SELF", "SOLD_VIA_OTHER_AGENCY", "WITHDRAWN_FROM_SALE"];
/// Причины ПОКУПАТЕЛЯ — соответственно, не для карточки продавца.
const BUYER_ONLY_REASONS: readonly RefusalReason[] = ["BOUGHT_SELF", "BOUGHT_VIA_OTHER_AGENCY"];

/**
 * Причины, подходящие этой карточке.
 *
 * Список не фильтровался вовсе, и в окне «Без сделки» у ПОКУПАТЕЛЯ висели «Продал
 * самостоятельно», «Продал через другое агентство» и «Снял с продажи» — три пункта
 * из двенадцати, которые к нему не относятся никак, а сервер их принимал. Для
 * OTHER (работа/аренда/прочее) оставляем общий набор: там нет ни покупки, ни
 * продажи, и сужать не по чему.
 */
export function selectableRefusalReasonsFor(kind: "BUYER" | "SELLER" | "OTHER" | undefined): readonly RefusalReason[] {
  if (kind === "BUYER") return SELECTABLE_REFUSAL_REASONS.filter((r) => !SELLER_ONLY_REASONS.includes(r));
  if (kind === "SELLER") return SELECTABLE_REFUSAL_REASONS.filter((r) => !BUYER_ONLY_REASONS.includes(r));
  return SELECTABLE_REFUSAL_REASONS;
}

export const REFUSAL_REASON_LABELS: Record<RefusalReason, string> = {
  EXPENSIVE: "Дорого — не сошлись по цене",
  WRONG_OBJECT: "Не подошли объекты (район, планировка, состояние)",
  FINANCE_ISSUE: "Финансы — бюджет/ипотека не одобрены, покупка отложена",
  CHANGED_MIND: "Передумал покупать / отложил",
  BOUGHT_SELF: "Купил самостоятельно",
  BOUGHT_VIA_OTHER_AGENCY: "Купил через другое агентство",
  STOPPED_RESPONDING: "Перестал выходить на связь",
  SOLD_SELF: "Продал самостоятельно",
  SOLD_VIA_OTHER_AGENCY: "Продал через другое агентство",
  WITHDRAWN_FROM_SALE: "Снял с продажи",
  NO_TRUST: "Не сложился контакт с агентом",
  OTHER: "Другое (см. комментарий)",
  BOUGHT_ELSEWHERE: "Купил самостоятельно / в другом месте (устар., см. BOUGHT_SELF/BOUGHT_VIA_OTHER_AGENCY)",
};

/**
 * Причины, после которых карточка уходит НЕ следующему агенту, а в службу
 * безопасности (спецификация владельца; сужено 03.09.2026, план §E).
 *
 * Объединяет их одно: сделка реально могла состояться НА СТОРОНЕ — клиент купил
 * сам, продавец продал через другое агентство. Это может быть правдой, а может
 * быть способом увести сделку и закрыть карточку красиво. Отличить одно от
 * другого по тексту в CRM нельзя, поэтому решение принимает человек.
 *
 * «Дорого», «не подошли объекты» — сюда НЕ входят изначально: обычный исход
 * работы. «Передумал» (CHANGED_MIND) и «снял с продажи» (WITHDRAWN_FROM_SALE)
 * ТОЖЕ убраны отсюда 03.09.2026 (решение владельца, план §E) — они означают ровно
 * то же самое: клиент/продавец просто отказался от сделки, а не увёл её на
 * сторону. Гонять их через проверку СБ значило утопить настоящие случаи в
 * потоке. Оба остаются обычными значениями REFUSAL_REASONS — отказ по-прежнему
 * фиксируется и виден в карточке, только без ручной проверки человеком.
 *
 * ИНИЦИАТОР БОЛЬШЕ НЕ УЧАСТВУЕТ В РЕШЕНИИ (тоже 03.09.2026, план §E). До этой
 * правки развилку решал initiator==="CLIENT" ИЛИ причина из этого списка
 * (routes/clients/lifecycle.ts, POST /:id/refuse, и routes/me.ts::refuseSellerClient
 * — оба места звали проверку отдельно, и оба были поправлены синхронно) —
 * отсюда «дорого» со слов самого клиента уходило в СБ наравне с «купил сам».
 * Теперь решает ТОЛЬКО причина: не важно, кто произнёс «купил сам» — клиент
 * агенту или агент со слов клиента, — сделка одинаково могла уйти на сторону.
 */
export const REASONS_REQUIRING_SECURITY_REVIEW: readonly RefusalReason[] = [
  "BOUGHT_SELF",
  "BOUGHT_VIA_OTHER_AGENCY",
  "SOLD_SELF",
  "SOLD_VIA_OTHER_AGENCY",
  /// Устаревшее значение (см. REFUSAL_REASONS) — не различало «сам»/«через
  /// агентство», но в обоих случаях сделка уходила на сторону; старые карточки
  /// с этой причиной уже могли попасть в СБ, поведение для них не меняем.
  "BOUGHT_ELSEWHERE",
];

export const SECURITY_REVIEW_STATES = ["PENDING", "CLEARED", "CONFIRMED"] as const;
export type SecurityReviewState = (typeof SECURITY_REVIEW_STATES)[number];

export const SECURITY_REVIEW_LABELS: Record<SecurityReviewState, string> = {
  PENDING: "Ждёт проверки СБ",
  CLEARED: "Закрыт после проверки СБ",
  CONFIRMED: "Закрыт: нарушение подтверждено",
};

/**
 * КТО ЗАВЕРШИЛ РАБОТУ — обязательный выбор из спецификации владельца (31.07.2026).
 *
 * Поля не было вовсе, и развилку «в службу безопасности или следующему агенту»
 * решала одна причина. Это не одно и то же: «дорого» от клиента и «дорого» со слов
 * агента — разные истории, и владелец прямо написал, что инициатор клиента ведёт в
 * СБ, а инициатор агента, компании или собственника — к передаче дальше.
 */
export const REFUSAL_INITIATORS = ["CLIENT", "AGENT", "OWNER", "COMPANY"] as const;
export type RefusalInitiator = (typeof REFUSAL_INITIATORS)[number];

export const REFUSAL_INITIATOR_LABELS: Record<RefusalInitiator, string> = {
  CLIENT: "Клиент",
  AGENT: "Агент",
  OWNER: "Собственник",
  COMPANY: "Компания",
};

/** Причины, при которых обязательно назвать агентство-конкурента. */
export const REASONS_REQUIRING_COMPETITOR: readonly RefusalReason[] = [
  "BOUGHT_VIA_OTHER_AGENCY",
  "SOLD_VIA_OTHER_AGENCY",
  /// Устаревшее значение (см. REFUSAL_REASONS) — не различало «сам»/«через
  /// агентство», но исторически требовало конкурента, оставляем как было.
  "BOUGHT_ELSEWHERE",
];

/**
 * «Завершить сделку → Без сделки» (ТЗ п. 16-18, переработка 12.08.2026 из бывшего
 * «Клиент отказался», POST /clients/:id/refuse). Доступна только после первого
 * проведённого показа — до этого агент закрывает клиента через «Передача» или
 * «Неактивный» (см. lib/clientTransfer.ts, lib/clientWorkStatus.ts), не через это.
 *
 * Причина обязательна всегда. Комментарий — тоже обязателен всегда (решение
 * владельца 11.08.2026): пункт из списка без пары слов своими словами не
 * объясняет руководству, что на самом деле произошло, когда оно открывает
 * «Потерянных» месяц спустя. До этого решения комментарий требовался только при
 * причине «Другое» — здесь схема проверяет лишь то, что поле вообще не пустое;
 * минимум длины (20 символов) — уже на сервере, в самом маршруте
 * (lib/clientRefuse.ts), литералом: поле `Settings.refusalCommentMinLength`
 * не читалось нигде и убрано из API настроек 13.09.2026 (колонка в БД пока не
 * тронута). Название
 * конкурента — при «купил/продал через другое агентство»: спецификация требует
 * знать, к кому уходят сделки, иначе разбор потерь не на чем строить. «Что
 * приобрёл клиент?» — при «купил самостоятельно» (ТЗ п. 18): агент может указать
 * объект/тип недвижимости, который клиент выбрал в итоге.
 */
export const clientRefuseSchema = z
  .object({
    reason: z.enum(REFUSAL_REASONS),
    initiator: z.enum(REFUSAL_INITIATORS),
    // Необязателен (владелец 18.08.2026: «упрости максимум») — было обязательным
    // при любой причине, требование снято.
    comment: z.string().trim().max(1000).optional().default(""),
    competitorName: z.string().max(200).optional(),
    /**
     * Только при reason="BOUGHT_SELF" — и НЕобязательно даже тогда.
     *
     * ТЗ п. 18 дословно: «появляется дополнительное поле „Что приобрёл клиент?“
     * Агент МОЖЕТ указать объект/тип недвижимости и дополнительную информацию».
     * Требовать его нельзя: агент часто и не знает, что именно человек купил, а
     * обязательное поле в такой ситуации заполняют мусором.
     */
    boughtWhat: z.string().trim().max(500).optional(),
    /** Голосовая заметка к комментарию (кнопка микрофона) — необязательна. */
    voiceNoteUrl: voiceNoteUrlSchema.optional(),
    voiceNoteTranscript: z.string().trim().max(4000).optional(),
  })
  .superRefine((data, ctx) => {
    if (REASONS_REQUIRING_COMPETITOR.includes(data.reason) && !data.competitorName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["competitorName"],
        message: "Укажите, через какое агентство прошла сделка",
      });
    }
  });

/**
 * ЗАЯВКА НА УДАЛЕНИЕ КЛИЕНТА (решение владельца 30.08.2026).
 *
 * Дословно: «дать агентам возможность направить клиента на удаление на моё
 * рассмотрение… в базе запрос нереальный или пустышка». Сам агент карточку не
 * удаляет никогда: удаление в Корзину остаётся за правом `clients.delete`
 * (директор/админ), агент лишь называет причину, а решение принимает человек.
 *
 * Таксономия СВОЯ, а не REFUSAL_REASONS: там «почему сделка не состоялась» —
 * карточка живая и остаётся в базе; здесь «почему этой карточки не должно быть
 * в базе вовсе». Смешать их значило бы предложить агенту «дорого» как повод
 * стереть клиента.
 *
 * Наборы у продавца и покупателя РАЗНЫЕ (прямое требование владельца: «окно для
 * продавца и для покупателя имеют разные варианты выбора — не путать»), поэтому
 * список фильтруется так же, как в окне «Без сделки»
 * (см. selectableRefusalReasonsFor выше).
 */
export const DELETE_REQUEST_REASONS = [
  "DUPLICATE",
  "WRONG_NUMBER",
  "NO_CONTACT_EVER",
  "NOT_A_CLIENT",
  "RENT_ONLY",
  "JOB_OR_OTHER",
  "NOT_OWNER",
  "NO_OBJECT",
  /**
   * ПЕРЕДУМАЛ ПРОДАВАТЬ (пачка 13, 11.09.2026). Отдельно от NO_OBJECT
   * («пустышка, продавать нечего» — объекта никогда и не было) и от
   * PROPERTY_DELETE_REQUEST_REASONS.OWNER_CANCELLED (там снимают ОБЪЕКТ, а
   * карточка продавца остаётся): здесь продавец сам отказался от идеи продажи
   * ДО того, как объект вообще завели, и просит закрыть карточку. Не штрафует
   * агента — обычный, ожидаемый исход работы, а не потерянный лид; в отчётах
   * считается отдельной строкой от «пустышки», чтобы не путать «мы бы не
   * продали никогда» с «человек передумал».
   */
  "CHANGED_MIND",
  "TEST_CARD",
  "OTHER",
] as const;
export type DeleteRequestReason = (typeof DELETE_REQUEST_REASONS)[number];

/** Причины ПОКУПАТЕЛЯ — продавцу их предлагать бессмысленно. */
const BUYER_ONLY_DELETE_REASONS: readonly DeleteRequestReason[] = ["NOT_A_CLIENT", "JOB_OR_OTHER"];
/** Причины ПРОДАВЦА — соответственно, не для карточки покупателя. */
const SELLER_ONLY_DELETE_REASONS: readonly DeleteRequestReason[] = ["NOT_OWNER", "NO_OBJECT", "CHANGED_MIND"];

/**
 * Подписи РАЗНЫЕ для продавца и покупателя даже у общих ключей: «дубль» у
 * покупателя — «этот человек уже есть другой карточкой», у продавца — «этот
 * собственник уже есть», а RENT_ONLY у одного «ищет только аренду», у другого
 * «сдаёт, а не продаёт». Один общий словарь пришлось бы писать обтекаемо, и
 * агент выбирал бы вслепую — поэтому словаря два, а общий (ниже) остаётся для
 * чтения уже сохранённых заявок в очереди руководства.
 */
export const DELETE_REQUEST_REASON_LABELS_BUYER: Record<DeleteRequestReason, string> = {
  DUPLICATE: "Дубль — этот человек уже есть в CRM другой карточкой",
  WRONG_NUMBER: "Ошиблись номером — это не тот человек",
  NO_CONTACT_EVER: "Номер нерабочий: ни разу не дозвонились и не ответил в переписке",
  NOT_A_CLIENT: "Не клиент — реклама, спам, посторонний вопрос",
  RENT_ONLY: "Ищет только аренду — мы этим не занимаемся",
  JOB_OR_OTHER: "Не по покупке — искал работу или другой вопрос",
  NOT_OWNER: "Не собственник — посредник или риелтор другого агентства",
  NO_OBJECT: "Объекта нет — пустышка, продавать нечего",
  // Продавцу не предлагается (SELLER_ONLY_DELETE_REASONS), но словарь — Record
  // по всем ключам; покупательский вариант формулируем нейтрально на случай
  // чтения старой заявки, заведённой до фильтрации по типу карточки.
  CHANGED_MIND: "Передумал — сделка не нужна",
  TEST_CARD: "Тестовая карточка, заведена по ошибке",
  OTHER: "Другое — опишите в комментарии",
};

export const DELETE_REQUEST_REASON_LABELS_SELLER: Record<DeleteRequestReason, string> = {
  ...DELETE_REQUEST_REASON_LABELS_BUYER,
  DUPLICATE: "Дубль — этот собственник уже есть в CRM",
  NO_CONTACT_EVER: "Номер нерабочий: ни разу не вышел на связь",
  RENT_ONLY: "Сдаёт в аренду, а не продаёт",
  CHANGED_MIND: "Передумал продавать — отказался от идеи до объекта",
};

/** Общий словарь — для очереди руководства и истории, где тип карточки уже не
 *  всегда под рукой. В самом окне выбора используйте deleteReasonLabelsFor. */
export const DELETE_REQUEST_REASON_LABELS: Record<DeleteRequestReason, string> = DELETE_REQUEST_REASON_LABELS_BUYER;

/** Подписи, подходящие типу карточки (продавец видит свои формулировки). */
export function deleteReasonLabelsFor(
  kind: "BUYER" | "SELLER" | "OTHER" | undefined
): Record<DeleteRequestReason, string> {
  return kind === "SELLER" ? DELETE_REQUEST_REASON_LABELS_SELLER : DELETE_REQUEST_REASON_LABELS_BUYER;
}

/**
 * Причины, подходящие этой карточке. Зеркально selectableRefusalReasonsFor:
 * покупателю не предлагаем «не собственник» и «объекта нет», продавцу — «искал
 * работу» и «реклама/спам». Для OTHER (прочие обращения) оставляем общий набор:
 * там нет ни покупки, ни продажи, и сужать не по чему.
 */
export function selectableDeleteReasonsFor(
  kind: "BUYER" | "SELLER" | "OTHER" | undefined
): readonly DeleteRequestReason[] {
  if (kind === "BUYER") return DELETE_REQUEST_REASONS.filter((r) => !SELLER_ONLY_DELETE_REASONS.includes(r));
  if (kind === "SELLER") return DELETE_REQUEST_REASONS.filter((r) => !BUYER_ONLY_DELETE_REASONS.includes(r));
  return DELETE_REQUEST_REASONS;
}

/** Состояния заявки — ClientDeleteRequest.status (строка, не enum в БД). */
export const DELETE_REQUEST_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type DeleteRequestStatus = (typeof DELETE_REQUEST_STATUSES)[number];

export const DELETE_REQUEST_STATUS_LABELS: Record<DeleteRequestStatus, string> = {
  PENDING: "Ждёт решения",
  APPROVED: "Одобрена — карточка в Корзине",
  REJECTED: "Отклонена",
};

/**
 * POST /clients/:id/delete-request — агент просит удалить карточку.
 *
 * Комментарий НЕобязателен (владелец: «комментарий необязательный, достаточно
 * выбрать причину») — кроме «Другое», где без пары слов заявка ничего не
 * объясняет тому, кто будет её рассматривать.
 */
export const clientDeleteRequestSchema = z
  .object({
    reason: z.enum(DELETE_REQUEST_REASONS),
    comment: z.string().trim().max(1000).optional(),
    /** Голосовая заметка к комментарию (кнопка микрофона) — необязательна. */
    voiceNoteUrl: voiceNoteUrlSchema.optional(),
    voiceNoteTranscript: z.string().trim().max(4000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.reason === "OTHER" && !data.comment?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comment"],
        message: "Опишите причину в комментарии",
      });
    }
  });

/** Отказ по заявке. Причина ОБЯЗАТЕЛЬНА: «отклонено» без объяснения агенту
 *  ничего не говорит — он заведёт такую же заявку завтра. */
export const clientDeleteRequestRejectSchema = z.object({
  decisionNote: z.string().trim().min(1, "Напишите, почему заявка отклонена").max(1000),
});

/** Одобрение — комментарий необязателен: решение и так видно по Корзине. */
export const clientDeleteRequestApproveSchema = z.object({
  decisionNote: z.string().trim().max(1000).optional(),
});

/**
 * ЗАЯВКА НА УДАЛЕНИЕ ОБЪЕКТА (31.08.2026) — зеркало ClientDeleteRequest выше,
 * то же устройство и то же решение владельца, распространённое на карточки
 * объектов. Таксономия своя (не DELETE_REQUEST_REASONS): у объекта нет
 * покупателя/продавца, зато есть собственник и конкретная сделка/публикация,
 * которых у клиента не бывает.
 */
export const PROPERTY_DELETE_REQUEST_REASONS = [
  "DUPLICATE",
  "TEST_CARD",
  "OWNER_CANCELLED",
  "SOLD_ELSEWHERE",
  "WRONG_DATA",
  "OTHER",
] as const;
export type PropertyDeleteRequestReason = (typeof PROPERTY_DELETE_REQUEST_REASONS)[number];

export const PROPERTY_DELETE_REQUEST_REASON_LABELS: Record<PropertyDeleteRequestReason, string> = {
  DUPLICATE: "Дубль — этот объект уже есть в CRM другой карточкой",
  TEST_CARD: "Тестовая карточка, заведена по ошибке",
  OWNER_CANCELLED: "Собственник отказался — передумал продавать через агентство",
  SOLD_ELSEWHERE: "Продан в обход агентства — сделка прошла не через нас",
  WRONG_DATA: "Создан по ошибке — не тот объект или неверные данные",
  OTHER: "Другое — опишите в комментарии",
};

/**
 * POST /properties/:id/delete-request — агент просит удалить карточку объекта.
 * Комментарий НЕобязателен — кроме «Другое», где без пары слов заявка ничего
 * не объясняет тому, кто будет её рассматривать.
 */
export const propertyDeleteRequestSchema = z
  .object({
    reason: z.enum(PROPERTY_DELETE_REQUEST_REASONS),
    comment: z.string().trim().max(1000).optional(),
    /** Голосовая заметка к комментарию (кнопка микрофона) — необязательна. */
    voiceNoteUrl: voiceNoteUrlSchema.optional(),
    voiceNoteTranscript: z.string().trim().max(4000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.reason === "OTHER" && !data.comment?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comment"],
        message: "Опишите причину в комментарии",
      });
    }
    /**
     * «ПРОДАН В ОБХОД АГЕНТСТВА» — КОММЕНТАРИЙ ОБЯЗАТЕЛЕН (владелец 09.09.2026).
     *
     * Ценность не в тексте, а в том, что ложь становится КОНКРЕТНОЙ. Общая ложь
     * ничего не стоит, названное агентство проверяемо: если имя повторяется от
     * заявки к заявке, это уже не отказ клиента, а канал утечки. Эта же причина
     * уходит в СБ автоматически (см. lib/sellerRefusalReview.ts).
     */
    /**
     * МИНИМУМ 20 СИМВОЛОВ (пачка 13, 11.09.2026, владелец: «продано мимо
     * агентства»). Одного слова недостаточно: короткая отписка «продали» не даёт
     * СБ ничего проверить — нужно хоть какое-то описание (какое агентство, кто
     * сказал), а не формальная галочка ради прохождения формы.
     */
    if (data.reason === "SOLD_ELSEWHERE" && (data.comment?.trim().length ?? 0) < 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comment"],
        message: "Опишите подробнее (от 20 символов): через какое агентство прошла сделка",
      });
    }
  });

/** Отказ по заявке на удаление объекта. Причина ОБЯЗАТЕЛЬНА — см. clientDeleteRequestRejectSchema. */
export const propertyDeleteRequestRejectSchema = z.object({
  decisionNote: z.string().trim().min(1, "Напишите, почему заявка отклонена").max(1000),
});

/** Одобрение — комментарий необязателен: решение и так видно по Корзине. */
export const propertyDeleteRequestApproveSchema = z.object({
  decisionNote: z.string().trim().max(1000).optional(),
});

/**
 * ЗАЯВКА НА ПЕРЕСМОТР ЧИСЛА ОБЪЕКТОВ (владелец 06.09.2026, разбор слепых зон
 * п.3; роль добавлена 07.09.2026 для симметрии с покупателем) — зеркало
 * clientDeleteRequestSchema выше: число пишет ИИ, агент может только
 * предложить своё и объяснить почему, решает руководитель. role различает
 * сторону: SELLER — sellerDeclaredPropertyCount, BUYER — buyerDesiredPropertyCount
 * (у клиента с dualIntent это разные, независимые заявки).
 */
export const propertyCountDisputeRoleSchema = z.enum(["SELLER", "BUYER"]);

export const propertyCountDisputeSchema = z.object({
  role: propertyCountDisputeRoleSchema,
  proposedCount: z.number().int().min(0).max(999),
  reason: z.string().trim().min(1, "Объясните, почему число ИИ неверное").max(1000),
});

/** Отказ — причина обязательна, см. clientDeleteRequestRejectSchema. */
export const propertyCountDisputeRejectSchema = z.object({
  decisionNote: z.string().trim().min(1, "Напишите, почему заявка отклонена").max(1000),
});

/** Одобрение — комментарий необязателен. */
export const propertyCountDisputeApproveSchema = z.object({
  decisionNote: z.string().trim().max(1000).optional(),
});

/**
 * Причины передачи клиента другому агенту (ТЗ п. 19) — доступна только после
 * первого проведённого показа (решение владельца, голосовое 12.08.2026). Отдельная
 * таксономия от REFUSAL_REASONS: там «почему сделка не состоялась», здесь —
 * «почему я не продолжаю вести именно я».
 */
/**
 * СУЖЕНО ДО ОДНОЙ ПРИЧИНЫ (задача F, план вечерней сессии 03-04.09.2026, решение
 * владельца): «Передача» живому агенту остаётся только для NO_TRUST — «не
 * сложился контакт с агентом», случай, который реально решается сменой
 * человека. Остальные семь причин здесь ниже (CANT_HANDLE...OTHER) больше НЕ
 * выбираются агентом (см. SELECTABLE_TRANSFER_REASONS/clientTransferSchema
 * ниже) — они остаются в массиве и в словаре подписей ТОЛЬКО для того, чтобы
 * старые записи хронологии (Interaction.notes собран из TRANSFER_REASON_LABELS
 * в момент передачи) продолжали читаться человеческим текстом, а не «undefined».
 * «Дорого» / «не подошли объекты» / «финансы» (REFUSAL_REASONS.EXPENSIVE/
 * WRONG_OBJECT/FINANCE_ISSUE — другая таксономия, см. ниже) больше не ведут ни
 * к передаче, ни к обычному отказу — они уходят в состояние «Отложенные»
 * (Client.workStatus=DEFERRED, см. lib/deferredClients.ts на сервере).
 */
export const TRANSFER_REASONS = [
  "NO_TRUST",
  "CANT_HANDLE",
  "NEEDS_DIFFERENT_APPROACH",
  "CANT_MATCH_PROPERTY",
  "NOT_INTERESTED_IN_OFFERS",
  "NOT_ENOUGH_TIME",
  "AT_LEAD_LIMIT",
  "BETTER_FIT",
  "OTHER",
] as const;
export type TransferReason = (typeof TRANSFER_REASONS)[number];
export const TRANSFER_REASON_LABELS: Record<TransferReason, string> = {
  NO_TRUST: "Не сложился контакт с агентом",
  CANT_HANDLE: "Не справляюсь с клиентом",
  NEEDS_DIFFERENT_APPROACH: "Клиент требует другой подход",
  CANT_MATCH_PROPERTY: "Не смог подобрать подходящий объект",
  NOT_INTERESTED_IN_OFFERS: "Клиент не заинтересован в предложенных объектах",
  NOT_ENOUGH_TIME: "Недостаточно времени",
  AT_LEAD_LIMIT: "Нахожусь на максимальном лимите",
  BETTER_FIT: "Другой агент лучше подходит для этого клиента",
  OTHER: "Другое (см. комментарий)",
};

/** Что реально предлагает форма «Передать» — см. документацию TRANSFER_REASONS выше. */
export const SELECTABLE_TRANSFER_REASONS: readonly TransferReason[] = ["NO_TRUST"];

/**
 * POST /clients/:id/transfer — агент передаёт клиента следующему по KPI.
 *
 * `reason` принимает ТОЛЬКО "NO_TRUST" (задача F, см. SELECTABLE_TRANSFER_REASONS
 * выше) — z.literal, а не z.enum(TRANSFER_REASONS): семь старых причин остаются
 * в типе TransferReason ради чтения истории, но новая передача с ними не
 * проходит валидацию границы, а не просто скрыта в интерфейсе. superRefine для
 * OTHER больше не нужен — OTHER этой схемой не принимается вовсе.
 */
export const clientTransferSchema = z.object({
  reason: z.literal("NO_TRUST"),
  comment: z.string().trim().max(1000).optional(),
  /** Голосовая заметка к комментарию (кнопка микрофона) — необязательна. */
  voiceNoteUrl: voiceNoteUrlSchema.optional(),
  voiceNoteTranscript: z.string().trim().max(4000).optional(),
});

/**
 * clientDeactivateSchema / POST /clients/:id/deactivate УБРАНЫ ЦЕЛИКОМ
 * (владелец 16.09.2026): это была схема последней ручной кнопки перевода в
 * Неактивные (DeactivateClientModal.tsx на карточке клиента). Агент больше не
 * выбирает причину сам ни в одном месте интерфейса — только автоматика
 * (ai/callAnalysis.ts, lib/clientInactiveTextDetector.ts,
 * lib/silentClientAutoDeactivate.ts), которая вызывает deactivateClient()
 * напрямую, минуя HTTP и эту схему.
 */

/**
 * Приём лида (POST /clients/:id/accept).
 *
 * Тело почти всегда пустое. `releaseClientId` появляется в одном случае: агент
 * берёт лид по СВОЕМУ объекту, портфель уже полон, и он выбрал, кого из обычных
 * клиентов отдать другому агенту, чтобы освободить место (решение владельца
 * 11.08.2026). Сервер проверяет, что выбранный клиент действительно из его
 * обычных активных, — выбор приходит от интерфейса и доверять ему нельзя.
 */
export const leadAcceptSchema = z.object({
  releaseClientId: z.guid().optional(),
});

/// Отправка подобранных объектов клиенту в его канал (POST /clients/:id/send-properties).
/// До пяти за раз: длинное сообщение со ссылками читают по диагонали, а канал
/// (WhatsApp/Instagram) склонен резать простыни текста.
export const sendPropertiesSchema = z.object({
  propertyIds: z.array(z.guid()).min(1).max(5),
  /**
   * Диалог инбокса, из которого нажали «Отправить» (28.09.2026): `<uuid>` для
   * WhatsApp/Instagram/Messenger/сайта, `tg_<uuid>` для Telegram. Без него
   * сервер выбирал «последний» диалог клиента сам — и объект из открытого
   * Instagram-чата улетал в пустой WhatsApp, где Meta его не пропускала.
   */
  conversationId: z.string().min(1).max(80).optional(),
  /**
   * Только подготовить текст и ссылки, ничего не отправляя (28.09.2026). Когда
   * заранее известно, что мессенджер не пропустит (окно Meta закрыто, клиент не
   * писал), телефон сразу показывает «СМС / Поделиться / Скопировать» — без
   * вопроса «клиент сразу получит» и без заведомо проваленной попытки.
   */
  prepareOnly: z.boolean().optional(),
});
export type SendPropertiesInput = z.infer<typeof sendPropertiesSchema>;

/**
 * Куда уйдёт объект, отправленный из CRM (GET /clients/:id/send-target) —
 * агент видит это ДО нажатия, а не узнаёт из отказа Meta после.
 *
 * `windowOpen` — правило Meta «свободный текст только в течение суток после
 * сообщения клиента»; у Telegram и чата на сайте окна нет, там всегда true.
 */
export interface SendTargetInfo {
  /** Канал диалога, куда уйдёт сообщение; null — клиент не писал ни в один мессенджер. */
  channel: "WHATSAPP" | "INSTAGRAM" | "FACEBOOK" | "TELEGRAM" | "WEBSITE" | null;
  /** Канал включён и ключи в Настройках заданы. */
  channelEnabled: boolean;
  windowOpen: boolean;
  /** Когда клиент последний раз писал в этот диалог (ISO), если писал. */
  lastClientMessageAt: string | null;
  /** Можно ли отправить ссылку по СМС: подключены и номер клиента таджикский. */
  smsAvailable: boolean;
  /** Одна фраза для агента: куда уйдёт или почему не уйдёт и что делать. */
  hint: string;
}

/**
 * Запасной путь, когда мессенджер не пропустил сообщение (закрыто окно Meta,
 * канал выключен, клиент не писал): тот же текст и те же ссылки, что ушли бы
 * клиенту, — агент копирует или отправляет их сам, а не начинает заново.
 */
export interface SendPropertiesFallback {
  text: string;
  links: { propertyId: string; shortId: number; url: string }[];
}

/// Заметки владельца к месячному отчёту (PATCH /reports/monthly/:id).
/// Пустая строка допустима — это способ очистить заметки.
export const monthlyReportNotesSchema = z.object({
  notes: z.string().max(10000),
});

/// Передача дел уходящего сотрудника (POST /agents/:id/handover).
/// toAgentId не указан — клиенты расходятся по команде обычным распределением
/// (учитывает лимит активных лидов и выбранную стратегию).
export const agentHandoverSchema = z.object({
  toAgentId: z.guid().optional(),
  /// Отключить учётку сразу после передачи (владелец 24.09.2026: «после передачи
  /// клиентов деактивируем аккаунт»). Окно ставит галочку по умолчанию; снять её —
  /// декрет, смена роли, когда учётка ещё нужна.
  deactivate: z.boolean().optional(),
});

/// Ручная передача объекта другому агенту из карточки объекта (24.09.2026).
/// Причина обязательна: получатель читает её перед тем, как принять объект.
export const propertyTransferSchema = z.object({
  toAgentId: z.guid(),
  reason: z.string().trim().min(3, "Напишите, почему объект передаётся").max(500),
});
export type PropertyTransferInput = z.infer<typeof propertyTransferSchema>;

/// Как называется вид отсутствия в интерфейсе (см. agentFreezeSchema.kind).
export const ABSENCE_KIND_LABELS: Record<AbsenceKind, string> = {
  VACATION: "Отпуск",
  SICK: "Больничный",
  OTHER: "Отсутствует",
};

/// Произвольное сообщение клиенту из его карточки (POST /clients/:id/message).
/// Предел тот же, что у ответа из инбокса: длиннее мессенджеры всё равно режут.
export const clientMessageSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  /// Диалог, в который писать: тот, что выбран вкладкой канала в карточке (id
  /// инбокса — `<uuid>` бота или `tg_<uuid>`). Без него — самый живой диалог
  /// клиента. Чужой или несуществующий id сервер отклоняет (аудит 04.10.2026).
  conversationId: z.string().trim().min(1).max(80).optional(),
});

export const dealCreateSchema = z.object({
  clientId: z.guid(),
  propertyId: z.guid(),
  agentId: z.guid().optional(),
  stage: z.enum(DEAL_STAGES).default("NEGOTIATION"),
  commissionAmount: z.number().positive().optional(),
  commissionPercent: z.number().positive().optional(),
  notes: z.string().optional(),
});

export const dealUpdateSchema = z.object({
  stage: z.enum(DEAL_STAGES).optional(),
  commissionAmount: moneyPositive().optional(),
  commissionPercent: z.number().positive().optional(),
  notes: z.string().optional(),
  /** Фактическая цена продажи — часто ниже цены объявления (скидка). Указывается
   *  при отправке сделки на закрытие; без неё продажа считается по цене объявления. */
  soldPrice: moneyPositive().optional(),
  /** Комиссия суммой (не процентом) — вводит агент при отправке сделки на закрытие
   *  (стадия PENDING_APPROVAL). 0,5% «за приём объекта» отменены 11.09.2026 —
   *  осталось только две доли, делит риелтор и компания. */
  commissionRealtorAmount: moneyNonNegative().optional(),
  commissionCompanyAmount: moneyNonNegative().optional(),
  /** Комментарий руководителя при возврате сделки с PENDING_APPROVAL на
   *  CONTRACT_SIGNED (Пачка 8, 11.09.2026) — обязателен именно для этого перехода,
   *  проверяется в routes/deals.ts, а не здесь: здесь он просто необязательная строка. */
  rejectReason: z.string().trim().min(3).max(500).optional(),
  /** Директор пропускает чек-лист обязательных документов при отправке/закрытии
   *  (Пачка 14, 11.09.2026) — только вместе с deals.complete, проверяется в
   *  routes/deals.ts; здесь просто необязательный флаг, пишется в аудит. */
  skipDocuments: z.boolean().optional(),
  /**
   * ОПТИМИСТИЧНАЯ БЛОКИРОВКА (13.09.2026, аудит надёжности, находка 2) — тот же
   * приём, что у propertyUpdateSchema.version выше: необязательно, для
   * обратной совместимости со старыми вызывающими. Канбан ещё не подключён к
   * отправке этого поля (см. routes/deals.ts) — задел на следующий заход.
   */
  version: z.number().int().nonnegative().optional(),
});

/// Загрузка документа сделки (POST /deals/:id/documents) — kind обязателен,
/// сам файл идёт multipart (multer), не через этот body-schema.
export const dealDocumentUploadSchema = z.object({
  kind: z.enum(DEAL_DOCUMENT_KINDS),
});

/// Отметка «комиссия выплачена» (POST /deals/:id/payout, Пачка 14, 11.09.2026).
export const dealPayoutSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

export const parseNoteSchema = z.object({
  text: z.string().min(1),
  clientId: z.guid(),
});

/// Публикация объектов на сайт royalhome.tj (POST /api/v1/properties/bulk-sync).
export const bulkSiteSyncSchema = z.object({
  ids: z.array(z.guid()).min(1).max(50),
  action: z.enum(["publish", "unpublish"]),
});

/// Массовое удаление объектов в Корзину (POST /api/v1/properties/bulk-trash).
/// Предел партии — как у публикации: список отдаёт до 50 строк на странице,
/// «выбрать все на странице» не должно упираться в лимит.
export const bulkTrashPropertiesSchema = z.object({
  ids: z.array(z.guid()).min(1).max(50),
});

/// Итог по ОДНОМУ объекту массового удаления. Партия не всё-или-ничего: объект со
/// сделкой удалить нельзя, и это не повод отменять удаление остальных — каждая
/// строка отвечает за себя, а экран показывает, что именно не удалось и почему.
export interface BulkTrashItemResult {
  id: string;
  /// Номер и название известны только для найденных объектов — по ним человек
  /// понимает, о какой карточке речь, не сверяя uuid.
  shortId?: number;
  title?: string;
  ok: boolean;
  error?: string;
}

/// Ответ синхронизации с сайтом — общий для api (lib/siteSync) и web (useProperties).
export interface SiteSyncItemResult {
  externalId: string;
  ok: boolean;
  error?: string;
  /// id строки объявления на сайте — сайт возвращает его при публикации. CRM его не
  /// хранит: публичная ссылка на объект собирается через редирект сайта
  /// /listing/by-crm/<id объекта в CRM>, см. lib/siteListingUrl.ts.
  id?: number;
}

/// Решение службы безопасности по закрытой карточке (POST /clients/:id/security-review).
/// Комментарий необязателен: «проверено, вопросов нет» часто и есть весь результат.
export const securityReviewSchema = z.object({
  verdict: z.enum(["CLEARED", "CONFIRMED"]),
  note: z.string().max(2000).optional(),
  /** Голосовая заметка к note (кнопка микрофона) — необязательна. */
  noteVoiceUrl: voiceNoteUrlSchema.optional(),
  noteVoiceTranscript: z.string().max(4000).optional(),
});

/// «Не принимаю лиды» (POST /me/lead-pause). Часы просит агент, потолок ставит
/// сервер из Настроек: запрошенное сверх потолка обрезается, а не отклоняется —
/// человек просит «на неделю», получает максимум и видит до какого момента.
export const leadPauseSchema = z.object({
  hours: z.number().int().min(1).max(720),
});

/// Пауза приёма лидов, которую ставит руководитель (POST /agents/:id/lead-pause,
/// 24.09.2026). Потолка из Настроек и «остыть» здесь нет: это решение
/// руководителя, а не просьба агента. Причина необязательна — агент увидит её в
/// профиле, если она есть.
export const supervisorLeadPauseSchema = z.object({
  hours: z.number().int().min(1).max(720),
  reason: z.string().trim().max(300).optional(),
});
export type SupervisorLeadPause = z.infer<typeof supervisorLeadPauseSchema>;

/// «Копии монтажа в Telegram» (PATCH /me/montage-copies, 22.09.2026) — админ
/// подписывается на копии всего, что уходит монтажёру. Только ADMIN/DIRECTOR.
export const montageCopiesUpdateSchema = z.object({
  montageCopiesTelegram: z.boolean(),
});
export type MontageCopiesUpdate = z.infer<typeof montageCopiesUpdateSchema>;

/// Экстренная заморозка сотрудника (POST /agents/:id/freeze). Причина обязательна:
/// запись в журнале без причины через месяц не объясняет ничего.
export const agentFreezeSchema = z.object({
  reason: z.string().min(3).max(500),
  /** Голосовая заметка к причине (кнопка микрофона) — необязательна, файл как есть. */
  reasonVoiceUrl: voiceNoteUrlSchema.optional(),
  reasonVoiceTranscript: z.string().trim().max(4000).optional(),
  /**
   * ВИД ОТСУТСТВИЯ — отпуск, больничный, прочее (владелец 09.09.2026: «дать отпуск /
   * больничный»). Добавлено к СУЩЕСТВУЮЩЕЙ заморозке, а не отдельным действием:
   * второй способ вывести человека из строя означал бы две кнопки с одинаковым
   * смыслом и два разных набора последствий.
   *
   * Различать виды понадобилось не ради статистики, а ради судьбы клиента: из
   * ОТПУСКА человек выходит в известный день, и вернувшегося продавца можно
   * подержать в очереди до его возвращения; БОЛЬНИЧНЫЙ кончается неизвестно когда,
   * и ждать нельзя — карточка уходит другому агенту сразу
   * (apps/api/src/lib/returningClientRouting.ts).
   *
   * Необязателен: старые вызовы (экстренная заморозка «для разбирательства») его не
   * шлют, и такое отсутствие трактуется как OTHER — осторожно, как больничный.
   */
  kind: z.enum(ABSENCE_KINDS).optional(),
  /**
   * Дата выхода. Необязательна: «до неизвестно когда» — законное состояние
   * больничного, и требовать выдуманную дату значит получать выдуманные даты.
   * Заданная дата снимает заморозку сама (apps/api/src/lib/absenceReturn.ts).
   */
  until: z.coerce.date().nullable().optional(),
});

/// Запись обязательного итога (POST /me/summaries/:id/complete). Минимум 10 знаков:
/// «ок» и «поговорили» — это не итог, а способ закрыть окно, и по такой записи
/// следующий агент всё равно начнёт с нуля.
export const summaryCompleteSchema = z.object({
  text: z.string().trim().min(10, "Опишите итог хотя бы одним предложением").max(4000),
});

/**
 * Ветвление внутри «Итога объекта» (kind="property", спецификация владельца,
 * «Контроль объекта») — единственное из трёх обязательных окон со СТРУКТУРНЫМ
 * решением вместо свободного текста: агент не описывает итог, а выбирает его.
 *
 * Неактивный: та же форма, что в «Клиент отказался» (причина + инициатор +
 * комментарий) — решение уже проверено там, повторно изобретать нечего.
 * Активный: либо назначить повторный контакт (окно останется открытым и
 * переедет на новую дату — 36-часовой цикл не запускается заново, это тот же
 * КОНТРОЛЬ, а не новая заявка), либо перейти к добавлению карточки объекта
 * (сам переход — на фронте, кнопкой «Создать объект», это поле лишь закрывает
 * текущий раунд контроля).
 */
export const summaryCompletePropertySchema = z
  .object({
    status: z.enum(["ACTIVE", "INACTIVE"]),
    reason: z.enum(REFUSAL_REASONS).optional(),
    initiator: z.enum(REFUSAL_INITIATORS).optional(),
    comment: z.string().max(1000).optional(),
    action: z.enum(["FOLLOW_UP", "ADD_PROPERTY"]).optional(),
    /** Когда назначить следующий «Итог объекта» — только для FOLLOW_UP; не
     * указано — CRM сама подберёт ближайшее дневное окно. */
    nextActionDate: requiredDate.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.status === "INACTIVE") {
      if (!data.reason) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Укажите причину" });
      }
      if (!data.initiator) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["initiator"], message: "Укажите инициатора" });
      }
      // Комментарий НЕОБЯЗАТЕЛЕН (владелец 28.08.2026: то же решение 18.08.2026 про
      // clientRefuseSchema, здесь его тогда забыли применить — причина и инициатор
      // из выпадающих списков уже достаточный итог).
    }
    if (data.status === "ACTIVE" && !data.action) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "Выберите: повторный контакт или добавить объект",
      });
    }
  });

/**
 * Пять веток «Итога показа» (kind="meeting", Путь покупателя, спецификация
 * владельца) — явный выбор агента после ПРОВЕДЁННОГО показа объекта:
 *
 *  - RESCHEDULE («Повторный показ») — клиенту нужно показать ещё раз (тот же
 *    объект или другой); агент назначает новый показ уже существующим
 *    механизмом (Interaction type=SHOWING) — эта форма его не дублирует.
 *  - THINKING («Клиент думает») — пауза с напоминанием; заводит уже
 *    существующий PendingSummary kind="waiting_check" (как «Ждёт варианты»/
 *    «Ждёт показ»), а не новый механизм.
 *  - SELECTION («Подбор») — агент продолжает подбирать другие объекты;
 *    Client.buyerStage="SELECTION", карточка остаётся активной у агента.
 *  - NEGOTIATION («Переговоры») — обсуждение условий сделки;
 *    Client.buyerStage="NEGOTIATION".
 *  - DEAL («Договор») — переиспользует уже существующий резерв объекта на
 *    сделке (3 рабочих дня, коммит 1aa4683): агент переходит к созданию
 *    сделки существующей формой, эта ветка лишь закрывает «Итог показа».
 */
/**
 * REFUSE («Клиент отказался») добавлен 08.09.2026 вместе с уборкой выбора
 * статуса из этого окна. Без него блокирующее окно не имеет ни одного
 * ПРАВДИВОГО варианта для встречи, на которой клиент сказал «нет»: раньше это
 * оформлялось выбором статуса «Неактивный», и, убрав статус, мы бы оставили
 * агента перед выбором из пяти веток «работа продолжается» — то есть заставили
 * бы врать, обычно нажатием «Клиент думает». Ложь в данных хуже пустоты: по
 * ней клиент навсегда остаётся активным и попадает во все отчёты как живой.
 */
export const SHOWING_OUTCOME_BRANCHES = ["RESCHEDULE", "THINKING", "SELECTION", "NEGOTIATION", "DEAL", "REFUSE"] as const;
export type ShowingOutcomeBranch = (typeof SHOWING_OUTCOME_BRANCHES)[number];

/// Подписи — дословно из ТЗ п. 15, чтобы агент видел на кнопке ровно то слово,
/// которое читал в инструкции. «Подбор» и «Договор» были сокращениями и
/// расходились с ТЗ («Подбираю другие объекты», «Подготовка договора»).
export const SHOWING_OUTCOME_LABELS: Record<ShowingOutcomeBranch, string> = {
  RESCHEDULE: "Повторный показ",
  THINKING: "Клиент думает",
  SELECTION: "Подбираю другие объекты",
  NEGOTIATION: "Ведутся переговоры",
  DEAL: "Подготовка договора",
  REFUSE: "Клиент отказался",
};

/// Тело запроса «Итога показа» (POST /me/summaries/:id/complete, kind="meeting").
/// Комментарий необязателен: сама ветка уже структурное решение, свободный
/// текст — только пояснение при желании.
/** Когда снова связаться с клиентом, который «думает» (ТЗ п. 15.2) — три готовых
 *  срока плюс своя дата. */
export const THINKING_DELAYS = ["TOMORROW", "IN_3_DAYS", "IN_WEEK", "CUSTOM"] as const;
export type ThinkingDelay = (typeof THINKING_DELAYS)[number];
export const THINKING_DELAY_LABELS: Record<ThinkingDelay, string> = {
  TOMORROW: "Завтра",
  IN_3_DAYS: "Через 3 дня",
  IN_WEEK: "Через неделю",
  CUSTOM: "Выбрать дату",
};

/**
 * ОКНО ВСТРЕЧИ БОЛЬШЕ НЕ МЕНЯЕТ СТАТУС КЛИЕНТА (владелец 08.09.2026).
 *
 * БЫЛО (12.08.2026): окно начиналось с выбора статуса — «Активный» (пять веток),
 * «Передача» (клиент уходит следующему агенту по KPI) или «Неактивный» (карточка
 * уходит из активной работы). То есть прямо в окне после встречи агент мог одним
 * нажатием убрать клиента из-под контроля — ровно та дыра, ради которой окно и
 * заводилось: встреча это слепая зона CRM, и заканчивалась она тем, что клиент
 * тихо исчезал, а внешне это выглядело как честно заполненный итог.
 *
 * СТАЛО: агент отвечает ТОЛЬКО на вопрос «что произошло на встрече» — факт,
 * который знает он один. Активный/неактивный/потерян выводит из этого факта
 * система (дословно: «он не может делать клиента активным либо неактивным —
 * это решает только система»).
 *
 * Отказ клиента оформляется НЕ здесь, а отдельной формой «Завершить сделку»
 * (POST /clients/:id/refuse): там причина, инициатор, проверка СБ, счётчик
 * отказов и передача лида дальше. Она и так доступна ровно после проведённого
 * показа — то есть именно в этот момент. Фронт из окна встречи открывает её
 * же, а не дублирует механику отказа внутри итога.
 */
export const summaryCompleteMeetingSchema = z
  .object({
    branch: z.enum(SHOWING_OUTCOME_BRANCHES),
    comment: z.string().trim().max(2000).optional(),
    /** Только для THINKING — см. THINKING_DELAYS. */
    thinkingDelay: z.enum(THINKING_DELAYS).optional(),
    /** Обязательна только при thinkingDelay="CUSTOM". */
    nextContactAt: requiredDate.optional(),
    /**
     * Следующий показ — обязателен для веток RESCHEDULE («Повторный показ», ТЗ
     * п. 15.1) и SELECTION («Подбираю другие объекты», ТЗ п. 15.3): обе по ТЗ
     * заканчиваются назначенной встречей, а не намерением её назначить.
     *
     * До 14.08.2026 показ создавался ОТДЕЛЬНЫМ запросом из вложенного окна, и это
     * не работало дважды: вложенное окно рисовалось под затемнением обязательного,
     * а после четвёртой отсрочки жёсткая блокировка (lib/summaryHardBlock) не
     * пропускала POST /clients/:id/interactions — то есть обе ветки становились
     * невыполнимыми ровно тогда, когда заполнение окна становилось обязательным.
     * Теперь показ заводит сам итог, одним запросом, который блокировка разрешает.
     */
    propertyId: z.guid().optional(),
    showingAt: requiredDate.optional(),
    /**
     * Только для REFUSE — тот же набор, что у отказа продавца («Итог приёмки»)
     * и у формы «Завершить сделку»: причина и инициатор. Инициатор здесь не
     * формальность — именно по нему («клиент сам») и по причине решается,
     * уходит ли карточка на проверку СБ.
     */
    refusalReason: z.enum(REFUSAL_REASONS).optional(),
    refusalInitiator: z.enum(REFUSAL_INITIATORS).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.branch === "REFUSE") {
      if (!data.refusalReason) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refusalReason"], message: "Укажите причину отказа" });
      }
      if (!data.refusalInitiator) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refusalInitiator"], message: "Укажите инициатора" });
      }
    }
    if (data.branch === "THINKING" && data.thinkingDelay === "CUSTOM" && !data.nextContactAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nextContactAt"], message: "Укажите дату" });
    }
    // Обе ветки по ТЗ обязаны закончиться назначенным показом: объект, дата и час.
    if (data.branch === "RESCHEDULE" || data.branch === "SELECTION") {
      if (!data.propertyId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["propertyId"], message: "Выберите объект показа" });
      }
      if (!data.showingAt) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["showingAt"], message: "Укажите дату и время показа" });
      } else if (isBareDate(data.showingAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["showingAt"],
          message: "Укажите время показа, а не только дату",
        });
      }
    }
  });

/**
 * «КАК ПРОШЁЛ ЗВОНОК» (kind="call_result") — окно сразу после того, как агент
 * положил трубку. Требование владельца 10.08.2026: «после каждого звонка окно,
 * чтобы всегда знать, что происходит».
 *
 * ЧЕМ ОТЛИЧАЕТСЯ ОТ summaryCompleteCallSchema ВЫШЕ, при похожем названии. То окно —
 * контроль по КЛИЕНТУ через час после принятия лида: «разобрался ли ты с ним вообще».
 * Это — по конкретному РАЗГОВОРУ, сразу после него, и спрашивает другое: чем
 * закончился именно он и что дальше. Отсюда и поля: исход разговора из общего списка
 * (тот же, что в AddInteractionModal) и следующий шаг с датой.
 *
 * Договорённость о показе здесь не назначается: для неё есть отдельное окно с выбором
 * объекта (см. showingFromCall ниже) — назначать показ без объекта бессмысленно.
 *
 * ПЕРЕРАБОТКА 12.08.2026 (ТЗ владельца, «Логика Статус + Итог»): окно теперь начинается
 * с шага СТАТУС, а не сразу с итога. status="ACTIVE" — старое поведение (итог/дальше)
 * без изменений.
 *
 * status="INACTIVE" УБРАН ЦЕЛИКОМ (16.09.2026, владелец: «агент ничего никогда не
 * делает кнопками, и самих кнопок для этого нет»). Фронт (CallResultForm) уже не
 * допускал этого значения на уровне типа (`useState<"ACTIVE" | "TRANSFER" | null>`,
 * StatusPicker::withInactive был мёртвым пропом с 07.09.2026) — схема и обработчик
 * держали ветку живой только для прямого POST мимо интерфейса. Автоматика (ИИ по
 * разбору звонка — ai/callAnalysis.ts) переводит клиента в Неактивные сама через
 * тот же deactivateClient, минуя это окно целиком. «Передача» здесь по-прежнему НЕ
 * предлагается: по решению владельца она доступна только после первого проведённого
 * показа (см. summaryCompleteMeetingSchema/routes/clients.ts transfer).
 */
export const summaryCompleteCallResultSchema = z
  .object({
    /**
     * ТРИ статуса, как в ТЗ п. 10, а не два.
     *
     * «Передача» здесь не предлагалась вовсе — ни до первого показа, ни после.
     * Правило ТЗ («доступна после первого проведённого показа») ограничивает
     * МОМЕНТ, а не окно: агент, у которого показ уже был, должен мочь передать
     * клиента и по итогу очередного разговора, не дожидаясь следующего показа.
     * Гейт проверяет сервер (lib/conductedShowing.ts), интерфейс лишь не рисует
     * кнопку раньше времени.
     */
    status: z.enum(["ACTIVE", "TRANSFER"]).default("ACTIVE"),
    /**
     * Только для TRANSFER — сужено до NO_TRUST (задача F, план 03-04.09.2026),
     * та же причина, что и в clientTransferSchema: это ОДИН ИЗ ВХОДОВ
     * transferClientByAgent (lib/clientTransfer.ts), и без того же ограничения
     * здесь агент обошёл бы сужение, выбрав «Передача» прямо из обязательного
     * окна вместо кнопки на карточке.
     */
    transferReason: z.literal("NO_TRUST").optional(),
    outcome: z.enum(INTERACTION_OUTCOMES).optional(),
    /** О чём договорились. Короче предложения итог не бывает — он и есть смысл окна.
     *  Обязателен только для Активного. */
    text: z.string().trim().max(4000).optional(),
    /** Что дальше и когда: перезвонить, отправить варианты, встретиться. */
    nextAction: z.string().trim().max(500).optional(),
    nextActionDate: requiredDate.optional(),
    /**
     * Объект показа — когда исход «Ждёт показ» и агент выбрал его прямо здесь.
     *
     * До 12.08.2026 показ из этого окна не назначался вовсе: исход просто ложился
     * задачей, а настоящий показ заводился ВТОРЫМ окном («Назначьте показ»), да и
     * то лишь если ИИ расслышал время в записи. Владелец: «то есть и ИИ открывает
     * окно „назначьте показ“, и это наше окно тоже — это же не логично?».
     * Теперь агент выбирает объект здесь, и показ создаётся сразу.
     */
    propertyId: z.guid().optional(),
    comment: z.string().trim().max(1000).optional(),
    /**
     * «БЕЗ ИЗМЕНЕНИЙ» — ОДНО НАЖАТИЕ, НИЧЕГО НЕ ЗАПОЛНЯЯ (владелец 17.08.2026).
     *
     * Дословно: «агент забыл что-то уточнить и перезванивает, а то снова у него
     * вышло полное окно и он опять должен выбирать». Клиент перезвонил через пару
     * минут — договорённости те же, выбирать исход и писать «итог хотя бы одним
     * предложением» второй раз не о чем. Ставит этот флаг, и окно просто
     * закрывается: ни статус клиента, ни исход, ни следующий шаг не меняются.
     *
     * Разговор при этом не теряется — он записан и разобран ИИ, как и любой
     * другой, а в хронологии остаётся отметка, что итог не менялся.
     */
    noChanges: z.boolean().optional(),
    /** Голосовая заметка агента (кнопка микрофона рядом с текстом итога) —
     *  необязательна, форма отправляется и без неё. URL уже загруженного на
     *  сервер файла (см. POST /me/summaries/:id/voice-note), не сам blob. */
    voiceNoteUrl: voiceNoteUrlSchema.optional(),
    /** Расшифровка voiceNoteUrl — для дополнения карточки клиента, не для notes. */
    voiceNoteTranscript: z.string().trim().max(4000).optional(),
  })
  .superRefine((data, ctx) => {
    // «Без изменений» — ровно то и значит: требовать исход и текст здесь нечего
    // (см. noChanges выше). Остальные проверки ниже тоже не про этот случай.
    if (data.noChanges) return;
    if (data.status === "ACTIVE") {
      if (!data.outcome) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "Укажите итог разговора" });
      }
      // Комментарий необязателен (владелец 25.08.2026): выбор исхода одним тапом —
      // достаточный итог сам по себе, кнопка «Записать итог» не должна упираться в
      // требование печатать хотя бы предложение. Пустой текст сервер не путает с
      // «ничего не заполнено»: заголовок исхода (INTERACTION_OUTCOME_LABELS) сам по
      // себе уже честная запись в хронологии, см. completeCallResultSummary.
      // Дата без действия — напоминание ни о чём: через сутки агент увидит время и не
      // вспомнит, зачем оно стоит.
      if (data.nextActionDate && !data.nextAction?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nextAction"],
          message: "Напишите, что нужно сделать к этому времени",
        });
      }
      /**
       * «ЖДЁТ ЗВОНКА»/«ЖДЁТ ВАРИАНТЫ» БЕЗ СЛЕДУЮЩЕГО ШАГА — НЕ БЫВАЕТ (31.08.2026).
       *
       * Название исхода само обещает будущее действие — но до этой правки
       * можно было выбрать WAITING_CALL/WAITING_OPTIONS, ничего больше не
       * заполнить и закрыть обязательное окно: звонок числится «обработанным»,
       * а перезвонить/отправить варианты не напоминает никому. Дыра касалась
       * только этих двух исходов — у NO_ANSWER уже есть автоподстановка
       * (planNoAnswerStep), у WAITING_SHOWING дата/объект уже обязательны
       * (см. блок ниже), у NEGATIVE/PROPERTY_ACCEPTED/SELLER_MEETING следующий
       * шаг на этой записи по смыслу не нужен — их не трогаем.
       */
      if ((data.outcome === "WAITING_CALL" || data.outcome === "WAITING_OPTIONS") && !data.nextActionDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nextActionDate"],
          message: "Укажите, когда перезвонить или отправить варианты",
        });
      }
      // Показ без времени назначить некуда: встреча — это дата и час, а не намерение.
      if (data.outcome === "WAITING_SHOWING") {
        if (!data.nextActionDate) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["nextActionDate"],
            message: "Укажите дату и время показа",
          });
        } else if (isBareDate(data.nextActionDate)) {
          /**
           * Голая дата («2026-08-20») разбирается как полночь UTC — в Душанбе это
           * 05:00. До 14.08.2026 сообщение обещало проверку даты И времени, а
           * проверялась только дата: показы падали в календарь на пять утра, а
           * напоминания за 2 часа и 40 минут уходили ночью. Реального показа
           * ровно в 05:00:00.000 не бывает — по этому признаку и отличаем
           * «время не указано» от указанного времени.
           */
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["nextActionDate"],
            message: "Укажите время показа, а не только дату",
          });
        }
        // Без объекта показ не создаётся (см. WAITING_SHOWING в routes/me.ts) —
        // окно закрывалось бы, будто показ назначен, а его нет ни в календаре, ни
        // в напоминаниях. Фронт это требовал и раньше, сервер — нет.
        if (!data.propertyId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["propertyId"],
            message: "Выберите объект показа",
          });
        }
      }
    } else if (data.status === "TRANSFER") {
      // Причина обязательна (всегда NO_TRUST, z.literal выше) — комментарий для
      // неё необязателен, «Другое» этой схемой больше не принимается вовсе.
      if (!data.transferReason) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["transferReason"], message: "Укажите причину" });
      }
    }
  });

/**
 * «ПРОВЕРЬТЕ, ВЕРНО ЛИ ПОНЯЛИ КЛИЕНТА» (kind="card_fill") — то же предложение ИИ,
 * что показывалось баннером в карточке, но теперь обязательным окном поверх CRM.
 *
 * apply — согласиться (возможно, поправив поля прямо в окне); dismiss — «не то».
 * Отклонение тоже закрывает окно: предложение — догадка машины, и агент имеет право
 * сказать, что она не расслышала. Молча висеть оно не должно.
 */
export const summaryCompleteCardFillSchema = z.object({
  action: z.enum(["apply", "dismiss"]),
  /** Что именно записать в карточку — только при apply. */
  card: cardSuggestionApplySchema.optional(),
  /** Агент правил поля руками («Поправить»), а не просто согласился с машиной —
   *  см. комментарий у cardSuggestionApplySchema. */
  manualEdit: z.boolean().optional(),
});

/**
 * «НАЗНАЧЬТЕ ПОКАЗ» (kind="showing_book") — окно после разговора, в котором
 * договорились о встрече.
 *
 * book — назначить: выбранный объект и время (подставлены из разговора, агент правит).
 * skip — встречи не будет: модель могла принять за договорённость «ну как-нибудь
 * съездим». Отказ пишется в хронологию причиной, а не пропадает: иначе руководитель
 * не отличит «показ не состоялся» от «CRM не спросила».
 */
export const summaryCompleteShowingSchema = z
  .object({
    action: z.enum(["book", "skip"]),
    propertyId: z.guid().optional(),
    at: requiredDate.optional(),
    comment: z.string().trim().max(1000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.action !== "book") return;
    if (!data.propertyId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["propertyId"], message: "Выберите объект для показа" });
    }
    if (!data.at) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["at"], message: "Укажите дату и время показа" });
    }
  });

/**
 * «ИТОГ ПРИЁМКИ» (kind="seller_showing", Путь продавца, мозговой штурм владельца
 * 20-21.08.2026) — агент встретился с продавцом на объекте (показ/приёмка/осмотр),
 * и через meetingSummaryAfterShowingMinutes после назначенного времени открывается
 * вопрос «чем кончилось», четырьмя исходами вместо свободного текста:
 *
 *  - ADD_PROPERTY («Добавить объект») — переход к созданию карточки объекта (сама
 *    форма — на фронте, кнопка уже есть в карточке заявки продавца). Требование
 *    НЕ закрывается этим ответом — см. completeSellerShowingSummary, routes/me.ts:
 *    закрывается только когда объект РЕАЛЬНО появится в базе с этим клиентом.
 *  - SCHEDULE_SHOWING («Назначить съёмку») — встреча не состоялась или нужна ещё
 *    одна; агент называет новые дату и время прямо в этом окне, сервер заводит
 *    новую запись SELLER_MEETING, и цикл повторяется своим отдельным требованием.
 *  - NEGOTIATION («Переговоры») — обсуждение условий продолжается; окно
 *    переоткрывается через 24 часа (то же число, что у ветки NEGOTIATION в
 *    summaryCompleteMeetingSchema выше — единообразие вместо новой настройки под
 *    тот же смысл), а не закрывается.
 *  - REFUSE («Отказ») — тот же набор полей и тот же механизм, что «Итог объекта:
 *    Неактивный» (см. refuseSellerClient, routes/me.ts): причина+инициатор+
 *    комментарий, предел передач, эскалация в LOST, проверка СБ.
 */
export const SELLER_SHOWING_ACTIONS = ["ADD_PROPERTY", "SCHEDULE_SHOWING", "NEGOTIATION", "REFUSE"] as const;
export type SellerShowingAction = (typeof SELLER_SHOWING_ACTIONS)[number];

export const SELLER_SHOWING_ACTION_LABELS: Record<SellerShowingAction, string> = {
  ADD_PROPERTY: "Добавить объект",
  SCHEDULE_SHOWING: "Назначить съёмку",
  NEGOTIATION: "Переговоры",
  REFUSE: "Отказ",
};

export const summaryCompleteSellerShowingSchema = z
  .object({
    action: z.enum(SELLER_SHOWING_ACTIONS),
    comment: z.string().trim().max(2000).optional(),
    /** Только для SCHEDULE_SHOWING — дата и час новой встречи с продавцом. */
    nextMeetingAt: requiredDate.optional(),
    /** Только для REFUSE — тот же набор, что у «Итога объекта: Неактивный». */
    reason: z.enum(REFUSAL_REASONS).optional(),
    initiator: z.enum(REFUSAL_INITIATORS).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.action === "SCHEDULE_SHOWING") {
      if (!data.nextMeetingAt) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nextMeetingAt"], message: "Укажите дату и время новой встречи" });
      } else if (isBareDate(data.nextMeetingAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nextMeetingAt"],
          message: "Укажите время встречи, а не только дату",
        });
      }
    }
    if (data.action === "REFUSE") {
      if (!data.reason) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Укажите причину" });
      }
      if (!data.initiator) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["initiator"], message: "Укажите инициатора" });
      }
      // Комментарий НЕОБЯЗАТЕЛЕН (владелец 28.08.2026, см. summaryCompletePropertySchema).
    }
  });

/// Ответ на вопрос, который бот пообещал уточнить у собственника
/// (POST /me/owner-questions/:id/answer). Ответ уходит клиенту как есть, поэтому
/// пустой и односложный не принимаем: «да» без контекста через сутки после вопроса
/// клиент не поймёт.
export const ownerAnswerSchema = z.object({
  answer: z.string().trim().min(5, "Ответьте так, чтобы клиент понял без вопроса").max(2000),
  expectedRevision: customerRevisionSchema.refine(value => value !== "0").optional(),
}).strict();

// ─── ИНСАЙТЫ ОТ ИИ (аудит 02.09.2026 §4.1/§4.2) ──────────────────────────────

/** Виды кейсов в диджесте инсайтов. */
export const INSIGHT_CASE_KINDS = [
  "call_low_score",
  "score_penalty",
  "agent_bypass",
  "client_lost",
  "complaint",
  "positive",
] as const;
export type InsightCaseKind = (typeof INSIGHT_CASE_KINDS)[number];

/** Статусы диджеста. */
export const INSIGHT_DIGEST_STATUSES = ["READY", "PARTIAL", "FAILED"] as const;
export type InsightDigestStatus = (typeof INSIGHT_DIGEST_STATUSES)[number];

/** Один кейс из диджеста инсайтов (с таймлайном и вердиктом). */
export const insightCaseSchema = z.object({
  id: z.guid(),
  digestId: z.guid(),
  agentId: z.guid(),
  clientId: z.guid(),
  kind: z.enum(INSIGHT_CASE_KINDS),
  severity: z.number().int().min(1).max(5),
  sourceKey: z.string().min(1),
  timeline: z.unknown(),
  verdict: z
    .object({
      wrong: z.array(z.object({ quote: z.string(), why: z.string() })).optional(),
      better: z.array(z.string()).optional(),
      summary: z.string().optional(),
    })
    .nullable()
    .optional(),
  reviewedAt: z.string().datetime().nullable().optional(),
  reviewedById: z.guid().nullable().optional(),
  meetingNote: z.string().nullable().optional(),
});

/** Диджест инсайтов (без вложенных кейсов — для списка). */
export const insightDigestListSchema = z.array(
  z.object({
    id: z.guid(),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    meetingAt: z.string().datetime(),
    status: z.enum(INSIGHT_DIGEST_STATUSES),
    coverage: z.object({
      calls: z.number().int().nonnegative(),
      analyzed: z.number().int().nonnegative(),
      findings: z.number().int().nonnegative(),
      penalties: z.number().int().nonnegative(),
    }),
    createdAt: z.string().datetime(),
    caseCount: z.number().int().nonnegative(),
  }),
);

/** Тело PATCH /insights/cases/:id — разметка кейса на встрече. */
export const insightCaseReviewSchema = z.object({
  reviewedAt: z.string().datetime().optional(),
  meetingNote: z.string().trim().max(2000).optional(),
});

/** Тело POST /instagram-comments/:id/reply — ручной ответ сотрудника на комментарий,
 *  которым бот не ответил (например, статус ESCALATED, «бот не знает ответа»).
 *  Предел длины — тот же порядок, что у комментария в Instagram/Facebook: лента
 *  режет всё равно, но пусть честно откажет на входе, а не после похода в Graph API. */
export const instagramCommentReplySchema = z.object({
  text: z.string().trim().min(1, "Пустой ответ").max(2200, "Слишком длинный ответ"),
});
export type InstagramCommentReplyInput = z.infer<typeof instagramCommentReplySchema>;
