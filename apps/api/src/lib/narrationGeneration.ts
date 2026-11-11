import { NARRATION_LANGS, NARRATION_VOICE_SAMPLE_TEXT, narrationConfigSchema, narrationLimits, narrationModelSupportsTajik, narrationSpeechText, type NarrationConfig, type NarrationLang } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { resolveElevenLabsKey } from "../ai/liveVoiceProvider.js";
import { dushanbeStartOfToday } from "./dushanbeTime.js";
import { localVideoDelete, localVideoUpload } from "./localVideoStorage.js";
import { generateNarrationAudio, narrationFacts, narrationHash, NARRATION_QUOTA_EXCEEDED } from "./propertyNarration.js";

/** Пауза после «кредиты кончились»: раз в час одна проверка, пока владелец не пополнит. */
export const NARRATION_QUOTA_PAUSE_MS = 60 * 60_000;
/**
 * Состояние ElevenLabs для Настроек и для паузы автоозвучки: последняя начатая генерация
 * упала на «кредиты кончились». Первая удачная генерация после пополнения снимает признак сама.
 */
export async function narrationQuotaExceededSince(db: Pick<Tx, "propertyNarrationVersion"> = prisma): Promise<Date | null> {
  const last = await db.propertyNarrationVersion.findFirst({ where: { generationStartedAt: { not: null } }, orderBy: { generationStartedAt: "desc" }, select: { errorCode: true, generationStartedAt: true } });
  return last?.errorCode === NARRATION_QUOTA_EXCEEDED ? last.generationStartedAt : null;
}

/**
 * ОДНА ДВЕРЬ ПЛАТНОЙ ОЗВУЧКИ (11.11.2026). И кнопка маркетинга
 * (`POST /properties/:id/narration/:versionId/generate`), и автоозвучка после
 * создания или правки объекта (lib/narrationAutoFlow.ts) идут только сюда:
 * захват версии под замком объекта → дневной потолок → один запрос в
 * ElevenLabs → сохранение. Двойной генерации нет: захват переводит DRAFT в
 * GENERATING одной записью, пока у объекта есть GENERATING/UNKNOWN — новый
 * платный запрос не начинается.
 */
type Tx = TxClient;

export async function loadNarrationConfiguration(): Promise<{ config: NarrationConfig; key: string | null }> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true, elevenLabsApiKey: true } });
  const parsed = narrationConfigSchema.safeParse(settings?.propertyNarrationConfig ?? {});
  return { config: parsed.success ? parsed.data : { modelId: "", voices: [] }, key: resolveElevenLabsKey(settings?.elevenLabsApiKey) };
}

export function narrationProviderReady(config: NarrationConfig, key: string | null): boolean {
  return !!key && !!config.modelId && config.voices.length > 0;
}

/**
 * Расход за сутки по Душанбе: каждая начатая генерация, включая неудачные (деньги могли списаться).
 * Образцы голосов (11.11.2026) — в том же потолке: это та же платная озвучка.
 */
export async function narrationBudgetUsage(db: Pick<Tx, "propertyNarrationVersion" | "narrationVoiceSample"> = prisma, now = new Date()) {
  const since = dushanbeStartOfToday(now);
  const [rows, samples] = await Promise.all([
    db.propertyNarrationVersion.findMany({ where: { generationStartedAt: { gte: since } }, select: { script: true }, take: 5000 }),
    db.narrationVoiceSample.findMany({ where: { generationStartedAt: { gte: since } }, select: { chars: true }, take: 5000 }),
  ]);
  return {
    usedChars: (rows ?? []).reduce((sum, r) => sum + r.script.length, 0) + (samples ?? []).reduce((sum, r) => sum + r.chars, 0),
    usedGenerations: (rows ?? []).length + (samples ?? []).length,
  };
}

