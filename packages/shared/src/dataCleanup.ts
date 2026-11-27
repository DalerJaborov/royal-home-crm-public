import { z } from "zod";

/**
 * Чистка мусора (владелец 28.11.2026): кнопки «Очистить» и автоочистка. Один источник для API и экрана.
 *
 * Три вида записей, которые директор и РОП видят как «висящий шум»:
 *  - notifications — уведомления (колокольчик);
 *  - directorAlerts — очередь оповещений директору (PendingDirectorAlert);
 *  - errorLog — журнал ошибок.
 * Удаление безвозвратное. «handled» — только прочитанное/доставленное/разобранное, «all» — вообще всё.
 */
export const CLEANUP_TARGETS = ["notifications", "directorAlerts", "errorLog"] as const;
export type CleanupTarget = (typeof CLEANUP_TARGETS)[number];

export const CLEANUP_MODES = ["handled", "all"] as const;
export type CleanupMode = (typeof CLEANUP_MODES)[number];

/** Для уведомлений: только свои или у всех сотрудников. Остальные виды общие — scope у них не действует. */
export const CLEANUP_SCOPES = ["mine", "all"] as const;
export type CleanupScope = (typeof CLEANUP_SCOPES)[number];

export const CLEANUP_TARGET_LABELS: Record<CleanupTarget, string> = {
  notifications: "Уведомления",
  directorAlerts: "Оповещения директору",
  errorLog: "Журнал ошибок",
};

export const cleanupRequestSchema = z.object({
  target: z.enum(CLEANUP_TARGETS),
  mode: z.enum(CLEANUP_MODES),
  scope: z.enum(CLEANUP_SCOPES).default("all"),
});
export type CleanupRequest = z.infer<typeof cleanupRequestSchema>;

/** Пределы сроков автоочистки, дней. min не даёт случайно стереть вчерашнее. */
export const AUTO_CLEANUP_DAYS = {
  autoCleanupNotificationsReadDays: { min: 3, max: 365, default: 30 },
  autoCleanupErrorsResolvedDays: { min: 3, max: 365, default: 14 },
  autoCleanupAiLogDays: { min: 3, max: 365, default: 14 },
  autoCleanupDirectorAlertsDays: { min: 3, max: 365, default: 30 },
  // Дневные счётчики щитов бота (GuardHit): пульт и утренний отчёт читают окно 14 суток, поэтому min 15.
  autoCleanupBotCountersDays: { min: 15, max: 365, default: 30 },
  // Просроченные одноразовые записи: коды входа, ключи повтора, метки кнопок Telegram.
  autoCleanupOneTimeDays: { min: 2, max: 90, default: 7 },
} as const;
export type AutoCleanupDaysKey = keyof typeof AUTO_CLEANUP_DAYS;
export const AUTO_CLEANUP_DAYS_KEYS = Object.keys(AUTO_CLEANUP_DAYS) as AutoCleanupDaysKey[];

export const AUTO_CLEANUP_DAYS_LABELS: Record<AutoCleanupDaysKey, { label: string; hint: string }> = {
  autoCleanupNotificationsReadDays: { label: "Прочитанные уведомления, дней", hint: "Старше срока и уже прочитанные. Непрочитанные остаются." },
  autoCleanupErrorsResolvedDays: { label: "Разобранные ошибки, дней", hint: "Только отмеченные «разобрано». Неразобранные остаются." },
  autoCleanupAiLogDays: { label: "Технический журнал ИИ, дней", hint: "Служебный журнал обращений к ИИ (около тысячи записей в день)." },
  autoCleanupDirectorAlertsDays: { label: "Оповещения директору, дней", hint: "Только уже разобранные очередью. Ждущие остаются." },
  autoCleanupBotCountersDays: { label: "Счётчики щитов бота, дней", hint: "Дневные счётчики срабатываний защит бота. Переписки и трассы ответов не затрагиваются." },
  autoCleanupOneTimeDays: { label: "Одноразовые записи, дней", hint: "Старые коды входа, ключи повтора запросов и метки кнопок Telegram." },
};

/** Пример фрагмента PATCH /settings: поля сроков. */
export const autoCleanupDaysUpdateSchema = z.object(
  Object.fromEntries(
    AUTO_CLEANUP_DAYS_KEYS.map((k) => [k, z.number().int().min(AUTO_CLEANUP_DAYS[k].min).max(AUTO_CLEANUP_DAYS[k].max).optional()])
  ) as Record<AutoCleanupDaysKey, z.ZodOptional<z.ZodNumber>>
);
