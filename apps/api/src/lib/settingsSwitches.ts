import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { logAgentAudit } from "./audit.js";
import { saveWithInvestigationControlAudit } from "./investigationSettingsAudit.js";
import { applySettingsSideEffects } from "./settingsSideEffects.js";
import { captureSettingsSnapshot } from "./settingsSnapshots.js";
import { logSystemError } from "./systemError.js";

/**
 * РУБИЛЬНИКИ НАСТРОЕК, КОТОРЫЕ МОЖНО ПЕРЕКЛЮЧИТЬ ИЗ ШАБНАМ (17.11.2026, «режим директора»;
 * владелец: «дай любые права боту… чтобы он был как супер мозг и руки компании»).
 *
 * БЕЛЫЙ СПИСОК, А НЕ «ЛЮБОЕ ПОЛЕ НАСТРОЕК». Помощница читает чужой текст (пересланные
 * сообщения, файлы, группу), и одна удачная подмена текста не должна дотягиваться до
 * ключей, промптов, звонков клиентам или денег. Поэтому сюда попадают ТОЛЬКО булевы
 * рубильники, которые уже есть на экране Настроек и которые:
 *  - не ключ, не маркер и не пароль;
 *  - сами не пишут и не звонят клиентам (бот, робозвонки, авто-ответы, рассылки,
 *    напоминания клиентам, публикации в соцсети);
 *  - не тратят деньги (реклама, платный ИИ, поиск Google);
 *  - не про вход и безопасность (passkey, сам помощник).
 * Всё это — внутренние сторожа, уведомления сотрудникам, отчёты руководству и правила
 * внутри команды. Расширять список — только сюда, и сторож (`assertSwitchWhitelistSafe`
 * ниже и tests/ai-assistant-director-tools.test.ts) не даст добавить запрещённое.
 *
 * ЗАПИСЬ — ТЕМИ ЖЕ КИРПИЧАМИ, ЧТО PATCH /settings (routes/settings.ts): точка возврата
 * ДО записи (captureSettingsSnapshot), запись через saveWithInvestigationControlAudit,
 * побочные эффекты applySettingsSideEffects, журнал SETTINGS_UPDATE с именем поля и
 * значением. Право и подтверждение личности (settings.manage + requireElevation на
 * маршруте) держит вызывающий: исполнитель помощницы — `requires` и `stepUp`.
 */

export interface SettingsSwitchDef {
  key: string;
  /** Название простыми словами — так помощница называет рубильник человеку. */
  label: string;
  /** Одна строка: что будет, если выключить. */
  hint: string;
  /** Умолчание колонки в schema.prisma — когда строки настроек ещё нет. */
  defaultOn: boolean;
}

export const SETTINGS_SWITCHES = [
  {
    key: "telegramSilenceWatchEnabled",
    label: "Сторож: клиент в Telegram без ответа 30 минут",
    hint: "Выключите — ответственный не получит напоминание, что клиент в Telegram ждёт ответа.",
    defaultOn: true,
  },
  {
    key: "telegramDeliveryWatchEnabled",
    label: "Сторож: Telegram перестал доставлять сообщения",
    hint: "Выключите — руководство не узнает, что сообщения в Telegram перестали доходить.",
    defaultOn: true,
  },
  {
    key: "whatsappWebhookWatchEnabled",
    label: "Сторож: WhatsApp замолчал в рабочие часы",
    hint: "Выключите — руководство не получит тревогу, если входящие WhatsApp перестали приходить.",
    defaultOn: true,
  },
  {
    key: "commentFailureWatchEnabled",
    label: "Сводка о сбоях бота в комментариях",
    hint: "Выключите — никто не узнает, что бот не ответил на комментарий из-за сбоя.",
    defaultOn: true,
  },
  {
    key: "ropTransferAlertEnabled",
    label: "Уведомлять директора о передачах РОП",
    hint: "Выключите — директор не получит кнопки «Подтвердить / Отклонить» на передачи клиентов от РОП.",
    defaultOn: true,
  },
  {
    key: "pushShowingsToSupervisors",
    label: "Показы — уведомлять руководителей",
    hint: "Выключите — руководители перестанут получать уведомления о показах агентов.",
    defaultOn: true,
  },
  {
    key: "pushLeadActionsEnabled",
    label: "Кнопки «Принять / Отклонить» в уведомлении о заявке",
    hint: "Выключите — заявку можно будет принять только из CRM, не из шторки уведомлений.",
    defaultOn: true,
  },
  {
    key: "incomingPushEnabled",
    label: "Уведомление о входящем звонке на телефон оператора",
    hint: "Выключите — при закрытой CRM оператор не узнает о звонке.",
    defaultOn: true,
  },
  {
    key: "problemReportWeeklyEnabled",
    label: "Недельный отчёт о проблемах директору",
    hint: "Выключите — недельный отчёт о проблемах не собирается и не приходит.",
    defaultOn: true,
  },
  {
    key: "problemReportMonthlyEnabled",
    label: "Месячный отчёт о проблемах директору",
    hint: "Выключите — месячный отчёт о проблемах не собирается и не приходит.",
    defaultOn: true,
  },
  {
    key: "financePdfMonthlyEnabled",
    label: "Финансовый PDF за месяц директорам в Telegram",
    hint: "Включите — первого числа директорам придёт PDF с финансами прошлого месяца.",
    defaultOn: false,
  },
  {
    key: "royalScoreEnabled",
    label: "Royal Score — баллы агентов",
    hint: "Выключите — баллы перестанут начисляться, агенты не увидят свой счёт (журнал не стирается).",
    defaultOn: true,
  },
  {
    key: "agentOccupancyShieldEnabled",
    label: "Щиток занятости: агент на показе или в звонке не получает новых заявок",
    hint: "Выключите — новые заявки будут приходить агенту и во время показа или звонка.",
    defaultOn: true,
  },
] as const satisfies readonly SettingsSwitchDef[];

