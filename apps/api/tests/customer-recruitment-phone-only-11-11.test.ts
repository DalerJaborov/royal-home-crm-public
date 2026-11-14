import { describe, expect, it } from "vitest";
import { RECRUITMENT_CONTACT, recruitmentPhoneLine } from "@royal-home/shared";
import { recruitmentCatalogHash } from "../src/ai/customerAgentRecruitmentProtocol.js";
import { recruitmentRecoveryReply } from "../src/ai/recruitmentRecoveryReply.js";

/**
 * Решение владельца 10–11.11.2026: бот не обсуждает условия работы, а называет
 * должность и даёт номер специалиста (Ноза, 777 070 100). Условия, написанные
 * сотрудниками в каталоге, в ответ кандидату не попадают вовсе.
 */
const position = {
  key: "real-estate-agent", revision: 5, titleRu: "Менеджер по продажам недвижимости", titleTg: "Менеҷери фурӯши амволи ғайриманқул",
  detailsRu: "Доход от сделок, офис на улице Примерной, 5.\nГрафик с 9 до 18.", detailsTg: "Даромад аз аҳдҳо.\nҶадвал аз 9 то 18.",
  isOpen: true, keywords: [], postCodes: [],
};
const facts = { collecting: true, positions: [position] };
const catalog = { kind: "open_vacancies" as const, ...facts, sourceHash: recruitmentCatalogHash(facts) };

describe("вакансия: только номер специалиста", () => {
  it("строка с номером на обоих языках, без длинного тире и с вежливой формой", () => {
    for (const lang of ["ru", "tg"] as const) {
      const line = recruitmentPhoneLine(lang);
      expect(line).toContain(RECRUITMENT_CONTACT.phone);
      expect(line).toContain(RECRUITMENT_CONTACT.name);
      expect(line).not.toContain("—");
    }
    expect(recruitmentPhoneLine("ru")).toContain("Позвоните, пожалуйста");
    expect(recruitmentPhoneLine("tg")).toContain("Лутфан занг занед");
  });

  it("досылка не дождавшимся: должность и номер, без условий и без просьбы о резюме", () => {
    for (const lang of ["ru", "tg"] as const) {
      const text = recruitmentRecoveryReply(catalog, { positionKey: position.key, language: lang, reason: "no_reply" } as never)!;
      expect(text).toContain(lang === "tg" ? position.titleTg : position.titleRu);
      expect(text.endsWith(recruitmentPhoneLine(lang))).toBe(true);
      expect(text).not.toMatch(/Примерной|График|Ҷадвал|Даромад|Доход|резюме/iu);
    }
  });
});
