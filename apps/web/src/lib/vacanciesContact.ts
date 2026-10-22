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

/** Офис из contact-options; `addressTg` новый сервер присылает с 22.10.2026, старый — нет. */
export interface RecruitmentOffice { address?: string | null; addressTg?: string | null; mapUrl?: string | null }

/** Адрес по умолчанию для выбранного языка: на таджикском — таджикский текст,
 *  если сервер его прислал, иначе обычный адрес. */
export function contactDefaultAddress(office: RecruitmentOffice, language: string): string {
  if (language === "tg" && office.addressTg?.trim()) return office.addressTg;
  return office.address || "";
}

/** Блокировать повторную отправку только после успеха или неясного исхода:
 *  5xx и сетевая ошибка могли уже отправить SMS; понятный 4xx — нет. */
export function contactConfirmBlocked(succeeded: boolean, error: unknown): boolean {
  if (succeeded) return true;
  if (!error) return false;
  const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : NaN;
  return !(status >= 400 && status < 500);
}

/** «SMS: 2 части» — сколько частей займёт текст; старый сервер число не присылает. */
export function smsSegmentsLabel(preview: unknown): string | null {
  const value = preview && typeof preview === "object" && "smsSegments" in preview ? (preview as { smsSegments?: unknown }).smsSegments : undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  const word = value % 10 === 1 && value % 100 !== 11 ? "часть" : [2, 3, 4].includes(value % 10) && ![12, 13, 14].includes(value % 100) ? "части" : "частей";
  return `SMS: ${value} ${word}`;
}