export type SettingsSwitchKey = (typeof SETTINGS_SWITCHES)[number]["key"];

export const SETTINGS_SWITCH_KEYS = SETTINGS_SWITCHES.map((s) => s.key) as [SettingsSwitchKey, ...SettingsSwitchKey[]];

/**
 * ЧТО НИКОГДА НЕ ПОПАДАЕТ В СПИСОК — по признаку имени, чтобы новое поле того же рода
 * не проскочило: ключи и секреты, промпты, всё про бота для клиентов, голос и звонки
 * клиентам, рассылки и напоминания клиентам, публикации, реклама, платный ИИ и поиск,
 * вход, сам помощник, приватные поля расследований.
 */
export const FORBIDDEN_SWITCH_PATTERNS: readonly RegExp[] = [
  /key|token|secret|password|passkey|prompt/i,
  /^bot/i,
  /liveVoice|robot|call(?!back)|whisper|postShowing|incomingAuto|incomingAssign|incomingRoute|incomingArchive/i,
  /followUp|reactivation|askClients|matchNotify|marketBuyer|autoMatch|ownProperty/i,
  /publish|stories|story|photoPosts|repost|digest|sharePost|telegramDirect|tiktok|metaAds|metaCatalog|ads/i,
  /meta(Enabled)?$|^metaEnabled$|Reconcile/i,
  /aiAssistant|grounded|semantic|photoEnhance|openai|gemini|elevenLabs/i,
  /videoHandoff|clip|rawReview|staffClip|handover|leadReassign|salesScenario/i,
];

/** Приватные поля расследований — их правит только директор с правом СБ, не помощница. */
const PRIVATE_FIELDS = new Set(["postShowingCallEnabled", "investigationCaseConfig", "sellerControlConfig", "postShowingCohortConfig", "buyerSellerAutomationMode"]);

export function isForbiddenSwitchKey(key: string): boolean {
  return PRIVATE_FIELDS.has(key) || FORBIDDEN_SWITCH_PATTERNS.some((re) => re.test(key));
}

/** Защита по умолчанию: запрещённое в белом списке роняет загрузку модуля, а не ждёт ревью. */
export function assertSwitchWhitelistSafe(list: readonly SettingsSwitchDef[] = SETTINGS_SWITCHES): void {
  const seen = new Set<string>();
  for (const s of list) {
    if (isForbiddenSwitchKey(s.key)) throw new Error(`Рубильник «${s.key}» нельзя отдавать помощнице: ключ, клиенты, деньги или вход`);
    if (seen.has(s.key)) throw new Error(`Рубильник «${s.key}» в белом списке дважды`);
    seen.add(s.key);
  }
}
assertSwitchWhitelistSafe();

export function findSettingsSwitch(key: string): (typeof SETTINGS_SWITCHES)[number] | null {
  return SETTINGS_SWITCHES.find((s) => s.key === key) ?? null;
}

export interface SettingsSwitchState {
  key: SettingsSwitchKey;
  label: string;
  hint: string;
  on: boolean;
}

/** Текущее положение всех рубильников белого списка. */
export async function readSettingsSwitches(): Promise<SettingsSwitchState[]> {
  const row = (await prisma.settings.findUnique({ where: { id: "singleton" } })) as unknown as Record<string, unknown> | null;
  return SETTINGS_SWITCHES.map((s) => {
    const value = row?.[s.key];
    return { key: s.key, label: s.label, hint: s.hint, on: typeof value === "boolean" ? value : s.defaultOn };
  });
}

export async function readSettingsSwitch(key: SettingsSwitchKey): Promise<boolean> {
  const all = await readSettingsSwitches();
  return all.find((s) => s.key === key)?.on ?? false;
}

/**
 * Переключить ОДИН рубильник белого списка. Ключ вне списка — отказ (даже если поле в
 * настройках существует). Возвращает, было ли что менять.
 */
export async function setSettingsSwitch(input: {
  key: string;
  on: boolean;
  actor: { id: string; name: string };
  meta?: Record<string, string>;
}): Promise<{ ok: true; changed: boolean; before: boolean; after: boolean } | { ok: false; error: string }> {
  const def = findSettingsSwitch(input.key);
  if (!def || isForbiddenSwitchKey(input.key)) return { ok: false, error: "Этот рубильник через помощницу не переключается — только в Настройках CRM" };
  const before = await readSettingsSwitch(def.key);
  if (before === input.on) return { ok: true, changed: false, before, after: before };

  const data: Record<string, boolean> = { [def.key]: input.on };
  // Точка возврата ДО записи — как в PATCH /settings; её сбой не отменяет сохранение, но и не молчит.
  try {
    await captureSettingsSnapshot({ agentId: input.actor.id, agentName: input.actor.name, reason: "update", nextData: data });
  } catch (err) {
    await logSystemError("api", `Точка возврата настроек не снялась: ${err instanceof Error ? err.message : String(err)}`);
  }
  await saveWithInvestigationControlAudit(data, input.actor, (db) =>
    db.settings.upsert({
      where: { id: "singleton" },
      update: data as unknown as Prisma.SettingsUpdateInput,
      create: { id: "singleton", ...data } as unknown as Prisma.SettingsCreateInput,
    })
  );
  applySettingsSideEffects([def.key]);
  logAgentAudit(input.actor.id, "SETTINGS_UPDATE", "Settings", "singleton", {
    fields: [def.key],
    [def.key]: input.on,
    ...(input.meta ?? {}),
  });
  return { ok: true, changed: true, before, after: input.on };
}
