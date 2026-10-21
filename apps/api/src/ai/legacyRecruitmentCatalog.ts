import type { CustomerAgentVacanciesObservation } from "@royal-home/shared";
import { isCustomerVacanciesObservation, selectedRecruitmentPosition } from "./customerAgentRecruitmentProtocol.js";

/** Current public facts, appended outside the old stable prompt/cache. Never
 * imports candidate records or converts an old advertisement into an opening. */
export function legacyRecruitmentCatalogBlock(catalog: CustomerAgentVacanciesObservation, text: string): string {
  if (!isCustomerVacanciesObservation(catalog)) throw new Error("Invalid recruitment catalog");
  const selected = selectedRecruitmentPosition(catalog.positions, text);
  const rows = selected ? [selected] : catalog.positions;
  return "\nАКТУАЛЬНЫЙ КАТАЛОГ ВАКАНСИЙ НА ЭТОТ ХОД (важнее старых блоков JOB, рекламы и истории):\n" +
    JSON.stringify({ collecting: catalog.collecting, positions: rows.map(row => ({ key: row.key,
      titleRu: row.titleRu, titleTg: row.titleTg, keywords: row.keywords, detailsRu: row.detailsRu, detailsTg: row.detailsTg })) }) +
    "\nТолько эти позиции открыты сейчас. Не говори «ищем только агентов», если есть другая позиция. " +
    "Условия одной должности не относятся к другой: зарплата и график агента не относятся к SMM/видеографу. " +
    "Резюме необязательно: кандидат может просто рассказать о себе и профессиональном опыте. Примеры работ по желанию. " +
    "Уточняй задачи, программы, опыт, готовность к опубликованному формату и срок выхода. " +
    "Не требуй возраст, образование, семейные сведения или машину для SMM. Не решай, подходит ли человек. " +
    "Если должность не выбрана, уточни её; не подставляй агента автоматически. Если клиент прямо говорит о покупке, продаже или аренде, отвечай об этом, а не о работе. " +
    "Отказался от работы — прекрати анкету. Не обещай звонок, собеседование или сохранение без фактического результата.";
}
