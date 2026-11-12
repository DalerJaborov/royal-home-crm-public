import { narrationPronunciationSupported, type NarrationConfig } from "@royal-home/shared";

/**
 * СЛОВАРЬ ПРОИЗНОШЕНИЯ ДЛЯ ТАДЖИКСКОГО (12.11.2026, решение владельца). Владелец правит в
 * Настройках → Озвучка список «слово → как читать»; CRM держит его синхронным со словарём
 * ElevenLabs и хранит id и версию в конфиге (pronunciationDictionaries), а narrationTtsOptions
 * подставляет их в каждый синтез озвучки и образцов. Новая версия словаря меняет ключ образцов —
 * они готовятся заново.
 *
 * ТОЛЬКО для моделей из NARRATION_PRONUNCIATION_MODELS (eleven_v4 — ФАКТ 12.11.2026: alias и
 * IPA-phoneme подействовали). Удаления словаря через API нет — только PATCH archived=true
 * (ФАКТ 12.11.2026): правила очистили — словарь архивируется. Пути add-from-rules и set-rules —
 * ОЦЕНКА по документации ElevenLabs, сверить при первом сохранении на проде (ошибка не теряет
 * правила: они остаются в CRM, руководству — текст). В тестах только подмена fetch.
 */
export type PronunciationSyncResult =
  | { status: "SKIPPED" }
  | { status: "SYNCED"; dictionaries: NonNullable<NarrationConfig["pronunciationDictionaries"]> }
  | { status: "FAILED"; error: string };

function rulesPayload(config: NarrationConfig) {
  return (config.pronunciationRules ?? []).map((r) => r.phoneme
    // IPA в словаре владельца записан в косых скобках («/havˈli/») — сами скобки не часть звуков.
    ? { type: "phoneme", string_to_replace: r.word, phoneme: r.phoneme.replace(/^\/|\/$/gu, ""), alphabet: "ipa" }
    : { type: "alias", string_to_replace: r.word, alias: r.alias ?? r.word });
}

export async function syncPronunciationDictionary(config: NarrationConfig, apiKey: string | null, fetcher: typeof fetch = fetch): Promise<PronunciationSyncResult> {
  if (!apiKey || !narrationPronunciationSupported(config.modelId)) return { status: "SKIPPED" };
  const rules = rulesPayload(config);
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
    return { status: "SYNCED", dictionaries: [{ id, ...(json?.version_id ? { versionId: json.version_id } : {}) }] };
  } catch (err) {
    return { status: "FAILED", error: err instanceof Error ? err.message : String(err) };
  }
}
