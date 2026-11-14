import { z } from "zod";

/**
 * «СОСТОЯНИЕ ФУНКЦИЙ» (14.11.2026): ОДИН РЕЕСТР СКРЫТЫХ РУБИЛЬНИКОВ.
 *
 * В CRM много функций, которые молча выключены или работают «вполсилы»: тумблер в
 * Настройках включён, а сервер не разрешает (переменная окружения не задана);
 * функция живёт в режиме «только проверка»; сторож выключен. Раньше это знали
 * только те, кто читал код (аудит 14.11, раздел D). Реестр ниже описывает каждую
 * такую функцию ОДИН РАЗ: ключ, название простыми словами, группа, имена
 * переменных окружения, вкладка Настроек, фоновые задачи. Состояние считает
 * сервер (apps/api/src/lib/functionStatus.ts), экран директора его показывает.
 *
 * ПРАВИЛО ДЛЯ НОВЫХ РУБИЛЬНИКОВ. Любая новая переменная окружения вида
 * `*_LIVE`, `*_MODE`, `*_EXECUTION_MODE`, `*_EXECUTION`, `*_ENABLED` в
 * apps/api/src обязана быть названа в `env` одной из записей ниже. Это держит
 * сторож `npm run audit:functions` (scripts/audit-function-registry.mjs, шаг
 * precheck): без записи сборка красная. Значения переменных нигде не
 * показываются — только факт «задана/не задана» и режим.
 */

export const FUNCTION_GROUPS = [
  { id: "bot", title: "Бот для клиентов" },
  { id: "voice", title: "Голос и звонки" },
  { id: "video", title: "Объекты, озвучка, отчёты" },
  { id: "control", title: "Контроль и проверки" },
  { id: "alerts", title: "Тревоги руководству" },
  { id: "market", title: "Рынок и площадки" },
  { id: "ai", title: "ИИ и ключи" },
  { id: "data", title: "Данные и диагностика" },
] as const;

export type FunctionGroupId = (typeof FUNCTION_GROUPS)[number]["id"];

/** Вкладки Настроек, куда можно сослаться (совпадают с SettingsTabId на сайте). */
export const FUNCTION_SETTINGS_TABS = ["agency", "money", "leads", "matching", "team", "channels", "bot", "system"] as const;
export type FunctionSettingsTab = (typeof FUNCTION_SETTINGS_TABS)[number];

/** Три состояния: работает по-настоящему / только проверка (ничего не уходит наружу) / выключено. */
export const FUNCTION_STATES = ["working", "preview", "off"] as const;
export type FunctionState = (typeof FUNCTION_STATES)[number];

export const FUNCTION_STATE_LABELS: Record<FunctionState, string> = {
  working: "Работает",
  preview: "Только проверка",
  off: "Выключено",
};

export interface FunctionDef {
  /** Стабильный ключ (латиница); по нему сервер находит расчёт состояния. */
  key: string;
  /** Название простыми словами. */
  title: string;
  /** Одна строка: что это даёт. */
  what: string;
  group: FunctionGroupId;
  /** Имена переменных окружения, которые управляют функцией. Значения не показываем. */
  env?: readonly string[];
  /** Вкладка Настроек, где есть тумблер этой функции (если он есть). */
  settingsTab?: FunctionSettingsTab;
  /** Имена фоновых задач (CronHeartbeat), чей последний запуск показываем в строке функции. */
  cron?: readonly string[];
  /** Источники журнала ошибок (ErrorLog.source) для «последней ошибки». */
  errorSources?: readonly string[];
}

