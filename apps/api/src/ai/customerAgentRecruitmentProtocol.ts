import { createHash } from "node:crypto";
import { customerAgentVacanciesObservationSchema, recruitmentPositionSchema, type CustomerAgentVacanciesObservation, type RecruitmentPosition } from "@royal-home/shared";

/** Pure public-data validation; never imports DB, candidate records or grants. */
export function recruitmentCatalogHash(value: Omit<CustomerAgentVacanciesObservation, "kind" | "sourceHash">): string {
  return createHash("sha256").update(JSON.stringify({ collecting: value.collecting,
    positions: value.positions.map(row => recruitmentPositionSchema.parse(row)) })).digest("hex");
}
export function isCustomerVacanciesObservation(value: unknown): value is CustomerAgentVacanciesObservation {
  const result = customerAgentVacanciesObservationSchema.safeParse(value);
  return result.success && result.data.sourceHash === recruitmentCatalogHash({ collecting: result.data.collecting, positions: result.data.positions }) &&
    result.data.positions.every(row => row.isOpen) && (result.data.collecting || !result.data.positions.length);
}
export function customerRecruitmentRequested(text: string): boolean {
  return /ваканси|ищу\s+работу|хочу\s+работать|хочу\s+(?:стать|устроиться)\s+агент|резюме|ҷойи\s+кор|чои\s+кор|кор\s+(?:меҷӯ|мечу|мекоб)|ба\s+кор\s+гири|SMM|СММ|видеограф/iu.test(text);
}
export function customerRecruitmentFactsRequested(text: string): boolean {
  return /ваканси|услови|зарплат|график|удал[её]н|удал[её]нк|дистанцион|из\s+дома|офис|суббот|выходн|(?:дни|часы)\s+работ|(?:есть|ищу)\s+работ|ҷойи\s+кор|чои\s+кор|маош|шартҳои\s+кор|дар\s+бораи\s+кор|фосилав|аз\s+хона|рӯзҳои\s+кор|соати\s+кор|шанбе|подроб|муфассал/iu.test(text);
}
/** Only topic projection. This creates no application, consent or HR verdict. */
export function customerRecruitmentTopic(text: string, previous: "buyer" | "seller" | "job" | "rent" | "unknown", matchedPublication = false) {
  if (/(?:хочу\s+купить|куплю|ищу\s+(?:квартир|дом)|мехарам|харидан\s+мехоҳ)/iu.test(text)) return "buyer" as const;
  if (/(?:хочу\s+продать|продаю|продать\s+(?:мою|свою)|мефурӯшам|мефурушам)/iu.test(text)) return "seller" as const;
  return matchedPublication || customerRecruitmentRequested(text) ? "job" as const : previous;
}
export function selectedRecruitmentPosition(positions: readonly RecruitmentPosition[], text: string, knownKey?: string): RecruitmentPosition | null {
  const query = text.toLocaleLowerCase();
  const matched = positions.filter(position => [position.titleRu, position.titleTg].join(" ").toLocaleLowerCase()
    .split(/[\s/—–-]+/u).filter(word => word.length >= 4).some(word => query.includes(word)));
  if (matched.length === 1) return matched[0];
  if (matched.length > 1) return null;
  return knownKey ? positions.find(position => position.key === knownKey) ?? null : null;
}
