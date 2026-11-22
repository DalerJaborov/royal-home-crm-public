import { createHash } from "node:crypto";
import { narrationCurrencyError, narrationPriceProblem, narrationTtsOptions, type NarrationConfig, type NarrationFacts, type NarrationLang } from "@royal-home/shared";
import { loadUsdRateInfo } from "./money.js";
import { logSystemError } from "./systemError.js";
export { suggestedNarration } from "@royal-home/shared";

/**
 * `landAreaSotka` ОБЯЗАТЕЛЕН в типе (21.11.2026): участок дома звучит в озвучке (`{сотки}`), и вызов, который выбрал
 * из базы объект без этого поля, иначе молча дал бы другой хэш фактов — версия казалась бы «устаревшей».
 * `liveWords` — рубильник «Живые слова» из Настроек (config.liveWords, по умолчанию ВЫКЛ, ревью #363): участок дома
 * входит в факты (и в их отпечаток) ТОЛЬКО при включённом — выключен, и правка соток ничего в озвучке не меняет,
 * факты ровно как до 21.11.2026. Параметр обязателен, чтобы ни один вызов не решил это молча.
 */
export function narrationFacts(p: { type: string; rooms: number | null; areaSqm: { toString(): string }; floor: number | null; totalFloors: number | null; district: { name: string } | null; price?: { toString(): string } | number | null; currency?: string | null; landAreaSotka: { toString(): string } | null }, liveWords: boolean): NarrationFacts {
  // Deliberate allowlist: no owner's identity, phone, free-form title/description.
  // Price is spoken since 11.11.2026 (owner decision), so a price change is a fact change.
  // The house plot (sotka) is spoken since 21.11.2026 — only for HOUSE and only with live words on, so everything else keeps its old hash.
  return { type: p.type, rooms: p.rooms, areaSqm: p.areaSqm.toString(), floor: p.floor, totalFloors: p.totalFloors, district: p.district?.name ?? null,
    price: p.price === null || p.price === undefined ? null : p.price.toString(), currency: p.currency ?? null,
    // `== null`: объект, собранный не из базы (подмена в тесте, старый снимок), может не нести поле вовсе — это «участка нет».
    ...(liveWords && p.type === "HOUSE" ? { landSotka: p.landAreaSotka == null ? null : p.landAreaSotka.toString() } : {}) };
}
/**
 * КУРС ДЛЯ {цена} (21.11.2026, владелец: цена в озвучке только в сомони). Курс — из Настроек, без
 * запасного значения: нет курса — цена долларовой карточки не звучит вовсе (лучше без цены, чем угадать).
 * Хранится в снимке версии рядом с фактами (`factsSnapshot.usdToTjs`), в хэш фактов не входит.
 */