export const FUNCTION_REGISTRY: readonly FunctionDef[] = [
  // ─── Бот для клиентов ───
  {
    key: "bot-pause-watch",
    title: "Сторож «бот на паузе и забыли»",
    what: "Находит диалоги, где бот молчит после ручного ответа, и сам возвращает бота через трое суток.",
    group: "bot",
    settingsTab: "bot",
    cron: ["bot-pause-watch"],
  },
  {
    key: "bot-say-mode",
    title: "Свободные фразы бота",
    what: "Бот может сказать клиенту своими словами, а не только готовым шаблоном.",
    group: "bot",
    env: ["CUSTOMER_AGENT_SAY_MODE"],
    errorSources: ["ai"],
  },
  {
    key: "bot-photos",
    title: "Фото объектов в чате",
    what: "Бот присылает клиенту фотографии объекта прямо в переписке.",
    group: "bot",
    env: ["CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE"],
    settingsTab: "bot",
  },
  {
    key: "bot-media",
    title: "Голосовые ответы и файл-гид",
    what: "Бот отвечает голосовым сообщением и присылает файл-подборку.",
    group: "bot",
    env: ["CUSTOMER_AGENT_MEDIA_EXECUTION_MODE"],
    settingsTab: "bot",
  },
  {
    key: "bot-lead-only",
    title: "Режим «только заявки»",
    what: "Бот в WhatsApp, Instagram и Facebook только собирает заявку, без ссылок, фото и подборок.",
    group: "bot",
    settingsTab: "bot",
  },
  {
    key: "bot-property-context",
    title: "Бот знает объект, о котором спрашивают",
    what: "Если клиент пришёл с карточки объекта, бот видит её данные и отвечает по делу.",
    group: "bot",
    env: ["BOT_PROPERTY_CONTEXT_ENABLED"],
  },
  {
    key: "object-interest-pull",
    title: "Заявка по объекту переходит хозяину объекта",
    what: "Непринятая заявка из очереди, где клиент спросил про чужой объект, уходит агенту-хозяину.",
    group: "bot",
    env: ["OBJECT_INTEREST_PULLS_QUEUE_LEAD"],
  },
  // ─── Голос и звонки ───
  {
    key: "live-voice",
    title: "Робот, который звонит и отвечает на звонки",
    what: "Живой голосовой робот: исходящие звонки по сценариям и входящие, когда никто не снял трубку.",
    group: "voice",
    settingsTab: "channels",
    cron: ["live-voice-spend-ceiling", "live-voice-orphan-sweep", "live-calls-sweep", "post-showing-call", "seller-probe-call", "interview-invite-call"],
    errorSources: ["telephony"],
  },
  {
    key: "assistant-semantic-search",
    title: "Умный поиск по базе знаний помощника",
    what: "Шабнам ищет ответы в базе знаний по смыслу, а не только по словам.",
    group: "voice",
    env: ["ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED", "ASSISTANT_KNOWLEDGE_SEMANTIC_INDEX_ENABLED"],
  },
  {
    key: "assistant-grounded-search",
    title: "Справочный поиск в интернете у Шабнам",
    what: "Помощница отвечает на вопросы про законы и налоги, сверяясь с интернетом.",
    group: "voice",
    settingsTab: "bot",
  },
  // ─── Объекты, озвучка, отчёты ───
  {
    key: "narration",
    title: "Озвучка роликов объектов",
    what: "Голос диктора на роликах: CRM готовит текст и звук сама и отправляет монтажёру.",
    group: "video",
    env: ["CRM_NARRATION_EXECUTION_MODE"],
    cron: ["narration-auto-flow", "narration-version-delivery"],
    errorSources: ["video-handoff"],
  },
  {
    key: "owner-reports",
    title: "Ежемесячный отчёт собственнику объекта",
    what: "Собственник раз в месяц получает отчёт о том, что сделано по его объекту.",
    group: "video",
    env: ["CRM_OWNER_REPORT_EXECUTION_MODE"],
    cron: ["owner-report-delivery", "owner-report-monthly-preview"],
  },
  {
    key: "publication-metadata",
    title: "Синхронизация описаний и обложек публикаций",
    what: "Правки объекта автоматически доезжают до уже вышедших публикаций.",
    group: "video",
    env: ["PUBLICATION_METADATA_EXECUTION"],
  },
  // ─── Контроль и проверки ───
  {
    key: "seller-control",
    title: "Контроль продавцов",
    what: "Следит, что по объекту продавца идёт работа, и поднимает тревогу руководителю отдела продаж.",
    group: "control",
    env: ["SELLER_CONTROL_INTERNAL_LIVE", "SELLER_CONTROL_LIVE_FROM"],
    cron: ["seller-control-episodes"],
  },
  {
    key: "buyer-candidates",
    title: "Контроль кандидатов на показ",
    what: "Следит за покупателями, которых подобрали на показ, и за ответами агента.",
    group: "control",
    env: ["BUYER_CANDIDATE_INTERNAL_LIVE", "BUYER_CANDIDATE_LIVE_FROM"],
    cron: ["seller-control-episodes"],
  },
  {
    key: "owner-verification",
    title: "Проверка собственников",
    what: "Проверяет, что объект действительно принадлежит тому, кто его даёт.",
    group: "control",
    env: ["CRM_OWNER_VERIFICATION_EXECUTION_MODE"],
    cron: ["owner-exposure-verification-preview", "approved-owner-verification"],
  },
  {
    key: "manual-corrections",
    title: "Ручные исправления данных",
    what: "Администратор может применить заранее проверенный план правки данных.",
    group: "control",
    env: ["MANUAL_DATA_CORRECTIONS_LIVE"],
  },
  // ─── Тревоги руководству ───
  {
    key: "director-alert-window",
    title: "Окно доставки тревог руководству",
    what: "Тревоги директору и администратору доходят только в это время суток.",
    group: "alerts",
    settingsTab: "leads",
    cron: ["director-alert-queue-flush"],
  },
  {
    key: "telegram-portal-pause",
    title: "Telegram-сообщения по заявкам с Somon и Paydo",
    what: "Агентам приходят сообщения в Telegram о новых заявках с площадок.",
    group: "alerts",
    cron: ["somon-owner-leads"],
  },
  // ─── Рынок и площадки ───
  {
    key: "market-crawl",
    title: "Сбор объявлений с Somon и Paydo",
    what: "CRM сама собирает объявления рынка и сопоставляет их с нашими объектами.",
    group: "market",
    env: ["MARKET_CRAWL_ENABLED"],
    cron: ["market-weekly-crawl", "market-paydo-daily", "market-paydo-incremental", "market-somon-incremental", "market-own-match"],
  },
  // ─── ИИ и ключи ───
  {
    key: "gemini-spare-key",
    title: "Запасной ключ Gemini",
    what: "Если основной ключ ИИ перестанет работать, бот и помощник переключатся на запасной.",
    group: "ai",
    env: ["GEMINI_API_KEY_2"],
    settingsTab: "bot",
    errorSources: ["ai"],
  },
  // ─── Данные и диагностика ───
  {
    key: "bot-turn-trace",
    title: "Запись хода работы бота для разбора",
    what: "Бот записывает, как принял решение на каждом ходе: нужно, чтобы разбирать ошибки.",
    group: "data",
    env: ["BOT_TURN_TRACE_ENABLED", "BOT_TURN_TRACE_TEXT_ENABLED"],
  },
];

