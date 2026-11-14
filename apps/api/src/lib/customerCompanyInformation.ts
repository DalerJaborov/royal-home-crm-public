import { customerAgentCompanyInformationSchema, type CustomerAgentCompanyInformationObservation } from "@royal-home/shared";
import { AGENCY_FACTS, loadClientHours } from "../ai/agencyFacts.js";
import { vacancyOfficeAddress, vacancyOfficeAddressTg } from "../ai/vacancyFacts.js";
import { customerAgentCompanyInformationHash, isCustomerCompanyInformation } from "../ai/customerAgentPublicProtocol.js";
import { configuredBrandNames } from "../messengers/accounts.js";

/**
 * ОДИН БОТ — РАЗНЫЕ БРЕНДЫ (решение владельца 13.11.2026).
 *
 * Arvan Estate и Royal Home — одна компания для клиента: тот же офис, те же часы,
 * те же правила, тот же бот. Отличается ТОЛЬКО имя, которым бот называет компанию
 * (`MessengerAccount.brandName`). Поэтому имя — единственное поле здесь, которое
 * зависит от аккаунта; офис, город, услуги и часы общие и подменяться не могут.
 *
 * `brandName` приходит от сервера (аккаунт канала), никогда от модели или клиента.
 * Пусто — «Royal Home» (AGENCY_FACTS.name).
 */
export function customerCompanyName(brandName?: string | null): string {
  return brandName?.trim() || AGENCY_FACTS.name;
}

/** The same public office and actual configured client hours as legacy. No
 * copied hours, staff schedule, fallback opening promise or contact database. */
export async function readCustomerCompanyInformation(brandName?: string | null): Promise<CustomerAgentCompanyInformationObservation> {
  const hours = await loadClientHours();
  const information = customerAgentCompanyInformationSchema.parse({
    name: customerCompanyName(brandName), city: AGENCY_FACTS.city, office: vacancyOfficeAddress(), officeTg: vacancyOfficeAddressTg(), services: AGENCY_FACTS.services,
    hours: hours ? { start: hours.start, end: hours.end, daysOff: [...(hours.daysOff ?? [])].sort() } : null,
  });
  return { kind: "company_information", information,
    sourceHash: customerAgentCompanyInformationHash(information) };
}

/** Freshness of a stored observation. The name must be the default one or a
 * brand currently configured on some account; every other field must match the
 * shared facts exactly — a branded answer cannot carry its own office or hours. */
export async function customerCompanyInformationCurrent(value: CustomerAgentCompanyInformationObservation): Promise<boolean> {
  if (!isCustomerCompanyInformation(value)) return false;
  const name = value.information.name;
  if (name !== AGENCY_FACTS.name && !(await configuredBrandNames()).includes(name)) return false;
  return value.sourceHash === (await readCustomerCompanyInformation(name)).sourceHash;
}
