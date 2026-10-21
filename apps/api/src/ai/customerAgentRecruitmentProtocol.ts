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
  return /ваканси|ищу\s+работу|хочу\s+работать|хочу\s+(?:стать|устроиться)\s+агент|резюме|ҷойи\s+кор|чои\s+кор|дар\s+бораи\s+кор|(?:о|по)\s+работе|(?:насч[её]т|по\s+поводу)\s+работы|кор\s+(?:меҷӯ|мечу|мекоб|мехо[ҳх]|даркор|лозим)|ба\s+кор\s+(?:гири|қабул|кабул)|SMM|СММ|видеограф/iu.test(text);
}
export function customerRecruitmentFactsRequested(text: string): boolean {
  return /ваканси|услови|зарплат|график|удал[её]н|удал[её]нк|дистанцион|из\s+дома|офис|суббот|выходн|(?:дни|часы)\s+работ|(?:есть|ищу)\s+работ|ҷойи\s+кор|чои\s+кор|маош|шартҳои\s+кор|дар\s+бораи\s+кор|фосилав|аз\s+хона|рӯзҳои\s+кор|соати\s+кор|шанбе|подроб|муфассал/iu.test(text);
}
/** Only topic projection. This creates no application, consent or HR verdict. */
export function customerRecruitmentTopic(text: string, previous: "buyer" | "seller" | "job" | "rent" | "unknown", matchedPublication = false) {
  if (/(?:хочу\s+купить|куплю|мехарам|харидан\s+мехоҳ)/iu.test(text)) return "buyer" as const;
  if (/(?:хочу\s+продать|продаю|продать\s+(?:мою|свою)|мефурӯшам|мефурушам)/iu.test(text)) return "seller" as const;
  // The customer's current request wins over an old recruitment/ad focus.
  // "Ищу квартиру в аренду" is rental, not buying or applying for a job.
  if (/(?:аренд|снять\s+(?:квартир|дом|жиль)|иҷора|ичора)/iu.test(text)) return "rent" as const;
  if (/ищу\s+(?:квартир|дом)/iu.test(text)) return "buyer" as const;
  return matchedPublication || customerRecruitmentRequested(text) ? "job" as const : previous;
}
export function selectedRecruitmentPosition(positions: readonly RecruitmentPosition[], text: string, knownKey?: string): RecruitmentPosition | null {
  const query = text.toLocaleLowerCase();
  // Repeated observations of the same catalog row are not two different jobs.
  // A conflicting edition of that key remains ambiguous, never last-write-wins.
  const unique = positions.filter((position, index) => positions.findIndex(other =>
    JSON.stringify(other) === JSON.stringify(position)) === index);
  const matched = unique.filter(position => [position.titleRu, position.titleTg, ...position.keywords].join(" ").toLocaleLowerCase()
    .split(/[\s/—–-]+/u).filter(word => word.length >= 3).some(word => query.includes(word)));
  if (matched.length === 1) return matched[0];
  if (matched.length > 1) return null;
  const known = knownKey ? unique.filter(position => position.key === knownKey) : [];
  return known.length === 1 ? known[0] : null;
}

/** Interpret the CURRENT question first, then the retained public job context.
 * Only already minimized user turns from this same inquiry may disambiguate a
 * captionless follow-up. These words never establish availability or consent. */
export function recruitmentPositionForTurn(positions: readonly RecruitmentPosition[], input: { inputText?: string; mediaText?: string;
  knownKey?: string; turns?: readonly { role: "user" | "assistant"; text: string }[] }): RecruitmentPosition | null {
  const current = [input.inputText, input.mediaText].filter(Boolean).join("\n");
  const selected = selectedRecruitmentPosition(positions, current, input.knownKey);
  if (selected || input.knownKey) return selected;
  // Do not settle an explicit multi-role question using an older single role.
  if (positions.filter(row => selectedRecruitmentPosition([row], current)?.key === row.key).length > 1) return null;
  for (const turn of [...input.turns ?? []].reverse()) {
    if (turn.role !== "user") continue;
    const prior = selectedRecruitmentPosition(positions, turn.text);
    if (prior) return prior;
  }
  return null;
}
