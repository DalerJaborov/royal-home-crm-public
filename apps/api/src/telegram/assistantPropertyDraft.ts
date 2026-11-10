/**
 * МАСТЕР ОБЪЕКТА В TELEGRAM У ПОМОЩНИЦЫ (10.11.2026, владелец: «приоритет
 * добавления объектов… полностью, чтобы работало прямо как мастер по добавлению
 * объектов»).
 *
 * Своей логики здесь нет — только разговор. Черновик тот же, что у мастера CRM
 * (`PropertyDraft`, routes/properties/draftLifecycle.ts), поля проверяет общая
 * `propertyWizardErrors` (packages/shared/src/propertyWizardRules.ts) вместе с
 * `propertyCreateSchema`, объект создаёт тот же `createProperty`. Фото —
 * `savePropertyDraftPhotos`, ролики — те же сессии загрузки частями
 * (lib/propertyDraftMedia.ts), дубль — `findPropertyDuplicates`
 * (GET /properties/duplicate-check), объект из карточки продавца —
 * `importClientIntoDraft` (POST /properties/drafts/from-client/:clientId) с теми
 * же правами, точка → район и ориентир — `districtFromMap`/`lookupGeoPoint` и
 * `suggestLandmarksForPoint` (GET /geo/lookup, /geo/landmarks).
 *
 * Адрес и телефон продавца в переписке не повторяются (только «указан» и две
 * последние цифры): история чата Telegram живёт дольше черновика.
 */
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  buildCreateBody, CURRENCIES, DETAIL_NOT_SET, firstLinkIn, MARKET_TYPES, NEW_BUILD_PHASES, PROPERTY_CONDITIONS, PROPERTY_CONDITION_LABELS,
  PROPERTY_DETAIL_KEYS, PROPERTY_DETAIL_OPTIONS, PROPERTY_DOCUMENT_PRESETS, PROPERTY_STAGES, PROPERTY_TYPES, PROPERTY_TYPE_LABELS,
  SECONDARY_CONDITIONS, UPLOAD_VIDEO_MAX_BYTES, fieldsForNewBuildPhase, formatClientCode, formatPropertyCode, parseShortCode,
  propertyCreateSchema, propertyDetailFieldLabel, propertyDetailOptionLabel, propertyDetailShown, propertyDuplicateCheckQuerySchema,
  propertyFieldShown, propertyFinishSummary, propertyHasCondition, propertyHasMarket, propertyWizardDraftValuesSchema,
  propertyWizardErrors, propertyWizardTypeChange, suggestedNarration,
  type PermissionId, type PropertyDetailKey, type PropertyDuplicateMatch, type PropertyType, type PropertyWizardDraftValues,
} from "@royal-home/shared";
import { z } from "zod";
import { BW, EW } from "../ai/wordBoundary.js";
import { isAiAssistantEnabled } from "../ai/assistant.js";
import { assistantLanguage } from "../ai/assistant/languageRouting.js";
import { createAssistantMoneyWallet, type AssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import { can, canBindClient, invalidateAgentAccess, loadAgentAccess, type AgentAccess } from "../auth/middleware.js";
import { prisma, type TxClient } from "../db.js";
import { findActiveAgentByName } from "../lib/agentNameLookup.js";
import { findDistrictIdByName } from "../lib/districtLookup.js";
import { lookupGeoPoint } from "../lib/geoLookup.js";
import { suggestLandmarksForPoint } from "../lib/landmarkPick.js";
import { districtFromMap } from "../lib/propertyDistrict.js";
import { findPropertyDuplicates } from "../lib/propertyDuplicates.js";
import { mapPointFromText } from "../lib/mapLinkResolve.js";
import { DRAFT_PHOTO_MAX_BYTES, isAcceptedDraftPhoto } from "../upload.js";
import { completeDraftVideo, deleteDraftMedia, importClientIntoDraft, startDraftVideoSession, writeDraftVideoPart } from "../lib/propertyDraftMedia.js";
import { logSystemError } from "../lib/systemError.js";
import { findAgentByTelegramChatId } from "../lib/telegramAgentLink.js";
import { createProperty, formatGeoAddressGuess } from "../routes/properties/crud.js";
import { savePropertyDraftPhotos } from "../routes/properties/drafts.js";
import { DRAFT_INCLUDE, DraftConflictError, assertActiveDraft, draftExpiry, draftMediaFingerprint, withDraftLock, type DraftRecord } from "../routes/properties/draftLifecycle.js";
import { assignableAgentError, propertyCreateDeniedReason } from "../routes/properties/shared.js";
import {
  TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES, answerCallbackQuery, editMessageText, resolveTelegramFile, sendMessage, sendMessageWithButtons,
  type TelegramCallbackQuery, type TelegramIncomingMessage, type TelegramInlineButton,
} from "./api.js";
import { downloadAssistantMedia } from "./assistantMedia.js";
import { extractPropertyFields } from "./assistantPropertyFields.js";
import { sendPropertyMatchesCard } from "./assistantPropertyOffers.js";
import {
  answerCompressedChoice, askAboutCompressedOnce, photoQualityCallback, photoQualityLine, recordDraftPhotoQuality,
  rejectsCompressed, tellCompressedRejected,
} from "./assistantPhotoQuality.js";
import { isTelegramCompressed } from "../lib/photoQuality.js";

type Lang = "ru" | "tg";
type Values = PropertyWizardDraftValues;
const kind = "property-draft";
const expiresAt = () => new Date(Date.now() + 12 * 60 * 60_000);
const isStart = new RegExp(
  `^(?:\\/(?:new_property|object)(?:@[A-Za-z0-9_]+)?|(?:(?:давай|хочу)\\s+)?${BW}(?:добавь|добавим|добавить|создай|создадим|создать)\\s+(?:новый\\s+)?объект${EW}|объекти нав|объект илова кун(?:ед)?)[.!?]*$`, "iu");
/** «Добавь объект продавца ПР-000456» / «объекти фурӯшанда ПР-456 илова кунед». */
const fromClientStart = new RegExp(
  `^(?:${BW}(?:добав(?:ь|ьте|ить)|созда(?:й|йте|ть)|завед(?:и|ите))\\s+объект${EW}\\s+(?:из\\s+карточки\\s+)?(?:продавца\\s+)?|объекти\\s+фурӯшанда\\s+)`
  + `((?:пр|пк|кл|pr|pk|kl)[\\s.\\-–—]*\\d{1,9})(?:\\s+илова\\s+кун(?:ед)?)?[.!?]*$`, "iu");
const isExit = /^(?:\/(?:cancel|new|reset)|выход|выйти из черновика|баромадан)$/iu;
const callback = /^pdt:(review|create|exit|edit):([\da-f-]{36})$/u;
const fieldCallback = /^pdt:f:([A-Za-z0-9_]{1,20}):([\da-f-]{36})$/u;
/** Выбор значения несёт ревизию черновика: после правки в CRM старая кнопка ничего не выберет. */
const valueCallback = /^pdt:v:([A-Za-z0-9_]{1,20}):(\d{1,2}):([0-9a-z]{1,8}):([\da-f-]{36})$/u;
/** «Убрать файл» — по номеру файла в черновике той же ревизии. */
const removeCallback = /^pdt:rm:([\da-f]{8}):([\da-f-]{36})$/u;
const importCallback = /^pdt:imp:(rd|rm|km|no):([\da-f-]{36})$/u;
const location = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
const stateSchema = z.object({
  draftId: z.guid(),
  lang: z.enum(["ru", "tg"]).optional(),
  /** dupIds — дубли, о которых сотрудник уже предупреждён кнопкой «Всё равно создать». */
  preview: z.object({ token: z.guid(), revision: z.number().int(), media: z.string(), dupIds: z.array(z.guid()).max(10).optional() }).optional(),
  /** Поле, которое агент выбрал кнопкой «Исправить поле»: следующий текст или голос — его значение. */
  editing: z.string().max(24).optional(),
  /** Карточка продавца, импорт которой ждёт ответа «заменить / оставить». */
  importClientId: z.guid().optional(),
  importMode: z.enum(["replace"]).optional(),
});
type State = z.infer<typeof stateSchema>;
type Transcribe = (msg: TelegramIncomingMessage, agentId: string, wallet: AssistantMoneyWallet) => Promise<{ text: string } | { error: string }>;
type Context = { chatId: string; agentId: string; fullName: string; lang: Lang; access: AgentAccess & { id: string; can: (permission: PermissionId) => boolean } };

const copy = {
  ru: {
    title: "📋 Проверьте объект",
    howTo: "Пришлите голосовое с описанием, фото, видео и точку на карте через скрепку. Исправить поле можно кнопкой «Исправить поле» или сообщением, например «Этаж: 5».",
    stale: "Черновик изменился. Нажмите «Проверить» ещё раз или откройте мастер командой /new_property.",
    exited: "Вышли из мастера. Черновик сохранён. Вернуться можно командой /new_property.",
    busy: "Сначала завершите текущее действие в чате.",
    unavailable: "Мастер объектов сейчас недоступен.",
    photoAdded: "Фото добавлено.",
    photoTooLarge: (mb: number) => `Пришлите фото размером до ${mb} МБ.`,
    videoAdded: "Видео добавлено.",
    videoTooLarge: (mb: number) => `Видео больше ${mb} МБ: Telegram не даёт боту скачать такой файл. Загрузите его в мастере CRM, черновик там тот же.`,
    videoFailed: "Видео не сохранилось. Пришлите его ещё раз или загрузите в мастере CRM.",
    videoNoSize: "Не вижу размер видео. Пришлите его файлом или загрузите в мастере CRM.",
    pointSaved: "Точка на карте сохранена.",
    district: "Район",
    landmark: "Ориентир",
    whatToFix: "Что исправить?",
    choose: (label: string) => `Выберите: ${label}.`,
    askText: (label: string) => `Напишите или скажите голосом: ${label}.`,
    chooseDetail: "Какую характеристику указать?",
    notSet: "Не указано",
    other: "Другое (напишу)",
    ready: "Всё заполнено. Проверьте данные и нажмите «Создать».",
    needMore: "Нужно ещё",
    waitFiles: "дождитесь обработки всех файлов или проверьте их в мастере CRM",
    staleFile: (name: string) => `файл «${name}» не догрузился — уберите его и пришлите снова`,
    removeFile: (label: string) => `Убрать: ${label}`,
    fileRemoved: "Файл убран.",
    listChanged: "Список файлов изменился.",
    videoUploading: "Видео загружается. Пришлю карточку, когда файл будет готов.",
    videoQueued: "Видео в очереди на загрузку: сначала догрузится предыдущее. Пришлю карточку, когда файл будет готов.",
    queuedFiles: (n: number) => `видео в очереди на загрузку: ${n} — «Создать» станет доступна, когда файлы догрузятся`,
    inQueue: "в очереди",
    videoInterrupted: (name: string) => `Загрузка видео «${name}» прервалась при перезапуске сервера. Пришлите его ещё раз.`,
    pointApproximate: "Проверьте точку: в ссылке был центр карты, а не метка.",
    noFiles: "В черновике пока нет файлов.",
    chooseFile: "Какой файл убрать?",
    cardChanged: "Карточка изменилась. Вот она сейчас.",
    albumAdded: (n: number) => `Принято фото: ${n}.`,
    newDuplicate: "Пока вы смотрели карточку, в CRM появился похожий объект.",
    districtMissing: "район из справочника",
    sellerMissing: "доступная карточка продавца в CRM",
    parseFailed: "Не разобрала поля. Напишите каждое с новой строки: «Цена: 750000», «Валюта: сомони», «Площадь: 68».",
    dailyLimit: "На сегодня закончился лимит разбора описаний. Заполните поля по одному, например «Площадь: 68».",
    nothingNew: "Новых полей не нашла. Пришлите описание объекта или нажмите «Исправить поле».",
    sellerLinked: "Продавец уже привязан к черновику. Сменить карточку можно в мастере CRM.",
    districtUnknown: "Район не совпал со справочником. Уточните его название.",
    agentMany: (names: string) => `Уточните имя агента: ${names}.`,
    agentNone: "Агента не нашла. Напишите полное имя.",
    duplicate: (code: string, details: string, more: number) =>
      `Похоже, этот объект уже есть в CRM: ${code}, ${details}${more ? ` и ещё ${more}` : ""}. Если это другой объект, нажмите «Всё равно создать».`,
    genericError: "Не получилось обновить черновик. Попробуйте ещё раз.",
    clientNotFound: "Карточку продавца с таким номером не нашла.",
    clientImported: "Данные продавца перенесены в черновик.",
    replaceDraft: "У вас уже есть заполненный черновик другого объекта. Заменить его данными продавца?",
    replaceMedia: (n: number) => `В черновике уже есть ваши файлы (${n}). Заменить их фото из переписки продавца?`,
    cancelled: "Оставила черновик как есть.",
    created: "✅ Объект создан. Фотографии и точка на карте в карточке.",
    createdPartly: (skipped: number) => `Файлов не перенеслось: ${skipped}. Добавьте их в карточке.`,
    createdPrefix: "✅ Объект создан.",
    open: "Открыть",
    duplicateHard: (code: string) => `В CRM уже есть такой объект: ${code}. Проверьте его перед созданием.`,
    rejected403: "CRM отклонила создание. Проверьте права и карточку продавца.",
    rejected: "CRM отклонила черновик. Проверьте поля и продавца в мастере.",
    confirmFailed: "Не удалось подтвердить результат. Проверьте список объектов в CRM перед повтором.",
    seller: "Продавец", intake: "Принял объект", files: "Файлы", photo: "фото", video: "видео", point: "Точка на карте",
    yes: "есть", addressSet: "указан", floorWord: "этаж", narration: "Текст для озвучки ролика",
    placeSite: "На сайт и в соцсети", placeCrm: "Только CRM (закрытый)",
    b: { review: "Проверить", create: "Создать", createAnyway: "Всё равно создать", fix: "Исправить поле", exit: "Выйти", back: "Назад",
      replaceDraft: "Заменить черновик", replaceMedia: "Заменить фото", keepMedia: "Оставить мои фото", keep: "Оставить как есть" },
  },
  tg: {
    title: "📋 Объектро санҷед",
    howTo: "Тавсифи объектро бо овоз фиристед, акс, видео ва нуқтаро дар харита тавассути гиреҳ (скрепка) илова кунед. Барои ислоҳ «Ислоҳи майдон»-ро пахш кунед ё нависед, масалан «Ошёна: 5».",
    stale: "Сиёҳнавис тағйир ёфт. «Санҷидан»-ро боз пахш кунед ё бо фармони /new_property кушоед.",
    exited: "Аз иловаи объект баромадем. Сиёҳнавис нигоҳ дошта шуд. Бо фармони /new_property баргаштан мумкин аст.",
    busy: "Аввал амали ҷориро дар чат анҷом диҳед.",
    unavailable: "Иловаи объект ҳоло дастрас нест.",
    photoAdded: "Акс илова шуд.",
    photoTooLarge: (mb: number) => `Лутфан акси то ${mb} МБ фиристед.`,
    videoAdded: "Видео илова шуд.",
    videoTooLarge: (mb: number) => `Видео аз ${mb} МБ калон аст: Telegram ба бот иҷозат намедиҳад, ки чунин файлро гирад. Онро дар CRM бор кунед, сиёҳнавис ҳамон аст.`,
    videoFailed: "Видео нигоҳ дошта нашуд. Лутфан боз фиристед ё дар CRM бор кунед.",
    videoNoSize: "Андозаи видео маълум нест. Онро ҳамчун файл фиристед ё дар CRM бор кунед.",
    pointSaved: "Нуқта дар харита нигоҳ дошта шуд.",
    district: "Ноҳия",
    landmark: "Мавқеъ",
    whatToFix: "Чиро ислоҳ кунем?",
    choose: (label: string) => `Интихоб кунед: ${label}.`,
    askText: (label: string) => `Нависед ё бо овоз гӯед: ${label}.`,
    chooseDetail: "Кадом хусусиятро нишон диҳем?",
    notSet: "Нишон дода нашудааст",
    other: "Дигар (менависам)",
    ready: "Ҳама пур шуд. Маълумотро санҷед ва «Сохтан»-ро пахш кунед.",
    needMore: "Боз лозим аст",
    waitFiles: "интизор шавед, то ҳамаи файлҳо коркард шаванд",
    staleFile: (name: string) => `файли «${name}» пурра бор нашуд — онро нест кунед ва боз фиристед`,
    removeFile: (label: string) => `Нест кардан: ${label}`,
    fileRemoved: "Файл нест карда шуд.",
    listChanged: "Рӯйхати файлҳо тағйир ёфт.",
    videoUploading: "Видео бор шуда истодааст. Вақте ки тайёр шуд, кортро мефиристам.",
    videoQueued: "Видео дар навбати боркунӣ: аввал видеои қаблӣ бор мешавад. Вақте ки тайёр шуд, кортро мефиристам.",
    queuedFiles: (n: number) => `видео дар навбати боркунӣ: ${n} — «Сохтан» баъди боршавии файлҳо дастрас мешавад`,
    inQueue: "дар навбат",
    videoInterrupted: (name: string) => `Боркунии видеои «${name}» ҳангоми бозоғози сервер қатъ шуд. Лутфан онро боз фиристед.`,
    pointApproximate: "Нуқтаро санҷед: дар истинод маркази харита буд, на нишона.",
    noFiles: "Дар сиёҳнавис ҳоло файл нест.",
    chooseFile: "Кадом файлро нест кунем?",
    cardChanged: "Корт тағйир ёфт. Ҳолати ҳозираи он.",
    albumAdded: (n: number) => `Акс қабул шуд: ${n}.`,
    newDuplicate: "Вақте ки шумо кортро медидед, дар CRM объекти монанд пайдо шуд.",
    districtMissing: "ноҳия аз феҳрист",
    sellerMissing: "корти дастраси фурӯшанда дар CRM",
    parseFailed: "Майдонҳоро нафаҳмидам. Ҳар якро аз сатри нав нависед: «Нарх: 750000», «Асъор: сомонӣ», «Масоҳат: 68».",
    dailyLimit: "Ҳадди имрӯзаи таҳлили тавсифҳо тамом шуд. Майдонҳоро як-як пур кунед, масалан «Масоҳат: 68».",
    nothingNew: "Майдони нав наёфтам. Тавсифи объектро фиристед ё «Ислоҳи майдон»-ро пахш кунед.",
    sellerLinked: "Фурӯшанда аллакай ба сиёҳнавис пайваст аст. Иваз кардани корт дар CRM мумкин аст.",
    districtUnknown: "Ноҳия бо феҳрист мувофиқ наомад. Номашро аниқ нависед.",
    agentMany: (names: string) => `Номи агентро аниқ кунед: ${names}.`,
    agentNone: "Агент ёфт нашуд. Номи пурраашро нависед.",
    duplicate: (code: string, details: string, more: number) =>
      `Чунин менамояд, ки ин объект аллакай дар CRM ҳаст: ${code}, ${details}${more ? ` ва боз ${more}` : ""}. Агар объекти дигар бошад, «Ба ҳар ҳол сохтан»-ро пахш кунед.`,
    genericError: "Сиёҳнавис нав нашуд. Лутфан боз кӯшиш кунед.",
    clientNotFound: "Корти фурӯшанда бо ин рақам ёфт нашуд.",
    clientImported: "Маълумоти фурӯшанда ба сиёҳнавис гузаронида шуд.",
    replaceDraft: "Шумо аллакай сиёҳнависи пуркардаи объекти дигар доред. Онро бо маълумоти фурӯшанда иваз кунем?",
    replaceMedia: (n: number) => `Дар сиёҳнавис аллакай файлҳои шумо ҳаст (${n}). Онҳоро бо аксҳои мукотибаи фурӯшанда иваз кунем?`,
    cancelled: "Сиёҳнависро ҳамон тавр гузоштам.",
    created: "✅ Объект сохта шуд. Аксҳо ва нуқтаи харита дар корт ҳастанд.",
    createdPartly: (skipped: number) => `Файлҳо нагузаштанд: ${skipped}. Онҳоро дар корт илова кунед.`,
    createdPrefix: "✅ Объект сохта шуд.",
    open: "Кушодан",
    duplicateHard: (code: string) => `Дар CRM аллакай чунин объект ҳаст: ${code}. Пеш аз сохтан онро санҷед.`,
    rejected403: "CRM сохтанро рад кард. Ҳуқуқҳо ва корти фурӯшандаро санҷед.",
    rejected: "CRM сиёҳнависро рад кард. Майдонҳо ва фурӯшандаро дар CRM санҷед.",
    confirmFailed: "Натиҷаро тасдиқ карда натавонистам. Пеш аз такрор рӯйхати объектҳоро дар CRM санҷед.",
    seller: "Фурӯшанда", intake: "Кӣ қабул кард", files: "Файлҳо", photo: "акс", video: "видео", point: "Нуқта дар харита",
    yes: "ҳаст", addressSet: "нишон дода шуд", floorWord: "ошёна", narration: "Матн барои овози видео",
    placeSite: "Ба сайт ва шабакаҳо", placeCrm: "Танҳо CRM (пӯшида)",
    b: { review: "Санҷидан", create: "Сохтан", createAnyway: "Ба ҳар ҳол сохтан", fix: "Ислоҳи майдон", exit: "Баромадан", back: "Бозгашт",
      replaceDraft: "Иваз кардан", replaceMedia: "Аксҳоро иваз кардан", keepMedia: "Аксҳои маро гузоред", keep: "Ҳамон тавр гузоштан" },
  },
} as const;
const t = (lang: Lang) => copy[lang];

/* ─────────────────────────── поля мастера ─────────────────────────── */

type Choice = { label: string; patch: Values; /** после выбора спросить текстом это поле */ thenAsk?: string };
type FieldDef = {
  id: string;
  /** Русская подпись — она же ключ «Поле: значение» для разбора (assistantPropertyFields.ts). */
  label: string;
  tg: string;
  shown: (v: Values, ctx: Context) => boolean;
  choices?: (v: Values, lang: Lang) => Choice[];
};

const enumValue = <T extends readonly string[]>(values: T, raw: unknown): T[number] | undefined =>
  typeof raw === "string" && (values as readonly string[]).includes(raw) ? raw as T[number] : undefined;
const typeOf = (v: Values) => enumValue(PROPERTY_TYPES, v.type);
const shownNumber = (field: "rooms" | "areaSqm" | "landAreaSotka" | "floor" | "totalFloors" | "windowCount") =>
  (v: Values) => Boolean(typeOf(v)) && propertyFieldShown(v.type, field);
const editForeign = (ctx: Context) => can({ agent: ctx.access }, "properties.editForeign");
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function finishChoices(v: Values): Choice[] {
  if (!propertyHasMarket(v.type)) {
    return SECONDARY_CONDITIONS.map(condition => ({ label: PROPERTY_CONDITION_LABELS[condition], patch: { condition } }));
  }
  return [
    ...SECONDARY_CONDITIONS.map(condition => ({
      label: `Вторичка, ${lower(PROPERTY_CONDITION_LABELS[condition])}`, patch: { marketType: "SECONDARY", stage: "", condition },
    })),
    ...NEW_BUILD_PHASES.map(phase => ({ label: `Новостройка, ${lower(phase.label)}`, patch: fieldsForNewBuildPhase(phase.key) })),
  ];
}

/** Тип меняется вместе с очисткой полей, которых у нового типа нет (как в мастере CRM). */
function typePatch(v: Values, type: PropertyType): Values {
  const patch: Values = { ...propertyWizardTypeChange(v, type) };
  // У участка нет «состояния»: мастер CRM держит в поле значение по умолчанию.
  if (!propertyHasCondition(type) && !v.condition) patch.condition = "GOOD";
  return patch;
}

const FIELDS: FieldDef[] = [
  { id: "place", label: "Куда пойдёт объект", tg: "Объект куҷо меравад", shown: () => true, choices: (_v, lang) => [
    { label: t(lang).placeSite, patch: { offSite: false } },
    { label: t(lang).placeCrm, patch: { offSite: true } },
  ] },
  { id: "type", label: "Вид", tg: "Навъ", shown: () => true, choices: v =>
    PROPERTY_TYPES.map(type => ({ label: PROPERTY_TYPE_LABELS[type], patch: typePatch(v, type) })) },
  { id: "finish", label: "Состояние", tg: "Ҳолат", shown: v => Boolean(typeOf(v)) && propertyHasCondition(v.type), choices: finishChoices },
  { id: "price", label: "Цена", tg: "Нарх", shown: () => true },
  { id: "cur", label: "Валюта", tg: "Асъор", shown: () => true, choices: () => CURRENCIES.map(currency => ({
    label: currency === "TJS" ? "Сомони" : "Доллары", patch: { currency } })) },
  { id: "rooms", label: "Комнаты", tg: "Ҳуҷраҳо", shown: shownNumber("rooms") },
  { id: "area", label: "Площадь", tg: "Масоҳат", shown: shownNumber("areaSqm") },
  { id: "sotka", label: "Сотки", tg: "Сотих", shown: shownNumber("landAreaSotka") },
  { id: "floor", label: "Этаж", tg: "Ошёна", shown: shownNumber("floor") },
  { id: "floors", label: "Этажей", tg: "Ошёнаҳои бино", shown: shownNumber("totalFloors") },
  { id: "windows", label: "Окна", tg: "Тирезаҳо", shown: shownNumber("windowCount") },
  { id: "district", label: "Район", tg: "Ноҳия", shown: () => true },
  { id: "address", label: "Адрес", tg: "Суроға", shown: () => true },
  { id: "landmark", label: "Ориентир", tg: "Мавқеъ", shown: () => true },
  { id: "seller", label: "Продавец", tg: "Фурӯшанда", shown: v => !v.sellerClientId },
  { id: "phone", label: "Телефон", tg: "Телефони фурӯшанда", shown: v => !v.sellerClientId },
  { id: "intake", label: "Агент", tg: "Кӣ қабул кард", shown: (_v, ctx) => editForeign(ctx) },
  { id: "docs", label: "Документы", tg: "Ҳуҷҷатҳо", shown: () => true, choices: (_v, lang) => [
    ...PROPERTY_DOCUMENT_PRESETS.map(preset => ({ label: preset, patch: { documentsPreset: preset, documentsOther: "" } })),
    { label: t(lang).other, patch: { documentsPreset: "Другое" }, thenAsk: "docs" },
  ] },
  { id: "details", label: "Характеристики", tg: "Хусусиятҳо", shown: v => PROPERTY_DETAIL_KEYS.some(key => propertyDetailShown(v.type, key)) },
  { id: "files", label: "Файлы", tg: "Файлҳо", shown: () => true },
];

function detailField(key: PropertyDetailKey): FieldDef {
  return {
    id: `d${PROPERTY_DETAIL_KEYS.indexOf(key)}`, label: propertyDetailFieldLabel(key), tg: propertyDetailFieldLabel(key),
    shown: v => propertyDetailShown(v.type, key),
    choices: (v, lang) => [
      ...PROPERTY_DETAIL_OPTIONS[key].map(option => ({
        label: propertyDetailOptionLabel(key, option), patch: { details: { ...(v.details ?? {}), [key]: option } },
      })),
      { label: t(lang).notSet, patch: { details: { ...(v.details ?? {}), [key]: DETAIL_NOT_SET } } },
    ],
  };
}

function fieldById(id: string): FieldDef | undefined {
  const detail = /^d(\d{1,2})$/u.exec(id);
  if (detail) {
    const key = PROPERTY_DETAIL_KEYS[Number(detail[1])];
    return key ? detailField(key) : undefined;
  }
  return FIELDS.find(field => field.id === id);
}
const fieldLabel = (field: FieldDef, lang: Lang) => lang === "tg" ? field.tg : field.label;

/** Ключи ошибок `propertyWizardErrors` и `propertyCreateSchema` → поле мастера. */
const FIELD_OF_ERROR: Record<string, string> = {
  type: "type", condition: "finish", price: "price", currency: "cur", rooms: "rooms", areaSqm: "area",
  landAreaSotka: "sotka", floor: "floor", totalFloors: "floors", windowCount: "windows", districtId: "district",
  address: "address", sellerName: "seller", sellerPhone: "phone", ownerContact: "phone", intakeAgentId: "intake",
};

/* ─────────────────────────── состояние диалога ─────────────────────────── */

function readState(row: { agentId: string; kind: string; expiresAt: Date; payload: unknown } | null, agentId: string) {
  if (!row || row.agentId !== agentId || row.kind !== kind || row.expiresAt <= new Date()) return null;
  const state = stateSchema.safeParse(row.payload);
  return state.success ? state.data : null;
}

async function getState(tx: TxClient, chatId: string, agentId: string) {
  return readState(await tx.telegramDialogState.findUnique({ where: { chatId } }), agentId);
}

async function writeState(tx: TxClient, { chatId, agentId }: Pick<Context, "chatId" | "agentId">, state: State) {
  await tx.telegramDialogState.updateMany({ where: { chatId, agentId, kind }, data: { payload: state, expiresAt: expiresAt() } });
}

/** Новое состояние поверх текущего; язык разговора сохраняется. */
async function patchState(ctx: Context, draftId: string, change: (state: State) => State): Promise<boolean> {
  return withDraftLock(ctx.agentId, async tx => {
    const state = await getState(tx, ctx.chatId, ctx.agentId);
    if (state?.draftId !== draftId) return false;
    await writeState(tx, ctx, { ...change(state), lang: ctx.lang });
    return true;
  });
}

const controls = (draftId: string, lang: Lang): TelegramInlineButton[][] => [
  [{ text: t(lang).b.fix, callback_data: `pdt:edit:${draftId}` }, { text: t(lang).b.review, callback_data: `pdt:review:${draftId}` }],
  [{ text: t(lang).b.exit, callback_data: `pdt:exit:${draftId}` }],
];

function rowsOf(buttons: TelegramInlineButton[], perRow = 2): TelegramInlineButton[][] {
  const rows: TelegramInlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return rows;
}

const rev = (draft: Pick<DraftRecord, "revision">) => draft.revision.toString(36);

function choiceButtons(field: FieldDef, values: Values, draft: Pick<DraftRecord, "id" | "revision">, lang: Lang): TelegramInlineButton[][] {
  return rowsOf((field.choices?.(values, lang) ?? []).map((choice, index) => ({
    text: choice.label, callback_data: `pdt:v:${field.id}:${index}:${rev(draft)}:${draft.id}`,
  })));
}

/** Загрузка, которая не двигается дольше этого, считается оборванной (выкат, обрыв связи). */
export const STALE_DRAFT_UPLOAD_MS = 30 * 60_000;
const isStaleUpload = (file: DraftRecord["media"][number], now = Date.now()) =>
  file.status !== "READY" && !queuedVideoMedia.has(file.id) && !activeVideoMedia.has(file.id)
  && now - file.updatedAt.getTime() > STALE_DRAFT_UPLOAD_MS;
const fileLabel = (draft: DraftRecord, index: number, lang: Lang) => {
  const file = draft.media[index];
  const sameKind = draft.media.slice(0, index + 1).filter(item => item.kind === file.kind).length;
  return `${file.kind === "PHOTO" ? t(lang).photo : t(lang).video} ${sameKind}${file.status === "READY" ? "" : queuedVideoMedia.has(file.id) ? ` ⏳ ${t(lang).inQueue}` : " ⏳"}`;
};
function removeButtons(draft: DraftRecord, lang: Lang, only?: (file: DraftRecord["media"][number]) => boolean): TelegramInlineButton[][] {
  return rowsOf(draft.media.flatMap((file, index) => (index < 40 && (!only || only(file))) ? [{
    // Файл называется своим id (первые 8 знаков), а не номером: добавление и
    // удаление файлов ревизию черновика не меняют, и номер старого меню указал
    // бы на другой файл — а удаление необратимо.
    text: t(lang).removeFile(fileLabel(draft, index, lang)), callback_data: `pdt:rm:${file.id.slice(0, 8)}:${draft.id}`,
  }] : []));
}

/* ─────────────────────────── карточка «Проверьте объект» ─────────────────────────── */

const readyMedia = (draft: DraftRecord, mediaKind: "PHOTO" | "VIDEO") =>
  draft.media.filter(file => file.kind === mediaKind && file.status === "READY");

async function review(ctx: Context, draft: DraftRecord) {
  const lang = ctx.lang;
  const c = t(lang);
  const values = propertyWizardDraftValuesSchema.parse(draft.values);
  const body = buildCreateBody(values);
  const canEditForeign = editForeign(ctx);
  const missing = new Map<string, string>();
  // Правило мастера («этаж выше этажности») показывается словами правила; простое
  // «не заполнено» и ошибки схемы — только названием поля.
  const addMissing = (key: string, message: string, rule: boolean) => {
    const field = fieldById(FIELD_OF_ERROR[key] ?? "");
    if (!field) { missing.set(key, message); return; }
    const label = lower(fieldLabel(field, lang));
    missing.set(field.id, rule && !/^(?:Укажите|Выберите)/u.test(message) ? `${label} (${lower(message)})` : label);
  };
  // Те же правила, что блокируют «Сохранить» в мастере CRM, плюс сама схема создания.
  for (const [key, message] of Object.entries(propertyWizardErrors(values, { requireIntakeAgent: canEditForeign }))) addMissing(key, message, true);
  const parsed = propertyCreateSchema.safeParse(body);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (!missing.has(FIELD_OF_ERROR[key] ?? key)) addMissing(key, issue.message, false);
    }
  }
  const stale = draft.media.filter(file => isStaleUpload(file));
  const queuedFiles = draft.media.filter(file => queuedVideoMedia.has(file.id));
  if (stale.length) missing.set("media", stale.map(file => c.staleFile(file.filename)).join(", "));
  else if (queuedFiles.length) missing.set("media", c.queuedFiles(queuedFiles.length));
  else if (draft.media.some(file => file.status !== "READY")) missing.set("media", c.waitFiles);

  const [district, intake, seller] = await Promise.all([
    values.districtId ? prisma.district.findUnique({ where: { id: values.districtId }, select: { name: true } }) : null,
    canEditForeign && values.intakeAgentId
      ? prisma.agent.findUnique({ where: { id: values.intakeAgentId }, select: { fullName: true } }) : null,
    values.sellerClientId ? prisma.client.findUnique({
      where: { id: values.sellerClientId }, select: { fullName: true, shortId: true, kind: true, assignedAgentId: true, deletedAt: true },
    }) : null,
  ]);
  if (values.districtId && !district) missing.set("district", c.districtMissing);
  if (canEditForeign && values.intakeAgentId) {
    const error = await assignableAgentError(values.intakeAgentId);
    if (error) missing.set("intake", error);
  }
  const sellerVisible = seller && !seller.deletedAt && canBindClient({ agent: ctx.access }, seller);
  if (values.sellerClientId && !sellerVisible) missing.set("seller", c.sellerMissing);

  const gap = "—";
  const type = typeOf(values);
  const amount = values.price && Number.isFinite(Number(values.price))
    ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(Number(values.price)) : values.price;
  const digits = values.sellerPhone?.replace(/\D/g, "");
  const phone = digits && digits.length >= 9 ? `•••• ${digits.slice(-2)}` : "";
  const finish = propertyFinishSummary({
    type: values.type, condition: enumValue(PROPERTY_CONDITIONS, values.condition),
    marketType: enumValue(MARKET_TYPES, values.marketType), stage: enumValue(PROPERTY_STAGES, values.stage),
  });
  const documents = values.documentsPreset === "Другое" ? values.documentsOther : values.documentsPreset;
  const row = (id: string, value: string | null | undefined | false) => {
    const field = fieldById(id)!;
    return field.shown(values, ctx) ? `${fieldLabel(field, lang)}: ${value || gap}` : null;
  };
  const sellerText = sellerVisible
    ? `${seller.fullName} · ${formatClientCode(seller.shortId, seller.kind)}`
    : [values.sellerName?.trim(), phone].filter(Boolean).join(" · ");
  const floorText = values.floor && values.totalFloors ? `${values.floor} / ${values.totalFloors}` : values.floor;
  const detailLines = PROPERTY_DETAIL_KEYS
    .filter(key => propertyDetailShown(values.type, key) && values.details?.[key] && values.details[key] !== DETAIL_NOT_SET)
    .map(key => `${propertyDetailFieldLabel(key)}: ${propertyDetailOptionLabel(key, values.details?.[key] ?? "")}`);
  // Текст для озвучки — тот же, что показывает шаг «Проверка» мастера CRM.
  const narration = type ? suggestedNarration({
    type, rooms: Number(values.rooms) || null, areaSqm: values.areaSqm || gap,
    floor: Number(values.floor) || null, totalFloors: Number(values.totalFloors) || null, district: district?.name ?? null,
  }) : null;
  const lines = [
    c.title,
    row("place", values.offSite ? c.placeCrm : c.placeSite),
    row("type", type && PROPERTY_TYPE_LABELS[type]),
    row("finish", finish),
    row("price", amount && `${amount} ${values.currency === "TJS" ? "сомони" : values.currency === "USD" ? "долларов" : ""}`.trim()),
    row("cur", values.currency === "TJS" ? "Сомони" : values.currency === "USD" ? "Доллары" : null),
    row("rooms", values.rooms),
    row("area", values.areaSqm && `${values.areaSqm} м²`),
    row("sotka", values.landAreaSotka && `${values.landAreaSotka} сот.`),
    propertyFieldShown(values.type, "floor") ? row("floor", floorText) : row("floors", values.totalFloors),
    row("windows", values.windowCount),
    row("district", district?.name),
    row("address", values.address?.trim() && c.addressSet),
    row("landmark", values.landmark?.trim()),
    `${c.seller}: ${sellerText || gap}`,
    `${c.intake}: ${canEditForeign ? intake?.fullName ?? gap : ctx.fullName}`,
    row("docs", documents),
    ...detailLines,
    `${c.files}: ${c.photo} ${readyMedia(draft, "PHOTO").length}, ${c.video} ${readyMedia(draft, "VIDEO").length}`,
    photoQualityLine(draft, lang),
    `${c.point}: ${values.lat != null && values.lng != null ? c.yes : gap}`,
    narration && `\n${c.narration}: ${narration}`,
  ].filter(Boolean);

  const duplicates = missing.size ? [] : await duplicateMatches(body);
  if (duplicates.length) {
    const first = duplicates[0];
    const facts = [`${first.areaSqm} м²`,
      first.floor != null && `${c.floorWord} ${first.floor}${first.totalFloors ? `/${first.totalFloors}` : ""}`,
      first.distanceM != null && first.matchedBy !== "address" && `${first.distanceM} м`].filter(Boolean).join(", ");
    lines.push(`\n⚠️ ${c.duplicate(formatPropertyCode(first.shortId), facts, duplicates.length - 1)}`);
  }
  lines.push(missing.size ? `\n${c.needMore}: ${[...missing.values()].join(", ")}.\n${c.howTo}` : `\n${c.ready}`);
  // Обязательное поле с готовыми вариантами — спрашиваем сразу кнопками.
  const firstChoice = [...missing.keys()].map(fieldById).find(field => field?.choices && field.shown(values, ctx));
  return { text: lines.join("\n"), missing: [...missing.values()], body, duplicates, values, firstChoice, hasStale: stale.length > 0 };
}

