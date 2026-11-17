import type { Prisma } from "../generated/prisma/client.js";

/** Actual contact, independent of whether asynchronous AI has filled outcome. */
export const REAL_CALL_CONTACT_WHERE = {
  type: "CALL",
  // Звонок-разбор из Корзины (lib/archiveReviewCall.ts) не контакт агента с клиентом.
  archiveReview: false,
  OR: [
    { callAttempt: "TALKED" },
    { recordingDurationSec: { gt: 0 } },
    { callAttempt: null, outcome: { not: null, notIn: ["NO_ANSWER"] } },
  ],
} satisfies Prisma.InteractionWhereInput;

export function isRealCallContact(call: {
  type: string;
  callAttempt: string | null;
  recordingDurationSec: number | null;
  outcome: string | null;
  archiveReview?: boolean;
}): boolean {
  return call.type === "CALL" && !call.archiveReview && (
    call.callAttempt === "TALKED" ||
    (call.recordingDurationSec ?? 0) > 0 ||
    (call.callAttempt === null && call.outcome !== null && call.outcome !== "NO_ANSWER")
  );
}

/** Auto-closed future appointments and declined meetings are not held meetings. */
export function isHeldMeeting(meeting: {
  completedAt: Date | null;
  nextActionDate: Date | null;
  declinedAt?: Date | null;
}): boolean {
  return !meeting.declinedAt && !!meeting.completedAt &&
    (!meeting.nextActionDate || meeting.nextActionDate <= meeting.completedAt);
}

export const TERMINAL_CLIENT_STATUSES = ["LOST", "ARCHIVED", "DEAL_CLOSED"] as const;

export function inactiveExitData() {
  return {
    workStatus: "ACTIVE" as const,
    inactiveLevel: null,
    inactiveReasonKey: null,
    inactiveSince: null,
    inactiveEnteredAt: null,
    inactivePingCount: 0 as const,
  };
}
