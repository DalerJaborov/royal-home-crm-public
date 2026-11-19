import { narrationMixByCrm } from "@royal-home/shared";
import { prisma } from "../db.js";
import { loadNarrationConfiguration, narrationQuotaExceededSince } from "./narrationGeneration.js";

/**
 * ОДНА СТРОКА ОБ ОЗВУЧКЕ В ЗАДАНИИ МОНТАЖЁРУ (12.11.2026). Задание на монтаж и перемонтаж
 * (lib/videoHandoff.ts::buildMontajerMessageText) берёт её только отсюда, чтобы монтажёр
 * всегда знал, что делать с голосом:
 *  - «Без озвучки» — голос не нужен;
 *  - голос накладывает CRM (рубильник mixByCrm) — прислать ролик без голоса;
 *  - озвучка одобрена или придёт — вклеить mp3 самому и сдать ОДИН готовый ролик;
 *  - кончились кредиты ElevenLabs — «озвучка задерживается».
 * null — озвучки у объекта нет и не будет (автоозвучка выключена), строка не нужна.
 */
/** Прежняя просьба о втором файле. Сейчас не отправляется (askMontajerForVoicelessCopy); текст нужен, чтобы
 *  вырезать его из подписи передач, поставленных до 19.11.2026 (lib/narrationDelivery.ts). */
export const VOICELESS_COPY_HINT = "При сдаче пришлите два файла: готовый ролик и тот же ролик без голоса (музыка и звуки остаются) — тогда смену цены CRM сделает сама.";

/**
 * ПРОСИМ ЛИ МОНТАЖЁРА О ВТОРОМ ФАЙЛЕ «БЕЗ ГОЛОСА» — ОДНО РЕШЕНИЕ. Нет: монтажёр сдаёт ОДИН готовый файл
 * (решение владельца 16.11.2026, подтверждено 19.11.2026: «мы же убрали это нет? Сможешь максимум все
 * упрощать?»). Отсюда берут ответ все просьбы: строка задания, подпись к mp3, возврат «замените голос» и
 * просьба вдогонку после сдачи (lib/narrationVoicelessCopy.ts::voicelessCopyAsk). Приём такого файла, если
 * монтажёр пришлёт его сам, и перемикс из уже имеющегося — работают, как работали.
 * Режим «голос кладёт CRM» (mixByCrm) — отдельный рубильник со своими словами, этим решением не трогается.
 */
export function askMontajerForVoicelessCopy(): boolean {
  return false;
}

/** Хвост просьбы о втором файле к строкам монтажёру; пусто, пока просьба выключена. */
export function voicelessCopyHint(): string {
  return askMontajerForVoicelessCopy() ? ` ${VOICELESS_COPY_HINT}` : "";
}

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
  if (!latest) return config.autoGenerate === true ? `🎙 Озвучка готовится, придёт сюда отдельным mp3 — вклейте её.${voicelessCopyHint()}` : null;
  // Старая ручная озвучка маркетинга (до автоозвучки): сама она монтажёру не уходит — mp3 не обещаем
  // (ревью 12.11.2026). Если маркетинг передаст её кнопкой, она придёт отдельным сообщением.
  if ((latest.source ?? "MANUAL") === "MANUAL") return "🎙 Озвучку этого объекта ведёт маркетинг вручную: сама она сюда не придёт. Нужна — спросите маркетинг.";
  if (latest.status === "READY" && latest.approvedAt) return `🎙 Озвучка одобрена и придёт (или уже пришла) отдельным mp3 — вклейте её сами.${voicelessCopyHint()}`;
  if (["DRAFT", "GENERATING", "READY"].includes(latest.status) && (await narrationQuotaExceededSince())) {
    return "🎙 Озвучка задерживается: сервис озвучки на паузе. Придёт сюда отдельным mp3, как только будет готова.";
  }
  if (["DRAFT", "GENERATING", "READY"].includes(latest.status)) {
    return `🎙 Озвучка ждёт одобрения и придёт сюда отдельным mp3 — вклейте её.${voicelessCopyHint()}`;
  }
  return null;
}
