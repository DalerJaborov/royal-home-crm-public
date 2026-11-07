import { ASSISTANT_DEADLINE_SEC, ASSISTANT_MAX_ROUNDS, clampAssistantLimit } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { describeError } from "../../lib/describeError.js";
import { logSystemError } from "../../lib/systemError.js";
import { resolveGeminiRuntime, type GeminiRuntime } from "../geminiSettings.js";

/**
 * НАСТРОЙКИ ПОМОЩНИКА ОДНИМ ЧТЕНИЕМ И КЭШЕМ НА 15 СЕКУНД (31.10.2026, пачка П1
 * задача 1.3, docs/design/internal-assistant-architecture-2026-10-31.md §1.3–1.4).
 *
 * До этого один запрос к помощнику читал строку Settings пять–восемь раз:
 * рубильник на входе в роут, ключ Gemini, классификатор (внутри — ещё раз ключ и
 * модели), рубильник на старте цикла, рубильник и модели перед КАЖДЫМ раундом,
 * тумблер семантики внутри поиска. Каждое чтение — поход в базу на критическом
 * пути ответа. Теперь их два, и оба кэшированы:
 *   1) тумблеры помощника (aiAssistantEnabled, groundedSearchEnabled,
 *      semanticSearchEnabled) — один select;
 *   2) ключи и модели Gemini (resolveGeminiRuntime) — один select.
 *
 * ПОЧЕМУ 15 СЕКУНД. Тот же порядок, что ACCESS_TTL_MS у прав (auth/middleware.ts):
 * достаточно, чтобы серия раундов и соседние запросы шли без базы, и достаточно
 * мало, чтобы выключенный директором рубильник остановил помощника не позже чем
 * через 15 секунд (цикл раундов перечитывает его перед каждым раундом через этот
 * же кэш — см. runAssistant). Сменённый ключ Gemini подхватится с той же задержкой.
 *
 * КЭШИРУЕТСЯ ОБЕЩАНИЕ, А НЕ ЗНАЧЕНИЕ: десять одновременных запросов делят одно
 * чтение, а не делают десять. Отказ базы НЕ кэшируется — следующий запрос
 * пробует снова, а не живёт 15 секунд с ошибкой.
 */
export const ASSISTANT_RUNTIME_TTL_MS = 15_000;

export interface AssistantSettingsSnapshot {
  /** Рубильник Settings.aiAssistantEnabled (Настройки → ИИ). */
  enabled: boolean;
  /** Тумблер Settings.groundedSearchEnabled: справочные ответы с поиском Google. */
  groundedSearchEnabled: boolean;
  /** Тумблер Settings.semanticSearchEnabled: семантика в search_properties. */
  semanticSearchEnabled: boolean;
  /** Шагов (походов в модель) на один ответ — Settings.aiAssistantMaxRounds, в пределах. */
  maxRounds: number;
  /** Срок одного ответа, мс — Settings.aiAssistantDeadlineSec, в пределах. */
  deadlineMs: number;
}

interface CacheEntry<T> {
  value: Promise<T>;
  at: number;
}

/** Кэш одного значения на ASSISTANT_RUNTIME_TTL_MS. */
function ttlCache<T>(load: () => Promise<T>) {
  let entry: CacheEntry<T> | null = null;
  return {
    get(): Promise<T> {
      const now = Date.now();
      if (entry && now - entry.at < ASSISTANT_RUNTIME_TTL_MS) return entry.value;
      const next: CacheEntry<T> = { value: load(), at: now };
      entry = next;
      // Отказ не кэшируем: снимаем запись, только если её за это время не заменили.
      next.value.catch(() => {
        if (entry === next) entry = null;
      });
      return next.value;
    },
    reset(): void {
      entry = null;
    },
  };
}

/** Колонки шагов и срока (миграция 20261108090000) — новее остальных полей помощницы. */
function isMissingLimitColumn(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const text = err instanceof Error ? err.message : String(err);
  return code === "P2022" || /aiAssistant(?:MaxRounds|DeadlineSec)/.test(text);
}

async function readAssistantSettings(): Promise<AssistantSettingsSnapshot> {
  const base = { aiAssistantEnabled: true, groundedSearchEnabled: true, semanticSearchEnabled: true } as const;
  let row: {
    aiAssistantEnabled: boolean; groundedSearchEnabled: boolean; semanticSearchEnabled: boolean;
    aiAssistantMaxRounds?: number; aiAssistantDeadlineSec?: number;
  } | null;
  try {
    row = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { ...base, aiAssistantMaxRounds: true, aiAssistantDeadlineSec: true },
    });
  } catch (err) {
    // Код выкачен раньше миграции (или она не дошла): ответ не роняем — шаги и срок по умолчанию,
    // а сбой виден в «Здоровье системы». Любой другой отказ базы бросается, как раньше.
    if (!isMissingLimitColumn(err)) throw err;
    void logSystemError(
      "ai",
      `Помощница: нет колонок шагов/срока в Settings (миграция 20261108090000?) — беру значения по умолчанию: ${describeError(err)}`,
    );
    row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: base });
  }
  return {
    enabled: row?.aiAssistantEnabled === true,
    groundedSearchEnabled: row?.groundedSearchEnabled ?? false,
    semanticSearchEnabled: row?.semanticSearchEnabled ?? false,
    maxRounds: clampAssistantLimit(row?.aiAssistantMaxRounds, ASSISTANT_MAX_ROUNDS),
    deadlineMs: clampAssistantLimit(row?.aiAssistantDeadlineSec, ASSISTANT_DEADLINE_SEC) * 1000,
  };
}

const settingsCache = ttlCache(readAssistantSettings);
const geminiCache = ttlCache(() => resolveGeminiRuntime());

/** Тумблеры помощника — одно чтение Settings на 15 секунд. Отказ базы бросается. */
export function loadAssistantSettings(): Promise<AssistantSettingsSnapshot> {
  return settingsCache.get();
}

/**
 * Ключи и модели Gemini — одно чтение Settings на 15 секунд. Сам
 * resolveGeminiRuntime отказ базы не бросает, а откатывается на .env (там это
 * осознанное решение: ИИ не должен падать от недоступной базы).
 */
export function loadAssistantGeminiRuntime(): Promise<GeminiRuntime> {
  return geminiCache.get();
}

/** Сбросить кэш: тесты, переключающие тумблеры в базе между проверками. */
export function resetAssistantRuntimeCache(): void {
  settingsCache.reset();
  geminiCache.reset();
}