export async function narrationRate(): Promise<number | null> {
  return (await loadUsdRateInfo()).rate;
}
/** Факты для СБОРКИ текста: с курсом (только у долларовой цены — у сомони курс не нужен и не хранится). */
export function withNarrationRate(facts: NarrationFacts, usdToTjs: number | null | undefined): NarrationFacts {
  return facts.currency === "USD" && usdToTjs ? { ...facts, usdToTjs } : facts;
}
/** Курс, с которым собирали текст версии (для сверки «текст версии = шаблон по её фактам»). */
export function snapshotNarrationRate(snapshot: unknown): number | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const rate = (snapshot as { usdToTjs?: unknown }).usdToTjs;
  return typeof rate === "number" && rate > 0 ? rate : null;
}
/** Цена не прозвучит — в журнал, один раз на объект и причину в сутки (иначе молча «без цены»). */
export function reportNarrationPriceProblem(shortId: number | string, facts: NarrationFacts): void {
  const problem = narrationPriceProblem(facts);
  if (!problem) return;
  const why = problem === "NO_RATE"
    ? "цена карточки в долларах, а курс доллара в Настройках не задан — цену в озвучке не говорим"
    : "валюта цены похожа на перепутанную (за квартиру сумма за м² нереальна) — цену в озвучке не говорим, проверьте цену и валюту в карточке";
  void logSystemError("api", `Озвучка объекта №${shortId}: ${why}.`, { dedupKey: `narration-price:${shortId}:${problem}`, dedupWindowMs: 24 * 60 * 60_000 });
}
export function narrationHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/**
 * АКТУАЛЬНА ЛИ ВЕРСИЯ ОЗВУЧКИ ПО ФАКТАМ (12.11.2026, ревью). Цена вошла в факты 11.11.2026; версии,
 * сделанные раньше (в снимке фактов нет поля price), сравниваются без цены — иначе при включении
 * все старые ручные озвучки разом стали бы «устаревшими»: волна перегенерации и возвратов монтажёру,
 * их нельзя было бы одобрить, а поставленные передачи падали бы. Одно место для всех сравнений.
 * Участок дома (landSotka, 21.11.2026, ревью #363): версия сверяется в той форме, в которой её сделали, — с участком
 * (живые слова были включены, сотки звучат в её аудио) или без него (выключены или раньше 21.11 — сотки в ней не звучат,
 * их правка версию не старит). Хэш с участком и без него совпасть не могут, поэтому рубильник для сверки не нужен,
 * и снимок фактов тоже: работает и у вызовов, которые выбирают из базы только `factsHash`.
 */
