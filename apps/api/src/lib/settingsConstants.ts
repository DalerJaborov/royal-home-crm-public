/**
 * НАСТРОЙКИ, УШЕДШИЕ В КОД (01.11.2026, пачка В чистки экрана «Настройки CRM»).
 *
 * Владелец: «всё должно работать по умолчанию», на экране остаются только
 * настоящие рычаги — ключи и подключения, бизнес-правила, аварийные выключатели.
 * Технические параметры алгоритмов (таймеры, веса, имена моделей, порт станции,
 * тонкая настройка голоса) выбирает разработчик, поэтому они живут здесь.
 *
 * ЗНАЧЕНИЯ — ИЗ СНИМКА ПРОДА 01.11.2026 (D:/CRM-migration-20261021/
 * settings-prod-values-20261101.json), а не дефолты схемы: перенос не должен
 * изменить поведение прода ни на одном пути. Колонки в `Settings` остались
 * (помечены «не используется с 01.11.2026») — без миграции и без потери данных.
 *
 * Модуль намеренно без импортов: его читают и горячие пути (ИИ, телефония), и
 * точки возврата настроек, циклу импортов здесь взяться неоткуда.
 *
 * Поменять значение — правкой здесь и выкатом, а не на экране.
 */

/* ── Светофор неактивных клиентов (Деньги) ─────────────────────────────── */
/** Сколько реальных попыток контакта нужно для перевода в «Неактивные». */
export const INACTIVATE_MIN_ATTEMPTS = 2;
/** Пауза после перевода в «Неактивные» до следующего такого перевода, часов. */
export const INACTIVATE_COOLDOWN_HOURS = 5;
// Число проверок по цвету светофора — в packages/shared (INACTIVE_TRAFFIC_MAX_ATTEMPTS):
// его же считает экран, правило одно на обе стороны.

/* ── Уведомления (Лиды) ────────────────────────────────────────────────── */
/** Сколько минут живёт одноразовый маркер действия в уведомлении. */
export const PUSH_ACTION_TTL_MINUTES = 30;
/** Не чаще одного уведомления о сообщениях одного клиента за столько минут. */
export const PUSH_MESSAGE_THROTTLE_MINUTES = 3;

/* ── Подбор ────────────────────────────────────────────────────────────── */
/** Порог повторного уведомления при снижении цены, процентов. */
export const MATCH_PRICE_DROP_RENOTIFY_PCT = 5;
/** Во сколько раз максимум расширять радиус поиска по карте. */
export const MATCH_RADIUS_MAX_MULTIPLIER = 3;
/** Минимум кандидатов, при котором расширение радиуса останавливается. */
export const MATCH_MIN_CANDIDATES = 3;
// Веса шкалы совпадения — в packages/shared (MATCH_SCORE_WEIGHTS): их же показывает экран.

/* ── Телефония ─────────────────────────────────────────────────────────── */
/** Контексты диалплана, из которых звонок считается входящим. Пусто — умолчание
 *  из lib/telephony/incomingCalls.ts (на проде список пуст). */
export const INCOMING_INBOUND_CONTEXTS: readonly string[] = [];
/** Порт AMI станции. */
export const ASTERISK_AMI_PORT = 5038;
/** Подсказка агенту о звонящем: что озвучивать, на каком языке и каким голосом. */
export const CALL_WHISPER_INCOMING_PARTS: readonly string[] = ["name", "role", "anchor", "budget"];
export const CALL_WHISPER_OUTGOING_PARTS: readonly string[] = ["name", "role"];
export const CALL_WHISPER_LANGUAGE = "ru";
export const CALL_WHISPER_VOICE = "Achernar";

/* ── Живой голос по телефону ───────────────────────────────────────────── */
/** Объектом: читается в момент вызова, тест подменяет отдельный параметр. */
export const LIVE_VOICE_TUNING: {
  /** Внутренний номер для пробных звонков консультанту. */
  readonly testExtension: string;
  /** Замок «только русский» (диагностика акцента) — выключен. */
  readonly forceRussianOnly: boolean;
  /** Вдох перед репликой. */
  readonly breathEnabled: boolean;
  /** Настоящий офисный амбиент и его громкость (0..1). */
  readonly officeAmbienceEnabled: boolean;
  readonly officeAmbienceVolume: number;
} = {
  testExtension: "101008890",
  forceRussianOnly: false,
  breathEnabled: false,
  officeAmbienceEnabled: true,
  officeAmbienceVolume: 0.45,
};
// Сколько секунд ждать оператора до консультанта — в packages/shared
// (LIVE_VOICE_INBOUND_WAIT_SECONDS): его же показывает экран.

