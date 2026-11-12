import { prisma } from "../db.js";
import { openForManualFinalVideo } from "./publishedVideoFix.js";
import { closeManualFinalVideoWait, notifyMontajerFinalUploadedManually, type ReceiveEditedVideoResult } from "./videoHandoff.js";

/**
 * ГОТОВЫЙ РОЛИК ОТ СОТРУДНИКА — ОДНА ДВЕРЬ (вынесено 12.11.2026 из routes/properties/videos.ts).
 * Загрузка готового ролика из карточки CRM и ролик, присланный СММщиком или другим сотрудником
 * в Telegram с кнопкой «Готов к выпуску» (telegram/staffClip.ts), идут одним путём: открыть
 * приём, если объект его не ждёт (openForManualFinalVideo), принять файл тем же приёмником, что
 * у монтажёра (проверка ролика, модерация, слот публикации во всех сетях), при отказе закрыть
 * открытое ожидание, а монтажёру, который держал объект, сказать «готов, доделывать не нужно».
 * Права проверяет вызывающий; `reopenDenied` — его текст отказа на открытие приёма.
 */
export type FinalVideoIntakeProperty = { id: string; shortId: number; videoHandoffStatus: string | null; videoHandoffManualSince: Date | null };
export type FinalVideoIntakeOutcome =
  | { ok: true; result: Extract<ReceiveEditedVideoResult, { ok: true }> }
  | { ok: false; error: string };

export async function acceptFinalVideoFromStaff(input: {
  property: FinalVideoIntakeProperty;
  actorIsEditor: boolean;
  reopenDenied: string | null;
  receive: () => Promise<ReceiveEditedVideoResult>;
  onOpened?: () => void;
}): Promise<FinalVideoIntakeOutcome> {
  const { property } = input;
  if (property.videoHandoffStatus !== "SENT_TO_EDITOR") {
    if (input.reopenDenied) return { ok: false, error: input.reopenDenied };
    const opened = await openForManualFinalVideo(property.id);
    if (!opened.ok) return { ok: false, error: opened.error ?? "Не получилось открыть приём ролика." };
    input.onOpened?.();
  }
  // Объект действительно держал монтажёр (не ручное ожидание) — запомним до приёма.
  const heldByMontajer = property.videoHandoffStatus === "SENT_TO_EDITOR" && !property.videoHandoffManualSince;
  const result = await input.receive();
  if (!result.ok) {
    // Отказ приёма не отменяет уже принятый прежний ролик (24.09.2026).
    await closeManualFinalVideoWait(property.id);
    return { ok: false, error: result.error };
  }
  // Загрузил сотрудник, а не сам монтажёр: монтажёр получает «готов, доделывать не нужно».
  if (heldByMontajer && !input.actorIsEditor) {
    void notifyMontajerFinalUploadedManually(property.id, property.shortId).catch((err) =>
      console.error("[video-handoff] уведомление монтажёру о ручной загрузке:", err)
    );
  }
  return { ok: true, result };
}

/**
 * Загрузил модератор роликов (не монтажёр) — проверка ему не нужна: ролик принимается сразу
 * одобренным на его имя (26.10.2026). Одно правило для карточки CRM и Telegram.
 */
export async function selfApprovedClipOptsFor(agent: { id: string; role: string; canModerate: boolean } | null | undefined): Promise<{ approvedById?: string }> {
  if (!agent || agent.role === "EDITOR" || !agent.canModerate) return {};
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } });
  return settings?.videoMontajerAgentId === agent.id ? {} : { approvedById: agent.id };
}
