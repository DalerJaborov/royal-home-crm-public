import type { LiveVoiceFunctionDeclaration } from "../../ai/liveVoiceClient.js";
import { ensureElevenLabsAgentReady } from "../../ai/elevenLabsAgentSync.js";
import { INTERVIEW_INVITE_CALL_TOOLS } from "../../ai/interviewInviteCallPersona.js";
import { loadLiveVoiceProviderConfig, type ElevenLabsProviderConfig } from "../../ai/liveVoiceProvider.js";
import { POST_SHOWING_CALL_TOOLS } from "../../ai/postShowingCallPersona.js";
import { SELLER_PROBE_CALL_TOOLS } from "../../ai/sellerProbeCallPersona.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";
import { LIVE_VOICE_TOOLS } from "./liveVoiceBridge.js";
import { CONSULTANT_TOOLS } from "./liveVoiceConsultant.js";
import { TRANSFER_TOOL } from "./liveVoiceTransfer.js";

/**
 * ПРОГРЕВ АГЕНТА ELEVENLABS ДО ПЕРВОГО ЗВОНКА (11.11.2026, П1, находка В6).
 *
 * Звонок через ElevenLabs перед разговором готовит агента под свой набор функций
 * (ensureElevenLabsAgentReady: заводит функции, PATCH настроек) и помнит итог в
 * памяти процесса — по ключу «агент + набор функций + таджикский голос». После
 * выката память пуста, и первый звонок КАЖДОГО вида ждал подготовку до 12 с, а
 * человек всё это время молчал в трубке после «алло». Кнопка «Проверить агента»
 * готовила агента мимо этой памяти, так что и после неё первый звонок ждал.
 *
 * Здесь — одна дверь прогрева: тот же вызов с теми же аргументами, что делает
 * подключение (ElevenLabsVoiceClient.connect), для каждого набора функций, с
 * которым CRM звонит. Зовут её старт api (index.ts), кнопка «Проверить агента»
 * (routes/settings.ts) и смена поставщика/ключа/агента (settingsSideEffects.ts).
 *
 * Новый вид звонка со своим набором функций обязан попасть в список ниже —
 * сторож в tests/live-voice-no-silent-dial.test.ts сверяет его с вызовами
 * `tools: <НАБОР>` в коде сервера.
 */
export interface LiveVoiceWarmupToolSet {
  /** Для журнала и ответа кнопки — простыми словами. */
  kind: string;
  tools: LiveVoiceFunctionDeclaration[];
}

export function liveVoiceWarmupToolSets(): LiveVoiceWarmupToolSet[] {
  return [
    { kind: "звонок клиенту из карточки и проверочный звонок", tools: LIVE_VOICE_TOOLS },
    // Консультант на входящем — с переводом агенту и без (liveVoiceConsultant.ts: transferAvailable).
    { kind: "консультант на входящем", tools: CONSULTANT_TOOLS },
    { kind: "консультант на входящем без перевода", tools: CONSULTANT_TOOLS.filter((t) => t.name !== TRANSFER_TOOL.name) },
    { kind: "опрос после показа", tools: POST_SHOWING_CALL_TOOLS },
    { kind: "проверка собственника", tools: SELLER_PROBE_CALL_TOOLS },
    { kind: "приглашение кандидата", tools: INTERVIEW_INVITE_CALL_TOOLS },
  ];
}

export interface LiveVoiceWarmupOutcome {
  /** Сколько наборов подготовлено (из памяти или заново). */
  prepared: number;
  /** Виды звонков, для которых подготовка не вышла (причина — в журнале, ensure пишет её сам). */
  failed: string[];
  /** Сколько разных функций заведено у агента на все наборы. */
  toolIds: number;
  /** Не уложились в потолок: оставшиеся наборы доготовятся в фоне. */
  timedOut: boolean;
}

type Ensure = typeof ensureElevenLabsAgentReady;

/**
 * Подготовить агента под все наборы. По очереди, а не разом: каждая подготовка
 * читает агента и пишет его заново (GET + PATCH), и параллельные записи затирали
 * бы друг друга. Не бросает. Потолок `budgetMs` держит вызывающего (кнопку), сама
 * подготовка после потолка не прерывается — её итог ляжет в память для звонков.
 */
export async function warmElevenLabsAgent(
  config: ElevenLabsProviderConfig,
  opts: { budgetMs?: number; ensure?: Ensure } = {}
): Promise<LiveVoiceWarmupOutcome> {
  const { apiKey, agentId } = config;
  const sets = liveVoiceWarmupToolSets();
  if (!apiKey || !agentId) return { prepared: 0, failed: sets.map((s) => s.kind), toolIds: 0, timedOut: false };
  const ensure = opts.ensure ?? ensureElevenLabsAgentReady;
  const ids = new Set<string>();
  const failed: string[] = [];
  let prepared = 0;
  const run = (async () => {
    for (const set of sets) {
      // Аргументы — ровно как у ElevenLabsVoiceClient.connect: иначе ключ памяти разойдётся.
      const got = await ensure(apiKey, agentId, set.tools, { voiceIdTg: config.voiceIdTg }).catch(() => null);
      if (got) {
        prepared += 1;
        for (const id of got.values()) ids.add(id);
      } else {
        failed.push(set.kind);
      }
    }
  })();
  if (opts.budgetMs === undefined) {
    await run;
    return { prepared, failed, toolIds: ids.size, timedOut: false };
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = await Promise.race([
    run.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), opts.budgetMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return { prepared, failed: [...failed], toolIds: ids.size, timedOut };
}

/** Потолок прогрева при старте: дальше подготовка идёт в фоне, старт его не ждёт вовсе. */
export const LIVE_VOICE_WARMUP_BUDGET_MS = 90_000;

/**
 * Прогрев в фоне — при старте api и после смены поставщика, ключа или агента.
 * Только когда голос робота — ElevenLabs и ключ с агентом заданы. Никогда не
 * отклоняется и не держит вызывающего: возвращённый промис нужен только тестам.
 */
export function startLiveVoiceAgentWarmup(opts: { ensure?: Ensure; budgetMs?: number } = {}): Promise<void> {
  return (async () => {
    const config = await loadLiveVoiceProviderConfig();
    if (config.provider !== "elevenlabs" || !config.apiKey || !config.agentId) return;
    const outcome = await warmElevenLabsAgent(config, { ensure: opts.ensure, budgetMs: opts.budgetMs ?? LIVE_VOICE_WARMUP_BUDGET_MS });
    if (outcome.timedOut) {
      void logSystemError(
        "telephony",
        `Живой голос (ElevenLabs): подготовка агента ${config.agentId} не уложилась в ` +
          `${(opts.budgetMs ?? LIVE_VOICE_WARMUP_BUDGET_MS) / 1000} с — доготовится в фоне, первые звонки могут ждать дольше.`,
        { dedupKey: "elevenlabs-warmup-slow" }
      );
    }
    // Отказ подготовки отдельного набора уже в журнале (ensureElevenLabsAgentReady, «elevenlabs-agent-sync»).
  })().catch(
    (err) =>
      void logSystemError("telephony", `Живой голос (ElevenLabs): прогрев агента упал: ${describeError(err)}`, {
        dedupKey: "elevenlabs-warmup-failed",
      })
  );
}