/** Под общим замком: две генерации одновременно не проскочат мимо потолка. */
async function budgetAllows(tx: Tx, chars: number, config: NarrationConfig, now: Date): Promise<boolean> {
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('property-narration-budget'))) AS budget_lock`;
  const limits = narrationLimits(config);
  const used = await narrationBudgetUsage(tx, now);
  return used.usedGenerations + 1 <= limits.dailyGenerations && used.usedChars + chars <= limits.dailyChars;
}

export type NarrationGenerationOutcome =
  | { status: "READY"; propertyTrashed: boolean; versionId: string }
  | { status: "REJECTED" }
  | { status: "BUDGET" }
  | { status: "ALREADY"; current: string }
  | { status: "FAILED" | "UNKNOWN"; errorCode: string; recorded: boolean }
  | { status: "LATE" }
  | { status: "PERSIST_FAILED" }
  | { status: "GONE" };

export async function generateNarrationVersion(input: {
  propertyId: string; versionId: string; expectedRevision: number;
  /** Кнопка маркетинга: только подтверждённый текст. Автоозвучка: агент одобряет уже готовое аудио. */
  requireApproval: boolean;
  config: NarrationConfig; key: string; now?: Date;
}): Promise<NarrationGenerationOutcome> {
  const now = input.now ?? new Date();
  const { config } = input;
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${input.propertyId} FOR UPDATE`;
    const current = await tx.property.findUniqueOrThrow({ where: { id: input.propertyId }, include: { district: true } });
    const latest = await tx.propertyNarrationVersion.findFirst({ where: { propertyId: input.propertyId }, orderBy: { revision: "desc" } });
    if (current.deletedAt || !latest || latest.id !== input.versionId || latest.revision !== input.expectedRevision
      || (input.requireApproval && !latest.approvedAt) || latest.factsHash !== narrationHash(narrationFacts(current))) return { kind: "REJECTED" as const };
    if (latest.status !== "DRAFT") return { kind: "ALREADY" as const, current: latest.status };
    if (!input.requireApproval && (!latest.generateAfter || latest.generateAfter > now)) return { kind: "REJECTED" as const };
    if (!latest.voiceId || !config.voices.some((v) => v.id === latest.voiceId) || latest.modelId !== config.modelId) return { kind: "REJECTED" as const };
    if (await tx.propertyNarrationVersion.count({ where: { propertyId: input.propertyId, status: { in: ["GENERATING", "UNKNOWN"] } } })) return { kind: "REJECTED" as const };
    if (!await budgetAllows(tx, latest.script.length, config, now)) return { kind: "BUDGET" as const };
    // То же «сейчас», что у потолка и паузы «кредиты кончились»: иначе пауза считалась бы по двум часам сразу.
    const generationStartedAt = now;
    await tx.propertyNarrationVersion.update({ where: { id: latest.id }, data: { status: "GENERATING", generationStartedAt, generationAttempts: { increment: 1 } } });
    return { kind: "RUN" as const, row: { ...latest, generationStartedAt } };
  });
  if (claimed.kind === "REJECTED") return { status: "REJECTED" };
  if (claimed.kind === "BUDGET") return { status: "BUDGET" };
  if (claimed.kind === "ALREADY") return { status: "ALREADY", current: claimed.current };
  const row = claimed.row;
  const script = narrationSpeechText(row.script, (row.language as NarrationLang | null) ?? null);
  const result = await generateNarrationAudio({ script, voiceId: row.voiceId!, config, apiKey: input.key });
  const guard = { id: row.id, status: "GENERATING", generationStartedAt: row.generationStartedAt };
  if (result.status !== "READY") {
    // Автоозвучка при кончившихся кредитах не теряет версию: она снова ждёт (через час), агенту ничего.
    const waitForTopUp = !input.requireApproval && result.errorCode === NARRATION_QUOTA_EXCEEDED;
    const saved = await prisma.propertyNarrationVersion.updateMany({ where: guard, data: waitForTopUp
      ? { status: "DRAFT", errorCode: result.errorCode, generateAfter: new Date(now.getTime() + NARRATION_QUOTA_PAUSE_MS) }
      : { status: result.status, errorCode: result.errorCode } });
    return { status: result.status, errorCode: result.errorCode, recorded: saved.count > 0 };
  }
  const storageKey = `${input.propertyId}/${row.id}.mp3`;
  try {
    await localVideoUpload(storageKey, result.audio);
    const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${input.propertyId} FOR UPDATE`;
      const changed = await tx.propertyNarrationVersion.updateMany({ where: guard, data: { status: "READY", storageKey, providerRequestId: result.requestId, generateAfter: null, errorCode: null } });
      if (changed.count) return "READY";
      const retained = await tx.propertyNarrationVersion.updateMany({ where: { id: row.id }, data: { storageKey, providerRequestId: result.requestId } });
      return retained.count ? "RECONCILED" : "REMOVED";
    });
    if (saved !== "READY") {
      if (saved === "REMOVED") await localVideoDelete(storageKey);
      return { status: "LATE" };
    }
  } catch {
    await prisma.propertyNarrationVersion.updateMany({ where: guard, data: { status: "UNKNOWN", errorCode: "AUDIO_PERSISTENCE_FAILED", providerRequestId: result.requestId } });
    return { status: "PERSIST_FAILED" };
  }
  const after = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { deletedAt: true } });
  if (!after) return { status: "GONE" };
  return { status: "READY", propertyTrashed: !!after.deletedAt, versionId: row.id };
}

/**
 * ОБРАЗЦЫ ГОЛОСОВ (11.11.2026, владелец: агент слушает голоса одной фразой и выбирает).
 * Та же платная дверь, что у озвучки объекта: общий дневной потолок под тем же замком, один
 * запрос в ElevenLabs на образец. Кэш — строка NarrationVoiceSample по голосу + модели + тексту
 * фразы (уникальный ключ): готовый образец второй раз не оплачивается, сменили фразу или
 * модель — нужен новый. Запускает только руководство кнопкой «Подготовить образцы голосов».
 */
/** Папка образцов в закрытом хранилище (ключ localVideoStorage — «uuid/uuid.mp3»). */
export const NARRATION_SAMPLE_FOLDER = "5a3b1e00-0000-4000-8000-0000000000a1";
const SAMPLE_STALE_MS = 120_000;

/** Языки образцов — языки шаблонов; таджикский только с моделью, которая его знает. */
export function voiceSampleLangs(config: NarrationConfig): NarrationLang[] {
  const langs = new Set<NarrationLang>((config.templates ?? []).map((t) => t.lang));
  if (!langs.size) langs.add("tg");
  return [...langs].filter((lang) => lang !== "tg" || narrationModelSupportsTajik(config.modelId));
}

export type VoiceSamplesReport = { created: number; existing: number; failed: number; remaining: number; budget: boolean; quota: boolean };

export async function generateVoiceSamples(input: {
  config: NarrationConfig; key: string; actorId: string; now?: Date; timeBudgetMs?: number; fetcher?: typeof fetch;
}): Promise<VoiceSamplesReport> {
  const { config } = input;
  const started = Date.now();
  const report: VoiceSamplesReport = { created: 0, existing: 0, failed: 0, remaining: 0, budget: false, quota: false };
  const jobs = config.voices.flatMap((voice) => voiceSampleLangs(config).map((lang) => ({ voiceId: voice.id, lang })));
  for (const [index, job] of jobs.entries()) {
    const text = NARRATION_VOICE_SAMPLE_TEXT[job.lang];
    const textHash = narrationHash(text);
    const where = { voiceId_modelId_textHash: { voiceId: job.voiceId, modelId: config.modelId, textHash } };
    const existing = await prisma.narrationVoiceSample.findUnique({ where });
    if (existing?.status === "READY" && existing.storageKey) { report.existing++; continue; }
    const busy = existing?.status === "GENERATING" && Date.now() - existing.generationStartedAt.getTime() < SAMPLE_STALE_MS;
    if (busy || report.budget || report.quota || Date.now() - started > (input.timeBudgetMs ?? 100_000)) { report.remaining += busy ? 1 : jobs.length - index; if (!busy) break; continue; }
    const now = input.now ?? new Date();
    const claimed = await prisma.$transaction(async (tx) => {
      if (!await budgetAllows(tx, text.length, config, now)) return "BUDGET" as const;
      if (!existing) {
        return tx.narrationVoiceSample.create({ data: { voiceId: job.voiceId, modelId: config.modelId, lang: job.lang, textHash, chars: text.length, createdById: input.actorId } });
      }
      // Повтор после отказа: символы прибавляются — прошлая попытка тоже могла стоить денег.
      const retried = await tx.narrationVoiceSample.updateMany({ where: { id: existing.id, status: existing.status, generationStartedAt: existing.generationStartedAt },
        data: { status: "GENERATING", errorCode: null, generationStartedAt: new Date(), chars: { increment: text.length } } });
      return retried.count ? tx.narrationVoiceSample.findUniqueOrThrow({ where: { id: existing.id } }) : null;
    }).catch(() => null);
    if (claimed === "BUDGET") { report.budget = true; report.remaining += jobs.length - index; break; }
    if (!claimed) { report.remaining++; continue; }
    const result = await generateNarrationAudio({ script: narrationSpeechText(text, job.lang), voiceId: job.voiceId, config, apiKey: input.key }, input.fetcher);
    if (result.status !== "READY") {
      await prisma.narrationVoiceSample.updateMany({ where: { id: claimed.id, status: "GENERATING" }, data: { status: result.status, errorCode: result.errorCode } });
      report.failed++;
      if (result.errorCode === NARRATION_QUOTA_EXCEEDED) { report.quota = true; report.remaining += jobs.length - index - 1; break; }
      continue;
    }
    const storageKey = `${NARRATION_SAMPLE_FOLDER}/${claimed.id}.mp3`;
    try {
      await localVideoUpload(storageKey, result.audio);
      await prisma.narrationVoiceSample.updateMany({ where: { id: claimed.id, status: "GENERATING" }, data: { status: "READY", storageKey } });
      report.created++;
    } catch {
      await prisma.narrationVoiceSample.updateMany({ where: { id: claimed.id, status: "GENERATING" }, data: { status: "UNKNOWN", errorCode: "AUDIO_PERSISTENCE_FAILED" } });
      report.failed++;
    }
  }
  return report;
}

/** Готовые образцы для текущих голосов, модели и фраз — бесплатное чтение для экранов и Шабнам. */
export async function readyVoiceSamples(config: NarrationConfig): Promise<Array<{ voiceId: string; lang: NarrationLang; storageKey: string }>> {
  if (!config.modelId || !config.voices.length) return [];
  const hashes = new Map(NARRATION_LANGS.map((lang) => [narrationHash(NARRATION_VOICE_SAMPLE_TEXT[lang]), lang] as const));
  const rows = await prisma.narrationVoiceSample.findMany({
    where: { status: "READY", modelId: config.modelId, voiceId: { in: config.voices.map((v) => v.id) }, textHash: { in: [...hashes.keys()] }, storageKey: { not: null } },
    select: { voiceId: true, textHash: true, storageKey: true }, take: 200,
  });
  return rows.flatMap((r) => (r.storageKey && hashes.get(r.textHash) ? [{ voiceId: r.voiceId, lang: hashes.get(r.textHash)!, storageKey: r.storageKey }] : []));
}
