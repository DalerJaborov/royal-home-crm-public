import { isReadOnlyRole, narrationModelSupportsTajik, type NarrationLang } from "@royal-home/shared";
import { loadAgentAccess } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { dushanbeStartOfToday } from "./dushanbeTime.js";
import { localVideoFilePath, localVideoUpload } from "./localVideoStorage.js";
import {
  budgetAllows, loadNarrationConfiguration, NARRATION_LISTEN_SOURCE, narrationProviderReady, narrationSoundKey, objectNarrationSpeech, synthesizeNarrationSpeech,
} from "./narrationGeneration.js";
import { narrationAutoEnabled } from "./narrationPlan.js";
import { NARRATION_QUOTA_EXCEEDED, narrationScriptError } from "./propertyNarration.js";
import { FREE_NARRATION_FOLDER } from "./freeNarration.js";
import { rememberNarrationChoice } from "./narrationLastChoice.js";
import { logSystemError } from "./systemError.js";

/**
 * «▶ ПРОСЛУШАТЬ» В МАСТЕРЕ ОБЪЕКТА (21.11.2026, владелец: «почему нельзя сразу слушать свой вариант прямо тут?»;
 * «разве недостаточно, что выбрали озвучку уже?»).
 *
 * Сотрудник слышит ровно тот звук, который получит монтажёр: текст объекта проходит те же проверки (длина, пустота,
 * цена только в сомони — narrationScriptError), числа словами (objectNarrationSpeech) и тот же синтез с громкостью
 * (synthesizeNarrationSpeech). Сохранил объект, не поменяв текст и голос, — версия встаёт готовой на этот файл и
 * одобренной им (narrationAutoFlow.ts::adoptListenedNarration): без второй генерации и второй оплаты.
 *
 * Деньги: строка FreeNarration (source LISTEN) — тот же общий дневной потолок озвучки под тем же замком, свой предел
 * на человека в сутки. Кэш: ключ запроса = сотрудник + отпечаток звука (narrationSoundKey: текст для голоса, язык,
 * голос, модель, настройки синтеза со словарём) — то же второй раз не оплачивается. Файл живёт сутки
 * (purgeFreeNarrations), версия объекта получает свою копию.
 */
/** Сколько раз в сутки один сотрудник может прослушать НОВЫЙ звук (повтор того же бесплатен). ОЦЕНКА: на объект
 *  уходит одно-три прослушивания, в день сотрудник заводит несколько объектов. */
export const NARRATION_LISTEN_PER_PERSON_DAILY = 30;
/** Генерация, не закончившаяся за это время, считается оборванной: можно попробовать снова. */
const LISTEN_STALE_MS = 3 * 60_000;

export function narrationListenKey(agentId: string, soundKey: string): string {
  return `listen:${agentId}:${soundKey}`;
}

export type NarrationListenOutcome =
  | { status: "READY"; id: string; cached: boolean }
  | { status: "NO_ACCESS" | "OFF" | "NOT_CONFIGURED" | "VOICE_UNKNOWN" | "TAJIK_MODEL" | "BUDGET" | "BUSY" }
  | { status: "INVALID"; error: string }
  | { status: "LIMIT_PERSON"; limit: number }
  | { status: "FAILED"; quota: boolean };

/** Права те же, что у озвучки своего текста: живая учётка, не «только просмотр», не монтажёр-редактор. */
async function canListen(agentId: string): Promise<boolean> {
  const access = await loadAgentAccess(agentId);
  return !!access?.isActive && !isReadOnlyRole(access.role) && access.role !== "EDITOR";
}

