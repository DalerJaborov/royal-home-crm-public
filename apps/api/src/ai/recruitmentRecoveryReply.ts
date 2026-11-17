import { createHash } from "node:crypto";
import { recruitmentPhoneLine, type CustomerAgentVacanciesObservation, type RecruitmentRecoveryRequest } from "@royal-home/shared";
import { isCustomerVacanciesObservation } from "./customerAgentRecruitmentProtocol.js";

export const recruitmentRecoveryHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function recruitmentRecoveryReply(catalog: CustomerAgentVacanciesObservation,
  target: Pick<RecruitmentRecoveryRequest["recipients"][number], "positionKey" | "language" | "reason">): string | null {
  if (!isCustomerVacanciesObservation(catalog) || !catalog.collecting) return null;
  const position = target.positionKey ? catalog.positions.find(row => row.key === target.positionKey) : null;
  if (target.positionKey && !position || !catalog.positions.length) return null;
  const tg = target.language === "tg";
  const prefix = target.reason === "incorrect_vacancy"
    ? tg ? "Дар бораи ҷойи кор пештар нодуруст ҷавоб додем, бубахшед." : "Ранее мы неверно ответили о вакансии. Извините за ошибку."
    : tg ? "Ташаккур барои таваҷҷуҳ ба кор дар Royal Home! Бубахшед, ки ҷавоби пурра надодем." : "Спасибо за интерес к работе в Royal Home! Извините, что не дали полный ответ.";
  const lines = [prefix, tg ? "Ҳоло қабул кушода аст:" : "Сейчас набор открыт:",
    ...(position ? [position] : catalog.positions).map(row => tg ? row.titleTg : row.titleRu)];
  // Conditions are not discussed in the chat: only the specialist's phone (owner 10–11.11.2026).
  lines.push(recruitmentPhoneLine(tg ? "tg" : "ru"));
  const text = lines.filter(Boolean).join("\n");
  return text.length <= 3500 ? text : null;
}