const FACTS_ADDED_LATER: ReadonlyArray<readonly (keyof NarrationFacts)[]> = [["price", "currency"]];
export function narrationFactsCurrent(version: { factsHash: string; factsSnapshot?: unknown }, p: Parameters<typeof narrationFacts>[0]): boolean {
  if (factsMatch(version, narrationFacts(p, false))) return true;
  return p.type === "HOUSE" && factsMatch(version, narrationFacts(p, true));
}
function factsMatch(version: { factsHash: string; factsSnapshot?: unknown }, facts: NarrationFacts): boolean {
  if (version.factsHash === narrationHash(facts)) return true;
  const snapshot = version.factsSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  // Поля, которых в снимке версии ещё не было, убираются из нынешних фактов; порядок остальных ключей прежний.
  const trimmed: Record<string, unknown> = { ...facts };
  let changed = false;
  for (const group of FACTS_ADDED_LATER) {
    if (group[0]! in snapshot) continue;
    for (const key of group) if (key in trimmed) { delete trimmed[key]; changed = true; }
  }
  return changed && version.factsHash === narrationHash(trimmed);
}
function narrationScriptLengthError(text: string): string | null {
  return text.length > 5000 ? "Текст длиннее 5000 символов — сократите его перед подтверждением." : null;
}
/** Текст озвучки ОБЪЕКТА (шаблон, текст агента, Шабнам). Озвучка своего текста и образцы голосов читают слово в слово. */
export function narrationScriptError(text: string): string | null {
  const length = narrationScriptLengthError(text);
  if (length) return length;
  // Пустоту не озвучиваем (ревью #348): шаблон из одной фразы про цену пустеет, когда цену сказать нельзя.
  if (!text.trim()) return "Текст озвучки пустой: в шаблоне не осталось ни одного предложения (цену сказать нельзя: нет курса доллара или валюта под сомнением). Выберите другой шаблон";
  // Price may be spoken since 11.11.2026 (owner: «Да, говорить цену»), only in somoni since 21.11.2026:
  // no dollars ever reach ElevenLabs, from a template or from a hand-written text.
  return narrationCurrencyError(text);
}
export const NARRATION_QUOTA_EXCEEDED = "PROVIDER_QUOTA_EXCEEDED";
/** Код версии, отклонённой сторожем валюты (21.11.2026): в тексте цена в долларах, в ElevenLabs не ушла, денег нет. */
export const NARRATION_PRICE_NOT_IN_TJS = "PRICE_NOT_IN_TJS";
/** Одна строка причины — в журнал, агенту и в отказ передачи. */
export const NARRATION_PRICE_NOT_IN_TJS_TEXT = "в тексте озвучки цена в долларах, такой голос не озвучиваем и монтажёру не отправляем; озвучка будет собрана заново из шаблона с ценой в сомони";
/** Отказ одобрить готовую версию с долларами (ревью #348, круг 2): пересборка — новая платная озвучка, её запускает человек. */
export const NARRATION_PRICE_NOT_IN_TJS_APPROVE_TEXT = "В этой озвучке цена в долларах: такую не одобряем и монтажёру не отправляем. Откройте озвучку в карточке объекта и нажмите «Исправить и озвучить»: текст соберётся с ценой в сомони.";
export type NarrationAudioResult = { status: "READY"; audio: Buffer; requestId: string | null } | { status: "FAILED" | "UNKNOWN"; errorCode: string };
/** Official POST /v1/text-to-speech/:voice_id. One attempt only: a timeout may have incurred cost. */
export async function generateNarrationAudio(input: { script: string; voiceId: string; config: NarrationConfig; apiKey: string; lang?: NarrationLang | null }, fetcher: typeof fetch = fetch): Promise<NarrationAudioResult> {
  if (!input.config.modelId || !input.config.voices.some((v) => v.id === input.voiceId)) return { status: "FAILED", errorCode: "VOICE_NOT_CONFIGURED" };
  // Здесь только длина: этой дверью идут и озвучка объекта (валюту сторожат при сборке версии и в
  // narrationGeneration), и «озвучка своего текста», и образцы голосов — они читают текст слово в слово.
  if (narrationScriptLengthError(input.script)) return { status: "FAILED", errorCode: "INVALID_SCRIPT" };
  try {
    const base = (process.env.ELEVENLABS_API_BASE?.trim() || "https://api.elevenlabs.io").replace(/\/+$/, "");
    const response = await fetcher(`${base}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=mp3_44100_128`, {
      method: "POST", headers: { "xi-api-key": input.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text: input.script, model_id: input.config.modelId, ...narrationTtsOptions(input.config, input.voiceId, input.lang) }), signal: AbortSignal.timeout(60_000), redirect: "error",
    });
    if (!response.ok) {
      // «Кредиты кончились» (ElevenLabs: detail.status = quota_exceeded, обычно 401): денег не списано,
      // повтор до пополнения бесполезен — отдельный код, по нему автоозвучка встаёт на паузу.
      const body = (await response.text().catch(() => "")).slice(0, 4000);
      if (/quota_exceeded/iu.test(body)) return { status: "FAILED", errorCode: NARRATION_QUOTA_EXCEEDED };
      return { status: response.status >= 500 ? "UNKNOWN" : "FAILED", errorCode: `PROVIDER_HTTP_${response.status}` };
    }
    if (!response.headers.get("content-type")?.startsWith("audio/")) return { status: "UNKNOWN", errorCode: "INVALID_AUDIO_RESPONSE" };
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length || audio.length > 25 * 1024 * 1024) return { status: "UNKNOWN", errorCode: "INVALID_AUDIO_SIZE" };
    return { status: "READY", audio, requestId: response.headers.get("request-id") };
  } catch { return { status: "UNKNOWN", errorCode: "PROVIDER_OUTCOME_UNKNOWN" }; }
}

export function publicationPreview(channels: string[]): Array<{ channel: string; operation: string; status: string; reason: string }> {
  return [...new Set(channels)].flatMap((channel) => ["CAPTION", "COVER"].map((operation) => {
    const supported = operation === "CAPTION" ? ["FACEBOOK", "TELEGRAM", "YOUTUBE"].includes(channel) : ["FACEBOOK", "YOUTUBE"].includes(channel);
    return { channel, operation, status: supported ? "PREVIEW" : "MANUAL_REQUIRED", reason: supported ? "Предварительный просмотр. Изменения ещё не отправлены." : "Автоматическая замена не подтверждена для этой площадки. Нужна ручная проверка." };
  }));
}
