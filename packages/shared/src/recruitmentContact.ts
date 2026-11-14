/**
 * Кандидатам на работу бот условия не обсуждает (решение владельца 10–11.11.2026):
 * называет должность и даёт номер специалиста. Одно место для текста и номера —
 * его зовут и ответ бота в чате, и досылка «не дождавшимся ответа».
 */
export const RECRUITMENT_CONTACT = { name: "Ноза", phone: "777 070 100" } as const;

export function recruitmentPhoneLine(language: "ru" | "tg"): string {
  return language === "tg"
    ? `Маълумоти пурраро дар бораи кор мутахассиси мо ${RECRUITMENT_CONTACT.name} бо телефон медиҳад: ${RECRUITMENT_CONTACT.phone}. Лутфан занг занед.`
    : `Всю информацию о работе даст по телефону наш специалист ${RECRUITMENT_CONTACT.name}: ${RECRUITMENT_CONTACT.phone}. Позвоните, пожалуйста.`;
}
