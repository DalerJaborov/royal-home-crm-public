import { createHash } from "node:crypto";
import { narrationPronunciationRuleHeldBack, narrationPronunciationSupported, type NarrationConfig } from "@royal-home/shared";
import { prisma } from "../db.js";
import { loadNarrationConfiguration } from "./narrationGeneration.js";
import { logSystemError } from "./systemError.js";

/**
 * СЛОВАРЬ ПРОИЗНОШЕНИЯ ДЛЯ ТАДЖИКСКОГО (12.11.2026, решение владельца). Владелец правит в
 * Настройках → Озвучка список «слово → как читать»; CRM держит его синхронным со словарём
 * ElevenLabs и хранит id и версию в конфиге (pronunciationDictionaries), а narrationTtsOptions
 * подставляет их в каждый синтез озвучки и образцов. Новая версия словаря меняет ключ образцов —
 * они готовятся заново (по кнопке руководства, сами не готовятся: это платно).
 *
 * ТОЛЬКО для моделей из NARRATION_PRONUNCIATION_MODELS (eleven_v4 — ФАКТ 12.11.2026: alias и
 * IPA-phoneme подействовали). Удаления словаря через API нет — только PATCH archived=true
 * (ФАКТ 12.11.2026): правила очистили — словарь архивируется. Пути add-from-rules и set-rules —
 * ОЦЕНКА по документации ElevenLabs, сверить при первом сохранении на проде (ошибка не теряет
 * правила: они остаются в CRM, руководству — текст). В тестах только подмена fetch.
 *
 * 20.11.2026 (ФАКТ на слух владельца, прод): таджикская озвучка со словарём звучала с акцентом
 * («ошёна» → «ашёна»), без словаря — правильно. 37 правил-звуков были собраны механически и
 * помечены «проверить носителем». Поэтому:
 *  - в ElevenLabs уходит только pronunciationRulesForElevenLabs: звуки без проверки носителем
 *    остаются в CRM, но не отправляются; замены-алиасы уходят как раньше;
 *  - рядом с id словаря хранится отпечаток реально отправленных правил (rulesFingerprint);
 *    словарь «устарел» (pronunciationDictionaryStale), если отпечатка нет или он не совпал, —
 *    это и сохранение настроек, и один проход при старте фонового процесса
 *    (syncPronunciationDictionaryOnStart, зовёт worker.ts): после выката словарь обновляется сам.
 */
export type PronunciationSyncResult =
  | { status: "SKIPPED" }
  | { status: "SYNCED"; dictionaries: NonNullable<NarrationConfig["pronunciationDictionaries"]> }
  | { status: "FAILED"; error: string };

export type PronunciationRulePayload =
  | { type: "phoneme"; string_to_replace: string; phoneme: string; alphabet: "ipa" }
  | { type: "alias"; string_to_replace: string; alias: string };

/** ОДНО МЕСТО: что реально уходит в ElevenLabs. Звуки без проверки носителем остаются в CRM и сюда не попадают. */
export function pronunciationRulesForElevenLabs(rules: NarrationConfig["pronunciationRules"]): PronunciationRulePayload[] {
  return (rules ?? []).filter((r) => !narrationPronunciationRuleHeldBack(r)).map((r): PronunciationRulePayload => r.phoneme
    // IPA в словаре владельца записан в косых скобках («/havˈli/») — сами скобки не часть звуков.
    ? { type: "phoneme", string_to_replace: r.word, phoneme: r.phoneme.replace(/^\/|\/$/gu, ""), alphabet: "ipa" }
    : { type: "alias", string_to_replace: r.word, alias: r.alias ?? r.word });
}

/** Отпечаток того, что уходит в ElevenLabs: тот же набор правил — тот же отпечаток. */
export function pronunciationFingerprint(payload: readonly PronunciationRulePayload[]): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Словарь в ElevenLabs не совпадает с правилами CRM и его надо обновить: нет словаря при непустом наборе, нет отпечатка
 * (настройки до 20.11.2026) или он не совпал; при пустом наборе — словарь ещё не архивирован. Модель без поддержки
 * словаря — не устарел никогда (синхронизировать нечего).
 */
export function pronunciationDictionaryStale(config: NarrationConfig): boolean {
  if (!narrationPronunciationSupported(config.modelId)) return false;
  const payload = pronunciationRulesForElevenLabs(config.pronunciationRules);
  const current = config.pronunciationDictionaries?.[0];
  if (!payload.length) return !!current;
  return !current || current.rulesFingerprint !== pronunciationFingerprint(payload);
}