/** Все имена переменных окружения, названные в реестре (для сторожа в CI). */
export function functionRegistryEnvNames(): string[] {
  return [...new Set(FUNCTION_REGISTRY.flatMap((f) => f.env ?? []))].sort();
}

/** Только директор и администратор: те же две роли, что у закрытых экранов владельца. */
export function canViewFunctionStatus(role: string | null | undefined): boolean {
  return role === "DIRECTOR" || role === "ADMIN";
}

// ─── Ответ API ───

const isoDate = z.string().datetime();

export const functionCronSchema = z.object({
  name: z.string(),
  lastRunAt: isoDate.nullable(),
  lastOkAt: isoDate.nullable(),
  lastError: z.string().nullable(),
  /** Давно не запускался (по расписанию должен был) или последний запуск упал. */
  health: z.enum(["ok", "failing", "stale", "never"]),
});
export type FunctionCron = z.infer<typeof functionCronSchema>;

export const functionStatusItemSchema = z.object({
  key: z.string(),
  title: z.string(),
  what: z.string(),
  group: z.enum(FUNCTION_GROUPS.map((g) => g.id) as [FunctionGroupId, ...FunctionGroupId[]]),
  state: z.enum(FUNCTION_STATES),
  /** Почему именно такое состояние — простыми словами. */
  reason: z.string(),
  /** Дополнительная строка с цифрами (потолки, окна), если есть. */
  detail: z.string().nullable(),
  /** Обратить внимание: состояние формально «работает», но с оговоркой или с сбоем фоновой задачи. */
  attention: z.boolean(),
  /** Имена переменных окружения (значения не передаются). */
  envNames: z.array(z.string()),
  settingsTab: z.enum(FUNCTION_SETTINGS_TABS).nullable(),
  crons: z.array(functionCronSchema),
  lastError: z.object({ at: isoDate, message: z.string() }).nullable(),
});
export type FunctionStatusItem = z.infer<typeof functionStatusItemSchema>;

export const functionStatusResponseSchema = z.object({
  generatedAt: isoDate,
  summary: z.object({ working: z.number().int(), preview: z.number().int(), off: z.number().int(), attention: z.number().int() }),
  items: z.array(functionStatusItemSchema),
  /** Все фоновые задачи с последним запуском (в том числе не привязанные к функции). */
  crons: z.array(functionCronSchema),
});
export type FunctionStatusResponse = z.infer<typeof functionStatusResponseSchema>;
