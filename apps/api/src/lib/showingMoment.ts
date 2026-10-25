import { dushanbeWallClock } from "./dushanbeTime.js";

/** Когда показ фактически был. Плановый час вернее отметки «выполнено» (её
 *  ставят вечером за весь день); полночь по Душанбе часом показа быть не может
 *  — так ложится дата без времени (см. hasExactTime в meetingReminders.ts). */
export function showingMomentOf(showing: {
  nextActionDate: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  showingEvidenceVersion?: number;
}): Date {
  const planned = showing.nextActionDate;
  if (planned) {
    if ((showing.showingEvidenceVersion ?? 0) >= 1) return planned;
    const wall = dushanbeWallClock(planned);
    const isMidnight = wall.getUTCHours() === 0 && wall.getUTCMinutes() === 0;
    if (!isMidnight) return planned;
  }
  return showing.completedAt ?? showing.createdAt;
}

