import { customerAgentCompanyInformationSchema, type CustomerAgentCompanyInformationObservation } from "@royal-home/shared";
import { AGENCY_FACTS, loadClientHours } from "../ai/agencyFacts.js";
import { vacancyOfficeAddress, vacancyOfficeAddressTg } from "../ai/vacancyFacts.js";
import { customerAgentCompanyInformationHash, isCustomerCompanyInformation } from "../ai/customerAgentPublicProtocol.js";

/** The same public office and actual configured client hours as legacy. No
 * copied hours, staff schedule, fallback opening promise or contact database. */
export async function readCustomerCompanyInformation(): Promise<CustomerAgentCompanyInformationObservation> {
  const hours = await loadClientHours();
  const information = customerAgentCompanyInformationSchema.parse({
    name: AGENCY_FACTS.name, city: AGENCY_FACTS.city, office: vacancyOfficeAddress(), officeTg: vacancyOfficeAddressTg(), services: AGENCY_FACTS.services,
    hours: hours ? { start: hours.start, end: hours.end, daysOff: [...(hours.daysOff ?? [])].sort() } : null,
  });
  return { kind: "company_information", information,
    sourceHash: customerAgentCompanyInformationHash(information) };
}
export async function customerCompanyInformationCurrent(value: CustomerAgentCompanyInformationObservation): Promise<boolean> {
  return isCustomerCompanyInformation(value) && value.sourceHash === (await readCustomerCompanyInformation()).sourceHash;
}
