import {
  freeNarrationEnabled, freeNarrationLimits, detectFreeNarrationLang, isReadOnlyRole, narrationModelSupportsTajik, narrationSpeechText, pickNarrationVoice,
  type NarrationConfig, type NarrationLang,
} from "@royal-home/shared";
import { loadAgentAccess } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { dushanbeStartOfToday } from "./dushanbeTime.js";
import { localVideoDelete, localVideoFilePath, localVideoUpload } from "./localVideoStorage.js";
import { budgetAllows, loadNarrationConfiguration, narrationProviderReady } from "./narrationGeneration.js";
import { rememberNarrationChoice } from "./narrationLastChoice.js";
import { generateNarrationAudio, NARRATION_QUOTA_EXCEEDED } from "./propertyNarration.js";
import { logSystemError } from "./systemError.js";

/**
 * ОДНА ДВЕРЬ «ОЗВУЧКА СВОБОДНОГО ТЕКСТА» (16.11.2026, решение владельца). Шабнам в Telegram и
 * REST (`/properties/narration-free`) идут только сюда. Движок, голоса, модель, словарь
 * произношения и дневной потолок знаков — общие с озвучкой объектов (narrationGeneration.ts):
 * здесь только права, потолок на человека, захват (одна запись = один платёж) и файл.
 * Текст читается слово в слово: модель его не пересказывает, уходит ровно narrationSpeechText.
 */
export const FREE_NARRATION_FOLDER = "5a3b1e00-0000-4000-8000-0000000000a2";
/** Файл и текст хранятся сутки (расход остаётся в строке) — потом purgeFreeNarrations. */
export const FREE_NARRATION_KEEP_MS = 24 * 3_600_000;
const STALE_GENERATING_MS = 3 * 60_000;
/** Ждём текст после «озвучь текст» без самого текста. */
export const FREE_NARRATION_TEXT_WINDOW_MS = 15 * 60_000;
export const FREE_NARRATION_MIN_CHARS = 3;

export type FreeNarrationRow = NonNullable<Awaited<ReturnType<typeof prisma.freeNarration.findUnique>>>;

/** Все активные сотрудники, кроме ролей «только чтение» (решение владельца 16.11). */
export async function canUseFreeNarration(agentId: string): Promise<boolean> {
  const access = await loadAgentAccess(agentId);
  return !!access?.isActive && !isReadOnlyRole(access.role);
}

/** Язык текста с учётом модели: таджикского модель не знает — подсказку не передаём. */
function effectiveLang(lang: NarrationLang | null | undefined, config: NarrationConfig): NarrationLang | null {
  return lang === "tg" && !narrationModelSupportsTajik(config.modelId) ? null : lang ?? null;
}

export type FreeNarrationCreateOutcome =
  | { status: "CREATED"; row: FreeNarrationRow }
  | { status: "EXISTS"; row: FreeNarrationRow }
  | { status: "NO_ACCESS" }
  | { status: "OFF" }
  | { status: "NOT_CONFIGURED" }
  | { status: "TOO_SHORT" }
  | { status: "TOO_LONG"; max: number; length: number };

/** Запрос на озвучку текста: голос выбирается следующим шагом. Повтор с тем же requestKey ничего не создаёт. */
export async function createFreeNarrationRequest(input: {
  agentId: string; source: "TELEGRAM" | "API"; text: string; chatId?: string; lang?: NarrationLang | null; requestKey?: string;
}): Promise<FreeNarrationCreateOutcome> {
  if (!await canUseFreeNarration(input.agentId)) return { status: "NO_ACCESS" };
  const { config, key } = await loadNarrationConfiguration();
  if (!freeNarrationEnabled(config)) return { status: "OFF" };
  if (!narrationProviderReady(config, key)) return { status: "NOT_CONFIGURED" };
  const text = input.text.trim();
  if (text.length < FREE_NARRATION_MIN_CHARS) return { status: "TOO_SHORT" };
  const { maxChars } = freeNarrationLimits(config);
  if (text.length > maxChars) return { status: "TOO_LONG", max: maxChars, length: text.length };
  const lang = effectiveLang(input.lang !== undefined ? input.lang : detectFreeNarrationLang(text), config);
  try {
    // Старое ожидание текста этого чата заменяется: текст пришёл.
    if (input.chatId) await prisma.freeNarration.deleteMany({ where: { chatId: input.chatId, status: "AWAITING_TEXT" } });
    const row = await prisma.freeNarration.create({ data: {
      agentId: input.agentId, source: input.source, chatId: input.chatId ?? null, status: "AWAITING_VOICE", script: text, lang, requestKey: input.requestKey ?? null,
    } });
    return { status: "CREATED", row };
  } catch (err) {
    if (input.requestKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const row = await prisma.freeNarration.findUnique({ where: { requestKey: input.requestKey } });
      if (row && row.agentId === input.agentId) return { status: "EXISTS", row };
      return { status: "NO_ACCESS" };
    }
    throw err;
  }
}

