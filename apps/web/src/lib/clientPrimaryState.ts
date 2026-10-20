import type { Client } from "../types";
import { CLIENT_STATUS_CHIP, CLIENT_STATUS_CHIP_DOT, CLIENT_STATUS_LABELS } from "./clientFormat";
import { INACTIVE_LEVEL_TITLES, INACTIVE_LEVEL_TONE } from "../components/InactiveLevelBadge";

type StateInput = Pick<Client, "status" | "workStatus" | "inactiveLevel" | "pendingAcceptance" | "hiddenReason" | "deletedAt" | "kind">;
export interface ClientPrimaryState {
  id: "status" | "hidden" | "inactive" | "deferred" | "pending" | "other" | "trashed";
  label: string;
  tone: string;
  title?: string;
  dot?: string;
}

/** One lifecycle state on every device; temperature never hides a pause or closure. */
export function clientPrimaryState(c: StateInput): ClientPrimaryState {
  if (c.deletedAt || c.hiddenReason?.kind === "trashed")
    return { id: "trashed", label: "В Корзине", tone: "mute", title: c.hiddenReason?.detail };
  if (c.hiddenReason?.kind === "securityReview")
    return { id: "hidden", label: c.hiddenReason.label, tone: "warn", title: c.hiddenReason.detail };
  if (["LOST", "DEAL_CLOSED", "ARCHIVED"].includes(c.status))
    return { id: "hidden", label: CLIENT_STATUS_LABELS[c.status], tone: CLIENT_STATUS_CHIP[c.status] };
  if (c.kind === "OTHER") return { id: "other", label: "Прочее обращение", tone: "mute" };
  if (c.workStatus === "DEFERRED")
    return { id: "deferred", label: "Отложен", tone: "mute", title: c.hiddenReason?.detail };
  if (c.workStatus === "INACTIVE")
    return { id: "inactive", label: "Неактивный", tone: c.inactiveLevel ? INACTIVE_LEVEL_TONE[c.inactiveLevel] : "mute",
      title: c.inactiveLevel ? INACTIVE_LEVEL_TITLES[c.inactiveLevel] : "Уровень светофора ещё не рассчитан" };
  if (c.hiddenReason) return { id: "hidden", label: c.hiddenReason.label, tone: "warn", title: c.hiddenReason.detail };
  if (c.pendingAcceptance) return { id: "pending", label: "Ждёт принятия", tone: "warn" };
  return { id: "status", label: CLIENT_STATUS_LABELS[c.status], tone: CLIENT_STATUS_CHIP[c.status], dot: CLIENT_STATUS_CHIP_DOT[c.status] };
}
