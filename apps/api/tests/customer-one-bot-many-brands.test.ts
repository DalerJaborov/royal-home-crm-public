// ОДИН БОТ — РАЗНЫЕ БРЕНДЫ (решение владельца 13.11.2026).
// «Арван должен лишь просто сказать, что он Арван… один бот, просто разные бренды,
// и всё остальное, офис, всё одинаковое». Сторож правила: у аккаунта со своим
// именем в ответах ядра меняется ТОЛЬКО имя компании; офис, город, услуги, часы и
// текст обращения к продавцу — общие, и придуманное имя не проходит сверку свежести.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENCY_FACTS } from "../src/ai/agencyFacts.js";
import { readCustomerCompanyInformation, customerCompanyInformationCurrent, customerCompanyName } from "../src/lib/customerCompanyInformation.js";
import { customerSellerPrivateReply } from "../src/lib/customerPublicModerationPolicy.js";
import { customerAgentCompanyInformationHash } from "../src/ai/customerAgentPublicProtocol.js";
import { deleteAccount, resetAccountsCache, saveAccount } from "../src/messengers/accounts.js";

const ids: string[] = [];
let brand: string;

beforeAll(async () => {
  brand = `Арван${randomUUID().slice(0, 6)}`;
  ids.push(await saveAccount({ channel: "INSTAGRAM", externalId: `brand-${randomUUID()}`, title: "Arvan test", brandName: brand }));
  resetAccountsCache();
});
afterAll(async () => {
  for (const id of ids) await deleteAccount(id);
  resetAccountsCache();
});

describe("one bot, different brands", () => {
  it("company name: brand when set, Royal Home otherwise", () => {
    expect(customerCompanyName(null)).toBe(AGENCY_FACTS.name);
    expect(customerCompanyName("  ")).toBe(AGENCY_FACTS.name);
    expect(customerCompanyName("Арван")).toBe("Арван");
  });

  it("only the name differs: office, city, services and hours are the shared facts", async () => {
    const shared = await readCustomerCompanyInformation();
    const branded = await readCustomerCompanyInformation(brand);
    expect(shared.information.name).toBe(AGENCY_FACTS.name);
    expect(branded.information.name).toBe(brand);
    expect({ ...branded.information, name: shared.information.name }).toEqual(shared.information);
  });

  it("stored answers stay fresh for the default and for a configured brand", async () => {
    expect(await customerCompanyInformationCurrent(await readCustomerCompanyInformation())).toBe(true);
    expect(await customerCompanyInformationCurrent(await readCustomerCompanyInformation(brand))).toBe(true);
  });

  it("an invented name or a branded answer with its own office is refused", async () => {
    expect(await customerCompanyInformationCurrent(await readCustomerCompanyInformation("Чужая Компания"))).toBe(false);
    const branded = await readCustomerCompanyInformation(brand);
    const information = { ...branded.information, office: "другой адрес" };
    expect(await customerCompanyInformationCurrent({ ...branded, information,
      sourceHash: customerAgentCompanyInformationHash(information) })).toBe(false);
  });

  it("seller private reply: same text, only the company name changes", () => {
    for (const language of ["ru", "tg"] as const) {
      const shared = customerSellerPrivateReply(language);
      const branded = customerSellerPrivateReply(language, "Арван");
      expect(shared).toContain("Royal Home");
      expect(branded).not.toContain("Royal Home");
      expect(branded).toBe(shared.replace("Royal Home", "Арван"));
      expect(customerSellerPrivateReply(language, null)).toBe(shared);
    }
  });
});
