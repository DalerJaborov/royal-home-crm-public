/**
 * ОБЪЕКТ РЕКЛАМЫ В ЗАЯВКЕ — ОДНО ПРАВИЛО НА ВСЕ ДВЕРИ (второе ревью 13.11.2026, находка №3).
 *
 * Человек, пришедший с рекламы объекта, «назвал объект пальцем», и его заявка уходит агенту этого
 * объекта (решение владельца 24.09.2026). Но только ПОКУПАТЕЛЬ и только с рекламы ОБЪЕКТА: продавец,
 * кандидат на вакансию или «прочее обращение», когда-то кликнувшие рекламу квартиры, не должны уехать
 * агенту той квартиры. Раньше это проверял только приём заявки ядра (services/leads/intake.ts), а старый
 * путь (messengers/conversation.ts::acceptLead) клал объект рекламы в заявку любого типа.
 *
 * Явно названный объект (номер, ссылка, пост) сюда не относится: его правило — в services/leads/assignment.ts.
 * Чистая функция без импортов: её зовут и приём ядра, и старый путь, и тест сверяет обе двери.
 */
export function adPropertyForLead(input: { kind: string | null | undefined; adPropertyId: string | null | undefined;
  adTopic: string | null | undefined }): string | null {
  if (!input.adPropertyId) return null;
  // Тема рекламы не записана — реклама объекта (старые диалоги до 13.11 писали только объект).
  if ((input.adTopic ?? "property") !== "property") return null;
  return input.kind === "BUYER" ? input.adPropertyId : null;
}