/** Тот же поиск, что GET /properties/duplicate-check у мастера CRM. */
async function duplicateMatches(body: Record<string, unknown>): Promise<PropertyDuplicateMatch[]> {
  const query = propertyDuplicateCheckQuerySchema.safeParse(Object.fromEntries(Object.entries({
    districtId: body.districtId, address: body.address, areaSqm: body.areaSqm, floor: body.floor, totalFloors: body.totalFloors,
    rooms: body.rooms, type: body.type, marketType: body.marketType, windowCount: body.windowCount,
    landAreaSotka: body.landAreaSotka, lat: body.lat, lng: body.lng,
  }).filter(([, value]) => value !== undefined)));
  if (!query.success) return [];
  try {
    return await findPropertyDuplicates(query.data);
  } catch (error) {
    void logSystemError("telegram", `Мастер объекта в Telegram: проверка дубля не прошла: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function sendReview(ctx: Context, draft: DraftRecord, prefix?: string) {
  const info = await review(ctx, draft);
  const buttons = controls(draft.id, ctx.lang);
  if (!info.missing.length) {
    const token = randomUUID();
    const ready = await withDraftLock(ctx.agentId, async tx => {
      const state = await getState(tx, ctx.chatId, ctx.agentId);
      if (state?.draftId !== draft.id) return false;
      const current = await assertActiveDraft(tx, ctx.agentId, { draftId: draft.id, revision: draft.revision });
      const media = draftMediaFingerprint(draft);
      if (draftMediaFingerprint(current) !== media) return false;
      await writeState(tx, ctx, { draftId: draft.id, lang: ctx.lang, preview: { token, revision: draft.revision, media, dupIds: info.duplicates.map(match => match.id).slice(0, 10) } });
      return true;
    });
    if (!ready) { await sendMessageWithButtons(ctx.chatId, t(ctx.lang).stale, buttons); return; }
    buttons.unshift([{ text: info.duplicates.length ? t(ctx.lang).b.createAnyway : t(ctx.lang).b.create, callback_data: `pdt:create:${token}` }]);
  } else if (info.hasStale) {
    buttons.unshift(...removeButtons(draft, ctx.lang, file => isStaleUpload(file)));
  } else if (info.firstChoice) {
    buttons.unshift(...choiceButtons(info.firstChoice, info.values, draft, ctx.lang));
  }
  await sendMessageWithButtons(ctx.chatId, prefix ? `${prefix}\n\n${info.text}` : info.text, buttons);
}

/* ─────────────────────────── черновик ─────────────────────────── */

async function startDraft(ctx: Context) {
  return withDraftLock(ctx.agentId, async tx => {
    const row = await tx.telegramDialogState.findUnique({ where: { chatId: ctx.chatId } });
    if (row && row.expiresAt > new Date() && (row.agentId !== ctx.agentId || ![kind, "assistant"].includes(row.kind))) return null;
    const current = await tx.propertyDraft.findUnique({ where: { agentId: ctx.agentId }, include: DRAFT_INCLUDE });
    const blank = { id: randomUUID(), values: {}, step: 0, closedAt: null, expiresAt: draftExpiry() };
    const draft = current && !current.closedAt
      ? await tx.propertyDraft.update({ where: { id: current.id }, data: { expiresAt: draftExpiry() }, include: DRAFT_INCLUDE })
      : await tx.propertyDraft.upsert({
        where: { agentId: ctx.agentId },
        create: { ...blank, agentId: ctx.agentId, revision: 1 },
        update: { ...blank, revision: { increment: 1 } },
        include: DRAFT_INCLUDE,
      });
    const data = { agentId: ctx.agentId, kind, payload: { draftId: draft.id, lang: ctx.lang }, expiresAt: expiresAt() };
    await tx.telegramDialogState.upsert({ where: { chatId: ctx.chatId }, create: { chatId: ctx.chatId, ...data }, update: data });
    return draft;
  });
}

async function saveFields(ctx: Context, draft: DraftRecord, patch: Values) {
  return withDraftLock(ctx.agentId, async tx => {
    const state = await getState(tx, ctx.chatId, ctx.agentId);
    if (state?.draftId !== draft.id) throw new DraftConflictError(null);
    const current = await assertActiveDraft(tx, ctx.agentId, { draftId: draft.id, revision: draft.revision });
    const values = propertyWizardDraftValuesSchema.parse({ ...propertyWizardDraftValuesSchema.parse(current.values), ...patch });
    const updated = await tx.propertyDraft.update({
      where: { id: draft.id }, data: { values, revision: { increment: 1 }, expiresAt: draftExpiry() }, include: DRAFT_INCLUDE,
    });
    await writeState(tx, ctx, { draftId: draft.id, lang: ctx.lang });
    return updated;
  });
}

async function exitDraft(ctx: Context, draftId: string) {
  const removed = await withDraftLock(ctx.agentId, async tx => {
    if ((await getState(tx, ctx.chatId, ctx.agentId))?.draftId !== draftId) return false;
    await tx.telegramDialogState.deleteMany({ where: { chatId: ctx.chatId, agentId: ctx.agentId, kind } });
    return true;
  });
  if (removed) await sendMessage(ctx.chatId, t(ctx.lang).exited);
}

/** Точка → район и ориентир теми же функциями, что у мастера CRM (useMapDistrict, usePointLandmarks). */
async function updateLocation(ctx: Context, draft: DraftRecord, point: z.infer<typeof location>, approximate = false): Promise<{ next: DraftRecord; note: string }> {
  const values = propertyWizardDraftValuesSchema.parse(draft.values);
  const lat = point.latitude;
  const lng = point.longitude;
  const safely = async <T>(label: string, run: () => Promise<T>): Promise<T | null> => {
    try { return await run(); } catch (error) {
      void logSystemError("telegram", `Мастер объекта в Telegram: ${label}(${lat},${lng}): ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const map = await safely("districtFromMap", () => districtFromMap({ lat, lng }));
  const geo = !values.address || (!map && !values.districtId) ? await safely("lookupGeoPoint", () => lookupGeoPoint(lat, lng)) : null;
  // Ориентир подставляется только в пустое поле: написанное агентом не трогаем.
  const landmark = values.landmark?.trim() ? null : await safely("landmarks", () => suggestLandmarksForPoint(lat, lng));
  const districtId = map?.id ?? values.districtId ?? geo?.district?.id;
  const address = values.address || (geo && formatGeoAddressGuess(geo));
  const landmarkText = landmark?.text.trim().slice(0, 120);
  const next = await saveFields(ctx, draft, {
    lat, lng, ...(districtId ? { districtId } : {}), ...(address ? { address } : {}), ...(landmarkText ? { landmark: landmarkText } : {}),
  });
  const districtName = map?.name ?? geo?.district?.name;
  const note = [t(ctx.lang).pointSaved, approximate && t(ctx.lang).pointApproximate, districtName && `${t(ctx.lang).district}: ${districtName}.`,
    landmarkText && `${t(ctx.lang).landmark}: ${landmarkText}.`].filter(Boolean).join(" ");
  return { next, note };
}

function documentsPatch(raw: string): Values {
  const preset = PROPERTY_DOCUMENT_PRESETS.find(item => item.toLowerCase() === raw.trim().toLowerCase());
  return preset ? { documentsPreset: preset, documentsOther: "" } : { documentsPreset: "Другое", documentsOther: raw.trim().slice(0, 200) };
}

/**
 * `prefix` — что уже сделано этим же сообщением (точка из ссылки); `silent` —
 * поля сохранить, но карточку не слать (подпись к альбому: карточка придёт одна,
 * после всего альбома).
 */
async function updateDescription(ctx: Context, draft: DraftRecord, text: string, wallet: AssistantMoneyWallet, options: { prefix?: string; silent?: boolean } = {}) {
  const lang = ctx.lang;
  const buttons = controls(draft.id, lang);
  const access = { agent: ctx.access };
  const withPrefix = (note?: string) => [options.prefix, note].filter(Boolean).join("\n") || undefined;
  const placement = /^(?:размещение:\s*)?(только crm|обычный объект)$/iu.exec(text);
  if (placement) {
    const saved = await saveFields(ctx, draft, { offSite: placement[1].toLowerCase() === "только crm" });
    if (!options.silent) await sendReview(ctx, saved, withPrefix());
    return;
  }
  let extracted;
  try {
    extracted = await extractPropertyFields(text.slice(0, 5000), ctx.agentId, wallet);
  } catch (error) {
    await sendMessageWithButtons(ctx.chatId, error instanceof Error && error.message === "draft_daily_limit" ? t(lang).dailyLimit : t(lang).parseFailed, buttons);
    return;
  }
  const { districtName, intakeAgentName, placement: place, documents, details, ...patch } = extracted;
  const currentValues = propertyWizardDraftValuesSchema.parse(draft.values);
  const values: Values = { ...patch };
  if (patch.type && patch.type !== currentValues.type) Object.assign(values, typePatch(currentValues, patch.type), patch);
  if (place) values.offSite = place === "CRM_ONLY";
  if (documents) Object.assign(values, documentsPatch(documents));
  if (details && Object.keys(details).length) values.details = { ...(currentValues.details ?? {}), ...details };
  const notes: string[] = [];
  if (districtName) {
    const id = await findDistrictIdByName(districtName);
    if (id) values.districtId = id;
    else notes.push(t(lang).districtUnknown);
  }
  if (intakeAgentName && can(access, "properties.editForeign")) {
    const match = await findActiveAgentByName(intakeAgentName);
    if (match.kind !== "one") notes.push(match.kind === "many"
      ? t(lang).agentMany(match.candidates.map(candidate => candidate.fullName).join(", "))
      : t(lang).agentNone);
    else {
      const error = await assignableAgentError(match.agent.id);
      if (error) notes.push(error);
      else values.intakeAgentId = match.agent.id;
    }
  }
  if (values.address || values.districtId) {
    const map = await districtFromMap({ lat: currentValues.lat, lng: currentValues.lng, address: values.address ?? currentValues.address });
    if (map) values.districtId = map.id;
  }
  if (currentValues.sellerClientId && (values.sellerName || values.sellerPhone)) {
    // Привязанная карточка продавца остаётся, пока сотрудник не сменит её в мастере CRM.
    delete values.sellerName;
    delete values.sellerPhone;
    notes.push(t(lang).sellerLinked);
  }
  if (!Object.keys(values).length) {
    if (options.prefix) await sendReview(ctx, draft, withPrefix(notes.join("\n")));
    else if (!options.silent || notes.length) await sendMessageWithButtons(ctx.chatId, notes.join("\n") || t(lang).nothingNew, buttons);
    return;
  }
  const saved = await saveFields(ctx, draft, values);
  if (!options.silent) await sendReview(ctx, saved, withPrefix(notes.join("\n")));
  else if (notes.length) await sendMessageWithButtons(ctx.chatId, notes.join("\n"), buttons);
}

/* ─────────────────────────── видео ─────────────────────────── */

type IncomingVideo = { file_id: string; file_size?: number; mime_type?: string; file_name?: string };

/** Фото файлом (без сжатия) — та же проверка типа, что у загрузки снимка в мастере CRM. */
function incomingPhotoDocument(msg: TelegramIncomingMessage) {
  const doc = msg.document;
  return doc && !doc.mime_type?.startsWith("video/") && isAcceptedDraftPhoto(doc.mime_type, doc.file_name) ? doc : null;
}
/** Снимок из Telegram: предел мастера CRM, но не больше того, что Bot API отдаёт боту. */
const TELEGRAM_DRAFT_PHOTO_LIMIT_BYTES = Math.min(DRAFT_PHOTO_MAX_BYTES, TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES);

function incomingVideo(msg: TelegramIncomingMessage): IncomingVideo | null {
  if (msg.video) return msg.video;
  if (msg.video_note) return msg.video_note;
  const doc = msg.document;
  if (doc && (doc.mime_type?.startsWith("video/") || /\.(?:mov|mp4|m4v|webm)$/iu.test(doc.file_name ?? ""))) return doc;
  return null;
}

/**
 * Предел ролика из Telegram: меньшее из того, что Bot API отдаёт боту, и общего
 * предела мастера CRM. На своём Bot API-сервере (`IS_LOCAL_BOT_API`, прод) это
 * 2000 МБ; 20 МБ — только у облачного Bot API.
 */
export const TELEGRAM_DRAFT_VIDEO_LIMIT_BYTES = Math.min(TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES, UPLOAD_VIDEO_MAX_BYTES);
const VIDEO_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Файл Telegram кусками ровно по плану частей — в памяти не больше одной части. */
async function* telegramFileParts(fileId: string, partSize: number): AsyncGenerator<Buffer> {
  // Таймаут getFile — общий (180 с): свой Bot API-сервер отвечает, только когда
  // сам докачал файл у Telegram, а это у ролика на сотни мегабайт не секунды.
  const ref = await resolveTelegramFile(fileId, TELEGRAM_DRAFT_VIDEO_LIMIT_BYTES);
  if (!ref) throw new Error("video_download_failed");
  if (ref.kind === "path") {
    const handle = await open(ref.path, "r");
    try {
      while (true) {
        const buffer = Buffer.alloc(partSize);
        let length = 0;
        while (length < partSize) {
          const read = await handle.read(buffer, length, partSize - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (!length) return;
        yield buffer.subarray(0, length);
        if (length < partSize) return;
      }
    } finally { await handle.close(); }
  }
  const response = await fetch(ref.url, { signal: AbortSignal.timeout(VIDEO_DOWNLOAD_TIMEOUT_MS), redirect: "error" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("video_download_failed");
  }
  const reader = response.body.getReader();
  let pending: Buffer[] = [];
  let pendingLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending.push(Buffer.from(chunk.value));
      pendingLength += chunk.value.byteLength;
      while (pendingLength >= partSize) {
        const joined = Buffer.concat(pending, pendingLength);
        yield joined.subarray(0, partSize);
        pending = [joined.subarray(partSize)];
        pendingLength -= partSize;
      }
    }
    if (pendingLength) yield Buffer.concat(pending, pendingLength);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const sessionSchema = z.union([
  z.object({ status: z.literal("done") }),
  z.object({
    status: z.enum(["started", "in-progress"]), mediaId: z.guid(), partSize: z.number().int().positive(),
    totalParts: z.number().int().positive(), uploadedPartNumbers: z.array(z.number().int()),
  }),
]);
const errorOf = (body: unknown) => body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : null;

const VIDEO_EXTENSION_BY_MIME: Record<string, string> = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/x-m4v": ".m4v", "video/webm": ".webm" };

/**
 * Имя ролика для сессии: своё имя из Telegram, а если у него нет годного
 * расширения («Видео от 10.11», «clip») — расширение по типу файла. Неизвестный
 * тип не подменяем: сервер сам честно откажет.
 */
export function telegramVideoFilename(name: string | undefined, mime: string, messageId?: number): string {
  const base = name?.trim() || `telegram-${messageId ?? "video"}`;
  const ext = /\.[A-Za-z0-9]{2,5}$/u.exec(base)?.[0].toLowerCase();
  const known = ext && Object.values(VIDEO_EXTENSION_BY_MIME).includes(ext);
  const byMime = VIDEO_EXTENSION_BY_MIME[mime];
  return (known || !byMime ? base : `${base}${byMime}`).slice(0, 255);
}

/** Почему ролик не взять ещё до скачивания (размер неизвестен или больше предела). */
function videoRefusal(video: IncomingVideo, lang: Lang): string | null {
  if (!video.file_size) return t(lang).videoNoSize;
  if (video.file_size > TELEGRAM_DRAFT_VIDEO_LIMIT_BYTES) return t(lang).videoTooLarge(Math.floor(TELEGRAM_DRAFT_VIDEO_LIMIT_BYTES / (1024 * 1024)));
  return null;
}

/** Ролик в черновик теми же шагами, что у мастера CRM: сессия → части → сборка. */
type OpenedVideo =
  | { kind: "message"; text: string }
  | { kind: "transfer"; mediaId: string; partSize: number; totalParts: number; uploaded: number[]; ours: boolean };

/**
 * Шаг 1 — сразу, в ходе сообщения: сессия загрузки открыта (файл виден в
 * черновике как «⏳» и держит «Создать»), подпись разбирается тут же. Шаг 2 —
 * перекачка байтов — в фоне (`queueVideoTransfer`).
 */
async function openTelegramVideo(ctx: Context, draft: DraftRecord, msg: TelegramIncomingMessage, video: IncomingVideo): Promise<OpenedVideo> {
  const lang = ctx.lang;
  const refusal = videoRefusal(video, lang);
  if (refusal || !video.file_size) return { kind: "message", text: refusal ?? t(lang).videoNoSize };
  const mime = video.mime_type?.startsWith("video/") ? video.mime_type : "video/mp4";
  const started = await startDraftVideoSession(ctx.agentId, draft.id, {
    uploadKey: `tg:${draft.id}:${msg.message_id ?? randomUUID()}`,
    filename: telegramVideoFilename(video.file_name, mime, msg.message_id),
    sizeBytes: video.file_size,
    contentType: mime,
  });
  if (started.status >= 300) return { kind: "message", text: errorOf(started.body) ?? t(lang).videoFailed };
  const session = sessionSchema.parse(started.body);
  if (session.status === "done") return { kind: "message", text: t(lang).videoAdded };
  // Сессию могли открыть не мы (тот же файл уже грузится из мастера CRM):
  // удалять при сбое можно только свою, только что начатую.
  return { kind: "transfer", mediaId: session.mediaId, partSize: session.partSize, totalParts: session.totalParts, uploaded: session.uploadedPartNumbers, ours: session.status === "started" };
}

/** Шаг 2: байты из Telegram частями в ту же сессию, затем сборка. */
async function transferTelegramVideo(ctx: Context, draftId: string, fileId: string, opened: Extract<OpenedVideo, { kind: "transfer" }>): Promise<string> {
  const lang = ctx.lang;
  const uploaded = new Set(opened.uploaded);
  try {
    let partNumber = 0;
    for await (const part of telegramFileParts(fileId, opened.partSize)) {
      partNumber += 1;
      if (partNumber > opened.totalParts) throw new Error("video_size_mismatch");
      if (uploaded.has(partNumber)) continue;
      const written = await writeDraftVideoPart(ctx.agentId, draftId, opened.mediaId, partNumber, part);
      if (written.status !== 200) throw new Error(errorOf(written.body) ?? "video_part_failed");
    }
    const completed = await completeDraftVideo(ctx.agentId, draftId, opened.mediaId);
    if (completed.status !== 200) throw new Error(errorOf(completed.body) ?? "video_complete_failed");
    return t(lang).videoAdded;
  } catch (error) {
    if (error instanceof DraftConflictError) throw error;
    if (!opened.ours) {
      const current = await prisma.propertyDraftMedia.findUnique({ where: { id: opened.mediaId }, select: { status: true } });
      if (current?.status === "READY") return t(lang).videoAdded;
    }
    void logSystemError("telegram", `Мастер объекта в Telegram: видео не сохранилось: ${error instanceof Error ? error.message : String(error)}`);
    if (opened.ours) await deleteDraftMedia(ctx.agentId, draftId, opened.mediaId).catch(() => undefined);
    return t(lang).videoFailed;
  }
}

/* ─────────────────────────── объект из карточки продавца ─────────────────────────── */

const importConflictSchema = z.object({ code: z.string().optional(), draftPhotoCount: z.number().optional(), draftVideoCount: z.number().optional() }).loose();

async function importSeller(ctx: Context, draft: DraftRecord, clientId: string, answer: { mode?: "replace"; media?: "replace" | "keep" } = {}) {
  const c = t(ctx.lang);
  // Те же права и та же склейка, что у кнопки «Добавить объект» в карточке продавца.
  const imported = await importClientIntoDraft({ agent: ctx.access }, clientId, { draftId: draft.id, revision: draft.revision, ...answer }, draft.id);
  if (imported.status === 409) {
    const body = importConflictSchema.parse(imported.body);
    if (body.code === "DRAFT_REPLACE_CONFIRM" || body.code === "DRAFT_MEDIA_REPLACE_CONFIRM") {
      await patchState(ctx, draft.id, state => ({ draftId: state.draftId, importClientId: clientId, ...(answer.mode ? { importMode: answer.mode } : {}) }));
      const question = body.code === "DRAFT_REPLACE_CONFIRM"
        ? { text: c.replaceDraft, buttons: [[{ text: c.b.replaceDraft, callback_data: `pdt:imp:rd:${draft.id}` }, { text: c.b.keep, callback_data: `pdt:imp:no:${draft.id}` }]] }
        : { text: c.replaceMedia((body.draftPhotoCount ?? 0) + (body.draftVideoCount ?? 0)), buttons: [[
          { text: c.b.replaceMedia, callback_data: `pdt:imp:rm:${draft.id}` }, { text: c.b.keepMedia, callback_data: `pdt:imp:km:${draft.id}` }]] };
      await sendMessageWithButtons(ctx.chatId, question.text, question.buttons);
      return;
    }
  }
  if (imported.status !== 200) {
    await sendMessageWithButtons(ctx.chatId, imported.status === 404 ? c.clientNotFound : errorOf(imported.body) ?? c.genericError, controls(draft.id, ctx.lang));
    return;
  }
  await patchState(ctx, draft.id, state => ({ draftId: state.draftId }));
  await sendReview(ctx, await assertActiveDraft(prisma, ctx.agentId, { draftId: draft.id }), c.clientImported);
}

/* ─────────────────────────── альбом фото ─────────────────────────── */

/**
 * Альбом приходит отдельными сообщениями без признака «последнее». Подтверждаем
 * одним сообщением «принято N фото», когда альбом затих (ответ на действие
 * сотрудника, не напоминание).
 */
const albums = new Map<string, { accepted: number; timer?: ReturnType<typeof setTimeout> }>();
let albumQuietMs = 2_500;
export function setAlbumQuietMsForTests(ms: number): void { albumQuietMs = ms; }

/** Следующее фото альбома уже обрабатывается — не подтверждать посреди альбома. */
function holdAlbum(chatId: string, groupId: string) {
  const key = `${chatId}:${groupId}`;
  const pending = albums.get(key);
  if (pending?.timer) clearTimeout(pending.timer);
  if (!pending) albums.set(key, { accepted: 0 });
}

/**
 * Фото альбома обработано (принято или нет). Таймер перевзводится в любом
 * случае — упавшее посреди альбома фото не должно съесть подтверждение
 * остальных; в итог «Принято фото: N» идут только фактически принятые.
 */
function finishAlbumPhoto(ctx: Context, draftId: string, groupId: string, accepted: boolean) {
  const key = `${ctx.chatId}:${groupId}`;
  const entry = albums.get(key) ?? { accepted: 0 };
  if (entry.timer) clearTimeout(entry.timer);
  if (accepted) entry.accepted += 1;
  entry.timer = setTimeout(() => {
    albums.delete(key);
    if (!entry.accepted) return;
    void (async () => {
      try {
        await sendReview(ctx, await assertActiveDraft(prisma, ctx.agentId, { draftId }), t(ctx.lang).albumAdded(entry.accepted));
      } catch (error) {
        if (!(error instanceof DraftConflictError)) {
          void logSystemError("telegram", `Мастер объекта в Telegram: подтверждение альбома не ушло: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();
  }, albumQuietMs);
  entry.timer.unref?.();
  albums.set(key, entry);
}

/* ─────────────────────────── ролики в фоне ─────────────────────────── */

/**
 * Перекачка ролика (на своём Bot API — до 2000 МБ) не держит ход помощника.
 * Не больше одной загрузки на сотрудника и двух на процесс: восемь роликов
 * одного агента не займут канал всем. Ролик в очереди виден в карточке как
 * «⏳ в очереди» и держит «Создать».
 *
 * Очередь живёт в памяти процесса. После перезапуска незаконченные загрузки из
 * Telegram (`tg:` в ключе) снимает `recoverInterruptedTelegramDraftUploads`, и
 * сотрудник получает ответ «загрузка прервалась, пришлите ещё раз», а не ждёт
 * карточку вечно.
 */
/** Когда загружен этот модуль — граница «от прошлого процесса» для уборки загрузок. */
const PROCESS_STARTED_AT = new Date();
const MAX_PARALLEL_VIDEO_UPLOADS = 2;
const MAX_VIDEO_UPLOADS_PER_AGENT = 1;
const activeVideoUploadsByAgent = new Map<string, number>();
let activeVideoUploads = 0;
const videoUploadQueue: Array<{ agentId: string; mediaId: string; start: () => void }> = [];
/** Файлы, которые этот процесс сейчас качает или держит в очереди. */
const queuedVideoMedia = new Set<string>();
const activeVideoMedia = new Set<string>();
const runningVideoUploads = new Set<Promise<void>>();

const canStartVideo = (agentId: string) =>
  activeVideoUploads < MAX_PARALLEL_VIDEO_UPLOADS && (activeVideoUploadsByAgent.get(agentId) ?? 0) < MAX_VIDEO_UPLOADS_PER_AGENT;

function pumpVideoQueue() {
  for (let index = 0; index < videoUploadQueue.length; index += 1) {
    const next = videoUploadQueue[index];
    if (!canStartVideo(next.agentId)) continue;
    videoUploadQueue.splice(index, 1);
    index -= 1;
    next.start();
  }
}

async function withVideoUploadSlot<T>(agentId: string, mediaId: string, run: () => Promise<T>): Promise<T> {
  queuedVideoMedia.add(mediaId);
  if (!canStartVideo(agentId)) await new Promise<void>(start => videoUploadQueue.push({ agentId, mediaId, start }));
  queuedVideoMedia.delete(mediaId);
  activeVideoMedia.add(mediaId);
  activeVideoUploads += 1;
  activeVideoUploadsByAgent.set(agentId, (activeVideoUploadsByAgent.get(agentId) ?? 0) + 1);
  try { return await run(); } finally {
    activeVideoMedia.delete(mediaId);
    activeVideoUploads -= 1;
    const left = (activeVideoUploadsByAgent.get(agentId) ?? 1) - 1;
    if (left > 0) activeVideoUploadsByAgent.set(agentId, left);
    else activeVideoUploadsByAgent.delete(agentId);
    pumpVideoQueue();
  }
}

/** Тестам: дождаться всех фоновых загрузок роликов. */
export async function waitForTelegramDraftUploadsForTests(): Promise<void> {
  while (runningVideoUploads.size) await Promise.all([...runningVideoUploads]);
}

function queueVideoTransfer(ctx: Context, draftId: string, fileId: string, opened: Extract<OpenedVideo, { kind: "transfer" }>) {
  const job = withVideoUploadSlot(ctx.agentId, opened.mediaId, async () => {
    try {
      const note = await transferTelegramVideo(ctx, draftId, fileId, opened);
      await sendReview(ctx, await assertActiveDraft(prisma, ctx.agentId, { draftId }), note);
    } catch (error) {
      if (error instanceof DraftConflictError) {
        await sendMessageWithButtons(ctx.chatId, t(ctx.lang).stale, controls(draftId, ctx.lang)).catch(() => {});
        return;
      }
      void logSystemError("telegram", `Мастер объекта в Telegram: фоновая загрузка видео: ${error instanceof Error ? error.message : String(error)}`);
      await sendMessageWithButtons(ctx.chatId, t(ctx.lang).videoFailed, controls(draftId, ctx.lang)).catch(() => {});
    }
  }).finally(() => { runningVideoUploads.delete(job); });
  runningVideoUploads.add(job);
}

/**
 * Запуск процесса, который обслуживает Telegram (поллер или вебхук): загрузки
 * роликов из Telegram, оставшиеся «загружается», — от прошлого процесса, их
 * никто не докачает. Снимаем и честно говорим сотруднику, что прислать снова.
 */
export async function recoverInterruptedTelegramDraftUploads(): Promise<number> {
  const stuck = await prisma.propertyDraftMedia.findMany({
    // Только то, что не двигалось с запуска процесса: свежую загрузку этого процесса не трогаем.
    where: { kind: "VIDEO", status: "UPLOADING", uploadKey: { startsWith: "tg:" }, updatedAt: { lt: PROCESS_STARTED_AT } },
    select: { id: true, filename: true, draftId: true, draft: { select: { agentId: true, closedAt: true, agent: { select: { telegramChatId: true } } } } },
    take: 200,
  });
  let removed = 0;
  for (const media of stuck) {
    if (queuedVideoMedia.has(media.id) || activeVideoMedia.has(media.id)) continue;
    try {
      await deleteDraftMedia(media.draft.agentId, media.draftId, media.id);
      removed += 1;
      const chatId = media.draft.agent.telegramChatId;
      if (chatId && !media.draft.closedAt) await sendMessage(chatId, copy.ru.videoInterrupted(media.filename)).catch(() => {});
    } catch (error) {
      void logSystemError("telegram", `Мастер объекта в Telegram: не снята прерванная загрузка видео: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return removed;
}

/* ─────────────────────────── входящие ─────────────────────────── */

/** Язык разговора: по собственным словам сотрудника; команда, число или смесь языков его не меняют. */
function languageOf(text: string, fallback: Lang): Lang {
  if (!text.trim() || text.startsWith("/")) return fallback;
  const detected = assistantLanguage([{ role: "user", content: text }]);
  return detected === "tg" ? "tg" : detected === "ru" ? "ru" : fallback;
}

async function contextFor(agentId: string, fullName: string, chatId: string, lang: Lang): Promise<Context | null> {
  const access = await loadAgentAccess(agentId);
  return access && { chatId, agentId, fullName, lang, access: { ...access, id: agentId, can: (permission: PermissionId) => access.permissions.has(permission) } };
}

export async function handleTelegramPropertyDraft(
  msg: TelegramIncomingMessage, agent: { id: string; fullName: string }, transcribe: Transcribe,
): Promise<boolean> {
  if (msg.chat.type !== "private" || !msg.from || msg.from.id !== msg.chat.id) return false;
  const chatId = String(msg.chat.id);
  const text = (msg.text ?? msg.caption ?? "").trim();
  const sellerCode = fromClientStart.exec(text)?.[1];
  const start = isStart.test(text) || Boolean(sellerCode);
  const state = await getState(prisma, chatId, agent.id);
  if (!start && !state) return false;
  const ctx = await contextFor(agent.id, agent.fullName, chatId, languageOf(text, state?.lang ?? "ru"));
  const denied = ctx && propertyCreateDeniedReason({ agent: ctx.access });
  if (!ctx?.access.isActive || denied || !(await isAiAssistantEnabled())) {
    await sendMessage(chatId, denied ?? t(ctx?.lang ?? "ru").unavailable);
    return true;
  }
  const lang = ctx.lang;
  try {
    if (start) {
      const draft = await startDraft(ctx);
      if (!draft) await sendMessage(chatId, t(lang).busy);
      else if (sellerCode) {
        const shortId = parseShortCode(sellerCode);
        const client = shortId ? await prisma.client.findUnique({ where: { shortId }, select: { id: true, deletedAt: true } }) : null;
        if (!client || client.deletedAt) await sendMessageWithButtons(chatId, t(lang).clientNotFound, controls(draft.id, lang));
        else await importSeller(ctx, draft, client.id);
      } else await sendReview(ctx, draft);
    } else if (state && isExit.test(text)) {
      await exitDraft(ctx, state.draftId);
    } else if (state) {
      const draft = await assertActiveDraft(prisma, agent.id, { draftId: state.draftId });
      const compressed = msg.photo?.at(-1);
      const photoFile = compressed ? null : incomingPhotoDocument(msg);
      const picture = compressed ?? photoFile;
      const video = picture ? null : incomingVideo(msg);
      const textPoint = msg.text && !picture && !video ? await mapPointFromText(msg.text) : null;
      const point = msg.location ?? msg.venue?.location ?? (textPoint && { latitude: textPoint.lat, longitude: textPoint.lng });
      // Ссылка на карту среди описания: точку берём из ссылки, остальное разбираем как обычно.
      const textAfterPoint = textPoint && msg.text ? msg.text.replace(firstLinkIn(msg.text) ?? msg.text, "").trim() : "";
      const editing = state.editing ? fieldById(state.editing) : undefined;
      // Поле выбрано кнопкой «Исправить поле» — ответ становится «Поле: значение».
      const asField = (value: string) => editing ? `${editing.label}: ${value.replace(/\s*\n\s*/gu, " ")}` : value;
      if (picture) {
        const album = msg.media_group_id;
        if (album) holdAlbum(ctx.chatId, album);
        let accepted = false;
        try {
          const maxBytes = TELEGRAM_DRAFT_PHOTO_LIMIT_BYTES;
          const compressedByTelegram = Boolean(compressed) && isTelegramCompressed(msg.photo);
          if (compressedByTelegram && rejectsCompressed(draft)) {
            await tellCompressedRejected(chatId, lang, album);
            return true;
          }
          if (picture.file_size && picture.file_size > maxBytes) throw new Error("photo_too_large");
          const buffer = await downloadAssistantMedia(picture.file_id, maxBytes);
          const uploadKey = `tg:${draft.id}:${msg.message_id}`;
          const saved = await savePropertyDraftPhotos(agent.id, draft.id, [{
            buffer, mimetype: photoFile?.mime_type || "image/jpeg", size: buffer.length,
            originalname: photoFile?.file_name?.slice(0, 255) || `telegram-${msg.message_id}.jpg`,
          }], [uploadKey]);
          accepted = saved.status === 201 || saved.status === 200;
          if (accepted) {
            // Пометки качества — до карточки, чтобы она их уже показала. Файл-фото
            // (document) — оригинал: сжатым его не считаем.
            await recordDraftPhotoQuality(uploadKey, buffer, compressedByTelegram);
            if (compressedByTelegram) await askAboutCompressedOnce(chatId, draft.id, lang);
          }
          if (!accepted) {
            await sendMessageWithButtons(chatId, "error" in saved.body ? saved.body.error : t(lang).genericError, controls(draft.id, lang));
          } else if (text) {
            // Подпись альбома приходит только у первого фото: поля сохраняем, карточка — одна, после альбома.
            await updateDescription(ctx, draft, text, createAssistantMoneyWallet(), { silent: Boolean(album) });
          } else if (!album) {
            await sendReview(ctx, await assertActiveDraft(prisma, agent.id, { draftId: draft.id }), t(lang).photoAdded);
          }
        } finally {
          if (album) finishAlbumPhoto(ctx, draft.id, album, accepted);
        }
      } else if (video) {
        const opened = await openTelegramVideo(ctx, draft, msg, video);
        if (opened.kind === "message") {
          if (text) await updateDescription(ctx, await assertActiveDraft(prisma, agent.id, { draftId: draft.id }), text, createAssistantMoneyWallet(), { prefix: opened.text });
          else await sendReview(ctx, await assertActiveDraft(prisma, agent.id, { draftId: draft.id }), opened.text);
        } else {
          // Подпись разбирается сразу: иначе через минуты загрузки она затёрла бы
          // поправку, которую агент успел сделать за это время. В фоне — только файл.
          const queued = !canStartVideo(agent.id);
          queueVideoTransfer(ctx, draft.id, video.file_id, opened);
          const note = queued ? t(lang).videoQueued : t(lang).videoUploading;
          if (text) await updateDescription(ctx, await assertActiveDraft(prisma, agent.id, { draftId: draft.id }), text, createAssistantMoneyWallet(), { prefix: note });
          else await sendMessageWithButtons(chatId, note, controls(draft.id, lang));
        }
      } else if (point) {
        const located = await updateLocation(ctx, draft, location.parse(point), Boolean(textPoint?.approximate));
        if (textAfterPoint) await updateDescription(ctx, located.next, textAfterPoint, createAssistantMoneyWallet(), { prefix: located.note });
        else await sendReview(ctx, located.next, located.note);
      } else if (msg.voice || msg.audio) {
        const wallet = createAssistantMoneyWallet();
        const voice = await transcribe(msg, agent.id, wallet);
        if ("error" in voice) await sendMessageWithButtons(chatId, voice.error, controls(draft.id, lang));
        else await updateDescription(ctx, draft, asField(voice.text), wallet);
      } else if (text && !text.startsWith("/")) {
        if (/^(?:черновик|проверь черновик|покажи черновик|сиёҳнавис)$/iu.test(text)) await sendReview(ctx, draft);
        else await updateDescription(ctx, draft, asField(text), createAssistantMoneyWallet());
      } else {
        await sendMessageWithButtons(chatId, t(lang).howTo, controls(draft.id, lang));
      }
    }
  } catch (error) {
    const message = error instanceof DraftConflictError ? t(lang).stale
      : error instanceof Error && error.message === "photo_too_large" ? t(lang).photoTooLarge(Math.floor(TELEGRAM_DRAFT_PHOTO_LIMIT_BYTES / (1024 * 1024)))
      : t(lang).genericError;
    if (!(error instanceof DraftConflictError)) console.warn("[telegram:property-draft] intake failed", { kind: error instanceof Error ? error.name : "unknown" });
    if (state) await sendMessageWithButtons(chatId, message, controls(state.draftId, lang));
    else await sendMessage(chatId, message);
  }
  return true;
}

/* ─────────────────────────── кнопки ─────────────────────────── */

/** «✅ Оставить эти / 📎 Пришлю файлом» — ответ автора черновика, один раз. */
async function handlePhotoQualityAnswer(query: TelegramCallbackQuery): Promise<boolean> {
  const answer = (text?: string) => answerCallbackQuery(query.id, text).catch(() => {});
  const [, choice, draftId] = photoQualityCallback.exec(query.data ?? "") ?? [];
  const chat = query.message?.chat;
  if (chat?.type !== "private" || query.from?.id !== chat.id) { await answer("Кнопка доступна только в личке автора"); return true; }
  const chatId = String(chat.id);
  const agent = await findAgentByTelegramChatId(chatId);
  const state = agent && await getState(prisma, chatId, agent.id);
  if (!agent || !state || state.draftId !== draftId) { await answer("Кнопка устарела"); return true; }
  const lang = state.lang ?? "ru";
  try {
    const draft = await assertActiveDraft(prisma, agent.id, { draftId });
    const text = await answerCompressedChoice(agent.id, draft, choice === "file" ? "file" : "keep", lang);
    await answer(text);
    const messageId = query.message?.message_id;
    // Кнопки убираем: вопрос задан один раз и ответ записан.
    if (messageId) await editMessageText(chatId, messageId, `${query.message?.text ?? ""}\n\n${text}`, null).catch(() => {});
  } catch (error) {
    if (error instanceof DraftConflictError) { await answer("Черновик уже закрыт"); return true; }
    void logSystemError("telegram", `Мастер объекта: ответ про сжатые фото: ${error instanceof Error ? error.message : String(error)}`);
    await answer("Не получилось, попробуйте ещё раз");
  }
  return true;
}

async function sendFieldPrompt(ctx: Context, draft: DraftRecord, field: FieldDef, values: Values) {
  const c = t(ctx.lang);
  const draftId = draft.id;
  const back = [{ text: c.b.back, callback_data: `pdt:edit:${draftId}` }];
  if (field.id === "details") {
    const buttons = rowsOf(PROPERTY_DETAIL_KEYS.filter(key => propertyDetailShown(values.type, key)).map(key => ({
      text: propertyDetailFieldLabel(key), callback_data: `pdt:f:${detailField(key).id}:${draftId}`,
    })));
    await sendMessageWithButtons(ctx.chatId, c.chooseDetail, [...buttons, back]);
  } else if (field.id === "files") {
    await sendMessageWithButtons(ctx.chatId, draft.media.length ? c.chooseFile : c.noFiles, [...removeButtons(draft, ctx.lang), back]);
  } else if (field.choices) {
    await sendMessageWithButtons(ctx.chatId, c.choose(lower(fieldLabel(field, ctx.lang))), [...choiceButtons(field, values, draft, ctx.lang), back]);
  } else {
    await askText(ctx, draftId, field);
  }
}

async function askText(ctx: Context, draftId: string, field: FieldDef) {
  const c = t(ctx.lang);
  await patchState(ctx, draftId, current => ({ draftId: current.draftId, editing: field.id }));
  await sendMessageWithButtons(ctx.chatId, c.askText(lower(fieldLabel(field, ctx.lang))), [[{ text: c.b.back, callback_data: `pdt:review:${draftId}` }]]);
}

export async function handleTelegramPropertyDraftCallback(query: TelegramCallbackQuery): Promise<boolean> {
  if (!query.data?.startsWith("pdt:")) return false;
  if (photoQualityCallback.test(query.data)) return handlePhotoQualityAnswer(query);
  const answer = (text?: string) => answerCallbackQuery(query.id, text).catch(() => {});
  const action = callback.exec(query.data);
  const fieldAction = fieldCallback.exec(query.data);
  const valueAction = valueCallback.exec(query.data);
  const importAction = importCallback.exec(query.data);
  const removeAction = removeCallback.exec(query.data);
  const chat = query.message?.chat;
  const messageId = query.message?.message_id;
  if (!messageId || chat?.type !== "private" || query.from?.id !== chat.id) {
    await answer("Кнопка доступна только в личке автора");
    return true;
  }
  if (!action && !fieldAction && !valueAction && !importAction && !removeAction) {
    // Кнопка прежнего вида (до ревизии в кнопках) — не «чужая», а устаревшая.
    await answer("Кнопка устарела");
    const owner = await findAgentByTelegramChatId(String(chat.id));
    const current = owner && await getState(prisma, String(chat.id), owner.id);
    if (owner && current) {
      const staleCtx = await contextFor(owner.id, owner.fullName, String(chat.id), current.lang ?? "ru");
      if (staleCtx) await sendReview(staleCtx, await assertActiveDraft(prisma, owner.id, { draftId: current.draftId }), t(staleCtx.lang).cardChanged).catch(() => {});
    }
    return true;
  }
  const chatId = String(chat.id);
  const agent = await findAgentByTelegramChatId(chatId);
  if (!agent || !(await isAiAssistantEnabled())) { await answer("Мастер недоступен"); return true; }
  invalidateAgentAccess(agent.id);
  const state = await getState(prisma, chatId, agent.id);
  const ctx = await contextFor(agent.id, agent.fullName, chatId, state?.lang ?? "ru");
  if (!ctx?.access.isActive || propertyCreateDeniedReason({ agent: ctx.access })) { await answer("Нет прав на создание"); return true; }
  const lang = ctx.lang;
  const command = action?.[1] ?? (fieldAction ? "field" : valueAction ? "value" : removeAction ? "remove" : "import");
  const id = action?.[2] ?? fieldAction?.[2] ?? valueAction?.[4] ?? importAction?.[2] ?? removeAction?.[2] ?? "";
  const expectedRevision = valueAction?.[3];
  if (!state || (command === "create" ? state.preview?.token !== id : state.draftId !== id)) {
    await answer("Кнопка устарела");
    return true;
  }
  await answer();
  try {
    if (command === "exit") { await exitDraft(ctx, id); return true; }
    if (command === "review") {
      await patchState(ctx, id, current => ({ draftId: current.draftId }));
      await sendReview(ctx, await assertActiveDraft(prisma, agent.id, { draftId: id }));
      return true;
    }
    if (command === "edit" || command === "field" || command === "value" || command === "remove") {
      const draft = await assertActiveDraft(prisma, agent.id, { draftId: id });
      const values = propertyWizardDraftValuesSchema.parse(draft.values);
      if (expectedRevision !== undefined && expectedRevision !== rev(draft)) {
        await sendReview(ctx, draft, t(lang).cardChanged);
        return true;
      }
      if (command === "remove") {
        const matches = draft.media.filter(file => file.id.startsWith(removeAction?.[1] ?? "-"));
        if (matches.length !== 1) {
          await sendMessageWithButtons(chatId, draft.media.length ? `${t(lang).listChanged}\n${t(lang).chooseFile}` : t(lang).noFiles,
            [...removeButtons(draft, lang), [{ text: t(lang).b.back, callback_data: `pdt:review:${id}` }]]);
          return true;
        }
        await deleteDraftMedia(agent.id, draft.id, matches[0].id);
        await sendReview(ctx, await assertActiveDraft(prisma, agent.id, { draftId: id }), t(lang).fileRemoved);
        return true;
      }
      if (command === "edit") {
        const buttons = rowsOf(FIELDS.filter(field => field.shown(values, ctx)).map(field => ({
          text: fieldLabel(field, lang), callback_data: `pdt:f:${field.id}:${id}`,
        })));
        await sendMessageWithButtons(chatId, t(lang).whatToFix, [...buttons, [{ text: t(lang).b.back, callback_data: `pdt:review:${id}` }]]);
        return true;
      }
      const field = fieldById(fieldAction?.[1] ?? valueAction?.[1] ?? "");
      if (!field?.shown(values, ctx)) { await sendReview(ctx, draft); return true; }
      if (command === "field") { await sendFieldPrompt(ctx, draft, field, values); return true; }
      const choice = field.choices?.(values, lang)[Number(valueAction?.[2])];
      if (!choice) { await sendReview(ctx, draft); return true; }
      const updated = await saveFields(ctx, draft, choice.patch);
      const next = choice.thenAsk ? fieldById(choice.thenAsk) : undefined;
      if (next) await askText(ctx, id, next);
      else await sendReview(ctx, updated);
      return true;
    }
    if (command === "import") {
      const draft = await assertActiveDraft(prisma, agent.id, { draftId: id });
      const clientId = state.importClientId;
      const reply = importAction?.[1];
      if (!clientId || reply === "no") {
        await patchState(ctx, id, current => ({ draftId: current.draftId }));
        await sendReview(ctx, draft, t(lang).cancelled);
        return true;
      }
      await importSeller(ctx, draft, clientId, {
        ...(reply === "rd" || state.importMode ? { mode: "replace" as const } : {}),
        ...(reply === "rm" ? { media: "replace" as const } : reply === "km" ? { media: "keep" as const } : {}),
      });
      return true;
    }
    const claimed = await withDraftLock(agent.id, async tx => {
      const current = await getState(tx, chatId, agent.id);
      const preview = current?.preview;
      if (!current || preview?.token !== id) return null;
      const draft = await assertActiveDraft(tx, agent.id, { draftId: current.draftId, revision: preview.revision });
      if (draftMediaFingerprint(draft) !== preview.media) throw new DraftConflictError(draft);
      await writeState(tx, ctx, { draftId: draft.id, lang });
      return { draft, media: preview.media, dupIds: preview.dupIds ?? [] };
    });
    if (!claimed) return true;
    const info = await review(ctx, claimed.draft);
    if (info.missing.length) { await sendReview(ctx, claimed.draft); return true; }
    // Дубль проверяется ещё раз в момент создания: между показом карточки и
    // нажатием в CRM мог появиться объект, о котором сотрудник не предупреждён.
    if (info.duplicates.some(match => !claimed.dupIds.includes(match.id))) {
      await sendReview(ctx, claimed.draft, t(lang).newDuplicate);
      return true;
    }
    const result = await createProperty({
      agent: ctx.access, source: "telegram", expectedDraftMedia: claimed.media,
      body: { ...info.body, draftId: claimed.draft.id, draftRevision: claimed.draft.revision },
    });
    if (result.status !== 201) {
      const body: Record<string, unknown> = result.body as Record<string, unknown>;
      const existingShortId = typeof body.existingShortId === "number" ? body.existingShortId : null;
      const reply = body.code === "DRAFT_CONFLICT" ? t(lang).stale
        : existingShortId ? t(lang).duplicateHard(formatPropertyCode(existingShortId))
        : result.status === 403 ? t(lang).rejected403
        : t(lang).rejected;
      await sendMessageWithButtons(chatId, reply, controls(claimed.draft.id, lang));
      return true;
    }
    await withDraftLock(agent.id, async tx => {
      if ((await getState(tx, chatId, agent.id))?.draftId === claimed.draft.id) {
        await tx.telegramDialogState.deleteMany({ where: { chatId, agentId: agent.id, kind } });
      }
    });
    const created = z.object({ id: z.guid(), shortId: z.number().int() }).parse(result.body);
    const number = formatPropertyCode(created.shortId);
    const base = process.env.CRM_PUBLIC_URL?.trim().replace(/\/+$/, "") || "https://crm.royalhome.tj";
    const buttons = [[{ text: `${t(lang).open} ${number}`, url: `${base}/properties/${created.id}` }]];
    const media = "media" in result.body ? result.body.media : undefined;
    const skipped = (media?.skipped.photos ?? 0) + (media?.skipped.videos ?? 0);
    const createdText = media?.error || skipped
      ? `${t(lang).createdPrefix} ${media?.error ?? t(lang).createdPartly(skipped)}`
      : t(lang).created;
    try { await editMessageText(chatId, messageId, createdText, buttons); }
    catch { await sendMessageWithButtons(chatId, createdText, buttons); }
    // Кому подходит объект — одно сообщение, клиентам ничего не уходит.
    await sendPropertyMatchesCard(chatId, { agent: ctx.access }, created.id, lang);
  } catch (error) {
    if (error instanceof DraftConflictError) {
      await sendMessageWithButtons(chatId, t(lang).stale, controls(state.draftId, lang));
    } else {
      console.warn("[telegram:property-draft] confirmation failed", { kind: error instanceof Error ? error.name : "unknown" });
      await sendMessage(chatId, t(lang).confirmFailed);
    }
  }
  return true;
}
