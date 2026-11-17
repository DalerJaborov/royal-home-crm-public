import crypto from "node:crypto";
import fs from "node:fs";
import { narrationConfigSchema, narrationMixByCrm } from "@royal-home/shared";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { probeMediaInfo } from "./ffmpeg.js";
import { dropNarrationMaster, storeNarrationMaster } from "./narrationMaster.js";
import { videoHandoffFinalDiskPath } from "./videoHandoff.js";
import { declaredObjectNumber } from "../telegram/montajerFileNumber.js";

/**
 * ТОТ ЖЕ РОЛИК БЕЗ ГОЛОСА ОТ МОНТАЖЁРА (12.11.2026, решение владельца). Монтажёр сам вклеивает
 * одобренную озвучку (музыка и громкость его), а к готовому ролику присылает ещё один экспорт —
 * тот же ролик без голоса. CRM хранит его мастером (Property.videoMasterStorageKey) с версией
 * озвучки, которая звучит в вышедшем ролике; поменялась цена — новая озвучка накладывается из
 * мастера сама (lib/narrationAutoFlow.ts::remixFromMaster), музыка не трогается.
 *
 * Второй файл не задерживает выпуск: бот просит его ОДИН раз, в квитанции о готовом ролике,
 * кнопками «Пришлю без голоса» / «Не сейчас». Узнаёт файл кнопкой (вопрос живёт час) или по
 * подписи «без голоса 123». Защита от путаницы: длина должна совпасть с готовым роликом, а
 * сам файл — отличаться от него; файл после кнопки, который не подошёл, принимается как обычный
 * готовый ролик, а не теряется.
 */
export const VOICELESS_DIALOG_KIND = "montajer_voiceless";
export const VOICELESS_DIALOG_TTL_MS = 60 * 60_000;
/** Расхождение длины, при котором это уже другой ролик, а не тот же без голоса. */
const DURATION_TOLERANCE_SEC = 1.5;
const LABEL = /без\s*(?:голоса|озвучки)|bez[\s_-]*golosa|no[\s_-]*voice|(?:^|[\s_.-])nv(?=[\s_.-]|$)/iu;

export function isVoicelessCopyLabel(filename: string | null | undefined, caption: string | null | undefined): boolean {
  return LABEL.test(filename ?? "") || LABEL.test(caption ?? "");
}

/** Голос в вышедшем ролике — от этой передачи монтажёру (последняя отправленная, где он вклеивал сам). */
async function editorVoicedDelivery(propertyId: string): Promise<{ versionId: string } | null> {
  const rows = await prisma.propertyNarrationDelivery.findMany({ where: { propertyId, status: "SENT" }, orderBy: { deliveredAt: "desc" }, take: 20, select: { versionId: true, plan: true } });
  const row = rows.find((d) => !(d.plan && typeof d.plan === "object" && !Array.isArray(d.plan) && (d.plan as Record<string, unknown>).mixByCrm === true));
  return row ? { versionId: row.versionId } : null;
}

async function crmMixesFirstVoice(): Promise<boolean> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { propertyNarrationConfig: true } });
  const parsed = narrationConfigSchema.safeParse(settings?.propertyNarrationConfig ?? {});
  return parsed.success && narrationMixByCrm(parsed.data);
}

export type VoicelessAsk = { text: string; buttons: Array<Array<{ text: string; callback_data: string }>> };
/** Просьба в квитанции о готовом ролике — один раз на принятый ролик; null — просить нечего. */
export async function voicelessCopyAsk(propertyId: string, now = new Date()): Promise<VoicelessAsk | null> {
  if (await crmMixesFirstVoice()) return null;
  const p = await prisma.property.findUnique({ where: { id: propertyId }, select: { shortId: true, deletedAt: true, narrationOff: true, videoHandoffStatus: true, videoMasterStorageKey: true } });
  if (!p || p.deletedAt || p.narrationOff || p.videoHandoffStatus !== "RECEIVED" || p.videoMasterStorageKey) return null;
  if (!(await editorVoicedDelivery(propertyId))) return null;
  await prisma.property.update({ where: { id: propertyId }, data: { videoMasterRequestedAt: now } });
  return {
    text: `И ещё одна просьба: пришлите тот же ролик №${p.shortId} без голоса (музыка и звуки остаются). Тогда при смене цены CRM сама поменяет голос, музыку не тронет. Выпуск ролика это не задерживает.`,
    buttons: [[{ text: "🎵 Пришлю без голоса", callback_data: `mj:nv:${p.shortId}` }, { text: "Не сейчас", callback_data: `mj:nvx:${p.shortId}` }]],
  };
}

