/**
 * Кандидатам на работу бот условия не обсуждает (решение владельца 10–11.11.2026):
 * называет должность и даёт номер специалиста. Одно место для текста и номера —
 * его зовут и ответ бота в чате, и досылка «не дождавшимся ответа».
 *
 * 16.11.2026 (аудит, 27 ответов в 21 чате): таджикская строка была с «Лутфан» и «мутахассиси мо» — оба слова
 * владелец запретил (tajik-phrasebook, do-not-say). Новая строка — по образцу разговорника; прежняя оставлена в
 * RETIRED, чтобы память старых чатов узнавала, что номер уже давали (его не повторяют).
 */
export const RECRUITMENT_CONTACT = { name: "Ноза", phone: "777 070 100" } as const;

export function recruitmentPhoneLine(language: "ru" | "tg"): string {
  return language === "tg"
    ? `Дар бораи кор ҳамаи тафсилотро ${RECRUITMENT_CONTACT.name} мегӯяд. Ба ӯ занг занед: ${RECRUITMENT_CONTACT.phone}.`
    : `Всю информацию о работе даст по телефону наш специалист ${RECRUITMENT_CONTACT.name}: ${RECRUITMENT_CONTACT.phone}. Позвоните, пожалуйста.`;
}

/** Earlier wording of the same line (sent before 16.11.2026): recognised in memory, never sent again. */
export function retiredRecruitmentPhoneLines(): string[] {
  return [`Маълумоти пурраро дар бораи кор мутахассиси мо ${RECRUITMENT_CONTACT.name} бо телефон медиҳад: ${RECRUITMENT_CONTACT.phone}. Лутфан занг занед.`];
}
