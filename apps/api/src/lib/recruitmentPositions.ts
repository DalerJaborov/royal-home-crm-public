import { recruitmentPositionSchema, customerAgentVacanciesObservationSchema,
  type RecruitmentPositionInput, type CustomerAgentVacanciesObservation } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { loadCustomerAgentFeaturePolicy } from "./customerAgentFeaturePolicy.js";
import { recruitmentCatalogHash, isCustomerVacanciesObservation } from "../ai/customerAgentRecruitmentProtocol.js";

type ReadDb = Pick<TxClient, "$queryRaw">;
/** `openOnly` is the customer-facing read: closed rows are filtered in SQL and the cap is a plain
 * take (the observation holds at most 24), so a long history of closed vacancies can never
 * make the whole catalog unavailable. The staff/admin read keeps the exact-catalog guard. */
export async function readRecruitmentPositions(db: ReadDb = prisma, options: { openOnly?: boolean } = {}) {
  const openOnly = options.openOnly === true, limit = openOnly ? 24 : 25;
  const rows = await db.$queryRaw<Array<RecruitmentPositionInput & { key: string; revision: number }>>`SELECT
    p."key",p."titleRu",p."titleTg",p."detailsRu",p."detailsTg",p."isOpen",p."revision",p."screeningRules",
    COALESCE((SELECT jsonb_agg(r."code" ORDER BY r."code") FROM "RecruitmentPublication" r
      WHERE r."positionKey"=p."key"),'[]'::jsonb) AS "postCodes",
    COALESCE((SELECT jsonb_agg(k."word" ORDER BY k."word") FROM "RecruitmentKeyword" k
      WHERE k."positionKey"=p."key"),'[]'::jsonb) AS "keywords"
    FROM "RecruitmentPosition" p WHERE (NOT ${openOnly}::boolean OR p."isOpen") ORDER BY p."key" LIMIT ${limit}::int`;
  if (!openOnly && rows.length > 24) throw new Error("Recruitment catalog limit exceeded");
  return rows.map(row => recruitmentPositionSchema.parse(row));
}
/** Actual current public facts only. No application, phone, score or HR notes. */
export async function readCustomerOpenVacancies(): Promise<CustomerAgentVacanciesObservation> {
  const features = await loadCustomerAgentFeaturePolicy();
  const rows = features.vacancies ? await readRecruitmentPositions(prisma, { openOnly: true }) : [];
  const facts = { collecting: features.vacancies, positions: features.vacancies ? rows.filter(row => row.isOpen) : [] };
  return customerAgentVacanciesObservationSchema.parse({ kind: "open_vacancies", ...facts, sourceHash: recruitmentCatalogHash(facts) });
}
export async function customerOpenVacanciesCurrent(value: CustomerAgentVacanciesObservation): Promise<boolean> {
  return isCustomerVacanciesObservation(value) && value.sourceHash === (await readCustomerOpenVacancies()).sourceHash;
}
