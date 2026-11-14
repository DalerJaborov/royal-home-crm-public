import {
  FUNCTION_REGISTRY,
  narrationConfigSchema,
  type FunctionCron,
  type FunctionDef,
  type FunctionState,
  type FunctionStatusItem,
  type FunctionStatusResponse,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { customerAgentSayMode } from "./customerAgentFeaturePolicy.js";
import { customerPropertyMediaExecutionMode } from "./customerPropertyMedia.js";
import { customerAgentMediaExecutionMode } from "./customerDeliveryMedia.js";
import { mediaExecutionMode } from "./mediaExecution.js";
import { newOwnerProbeMode } from "./ownerVerificationSources.js";
import { buyerCandidateLiveEnabled } from "./buyerCandidateControl.js";
import { objectInterestPullsQueueLead } from "./propertyInterestNotice.js";
import { customerPropertyContextEnabled } from "./customerPropertyContextFlag.js";
import { cronIntervalMs, nextCronRun } from "./cronHeartbeat.js";
import { narrationAutoEnabled } from "./narrationAutoFlow.js";
import { readLiveVoiceSpend } from "./liveVoiceSpend.js";
import { visibleCronWhere } from "./investigationOperations.js";
import { visibleErrorLogs } from "./systemErrorVisibility.js";
import { maskPhonesInFreeText } from "./clientPhone.js";

/**
 * «СОСТОЯНИЕ ФУНКЦИЙ» (14.11.2026) — расчёт состояния по реестру из packages/shared/src/functionStatus.ts.
 *
 * ЧИСТАЯ ЧАСТЬ (`evaluateFunctions`) получает уже прочитанные данные (Настройки, переменные окружения,
 * расход робота, пульс фоновых задач, ошибки) и ничего не читает сама — поэтому проверяется без базы.
 * Загрузка данных (`loadFunctionStatus`) — тонкая обёртка.
 *
 * ЗНАЧЕНИЯ ПЕРЕМЕННЫХ НЕ ВЫХОДЯТ НАРУЖУ: в ответ идут только имя переменной и вывод «задана / режим».
 * Расчёты состояния там, где у функции уже есть публичная проверка (`customerAgentSayMode`,
 * `mediaExecutionMode`, …), зовут именно её: вторая копия правила разошлась бы с боевой молча.
 * Для остальных (inline-проверки в cron.ts и маршрутах) условие повторено здесь с пометкой, откуда оно.
 */

const DAY_MS = 24 * 3600_000;
const MINUTE_MS = 60_000;

export interface FunctionStatusSettings {
  botPauseWatchEnabled: boolean;
  botPauseAlertHours: number;
  botPauseEscalateHours: number;
  botCanSendPhotos: boolean;
  botPhotosPerOffer: number;
  botCanSendVoiceReplies: boolean;
  botLeadOnlyMode: boolean;
  liveVoiceEnabled: boolean;
  liveVoiceInboundMode: string;
  liveVoiceProvider: string;
  telegramPortalAlertsPaused: boolean;
  groundedSearchEnabled: boolean;
  narrationAutoGenerate: boolean;
  alarmHoursStart: string;
  alarmHoursEnd: string;
  geminiSpareKeyInSettings: boolean;
}

export interface FunctionStatusSpend {
  dayUsed: number;
  dayCap: number;
  monthUsed: number;
  monthCap: number;
  held: "day" | "month" | null;
}

export interface FunctionStatusInput {
  now: Date;
  /** Копия process.env: читаем только нужные имена, значения не отдаём. */
  env: Readonly<Record<string, string | undefined>>;
  settings: FunctionStatusSettings;
  spend: FunctionStatusSpend | null;
  heartbeats: ReadonlyArray<{
    name: string;
    expr: string;
    lastRunAt: Date | null;
    lastOkAt: Date | null;
    lastError: string | null;
    lastSkippedAt: Date | null;
  }>;
  errors: ReadonlyArray<{ source: string; message: string; createdAt: Date }>;
}

type Verdict = { state: FunctionState; reason: string; detail?: string | null; attention?: boolean };
type Evaluator = (input: FunctionStatusInput, def: FunctionDef) => Verdict;

const ENV_NOT_SET = (name: string) => `переменная ${name} на сервере не задана`;

/** Режим из трёх значений OFF/PREVIEW/LIVE → состояние (бот: фото, медиа). */
function threeWay(mode: "OFF" | "PREVIEW" | "LIVE", name: string, toggleOn: boolean, toggleLabel: string): Verdict {
  if (!toggleOn) return { state: "off", reason: `Выключено тумблером «${toggleLabel}» в Настройках.` };
  if (mode === "LIVE") return { state: "working", reason: `Тумблер «${toggleLabel}» включён, сервер разрешает отправку.` };
  if (mode === "PREVIEW") {
    return { state: "preview", reason: `Тумблер включён, но сервер в режиме «только проверка» (${name}=PREVIEW): клиенту ничего не уходит.`, attention: true };
  }
  return {
    state: "off",
    reason: `Тумблер «${toggleLabel}» включён, но сервер не разрешает: ${ENV_NOT_SET(name)}. Клиенту ничего не уходит.`,
    attention: true,
  };
}

function windowMinutes(start: string, end: string): number | null {
  const parse = (s: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const a = parse(start);
  const b = parse(end);
  if (a === null || b === null) return null;
  return b > a ? b - a : b + 24 * 60 - a;
}

function hoursText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

const EVALUATORS: Record<string, Evaluator> = {
  "bot-pause-watch": ({ settings }) =>
    settings.botPauseWatchEnabled
      ? {
          state: "working",
          reason: "Включён: диалог, где бот молчит после ручного ответа, получает отметку через сутки и бота возвращают через трое суток.",
          detail: `Напоминание через ${settings.botPauseAlertHours} ч, возврат бота через ${settings.botPauseEscalateHours} ч.`,
        }
      : { state: "off", reason: "Выключен тумблером в Настройках → ИИ-ассистент. Бот, поставленный на паузу вручную, остаётся молчать бессрочно.", attention: true },

  "bot-say-mode": ({ env }) =>
    customerAgentSayMode(env) === "live"
      ? { state: "working", reason: "Свободные фразы уходят клиентам (CUSTOMER_AGENT_SAY_MODE=live)." }
      : {
          state: "preview",
          reason: "Бот проверяет свои свободные фразы, но клиенту их не отправляет: отвечает готовыми шаблонами. Чтобы включить, на сервере нужно CUSTOMER_AGENT_SAY_MODE=live.",
        },

  "bot-photos": ({ settings }) => {
    const base = threeWay(customerPropertyMediaExecutionMode(), "CUSTOMER_PROPERTY_MEDIA_EXECUTION_MODE", settings.botCanSendPhotos, "Бот шлёт фото");
    if (settings.botCanSendPhotos && settings.botLeadOnlyMode) {
      return { ...base, state: "off", reason: "Тумблер включён, но действует режим «только заявки»: в WhatsApp, Instagram и Facebook фото не отправляются.", attention: true };
    }
    return settings.botPhotosPerOffer > 5
      ? { ...base, detail: `В Настройках выбрано ${settings.botPhotosPerOffer} фото, бот отправляет не больше 5.` }
      : base;
  },

  "bot-media": ({ settings }) =>
    threeWay(customerAgentMediaExecutionMode(), "CUSTOMER_AGENT_MEDIA_EXECUTION_MODE", settings.botCanSendVoiceReplies, "Голосовые ответы"),

  "bot-lead-only": ({ settings }) =>
    settings.botLeadOnlyMode
      ? { state: "working", reason: "Включён: в WhatsApp, Instagram и Facebook бот собирает заявку и передаёт человеку, без ссылок, фото и подборок." }
      : { state: "off", reason: "Выключен: бот отвечает клиентам в полную силу, в рамках остальных тумблеров." },

  "bot-property-context": () =>
    customerPropertyContextEnabled()
      ? { state: "working", reason: "Бот видит карточку объекта, с которого пришёл клиент." }
      : { state: "off", reason: `Выключено: ${ENV_NOT_SET("BOT_PROPERTY_CONTEXT_ENABLED")}. Бот не видит карточку объекта, с которого пришёл клиент.` },

  "object-interest-pull": () =>
    objectInterestPullsQueueLead()
      ? { state: "working", reason: "Непринятая заявка из очереди переходит хозяину объекта, о котором спросил клиент." }
      : { state: "off", reason: `Выключено: ${ENV_NOT_SET("OBJECT_INTEREST_PULLS_QUEUE_LEAD")}. Хозяину объекта уходит только уведомление, заявка остаётся в очереди.` },

  "live-voice": ({ settings, spend }) => {
    if (!settings.liveVoiceEnabled) {
      return { state: "off", reason: "Выключен тумблером «Живой голос» в Настройках: робот не звонит и не отвечает на звонки." };
    }
    const inbound =
      settings.liveVoiceInboundMode === "always"
        ? "входящие первым берёт робот"
        : settings.liveVoiceInboundMode === "no_answer"
          ? "входящие робот берёт, если оператор не снял трубку"
          : "входящие робот не берёт";
    const detail = spend
      ? `Сегодня ${spend.dayUsed} из ${spend.dayCap || "∞"} мин, за месяц ${spend.monthUsed} из ${spend.monthCap || "∞"} мин; ${inbound}.`
      : `Входящие: ${inbound}.`;
    if (spend?.held) {
      return {
        state: "working",
        reason: `Потолок минут ${spend.held === "day" ? "на сегодня" : "на месяц"} достигнут: новые звонки робот не делает, входящие уходят на автоответчик.`,
        detail,
        attention: true,
      };
    }
    return { state: "working", reason: "Включён: робот звонит по сценариям и отвечает на звонки.", detail };
  },

  "assistant-semantic-search": ({ env }) => {
    const search = env.ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED === "true";
    const index = env.ASSISTANT_KNOWLEDGE_SEMANTIC_INDEX_ENABLED === "true";
    if (search && index) return { state: "working", reason: "Умный поиск включён, индекс пополняется." };
    if (search) return { state: "working", reason: "Умный поиск включён, но новые материалы в индекс не попадают (ASSISTANT_KNOWLEDGE_SEMANTIC_INDEX_ENABLED не включена).", attention: true };
    return { state: "off", reason: `Выключено: ${ENV_NOT_SET("ASSISTANT_KNOWLEDGE_SEMANTIC_ENABLED")}. Шабнам ищет по базе знаний только по словам.` };
  },

  "assistant-grounded-search": ({ settings }) =>
    settings.groundedSearchEnabled
      ? { state: "off", reason: "Тумблер в Настройках включён, но функция пока не работает: код не подключает справочный поиск. Включение ничего не меняет.", attention: true }
      : { state: "off", reason: "Выключено, и включить пока нельзя: функция недоделана. Вопросы про законы и налоги Шабнам оставляет без ответа." },

  narration: ({ settings }) => {
    const mode = mediaExecutionMode("NARRATION");
    if (mode !== "LIVE") {
      return {
        state: "preview",
        reason: `CRM готовит озвучку, но монтажёру не отправляет: ${ENV_NOT_SET("CRM_NARRATION_EXECUTION_MODE")} (нужно LIVE).`,
        attention: true,
      };
    }
    return settings.narrationAutoGenerate
      ? { state: "working", reason: "Автоозвучка включена, готовое отправляется монтажёру." }
      : { state: "off", reason: "Сервер разрешает отправку, но автоозвучка выключена в настройках озвучки: версии готовятся только вручную.", attention: true };
  },

  "owner-reports": () =>
    mediaExecutionMode("OWNER_REPORT") === "LIVE"
      ? { state: "working", reason: "Отчёты собственникам отправляются." }
      : { state: "preview", reason: `Отчёты готовятся, но собственникам не уходят: ${ENV_NOT_SET("CRM_OWNER_REPORT_EXECUTION_MODE")} (нужно LIVE).` },

  // Условие из publicationMetadataSync.ts / publicationMetadataAdapter.ts: без LIVE — EXECUTION_DISABLED.
  "publication-metadata": ({ env }) =>
    env.PUBLICATION_METADATA_EXECUTION === "LIVE"
      ? { state: "working", reason: "Синхронизация разрешена сервером. Запускается только вручную из кода, расписания нет." }
      : { state: "off", reason: `Выключено: ${ENV_NOT_SET("PUBLICATION_METADATA_EXECUTION")} (нужно LIVE). Выложенные публикации не обновляются после правки объекта.` },

  // Условия из sellerControlEpisodes.ts (runSellerControlTick, enrollDueSellerIntakes).
  "seller-control": ({ env }) => {
    if (env.SELLER_CONTROL_INTERNAL_LIVE !== "explicitly-approved") {
      return {
        state: "preview",
        reason: "Только проверка: боевой режим не разрешён сервером (SELLER_CONTROL_INTERNAL_LIVE), задача раз в минуту ничего не делает.",
        attention: true,
      };
    }
    return Number.isFinite(Date.parse(env.SELLER_CONTROL_LIVE_FROM ?? ""))
      ? { state: "working", reason: "Боевой режим разрешён, новые приёмы продавцов берутся в контроль." }
      : { state: "preview", reason: `Боевой режим разрешён, но новые продавцы не берутся: ${ENV_NOT_SET("SELLER_CONTROL_LIVE_FROM")} (дата начала).`, attention: true };
  },

  "buyer-candidates": ({ env }) => {
    if (!buyerCandidateLiveEnabled()) {
      return {
        state: "preview",
        reason: "Только проверка: нужно, чтобы сервер разрешил и BUYER_CANDIDATE_INTERNAL_LIVE, и SELLER_CONTROL_INTERNAL_LIVE.",
        attention: true,
      };
    }
    return Number.isFinite(Date.parse(env.BUYER_CANDIDATE_LIVE_FROM ?? ""))
      ? { state: "working", reason: "Боевой режим разрешён, новые кандидаты берутся в контроль." }
      : { state: "preview", reason: `Боевой режим разрешён, но новые кандидаты не берутся: ${ENV_NOT_SET("BUYER_CANDIDATE_LIVE_FROM")} (дата начала).`, attention: true };
  },

  "owner-verification": () =>
    newOwnerProbeMode() === "LIVE"
      ? { state: "working", reason: "Проверка собственников выполняется по-настоящему." }
      : { state: "preview", reason: `Проверки только планируются, звонков и сообщений собственникам нет: ${ENV_NOT_SET("CRM_OWNER_VERIFICATION_EXECUTION_MODE")} (нужно LIVE).` },

  // Условие из routes/manualDataCorrections.ts.
  "manual-corrections": ({ env }) =>
    env.MANUAL_DATA_CORRECTIONS_LIVE === "explicitly-approved"
      ? { state: "working", reason: "Применение проверенных планов правки данных разрешено." }
      : { state: "preview", reason: `Доступен только план правки, применить его нельзя: ${ENV_NOT_SET("MANUAL_DATA_CORRECTIONS_LIVE")}.` },

  "director-alert-window": ({ settings }) => {
    const minutes = windowMinutes(settings.alarmHoursStart, settings.alarmHoursEnd);
    if (minutes === null) return { state: "working", reason: "Окно доставки задано, но не читается: проверьте часы в Настройках.", attention: true };
    const text = `с ${settings.alarmHoursStart} до ${settings.alarmHoursEnd} по Душанбе`;
    if (minutes >= 20 * 60) return { state: "working", reason: `Тревоги доходят почти круглые сутки (${text}).`, detail: `Окно: ${hoursText(minutes)}.` };
    return {
      state: "working",
      reason: `Тревоги директору и администратору доходят только ${text}. Что случилось вне окна, ждёт до следующего утра.`,
      detail: `Окно: ${hoursText(minutes)} из 24.`,
      attention: true,
    };
  },

  // Читается тем же путём, что lib/telegramPortalPause.ts: по умолчанию — пауза.
  "telegram-portal-pause": ({ settings }) =>
    settings.telegramPortalAlertsPaused
      ? { state: "off", reason: "На паузе: сообщения в Telegram по заявкам с Somon и Paydo не отправляются (в CRM заявки видны). Снять паузу можно только на сервере, кнопки в Настройках нет.", attention: true }
      : { state: "working", reason: "Сообщения в Telegram по заявкам с площадок отправляются." },

  "market-crawl": ({ env }) =>
    env.MARKET_CRAWL_ENABLED === "1"
      ? { state: "working", reason: "Сбор включён: Somon раз в неделю и по минутам, Paydo ночью и частями." }
      : { state: "off", reason: `Выключено: ${ENV_NOT_SET("MARKET_CRAWL_ENABLED")} (нужно 1). Свежих объявлений рынка нет.`, attention: true },

  "gemini-spare-key": ({ env, settings }) =>
    settings.geminiSpareKeyInSettings || !!env.GEMINI_API_KEY_2
      ? { state: "working", reason: "Запасной ключ задан: если основной откажет, ИИ переключится на него." }
      : { state: "off", reason: "Запасного ключа нет: если основной ключ Gemini перестанет работать, бот и помощник остановятся.", attention: true },

  "bot-turn-trace": ({ env }) => {
    const on = /^(1|true)$/.test(env.BOT_TURN_TRACE_ENABLED ?? "");
    return on
      ? { state: "working", reason: env.BOT_TURN_TRACE_TEXT_ENABLED === "1" ? "Запись включена, вместе с текстом сообщений." : "Запись включена, тексты сообщений в неё не попадают." }
      : { state: "off", reason: `Выключено: ${ENV_NOT_SET("BOT_TURN_TRACE_ENABLED")}. Разбирать решения бота по ходам не по чему.` };
  },
};

/** Ключи, для которых есть расчёт (тест сверяет с реестром в обе стороны). */
export const EVALUATED_FUNCTION_KEYS = Object.keys(EVALUATORS);

// ─── Фоновые задачи ───

/** Запас на задержку запуска (как SLACK_MS у сторожа пульса). */
const CRON_SLACK_MS = 10 * MINUTE_MS;

export function cronHealth(row: FunctionStatusInput["heartbeats"][number], now: Date): FunctionCron["health"] {
  const lastSeen = Math.max(row.lastRunAt?.getTime() ?? 0, row.lastSkippedAt?.getTime() ?? 0);
  if (!lastSeen) return "never";
  if (row.lastError && (!row.lastOkAt || row.lastOkAt.getTime() < (row.lastRunAt?.getTime() ?? 0))) return "failing";
  const interval = cronIntervalMs(row.expr);
  let limit: number;
  if (interval >= 7 * DAY_MS) {
    // Недельные и месячные: честная дата следующего запуска, а не кратное интервала.
    try {
      limit = nextCronRun(row.expr, new Date(lastSeen)).getTime() + DAY_MS;
    } catch {
      limit = lastSeen + interval * 2;
    }
  } else {
    limit = lastSeen + interval * 3 + CRON_SLACK_MS;
  }
  return now.getTime() > limit ? "stale" : "ok";
}

function toCron(row: FunctionStatusInput["heartbeats"][number], now: Date): FunctionCron {
  return {
    name: row.name,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastOkAt: row.lastOkAt?.toISOString() ?? null,
    lastError: row.lastError ? maskPhonesInFreeText(row.lastError).slice(0, 200) : null,
    health: cronHealth(row, now),
  };
}

// ─── Чистая часть ───

export function evaluateFunctions(input: FunctionStatusInput): FunctionStatusResponse {
  const crons = input.heartbeats.map((row) => toCron(row, input.now)).sort((a, b) => a.name.localeCompare(b.name));
  const cronByName = new Map(crons.map((c) => [c.name, c]));

  const items: FunctionStatusItem[] = FUNCTION_REGISTRY.map((def) => {
    const evaluator = EVALUATORS[def.key];
    const verdict: Verdict = evaluator
      ? evaluator(input, def)
      : { state: "off", reason: "Состояние этой функции не удалось определить.", attention: true };
    const own = (def.cron ?? []).map((name) => cronByName.get(name)).filter((c): c is FunctionCron => !!c);
    const cronBroken = own.some((c) => c.health === "failing" || c.health === "stale");
    const lastError = (def.errorSources?.length
      ? input.errors.find((e) => def.errorSources!.includes(e.source))
      : undefined) ?? null;
    return {
      key: def.key,
      title: def.title,
      what: def.what,
      group: def.group,
      state: verdict.state,
      reason: verdict.reason,
      detail: verdict.detail ?? null,
      attention: (verdict.attention ?? false) || (verdict.state !== "off" && cronBroken),
      envNames: [...(def.env ?? [])],
      settingsTab: def.settingsTab ?? null,
      crons: own,
      lastError: lastError ? { at: lastError.createdAt.toISOString(), message: maskPhonesInFreeText(lastError.message).slice(0, 200) } : null,
    };
  });

  return {
    generatedAt: input.now.toISOString(),
    summary: {
      working: items.filter((i) => i.state === "working").length,
      preview: items.filter((i) => i.state === "preview").length,
      off: items.filter((i) => i.state === "off").length,
      attention: items.filter((i) => i.attention).length,
    },
    items,
    crons,
  };
}

// ─── Загрузка данных ───

const ERRORS_WINDOW_MS = 7 * DAY_MS;
const ERRORS_TAKE = 300;

export async function loadFunctionStatus(viewerRole: string | undefined, now: Date = new Date()): Promise<FunctionStatusResponse> {
  const errorSources = [...new Set(FUNCTION_REGISTRY.flatMap((f) => f.errorSources ?? []))];
  const [row, heartbeats, errors, spend] = await Promise.all([
    prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        botPauseWatchEnabled: true,
        botPauseAlertHours: true,
        botPauseEscalateHours: true,
        botCanSendPhotos: true,
        botPhotosPerOffer: true,
        botCanSendVoiceReplies: true,
        botLeadOnlyMode: true,
        liveVoiceEnabled: true,
        liveVoiceInboundMode: true,
        liveVoiceProvider: true,
        telegramPortalAlertsPaused: true,
        groundedSearchEnabled: true,
        propertyNarrationConfig: true,
        alarmHoursStart: true,
        alarmHoursEnd: true,
        geminiApiKey2: true,
      },
    }),
    prisma.cronHeartbeat.findMany({
      where: visibleCronWhere(viewerRole),
      orderBy: { name: "asc" },
      take: 300,
      select: { name: true, expr: true, lastRunAt: true, lastOkAt: true, lastError: true, lastSkippedAt: true },
    }),
    visibleErrorLogs(viewerRole).findMany({
      where: { source: { in: errorSources }, resolvedAt: null, createdAt: { gte: new Date(now.getTime() - ERRORS_WINDOW_MS) } },
      orderBy: { createdAt: "desc" },
      take: ERRORS_TAKE,
      select: { source: true, message: true, createdAt: true },
    }),
    readLiveVoiceSpend(now).catch(() => null),
  ]);

  const narration = narrationConfigSchema.safeParse(row?.propertyNarrationConfig ?? {});
  const settings: FunctionStatusSettings = {
    // Умолчания — те же, что в схеме Prisma: строки Settings может не быть (чистая база).
    botPauseWatchEnabled: row?.botPauseWatchEnabled ?? true,
    botPauseAlertHours: row?.botPauseAlertHours ?? 24,
    botPauseEscalateHours: row?.botPauseEscalateHours ?? 72,
    botCanSendPhotos: row?.botCanSendPhotos ?? true,
    botPhotosPerOffer: row?.botPhotosPerOffer ?? 3,
    botCanSendVoiceReplies: row?.botCanSendVoiceReplies ?? false,
    botLeadOnlyMode: row?.botLeadOnlyMode ?? false,
    liveVoiceEnabled: row?.liveVoiceEnabled ?? false,
    liveVoiceInboundMode: row?.liveVoiceInboundMode ?? "off",
    liveVoiceProvider: row?.liveVoiceProvider ?? "google",
    telegramPortalAlertsPaused: row?.telegramPortalAlertsPaused ?? true,
    groundedSearchEnabled: row?.groundedSearchEnabled ?? false,
    narrationAutoGenerate: narration.success && narrationAutoEnabled(narration.data),
    alarmHoursStart: row?.alarmHoursStart ?? "09:50",
    alarmHoursEnd: row?.alarmHoursEnd ?? "14:45",
    geminiSpareKeyInSettings: !!decryptSecretSafe(row?.geminiApiKey2 ?? null),
  };

  return evaluateFunctions({
    now,
    env: process.env,
    settings,
    spend: spend
      ? {
          dayUsed: spend.day.usedMinutes,
          dayCap: spend.day.capMinutes,
          monthUsed: spend.month.usedMinutes,
          monthCap: spend.month.capMinutes,
          held: spend.held,
        }
      : null,
    heartbeats,
    errors,
  });
}
