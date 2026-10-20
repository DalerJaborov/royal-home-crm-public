import { INSTAGRAM_COMMENT_STATUS_LABELS, isInstagramCommentStatus } from "./enums.js";

/** Channel capabilities do not grant staff permissions. No history is reclassified as a new receipt. */
export function commentModerationView(row: { channel: string; status: string; note?: string | null }) {
  const supported = row.channel === "INSTAGRAM" || row.channel === "FACEBOOK" || row.channel === "YOUTUBE";
  const hidden = row.status === "HIDDEN";
  const deleted = row.status === "DELETED";
  const youtube = row.channel === "YOUTUBE";
  const known = isInstagramCommentStatus(row.status);
  const marker = row.note?.split(";", 1)[0]?.trim();
  const confirmedReject = marker === "youtube_rejected";
  const confirmedHide = marker === "moderation_hidden";
  const hiddenConfirmed = supported && hidden && (youtube ? confirmedReject : confirmedHide);
  const label = hidden && !hiddenConfirmed ? "Ранее отмечен скрытым в CRM"
    : youtube && hidden ? "Отклонён YouTube"
    : deleted ? (supported && !youtube && marker === "moderation_deleted" ? "Удалён" : "Ранее отмечен удалённым в CRM")
    : INSTAGRAM_COMMENT_STATUS_LABELS[row.status as keyof typeof INSTAGRAM_COMMENT_STATUS_LABELS] ?? "Неизвестный статус";
  return {
    label, hidden, deleted, hiddenConfirmed, supportsModeration: supported && known,
    canHide: supported && known && !hidden && !deleted && row.status !== "WORKING",
    canUnhide: supported && !youtube && hidden,
    canReply: supported && known && !hidden && !deleted && row.status !== "WORKING",
    youtubeRejection: youtube && hidden,
  };
}