/** «Озвучь текст» без текста: ждём его следующим сообщением (15 минут). */
export async function startFreeNarrationTextWait(agentId: string, chatId: string): Promise<boolean> {
  if (!await canUseFreeNarration(agentId)) return false;
  await prisma.freeNarration.deleteMany({ where: { chatId, status: "AWAITING_TEXT" } });
  await prisma.freeNarration.create({ data: { agentId, source: "TELEGRAM", chatId, status: "AWAITING_TEXT" } });
  return true;
}
export async function pendingFreeNarrationTextWait(agentId: string, chatId: string, now = new Date()): Promise<boolean> {
  const row = await prisma.freeNarration.findFirst({ where: { chatId, agentId, status: "AWAITING_TEXT", createdAt: { gte: new Date(now.getTime() - FREE_NARRATION_TEXT_WINDOW_MS) } }, select: { id: true } });
  return !!row;
}
export async function clearFreeNarrationTextWait(chatId: string): Promise<void> {
  await prisma.freeNarration.deleteMany({ where: { chatId, status: "AWAITING_TEXT" } });
}

/** Язык меняет только владелец запроса и только до выбора голоса (после выбора уже заплачено). */
export async function setFreeNarrationLang(id: string, agentId: string, lang: NarrationLang | null): Promise<boolean> {
  const { config } = await loadNarrationConfiguration();
  const changed = await prisma.freeNarration.updateMany({ where: { id, agentId, status: "AWAITING_VOICE" }, data: { lang: effectiveLang(lang, config) } });
  return changed.count > 0;
}

export async function cancelFreeNarration(id: string, agentId: string): Promise<boolean> {
  const removed = await prisma.freeNarration.deleteMany({ where: { id, agentId, status: "AWAITING_VOICE" } });
  return removed.count > 0;
}

/** Сколько озвучек человек уже начал сегодня (по Душанбе), включая неудачные: деньги могли списаться. */
export async function freeNarrationUsedToday(agentId: string, now = new Date(), db: Pick<typeof prisma, "freeNarration"> = prisma): Promise<number> {
  return db.freeNarration.count({ where: { agentId, generationStartedAt: { gte: dushanbeStartOfToday(now) } } });
}

export type FreeNarrationRunOutcome =
  | { status: "READY"; row: FreeNarrationRow; voiceName: string | null; storageKey: string | null; audio: Buffer }
  | { status: "ALREADY_READY"; row: FreeNarrationRow }
  | { status: "ALREADY_RUNNING" }
  | { status: "ALREADY_FAILED"; errorCode: string | null }
  | { status: "GONE" }
  | { status: "NO_ACCESS" }
  | { status: "OFF" }
  | { status: "NOT_CONFIGURED" }
  | { status: "VOICE_UNKNOWN" }
  | { status: "BUDGET" }
  | { status: "LIMIT_PERSON"; limit: number }
  | { status: "FAILED"; errorCode: string; quota: boolean };

/**
 * Выбор голоса = платный шаг. Захват под общим замком бюджета: потолок на человека и общий дневной
 * потолок озвучки проверяются до вызова ElevenLabs, а переход AWAITING_VOICE → GENERATING одной
 * записью не даёт второму нажатию (или повтору запроса) начать вторую генерацию.
 */
