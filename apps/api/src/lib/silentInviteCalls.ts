import { prisma } from "../db.js";
import { isDialableTajikNumber } from "@royal-home/shared";
import { AUDIO_DEAD_REASON, enqueueInterviewInviteCallTx } from "./interviewInviteCall.js";
import { alignToCallHours } from "./postShowingCall.js";

/**
 * НЕМЫЕ ЗВОНКИ КАНДИДАТАМ (28.09–03.10.2026).
 *
 * С вечера 28.09 канал звука между станцией и сервером CRM был мёртв: робот
 * «звонил» кандидату с приглашением, а кандидат слышал тишину. Такие звонки
 * легли как «не дозвонились» (робот тоже ничего не слышал) или «ответ
 * непонятен», и правило «один звонок» (владелец 01.10.2026) не даёт роботу
 * позвонить снова — хотя разговора не было.
 *
 * Здесь — найти такие звонки и, по слову владельца, поставить кандидату новый.
 * Старая строка помечается AUDIO_DEAD_REASON: защита «один звонок» её больше не
 * считает (interviewInviteCall.ts, countsAsCall). Запускается разовым скриптом
 * scripts/recall-silent-invite-calls.ts; без --apply не пишет ничего.
 */

/** Немой период по часам сервера (UTC): 28.09 22:58 — 03.10 00:20 по Душанбе. */
export const SILENT_WINDOW = {
  from: new Date("2026-09-28T17:58:00Z"),
  to: new Date("2026-10-02T19:20:00Z"),
};

/** Ближе этого к собеседованию перезванивать не стоит — как TOO_LATE_MS у робота. */
const TOO_LATE_MS = 60 * 60 * 1000;

export interface SilentInviteCall {
  callId: string;
  jobApplicationId: string;
  name: string;
  interviewAt: Date;
  /** Как звонок записан сейчас: «не дозвонились» или «ответ непонятен». */
  was: "no_answer" | "unclear";
}

/**
 * Звонки из немого периода, после которых кандидату стоит позвонить снова:
 * разговора не было, анкета всё ещё на «Собеседовании» с тем же временем,
 * собеседование впереди, номер набираемый и после этого звонка HR нового не
 * ставил.
 */
export async function findSilentInviteCalls(now: Date = new Date()): Promise<SilentInviteCall[]> {
  const rows = await prisma.interviewInviteCall.findMany({
    where: {
      lastAttemptAt: { gte: SILENT_WINDOW.from, lte: SILENT_WINDOW.to },
      OR: [
        { status: "GIVEN_UP", skipReason: { in: ["no_answer", "robot_failed"] } },
        { status: "DONE", outcome: "UNCLEAR" },
      ],
    },
    orderBy: { interviewAt: "asc" },
    take: 500,
    select: {
      id: true,
      jobApplicationId: true,
      interviewAt: true,
      status: true,
      createdAt: true,
      jobApplication: { select: { name: true, contactName: true, phone: true, status: true, interviewAt: true } },
    },
  });
  if (rows.length === 0) return [];
  // Новее этого звонка у анкеты что-то есть — HR уже распорядился сам.
  const newer = await prisma.interviewInviteCall.findMany({
    where: { jobApplicationId: { in: rows.map((r) => r.jobApplicationId) } },
    select: { id: true, jobApplicationId: true, createdAt: true },
  });
  const earliestCallable = alignToCallHours(now, null).getTime() + TOO_LATE_MS;
  const out: SilentInviteCall[] = [];
  for (const row of rows) {
    const app = row.jobApplication;
    if (app.status !== "INTERVIEW" || app.interviewAt?.getTime() !== row.interviewAt.getTime()) continue;
    if (row.interviewAt.getTime() < earliestCallable) continue;
    if (!app.phone || !isDialableTajikNumber(app.phone)) continue;
    if (newer.some((n) => n.jobApplicationId === row.jobApplicationId && n.id !== row.id && n.createdAt > row.createdAt)) {
      continue;
    }
    out.push({
      callId: row.id,
      jobApplicationId: row.jobApplicationId,
      name: app.name ?? app.contactName ?? app.phone,
      interviewAt: row.interviewAt,
      was: row.status === "DONE" ? "unclear" : "no_answer",
    });
  }
  return out;
}

/**
 * Пометить немые звонки и поставить кандидатам новые — каждую анкету своей
 * транзакцией: сбой на одной не оставляет другую полупомеченной. Повторный
 * запуск безопасен: помеченная строка в выборку больше не попадает (у неё уже
 * есть звонок новее).
 */
export async function recallSilentInviteCalls(calls: SilentInviteCall[], now: Date = new Date()): Promise<number> {
  let queued = 0;
  for (const call of calls) {
    await prisma.$transaction(async (tx) => {
      const marked = await tx.interviewInviteCall.updateMany({
        where: { id: call.callId, skipReason: { not: AUDIO_DEAD_REASON } },
        data: { skipReason: AUDIO_DEAD_REASON },
      });
      // DONE/UNCLEAR приходит с пустым skipReason — условие выше его не ловит.
      const markedEmpty = marked.count
        ? marked
        : await tx.interviewInviteCall.updateMany({
            where: { id: call.callId, skipReason: null },
            data: { skipReason: AUDIO_DEAD_REASON },
          });
      if (markedEmpty.count !== 1) return;
      await enqueueInterviewInviteCallTx(tx, {
        jobApplicationId: call.jobApplicationId,
        interviewAt: call.interviewAt,
        requestedById: null,
        now,
      });
      queued += 1;
    });
  }
  return queued;
}