export async function syncPronunciationDictionary(config: NarrationConfig, apiKey: string | null, fetcher: typeof fetch = fetch): Promise<PronunciationSyncResult> {
  if (!apiKey || !narrationPronunciationSupported(config.modelId)) return { status: "SKIPPED" };
  const rules = pronunciationRulesForElevenLabs(config.pronunciationRules);
  const base = (process.env.ELEVENLABS_API_BASE?.trim() || "https://api.elevenlabs.io").replace(/\/+$/, "");
  const current = config.pronunciationDictionaries?.[0];
  try {
    if (!rules.length) {
      if (current) {
        const archived = await fetcher(`${base}/v1/pronunciation-dictionaries/${encodeURIComponent(current.id)}`, { method: "PATCH", headers: { "xi-api-key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ archived: true }), signal: AbortSignal.timeout(30_000), redirect: "error" });
        if (!archived.ok) return { status: "FAILED", error: `ElevenLabs ответил ${archived.status}` };
      }
      return { status: "SYNCED", dictionaries: [] };
    }
    const url = current ? `${base}/v1/pronunciation-dictionaries/${encodeURIComponent(current.id)}/set-rules` : `${base}/v1/pronunciation-dictionaries/add-from-rules`;
    const body = current ? { rules } : { name: "royal-home-tajik", rules };
    const response = await fetcher(url, { method: "POST", headers: { "xi-api-key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: "error" });
    if (!response.ok) return { status: "FAILED", error: `ElevenLabs ответил ${response.status}` };
    const json = (await response.json().catch(() => null)) as { id?: string; version_id?: string } | null;
    const id = json?.id ?? current?.id;
    if (!id) return { status: "FAILED", error: "ElevenLabs не вернул id словаря" };
    return { status: "SYNCED", dictionaries: [{ id, ...(json?.version_id ? { versionId: json.version_id } : {}), rulesFingerprint: pronunciationFingerprint(rules) }] };
  } catch (err) {
    return { status: "FAILED", error: err instanceof Error ? err.message : String(err) };
  }
}

export type PronunciationStartOutcome = "FRESH" | "SKIPPED" | "SYNCED" | "FAILED" | "RACED";

/**
 * ПРОХОД ПРИ СТАРТЕ ФОНОВОГО ПРОЦЕССА (20.11.2026): словарь в ElevenLabs устарел — обновить без ручных шагов после выката.
 * Идемпотентно: свежий словарь — ни одного запроса. Отказ ElevenLabs — в журнал ошибок, процесс не падает, повторится при
 * следующем старте или сохранении настроек. Результат пишется УЗКО и с проверкой (только поле pronunciationDictionaries и только
 * если оно с момента чтения не менялось): сохранение с экрана Настроек пишет конфиг целиком и не должно быть затёрто
 * (и само не затирает чужое).
 */
export async function syncPronunciationDictionaryOnStart(fetcher: typeof fetch = fetch): Promise<PronunciationStartOutcome> {
  try {
    const { config, key, unreadable } = await loadNarrationConfiguration();
    if (unreadable) return "SKIPPED";
    if (!key || !narrationPronunciationSupported(config.modelId)) return "SKIPPED";
    if (!pronunciationDictionaryStale(config)) return "FRESH";
    const sync = await syncPronunciationDictionary(config, key, fetcher);
    if (sync.status === "SKIPPED") return "SKIPPED";
    if (sync.status === "FAILED") {
      void logSystemError("api", `Словарь произношения озвучки не обновился в ElevenLabs при запуске: ${sync.error}. Правила целы в CRM; повтор при следующем запуске или сохранении настроек озвучки`, { dedupKey: "narration-dictionary-start-sync" });
      return "FAILED";
    }
    const before = config.pronunciationDictionaries === undefined ? null : JSON.stringify(config.pronunciationDictionaries);
    const changed = await prisma.$executeRaw`
      UPDATE "Settings"
         SET "propertyNarrationConfig" = jsonb_set("propertyNarrationConfig", '{pronunciationDictionaries}', ${JSON.stringify(sync.dictionaries)}::jsonb, true)
       WHERE id = 'singleton'
         AND ("propertyNarrationConfig" -> 'pronunciationDictionaries') IS NOT DISTINCT FROM ${before}::jsonb`;
    // Конфиг успели поменять, пока шёл запрос: результат не пишем, словарь останется устаревшим и обновится при следующем случае.
    return changed ? "SYNCED" : "RACED";
  } catch (err) {
    void logSystemError("api", `Словарь произношения озвучки: проверка при запуске упала: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-dictionary-start-sync" });
    return "FAILED";
  }
}
