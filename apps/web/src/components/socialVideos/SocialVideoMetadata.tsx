import { CalendarClock } from "lucide-react";
import { SOCIAL_VIDEO_STATUS_LABELS, type SocialVideoItem } from "@royal-home/shared";
import { exactDateTime } from "../../lib/format";

/** Keep each icon attached to its own text when metadata wraps on a phone. */
export function SocialVideoMetadata({ item, statusClassName }: {
  item: Pick<SocialVideoItem, "status" | "scheduledAt" | "finishedAt" | "startedAt" | "createdBy">;
  statusClassName: string;
}) {
  return <p className="sub clean-social-video-meta">
    <span className={statusClassName}>{SOCIAL_VIDEO_STATUS_LABELS[item.status]}</span>
    {item.status === "SCHEDULED" && item.scheduledAt && <span className="clean-icon-text">
      <CalendarClock className="i" aria-hidden /><span>выйдет {exactDateTime(item.scheduledAt)} по Душанбе</span>
    </span>}
    {item.finishedAt && item.status !== "SCHEDULED" && <span>завершено {exactDateTime(item.finishedAt)}</span>}
    {!item.finishedAt && item.startedAt && item.status === "PUBLISHING" && <span>начато {exactDateTime(item.startedAt)}</span>}
    {item.createdBy && <span>добавил {item.createdBy.name}</span>}
  </p>;
}
