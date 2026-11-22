import { narrationMixByCrm } from "@royal-home/shared";
import { prisma } from "../db.js";
import { loadNarrationConfiguration, narrationQuotaExceededSince } from "./narrationGeneration.js";
import { crmWillPrepareFirstNarration } from "./narrationPlan.js";
import { mediaExecutionMode } from "./mediaExecution.js";
import { narrationCurrencyError } from "@royal-home/shared";
import { narrationFactsCurrent } from "./propertyNarration.js";

/**
 * ОДНА СТРОКА ОБ ОЗВУЧКЕ В ЗАДАНИИ МОНТАЖЁРУ (12.11.2026). Задание на монтаж и перемонтаж
 * (lib/videoHandoff.ts::buildMontajerMessageText) берёт её только отсюда, чтобы монтажёр
 * всегда знал, что делать с голосом:
 *  - «Без озвучки» — голос не нужен;
 *  - голос накладывает CRM (рубильник mixByCrm) — прислать ролик без голоса;
 *  - озвучка одобрена или придёт — вклеить mp3 самому и сдать ОДИН готовый ролик;
 *  - кончились кредиты ElevenLabs — «озвучка задерживается».
 * null — озвучки у объекта нет и не будет, строка не нужна. «Готовится» пишем, только когда CRM правда подготовит её этому
 * объекту (lib/narrationPlan.ts::crmWillPrepareFirstNarration — те же условия, что у обхода озвучки; 20.11.2026: объект, заведённый
 * давно и ушедший на перемонтаж, получал «готовится» при выключенном проходе по очереди монтажа).
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

/**
 * УЙДЁТ ЛИ ГОЛОС СРАЗУ ЗА ФАЙЛАМИ ЭТОЙ ВЫДАЧИ (ревью 21.11.2026) — одно правило для строки задания и для
 * «следующим сообщением» под файлами. Ровно условия, при которых крючок выдачи видео поставит передачу
 * (narrationAutoFlow.ts::narrationAfterVideoIssued → narrationDelivery.ts::prepareNarrationDeliveryPlan):
 * отправка голоса включена, у объекта не «Без озвучки», последняя версия не ручная маркетинга, готова и одобрена,
 * факты объекта с ней совпадают (цену поменяли — будет новая версия) и цена в тексте не в долларах.
 */
export async function narrationFollowsVideoNow(propertyId: string): Promise<boolean> {
  if (mediaExecutionMode("NARRATION") !== "LIVE") return false;
  const [p, latest] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId }, include: { district: true } }),
    prisma.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" } }),
  ]);
  if (!p || p.deletedAt || p.narrationOff || !latest || (latest.source ?? "MANUAL") === "MANUAL") return false;
  if (latest.status !== "READY" || !latest.approvedAt || !latest.storageKey) return false;
  return narrationFactsCurrent(latest, p) && !narrationCurrencyError(latest.script);
}

/** Хвост итогового «отправлено N из N»: голос — следующим сообщением (оно и правда следующее), или null. */
export async function narrationNextMessageLine(propertyId: string): Promise<string | null> {
  if (!(await narrationFollowsVideoNow(propertyId))) return null;
  const { config } = await loadNarrationConfiguration();
  return narrationMixByCrm(config) ? "🎙 Озвучка — следующим сообщением: под неё длина и темп." : `🎙 Озвучка — следующим сообщением, вклейте её сами.${voicelessCopyHint()}`;
}

export async function narrationLineForMontajer(propertyId: string): Promise<string | null> {
  const [p, latest, { config, key }] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId }, select: { narrationOff: true, videoMasterStorageKey: true } }),
    prisma.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" }, select: { status: true, approvedAt: true, source: true, approveAsId: true } }),
    loadNarrationConfiguration(),
  ]);
  if (!p) return null;
  if (p.narrationOff) return "🔇 Без озвучки: голос в ролик не нужен.";
  if (narrationMixByCrm(config)) {
    return latest || p.videoMasterStorageKey ? "🎙 Озвучку накладывает CRM: пришлите ролик БЕЗ голоса (музыка и звуки можно)." : null;
  }
  if (!latest) return await crmWillPrepareFirstNarration(propertyId, config, key) ? `🎙 Озвучка готовится и придёт сюда, как будет готова, — вклейте её сами.${voicelessCopyHint()}` : null;
  // Старая ручная озвучка маркетинга (до автоозвучки): сама она монтажёру не уходит — mp3 не обещаем
  // (ревью 12.11.2026). Если маркетинг передаст её кнопкой, она придёт отдельным сообщением.
  if ((latest.source ?? "MANUAL") === "MANUAL") return "🎙 Озвучку этого объекта ведёт маркетинг вручную: сама она сюда не придёт. Нужна — спросите маркетинг.";
  // Одобренный голос уходит СЛЕДОМ за файлами этой же выдачи (21.11.2026, объект №211: голос раньше видео терялся) —
  // при каждой выдаче заново, старый файл искать не нужно (videoHandoff.ts → narrationAutoFlow.ts::narrationAfterVideoIssued).
  // Строка стоит в подписи ПЕРВОГО файла, поэтому здесь «сразу после файлов»; «следующим сообщением» — под итоговым
  // «отправлено N из N» (narrationNextMessageLine). Уйдёт не сейчас (отправка выключена, цену поменяли — будет новая
  // версия, в тексте доллары) — обещаем только «как будет готова» (ревью 21.11).
  if (latest.status === "READY" && latest.approvedAt) {
    return await narrationFollowsVideoNow(propertyId)
      ? `🎙 Озвучка одобрена: mp3 придёт сразу после файлов ролика — вклейте её сами.${voicelessCopyHint()}`
      : `🎙 Озвучка придёт сюда, как будет готова, — вклейте её сами.${voicelessCopyHint()}`;
  }
  if (["DRAFT", "GENERATING", "READY"].includes(latest.status) && (await narrationQuotaExceededSince())) {
    return "🎙 Озвучка задерживается: сервис озвучки на паузе. Придёт сюда, как будет готова.";
  }
  // Одобрена уже при сохранении (21.11.2026, approveAsId): ждать некого, только пока готовится звук.
  if (["DRAFT", "GENERATING", "READY"].includes(latest.status) && latest.approveAsId) {
    return `🎙 Озвучка готовится и придёт сюда, как будет готова, — вклейте её сами.${voicelessCopyHint()}`;
  }
  if (["DRAFT", "GENERATING", "READY"].includes(latest.status)) {
    return `🎙 Озвучка ждёт одобрения и придёт сюда, как будет готова, — вклейте её сами.${voicelessCopyHint()}`;
  }
  return null;
}
