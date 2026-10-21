import type { RecruitmentCommunicationStatus, RecruitmentCommunicationChannel } from "@royal-home/shared";

export const RECRUITMENT_DELIVERY_LABEL: Record<RecruitmentCommunicationStatus, string> = {
  PREVIEW: "Подготовлено, ещё не отправлено", QUEUED: "В очереди", IN_FLIGHT: "Отправляется",
  ACCEPTED: "Принято оператором", DELIVERED: "Доставлено", CONFIRMED: "Кандидат подтвердил участие",
  COMPLETED: "Разговор завершён", REJECTED: "Не отправлено", UNKNOWN: "Результат не подтверждён",
  CANCELLED: "Отменено", DRY_RUN: "Проверочный режим — не отправлено",
};

export function recruitmentSendLabel(channels: RecruitmentCommunicationChannel[]) {
  return channels.length === 2 ? "Отправить SMS и поручить звонок" : channels[0] === "ASSISTANT_CALL" ? "Поручить звонок ассистенту" : "Отправить SMS";
}