export async function listenNarration(input: { agentId: string; script: string; voiceId: string; lang: NarrationLang; now?: Date; fetcher?: typeof fetch }): Promise<NarrationListenOutcome> {
  if (!await canListen(input.agentId)) return { status: "NO_ACCESS" };
  const { config, key } = await loadNarrationConfiguration();
  // Прослушанное встаёт в версию только при автоозвучке: без неё версии из мастера нет, и платить незачем.
  if (!narrationAutoEnabled(config)) return { status: "OFF" };
  if (!key || !narrationProviderReady(config, key)) return { status: "NOT_CONFIGURED" };
  if (!config.voices.some((v) => v.id === input.voiceId)) return { status: "VOICE_UNKNOWN" };
  if (input.lang === "tg" && !narrationModelSupportsTajik(config.modelId)) return { status: "TAJIK_MODEL" };
  const script = input.script.trim();
  const error = narrationScriptError(script);
  if (error) return { status: "INVALID", error };
  const now = input.now ?? new Date();
  const requestKey = narrationListenKey(input.agentId, narrationSoundKey({ script, language: input.lang, voiceId: input.voiceId, config }));

  const existing = await prisma.freeNarration.findUnique({ where: { requestKey } });
  if (existing) {
    if (existing.status === "READY" && existing.storageKey && localVideoFilePath(existing.storageKey)) return { status: "READY", id: existing.id, cached: true };
    const running = existing.status === "GENERATING" && !!existing.generationStartedAt && now.getTime() - existing.generationStartedAt.getTime() < LISTEN_STALE_MS;
    if (running) return { status: "BUSY" };
    // Неудача, оборванная генерация или файл уже убран уборкой: ключ освобождается, строка (и её расход) остаются.
    await prisma.freeNarration.updateMany({ where: { id: existing.id, requestKey }, data: { requestKey: null } });
  }

  const speech = objectNarrationSpeech(script, input.lang);
  let claimed: "BUDGET" | "LIMIT_PERSON" | { id: string };
  try {
    claimed = await prisma.$transaction(async (tx) => {
      // Общий замок и потолок с озвучкой роликов: две генерации разом не проскочат мимо дневного предела.
      if (!await budgetAllows(tx, speech.length, config, now)) return "BUDGET" as const;
      const used = await tx.freeNarration.count({ where: { agentId: input.agentId, source: NARRATION_LISTEN_SOURCE, generationStartedAt: { gte: dushanbeStartOfToday(now) } } });
      if (used >= NARRATION_LISTEN_PER_PERSON_DAILY) return "LIMIT_PERSON" as const;
      return tx.freeNarration.create({ data: { agentId: input.agentId, source: NARRATION_LISTEN_SOURCE, status: "GENERATING", script, lang: input.lang,
        voiceId: input.voiceId, chars: speech.length, requestKey, generationStartedAt: now }, select: { id: true } });
    });
  } catch (err) {
    // Тот же звук в эту же секунду уже заказан вторым нажатием: второй оплаты нет, ждём первый.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { status: "BUSY" };
    throw err;
  }
  if (claimed === "BUDGET") return { status: "BUDGET" };
  if (claimed === "LIMIT_PERSON") return { status: "LIMIT_PERSON", limit: NARRATION_LISTEN_PER_PERSON_DAILY };

  const guard = { id: claimed.id, status: "GENERATING" };
  const result = await synthesizeNarrationSpeech({ speech, voiceId: input.voiceId, lang: input.lang, config, apiKey: key, label: "прослушивания в мастере" }, input.fetcher);
  if (result.status !== "READY") {
    await prisma.freeNarration.updateMany({ where: guard, data: { status: result.status, errorCode: result.errorCode } });
    const quota = result.errorCode === NARRATION_QUOTA_EXCEEDED;
    void logSystemError("api", `Прослушивание озвучки в мастере: ElevenLabs не выдал аудио (${result.errorCode})`, { dedupKey: `narration-listen:${result.errorCode}` });
    return { status: "FAILED", quota };
  }
  const storageKey = `${FREE_NARRATION_FOLDER}/${claimed.id}.mp3`;
  try {
    await localVideoUpload(storageKey, result.audio);
  } catch (err) {
    await prisma.freeNarration.updateMany({ where: guard, data: { status: "UNKNOWN", errorCode: "AUDIO_PERSISTENCE_FAILED", providerRequestId: result.requestId } });
    void logSystemError("api", `Прослушивание озвучки в мастере: файл не сохранён: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "narration-listen:persist" });
    return { status: "FAILED", quota: false };
  }
  await prisma.freeNarration.updateMany({ where: guard, data: { status: "READY", storageKey, providerRequestId: result.requestId, errorCode: null } });
  await rememberNarrationChoice(input.agentId, { voiceId: input.voiceId }).catch(() => {});
  return { status: "READY", id: claimed.id, cached: false };
}

/** Файл прослушивания: только тому, кто слушал, и пока не прошли сутки. */
export async function narrationListenFilePath(id: string, agentId: string): Promise<string | null> {
  const row = await prisma.freeNarration.findUnique({ where: { id }, select: { agentId: true, source: true, status: true, storageKey: true } });
  return row && row.agentId === agentId && row.source === NARRATION_LISTEN_SOURCE && row.status === "READY" && row.storageKey ? localVideoFilePath(row.storageKey) : null;
}
