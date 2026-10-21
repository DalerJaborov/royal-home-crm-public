import { recruitmentPositionSchema, customerAgentVacanciesObservationSchema,
  type RecruitmentPositionInput, type CustomerAgentVacanciesObservation } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { loadCustomerAgentFeaturePolicy } from "./customerAgentFeaturePolicy.js";
import { recruitmentCatalogHash, isCustomerVacanciesObservation } from "../ai/customerAgentRecruitmentProtocol.js";

type ReadDb = Pick<TxClient, "$queryRaw">;
export async function readRecruitmentPositions(db: ReadDb = prisma) {
  const rows = await db.$queryRaw<Array<RecruitmentPositionInput & { key: string; revision: number }>>`SELECT
    p."key",p."titleRu",p."titleTg",p."detailsRu",p."detailsTg",p."isOpen",p."revision",
    COALESCE((SELECT jsonb_agg(r."code" ORDER BY r."code") FROM "RecruitmentPublication" r
      WHERE r."positionKey"=p."key"),'[]'::jsonb) AS "postCodes",
    COALESCE((SELECT jsonb_agg(k."word" ORDER BY k."word") FROM "RecruitmentKeyword" k
      WHERE k."positionKey"=p."key"),'[]'::jsonb) AS "keywords"
    FROM "RecruitmentPosition" p ORDER BY p."key" LIMIT 25`;
  if (rows.length > 24) throw new Error("Recruitment catalog limit exceeded");
  return rows.map(row => recruitmentPositionSchema.parse(row));
}
/** Actual current public facts only. No application, phone, score or HR notes. */
export async function readCustomerOpenVacancies(): Promise<CustomerAgentVacanciesObservation> {
  const [features, rows] = await Promise.all([loadCustomerAgentFeaturePolicy(), readRecruitmentPositions()]);
  const facts = { collecting: features.vacancies, positions: features.vacancies ? rows.filter(row => row.isOpen) : [] };
  return customerAgentVacanciesObservationSchema.parse({ kind: "open_vacancies", ...facts, sourceHash: recruitmentCatalogHash(facts) });
}
export async function customerOpenVacanciesCurrent(value: CustomerAgentVacanciesObservation): Promise<boolean> {
  return isCustomerVacanciesObservation(value) && value.sourceHash === (await readCustomerOpenVacancies()).sourceHash;
}