/* ── Обложки ChatGPT (внутренние параметры генерации) ──────────────────── */
/** Объектом, а не пятью константами: читается в момент вызова, и тест может
 *  подменить отдельный параметр (vi.mock с importOriginal), не трогая базу. */
export const OPENAI_COVER_TUNING = {
  imageQuality: "medium",
  candidates: 1,
  textMode: "MODEL",
  imageModel: "gpt-image-2.5-sunburst",
  photoSource: "ORIGINAL",
} as const;

/* ── Расстановщик публикаций ───────────────────────────────────────────── */
/** Объектом: читается в момент вызова, тест подменяет отдельный параметр. */
export const PUBLISH_SCHEDULE_TUNING: {
  /** Постоянные приоритетные окна парами «начало, конец», минуты от полуночи:
   *  12:00–14:00 и 19:00–21:00. */
  readonly priorityWindows: readonly number[];
  readonly heatmapDays: number;
  readonly leadHours: number;
  /** Тепловая карта и статистика Instagram как источник часов — выключены (прод). */
  readonly useHeatmap: boolean;
  readonly useInstagramOnline: boolean;
} = {
  priorityWindows: [720, 840, 1140, 1260],
  heatmapDays: 90,
  leadHours: 1,
  useHeatmap: false,
  useInstagramOnline: false,
};

/* ── Модели Gemini ─────────────────────────────────────────────────────── */
/** null / пустой список — «не задано»: действует .env сервера или умолчание из
 *  ai/geminiTransport.ts, ровно как на проде с пустыми полями. */
export const GEMINI_MODEL_OVERRIDE: string | null = null;
export const GEMINI_FALLBACK_MODELS_OVERRIDE: readonly string[] = [];
export const GEMINI_TRANSCRIBE_MODELS_OVERRIDE: readonly string[] = [];
export const GEMINI_IMAGE_MODEL_OVERRIDE: string | null = null;
/** Дешёвая ступень для простых задач. */
export const GEMINI_LITE_MODEL_OVERRIDE: string | null = "gemini-3.1-flash-lite";
/** Явный кэш системного промта Gemini. */
export const GEMINI_EXPLICIT_CACHING_ENABLED: boolean = true;

/* ── Безопасность ──────────────────────────────────────────────────────── */
/** Сколько минут действует подтверждение личности (step-up). */
export const STEP_UP_MINUTES = 240;

/**
 * Колонки Settings, которые с 01.11.2026 никто не читает: значение в коде выше.
 * Точки возврата настроек их не показывают и не восстанавливают
 * (lib/settingsSnapshots.ts) — вернуть в колонку старое число значило бы
 * показать владельцу «отличие», которое ни на что не влияет.
 */
export const SETTINGS_FIELDS_MOVED_TO_CODE = [
  "inactiveGreenMaxAttempts",
  "inactiveYellowMaxAttempts",
  "inactiveRedMaxAttempts",
  "inactivateMinAttempts",
  "inactivateCooldownHours",
  "pushActionTtlMinutes",
  "pushMessageThrottleMinutes",
  "matchPriceDropRenotifyPct",
  "matchRadiusMaxMultiplier",
  "matchMinCandidates",
  "matchScoreBase",
  "matchScoreDistrict",
  "matchScoreRooms",
  "matchScoreBudget",
  "matchScoreHotBonus",
  "matchScoreDistance",
  "incomingInboundContexts",
  "asteriskAmiPort",
  "callWhisperIncomingParts",
  "callWhisperOutgoingParts",
  "callWhisperLanguage",
  "callWhisperVoice",
  "liveVoiceTestExtension",
  "liveVoiceForceRussianOnly",
  "liveVoiceBreathEnabled",
  "liveVoiceOfficeAmbienceEnabled",
  "liveVoiceOfficeAmbienceVolume",
  "liveVoiceInboundWaitSeconds",
  "openaiImageQuality",
  "openaiCandidates",
  "openaiTextMode",
  "openaiImageModel",
  "openaiPhotoSource",
  "publishSchedulePriorityWindows",
  "publishScheduleHeatmapDays",
  "publishScheduleLeadHours",
  "publishScheduleUseHeatmap",
  "publishScheduleUseInstagramOnline",
  "geminiModel",
  "geminiFallbackModels",
  "geminiTranscribeModels",
  "geminiImageModel",
  "geminiLiteModel",
  "geminiExplicitCachingEnabled",
  "stepUpMinutes",
] as const;
