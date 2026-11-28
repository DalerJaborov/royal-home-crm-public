import { narrationMixByCrm } from "@royal-home/shared";
import { prisma } from "../db.js";
import { loadNarrationConfiguration, narrationQuotaExceededSince } from "./narrationGeneration.js";
import { crmWillPrepareFirstNarration } from "./narrationPlan.js";
import { mediaExecutionMode } from "./mediaExecution.js";
import { narrationCurrencyError } from "@royal-home/shared";
import { narrationFactsCurrent } from "./propertyNarration.js";
import { currentMontajerTexts, type MontajerNarrationNote, type MontajerTexts } from "./montajerTexts.js";

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
export const VOICELESS_COPY_HINT = "При сдаче пришлите два файла: готовый ролик и тот же ролик без голоса (музыка и звуки остаются), тогда смену цены CRM сделает сама.";
/** Тот же текст с длинным тире (до 28.11.2026): в подписях передач, поставленных раньше, он лежит именно так. */
export const VOICELESS_COPY_HINT_BEFORE_28_11 = "При сдаче пришлите два файла: готовый ролик и тот же ролик без голоса (музыка и звуки остаются) — тогда смену цены CRM сделает сама.";

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

/** Хвост итогового «отправлено N из N»: голос — следующим сообщением (оно и правда следующее), или null.
 *  Слова — lib/montajerTexts.ts (короткий режим: «Голос придёт следом.»). */
export async function narrationNextMessageLine(propertyId: string, texts?: MontajerTexts): Promise<string | null> {
  if (!(await narrationFollowsVideoNow(propertyId))) return null;
  const [{ config }, t] = await Promise.all([loadNarrationConfiguration(), texts ? Promise.resolve(texts) : currentMontajerTexts()]);
  return t.voiceNextLine(narrationMixByCrm(config), voicelessCopyHint());
}

/** Строка про голос в задании словами текущего режима (lib/montajerTexts.ts); null — строка не нужна. */
export async function narrationLineForMontajer(propertyId: string, texts?: MontajerTexts): Promise<string | null> {
  const [note, t] = await Promise.all([narrationNoteForMontajer(propertyId), texts ? Promise.resolve(texts) : currentMontajerTexts()]);
  return note ? t.narrationLine(note, voicelessCopyHint()) : null;
}

/** Состояние голоса объекта для строки задания (слова — lib/montajerTexts.ts). null — озвучки нет и не будет. */
export async function narrationNoteForMontajer(propertyId: string): Promise<MontajerNarrationNote | null> {
  const [p, latest, { config, key }] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId }, select: { narrationOff: true, videoMasterStorageKey: true } }),
    prisma.propertyNarrationVersion.findFirst({ where: { propertyId }, orderBy: { revision: "desc" }, select: { status: true, approvedAt: true, source: true, approveAsId: true, editorDelayNotifiedAt: true } }),
    loadNarrationConfiguration(),
  ]);
  if (!p) return null;
  if (p.narrationOff) return "off";
  if (narrationMixByCrm(config)) return latest || p.videoMasterStorageKey ? "mix" : null;
  if (!latest) return (await crmWillPrepareFirstNarration(propertyId, config, key)) ? "preparing" : null;
  // Старая ручная озвучка маркетинга (до автоозвучки): сама она монтажёру не уходит — mp3 не обещаем
  // (ревью 12.11.2026). Если маркетинг передаст её кнопкой, она придёт отдельным сообщением.
  if ((latest.source ?? "MANUAL") === "MANUAL") return "manual";
  // Одобренный голос уходит СЛЕДОМ за файлами этой же выдачи (21.11.2026, объект №211: голос раньше видео терялся) —
  // при каждой выдаче заново, старый файл искать не нужно (videoHandoff.ts → narrationAutoFlow.ts::narrationAfterVideoIssued).
  // «follows» — уйдёт сразу после файлов; уйдёт не сейчас (отправка выключена, цену поменяли — будет новая
  // версия, в тексте доллары) — обещаем только «как будет готова» (ревью 21.11).
  if (latest.status === "READY" && latest.approvedAt) {
    return (await narrationFollowsVideoNow(propertyId)) ? "follows" : "later";
  }
  if (["DRAFT", "GENERATING", "READY"].includes(latest.status) && (await narrationQuotaExceededSince())) {
    // Монтажёр уже получил «голос задерживается» отдельным сообщением (narrationAutoFlow.ts::notifyEditorNarrationDelayed).
    return latest.editorDelayNotifiedAt ? "delayedNotified" : "delayed";
  }
  // Одобрена уже при сохранении (21.11.2026, approveAsId): ждать некого, только пока готовится звук.
  if (["DRAFT", "GENERATING", "READY"].includes(latest.status) && latest.approveAsId) return "preparing";
  if (["DRAFT", "GENERATING", "READY"].includes(latest.status)) return "awaitingApproval";
  return null;
}
