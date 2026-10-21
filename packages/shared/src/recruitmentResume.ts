import { z } from "zod";

export const recruitmentFactKeySchema = z.enum(["name", "phone", "city", "about", "age", "studyingNow", "employedNow",
  "education", "experience", "languages", "startWhen", "skills", "tools"]);
export type RecruitmentFactKey = z.infer<typeof recruitmentFactKeySchema>;
export const recruitmentScreeningRulesSchema = z.object({
  version: z.literal(1), minimumAge: z.number().int().min(16).max(100).nullable(),
  allowStudying: z.boolean(), allowOtherEmployment: z.boolean(),
  requiredFacts: z.array(recruitmentFactKeySchema).max(13).refine(values => new Set(values).size === values.length, "Повтор поля"),
}).strict();
export type RecruitmentScreeningRules = z.infer<typeof recruitmentScreeningRulesSchema>;
export const DEFAULT_RECRUITMENT_SCREENING_RULES: RecruitmentScreeningRules = {
  version: 1, minimumAge: null, allowStudying: true, allowOtherEmployment: true, requiredFacts: ["name", "phone", "about"],
};
export const REALTOR_RECRUITMENT_SCREENING_RULES: RecruitmentScreeningRules = {
  version: 1, minimumAge: 24, allowStudying: false, allowOtherEmployment: false,
  requiredFacts: ["name", "phone", "about", "age", "studyingNow", "employedNow"],
};
// Presentation provenance only; this field never grants verified-source authority.
const source = { sourceEventKey: z.string().regex(/^[a-f0-9]{64}$/), quote: z.string().trim().min(1).max(2000),
  sourceKind: z.enum(["message", "document", "assistant_call"]).optional() };
const text = z.object({ value: z.string().trim().min(1).max(2000), ...source }).strict();
const yesNo = z.object({ value: z.boolean(), ...source }).strict();
export const recruitmentResumeFactsSchema = z.object({
  name: text.optional(), phone: text.optional(), city: text.optional(), about: text.optional(),
  age: z.object({ value: z.number().int().min(14).max(100), ...source }).strict().optional(),
  studyingNow: yesNo.optional(), employedNow: yesNo.optional(), education: text.optional(), experience: text.optional(),
  languages: text.optional(), startWhen: text.optional(), skills: text.optional(), tools: text.optional(),
}).strict();
export type RecruitmentResumeFacts = z.infer<typeof recruitmentResumeFactsSchema>;
export const recruitmentResumeSchema = z.object({ version: z.literal(1), facts: recruitmentResumeFactsSchema }).strict();
export type RecruitmentResume = z.infer<typeof recruitmentResumeSchema>;
export const RECRUITMENT_FACT_LABELS: Record<RecruitmentFactKey, string> = {
  name: "Имя", phone: "Телефон", city: "Город", about: "Рассказ о себе или резюме", age: "Возраст",
  studyingNow: "Учится ли сейчас", employedNow: "Работает ли сейчас", education: "Образование", experience: "Опыт",
  languages: "Языки", startWhen: "Когда готов начать", skills: "Навыки", tools: "Программы и инструменты",
};

/** Completeness and human-review hints, never an eligibility/status mutation. */
export function assessRecruitmentResume(input: { rules?: RecruitmentScreeningRules | null; facts?: RecruitmentResumeFacts;
  values?: Partial<Record<RecruitmentFactKey, string | number | boolean | null>>;
  name?: string | null; phone?: string | null; portfolioCount?: number }) {
  const rules = input.rules ?? DEFAULT_RECRUITMENT_SCREENING_RULES, facts = input.facts ?? {};
  const required = new Set(rules.requiredFacts);
  if (rules.minimumAge !== null) required.add("age");
  if (!rules.allowStudying) required.add("studyingNow");
  if (!rules.allowOtherEmployment) required.add("employedNow");
  const missing = [...required].filter(key => {
    const value = input.values?.[key];
    if (facts[key] !== undefined || value !== undefined && value !== null && (typeof value !== "string" || value.trim() !== "")) return false;
    if (key === "name" && input.name?.trim()) return false;
    if (key === "phone" && input.phone?.trim()) return false;
    return !(key === "about" && (input.portfolioCount ?? 0) > 0);
  });
  const warnings: string[] = [];
  const age = facts.age?.value ?? input.values?.age;
  if (rules.minimumAge !== null && typeof age === "number" && age < rules.minimumAge) warnings.push(`Возраст ниже указанного в вакансии: ${rules.minimumAge} лет`);
  if (!rules.allowStudying && (facts.studyingNow?.value ?? input.values?.studyingNow) === true) warnings.push("Кандидат сейчас учится — обсудите совместимость с графиком");
  if (!rules.allowOtherEmployment && (facts.employedNow?.value ?? input.values?.employedNow) === true) warnings.push("Кандидат сейчас работает — уточните готовность перейти");
  return { missing, warnings, readyForReview: missing.length === 0 };
}