/** choice — монтажёр сам подтвердил кнопкой «это версия без голоса» после несовпавшей длины. */
export type VoicelessTarget = { propertyId: string; shortId: number; via: "button" | "label" | "choice" };
/** Это файл «без голоса»? По кнопке (вопрос живёт час) или по подписи. null — обычный готовый ролик. */
export async function voicelessCopyTarget(input: { chatId: string; agentId: string; filename: string; caption: string | null }, now = new Date()): Promise<VoicelessTarget | null> {
  const declared = declaredObjectNumber(input.filename, input.caption);
  const state = await prisma.telegramDialogState.findUnique({ where: { chatId: input.chatId } });
  if (state?.kind === VOICELESS_DIALOG_KIND && state.agentId === input.agentId && state.expiresAt > now) {
    const payload = state.payload as { propertyId?: string; shortId?: number } | null;
    // Номер другого объекта в имени файла — это не «без голоса», а готовый ролик того объекта.
    if (payload?.propertyId && payload.shortId && (declared == null || declared === payload.shortId)) {
      return { propertyId: payload.propertyId, shortId: payload.shortId, via: "button" };
    }
  }
  if (!isVoicelessCopyLabel(input.filename, input.caption)) return null;
  if (declared != null) {
    const p = await prisma.property.findFirst({ where: { shortId: declared, deletedAt: null }, select: { id: true, shortId: true } });
    return p ? { propertyId: p.id, shortId: p.shortId, via: "label" } : null;
  }
  const asked = await prisma.property.findFirst({
    where: { deletedAt: null, videoMasterStorageKey: null, videoMasterRequestedAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } },
    orderBy: { videoMasterRequestedAt: "desc" }, select: { id: true, shortId: true },
  });
  return asked ? { propertyId: asked.id, shortId: asked.shortId, via: "label" } : null;
}

export async function rememberVoicelessQuestion(chatId: string, agentId: string, propertyId: string, shortId: number, now = new Date()): Promise<void> {
  const data = { agentId, kind: VOICELESS_DIALOG_KIND, payload: { propertyId, shortId } as Prisma.InputJsonValue, expiresAt: new Date(now.getTime() + VOICELESS_DIALOG_TTL_MS) };
  await prisma.telegramDialogState.upsert({ where: { chatId }, create: { chatId, ...data }, update: data });
}
export async function forgetVoicelessQuestion(chatId: string): Promise<void> {
  await prisma.telegramDialogState.deleteMany({ where: { chatId, kind: VOICELESS_DIALOG_KIND } });
}

async function md5(filePath: string): Promise<string | null> {
  try {
    const hash = crypto.createHash("md5");
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/** MISMATCH — файл по длине или содержимому не «тот же без голоса»: вызывающий решает, принять ли его обычным роликом. */
export type VoicelessStoreResult = { ok: true; shortId: number } | { ok: false; code: "MISMATCH" | "REFUSED"; error: string };
export async function storeVoicelessCopy(propertyId: string, filePath: string, opts: { ignoreDuration?: boolean } = {}): Promise<VoicelessStoreResult> {
  const p = await prisma.property.findUnique({ where: { id: propertyId }, select: { shortId: true, deletedAt: true, narrationOff: true, videoHandoffStatus: true, videoHandoffFinalPath: true, videoMasterStorageKey: true } });
  if (!p || p.deletedAt) return { ok: false, code: "REFUSED", error: "Объект удалён — ролик без голоса не нужен." };
  if (p.narrationOff) return { ok: false, code: "REFUSED", error: `Для №${p.shortId} выбрано «Без озвучки» — ролик без голоса не нужен.` };
  if (p.videoHandoffStatus !== "RECEIVED" || !p.videoHandoffFinalPath) return { ok: false, code: "MISMATCH", error: `Сначала пришлите готовый ролик №${p.shortId} с голосом, потом тот же без голоса.` };
  const delivery = await editorVoicedDelivery(propertyId);
  if (!delivery) return { ok: false, code: "REFUSED", error: `К №${p.shortId} озвучку не отправляли — ролик без голоса не нужен.` };
  const incoming = await probeMediaInfo(filePath);
  if (!incoming?.hasVideo) return { ok: false, code: "MISMATCH", error: "Файл не читается как видео." };
  const finalDisk = videoHandoffFinalDiskPath(p.videoHandoffFinalPath);
  const final = finalDisk && fs.existsSync(finalDisk) ? await probeMediaInfo(finalDisk) : null;
  if (!opts.ignoreDuration && final && final.durationSec > 0 && incoming.durationSec > 0 && Math.abs(final.durationSec - incoming.durationSec) > DURATION_TOLERANCE_SEC) {
    return { ok: false, code: "MISMATCH", error: `Ролик без голоса по длине (${incoming.durationSec.toFixed(1)} с) не совпадает с готовым (${final.durationSec.toFixed(1)} с). Пришлите тот же ролик, только без голоса.` };
  }
  if (finalDisk && fs.existsSync(finalDisk) && (await md5(finalDisk)) === (await md5(filePath))) {
    return { ok: false, code: "REFUSED", error: "Это тот же файл, что готовый ролик. Пришлите версию без голоса (музыка и звуки остаются)." };
  }
  const key = await storeNarrationMaster(propertyId, filePath);
  const written = await prisma.property.updateMany({
    where: { id: propertyId, deletedAt: null, videoHandoffStatus: "RECEIVED", videoHandoffFinalPath: p.videoHandoffFinalPath },
    data: { videoMasterStorageKey: key, videoMasterNarrationVersionId: delivery.versionId, videoMasterMixError: null, videoMasterMixErrorVersionId: null },
  });
  if (!written.count) {
    await dropNarrationMaster(key);
    return { ok: false, code: "REFUSED", error: `Готовый ролик №${p.shortId} только что поменялся — пришлите ролик без голоса к новому.` };
  }
  if (p.videoMasterStorageKey && p.videoMasterStorageKey !== key) await dropNarrationMaster(p.videoMasterStorageKey);
  return { ok: true, shortId: p.shortId };
}
