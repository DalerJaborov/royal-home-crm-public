import { narrationMixByCrm } from "@royal-home/shared";
import { prisma } from "../db.js";
import { loadNarrationConfiguration, narrationQuotaExceededSince } from "./narrationGeneration.js";

/**
 * ОДНА СТРОКА ОБ ОЗВУЧКЕ В ЗАДАНИИ МОНТАЖЁРУ (12.11.2026). Задание на монтаж и перемонтаж
 * (lib/videoHandoff.ts::buildMontajerMessageText) берёт её только отсюда, чтобы монтажёр
 * всегда знал, что делать с голосом:
 *  - «Без озвучки» — голос не нужен;
 *  - голос накладывает CRM (рубильник mixByCrm) — прислать ролик без голоса;
 *  - озвучка одобрена или придёт — вклеить mp3 самому и сдать ДВА файла (готовый и без голоса);
 *  - кончились кредиты ElevenLabs — «озвучка задерживается».
 * null — озвучки у объекта нет и не будет (автоозвучка выключена), строка не нужна.
 */
export const VOICELESS_COPY_HINT = "При сдаче пришлите два файла: готовый ролик и тот же ролик без голоса (музыка и звуки остаются) — тогда смену цены CRM сделает сама.";

export async function narrationLineForMontajer(propertyId: string): Promise<string | null> {
  const [p, latest, { config }] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId }, select: { narrationOff: true, videoMasterStorageKey: true } }),
    prisma.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" }, select: { status: true, approvedAt: true, source: true } }),
    loadNarrationConfiguration(),
  ]);
  if (!p) return null;
  if (p.narrationOff) return "🔇 Без озвучки: голос в ролик не нужен.";
  if (narrationMixByCrm(config)) {
    return latest || p.videoMasterStorageKey ? "🎙 Озвучку накладывает CRM: пришлите ролик БЕЗ голоса (музыка и звуки можно)." : null;
  }
  if (!latest) return config.autoGenerate === true ? `🎙 Озвучка готовится, придёт сюда отдельным mp3 — вклейте её. ${VOICELESS_COPY_HINT}` : null;
  if (latest.status === "READY" && latest.approvedAt) return `🎙 Озвучка одобрена и придёт (или уже пришла) отдельным mp3 — вклейте её сами. ${VOICELESS_COPY_HINT}`;
  if (["DRAFT", "GENERATING", "READY"].includes(latest.status) && (await narrationQuotaExceededSince())) {
    return "🎙 Озвучка задерживается: сервис озвучки на паузе. Придёт сюда отдельным mp3, как только будет готова.";
  }
  if (["DRAFT", "GENERATING", "READY"].includes(latest.status)) {
    return `🎙 Озвучка ждёт одобрения и придёт сюда отдельным mp3 — вклейте её. ${VOICELESS_COPY_HINT}`;
  }
  return null;
}
