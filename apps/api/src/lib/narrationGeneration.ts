import { narrationConfigSchema, narrationLimits, narrationSpeechText, type NarrationConfig, type NarrationLang } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { resolveElevenLabsKey } from "../ai/liveVoiceProvider.js";
import { dushanbeStartOfToday } from "./dushanbeTime.js";
import { localVideoDelete, localVideoUpload } from "./localVideoStorage.js";
import { generateNarrationAudio, narrationFacts, narrationHash } from "./propertyNarration.js";

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

/** Расход за сутки по Душанбе: каждая начатая генерация, включая неудачные (деньги могли списаться). */
export async function narrationBudgetUsage(db: Pick<Tx, "propertyNarrationVersion"> = prisma, now = new Date()) {
  const rows = await db.propertyNarrationVersion.findMany({ where: { generationStartedAt: { gte: dushanbeStartOfToday(now) } }, select: { script: true }, take: 5000 });
  return { usedChars: (rows ?? []).reduce((sum, r) => sum + r.script.length, 0), usedGenerations: (rows ?? []).length };
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
    const generationStartedAt = new Date();
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
    const saved = await prisma.propertyNarrationVersion.updateMany({ where: guard, data: { status: result.status, errorCode: result.errorCode } });
    return { status: result.status, errorCode: result.errorCode, recorded: saved.count > 0 };
  }
  const storageKey = `${input.propertyId}/${row.id}.mp3`;
  try {
    await localVideoUpload(storageKey, result.audio);
    const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${input.propertyId} FOR UPDATE`;
      const changed = await tx.propertyNarrationVersion.updateMany({ where: guard, data: { status: "READY", storageKey, providerRequestId: result.requestId, generateAfter: null } });
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