export async function runFreeNarration(input: {
  id: string; agentId: string; voiceId?: string; lang?: NarrationLang | null; now?: Date; fetcher?: typeof fetch;
}): Promise<FreeNarrationRunOutcome> {
  const now = input.now ?? new Date();
  const row = await prisma.freeNarration.findUnique({ where: { id: input.id } });
  if (!row || row.agentId !== input.agentId || row.status === "AWAITING_TEXT") return { status: "GONE" };
  if (row.status === "READY") return { status: "ALREADY_READY", row };
  if (row.status === "GENERATING") return { status: "ALREADY_RUNNING" };
  if (row.status !== "AWAITING_VOICE") return { status: "ALREADY_FAILED", errorCode: row.errorCode };
  if (!await canUseFreeNarration(input.agentId)) return { status: "NO_ACCESS" };
  const { config, key } = await loadNarrationConfiguration();
  if (!freeNarrationEnabled(config)) return { status: "OFF" };
  if (!key || !narrationProviderReady(config, key)) return { status: "NOT_CONFIGURED" };
  // Один источник голосов с озвучкой объектов; без выбора — голос по умолчанию из настроек.
  const voiceId = input.voiceId ? (config.voices.some((v) => v.id === input.voiceId) ? input.voiceId : null) : pickNarrationVoice(config);
  if (!voiceId) return { status: "VOICE_UNKNOWN" };
  const lang = effectiveLang(input.lang !== undefined ? input.lang : (row.lang as NarrationLang | null), config);
  const script = narrationSpeechText(row.script, lang);
  const limits = freeNarrationLimits(config);
  if (row.script.length > limits.maxChars) return { status: "FAILED", errorCode: "TOO_LONG", quota: false };

  const claimed = await prisma.$transaction(async (tx) => {
    // budgetAllows берёт общий замок бюджета озвучки: две генерации разом не проскочат мимо потолков.
    if (!await budgetAllows(tx, script.length, config, now)) return "BUDGET" as const;
    if (await freeNarrationUsedToday(input.agentId, now, tx) >= limits.perPersonDaily) return "LIMIT_PERSON" as const;
    const moved = await tx.freeNarration.updateMany({ where: { id: row.id, agentId: input.agentId, status: "AWAITING_VOICE" },
      data: { status: "GENERATING", voiceId, lang, chars: script.length, generationStartedAt: now } });
    return moved.count ? "RUN" as const : "ALREADY" as const;
  });
  if (claimed === "BUDGET") return { status: "BUDGET" };
  if (claimed === "LIMIT_PERSON") return { status: "LIMIT_PERSON", limit: limits.perPersonDaily };
  if (claimed === "ALREADY") return { status: "ALREADY_RUNNING" };

  const guard = { id: row.id, status: "GENERATING" };
  const result = await generateNarrationAudio({ script, voiceId, config, apiKey: key, lang }, input.fetcher);
  if (result.status !== "READY") {
    await prisma.freeNarration.updateMany({ where: guard, data: { status: result.status, errorCode: result.errorCode } });
    const quota = result.errorCode === NARRATION_QUOTA_EXCEEDED;
    void logSystemError("api", `Озвучка текста: ElevenLabs не выдал аудио (${result.errorCode})`, { dedupKey: `free-narration:${result.errorCode}` });
    return { status: "FAILED", errorCode: result.errorCode, quota };
  }
  const storageKey = `${FREE_NARRATION_FOLDER}/${row.id}.mp3`;
  let stored: string | null = storageKey;
  try { await localVideoUpload(storageKey, result.audio); } catch (err) {
    stored = null;
    void logSystemError("api", `Озвучка текста: файл не сохранён: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "free-narration:persist" });
  }
  const done = await prisma.freeNarration.update({ where: { id: row.id }, data: { status: "READY", storageKey: stored, providerRequestId: result.requestId, errorCode: stored ? null : "AUDIO_PERSISTENCE_FAILED" } });
  await rememberNarrationChoice(input.agentId, { voiceId }).catch(() => {});
  return { status: "READY", row: done, voiceName: config.voices.find((v) => v.id === voiceId)?.name ?? null, storageKey: stored, audio: result.audio };
}

/** Файл готовой озвучки: только владельцу и только пока не прошли сутки. */
export async function freeNarrationFilePath(id: string, agentId: string): Promise<string | null> {
  const row = await prisma.freeNarration.findUnique({ where: { id }, select: { agentId: true, status: true, storageKey: true } });
  return row && row.agentId === agentId && row.status === "READY" && row.storageKey ? localVideoFilePath(row.storageKey) : null;
}

/** Уборка (cron): файлы и тексты старше суток, зависшие генерации, брошенные ожидания. Расход остаётся. */
export async function purgeFreeNarrations(now = new Date()): Promise<{ files: number; stale: number; dropped: number }> {
  const old = new Date(now.getTime() - FREE_NARRATION_KEEP_MS);
  const withFiles = await prisma.freeNarration.findMany({ where: { storageKey: { not: null }, createdAt: { lt: old } }, select: { id: true, storageKey: true }, take: 500 });
  for (const r of withFiles) {
    if (r.storageKey && !await localVideoDelete(r.storageKey)) { void logSystemError("api", "Озвучка текста: старый файл не удалился", { dedupKey: "free-narration:purge" }); continue; }
    await prisma.freeNarration.update({ where: { id: r.id }, data: { storageKey: null, script: "" } });
  }
  await prisma.freeNarration.updateMany({ where: { createdAt: { lt: old }, status: { in: ["FAILED", "UNKNOWN"] }, script: { not: "" } }, data: { script: "" } });
  const stale = await prisma.freeNarration.updateMany({ where: { status: "GENERATING", generationStartedAt: { lt: new Date(now.getTime() - STALE_GENERATING_MS) } }, data: { status: "UNKNOWN", errorCode: "STALE_GENERATING" } });
  const dropped = await prisma.freeNarration.deleteMany({ where: { status: { in: ["AWAITING_TEXT", "AWAITING_VOICE"] }, createdAt: { lt: old } } });
  return { files: withFiles.length, stale: stale.count, dropped: dropped.count };
}
