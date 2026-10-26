import { describe, expect, it } from "vitest";
import { renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";
import { customerAgentCompanyInformationHash } from "../src/ai/customerAgentPublicProtocol.js";
import { customerFollowRequest, customerRecruitmentLanguagePermissionQuestion,
  customerStandaloneFurnitureQuestion, customerRecruitmentLanguagePermissionRequested,
  customerFurnitureQuestionRequested, customerMessengerChannelQuestion } from "../src/ai/customerAgentConversationPolicy.js";
import { customerRecruitmentFactsRequested, recruitmentCatalogHash } from "../src/ai/customerAgentRecruitmentProtocol.js";
import { recruitmentPositionTemplates } from "../src/lib/recruitmentPositionTemplates.js";

const context = (topic: "job" | "property", turns: Array<{ role: "user" | "assistant"; text: string }>, jobPositionKey: string | null = null) => ({
  surface: "dm", revisionId: "a".repeat(64), turns,
  publicState: { topic, jobPositionKey, role: "unknown" },
}) as never;

const base = {
  evidence: [], requestedFacts: [], knownPhoneSource: "none" as const,
  maxOutputChars: 3000, surface: "dm" as const,
};

describe("customer conversation quality", () => {
  it("answers a standalone candidate question about using Tajik without repeating the vacancy", () => {
    const result = renderCustomerAgentDecision({ ...base,
      decision: { kind: "reply", refs: [], social: "none", question: "job_position" },
      inputText: "По таджикский можно рассказать о себе?", language: "ru",
      verifiedContext: context("job", [{ role: "assistant", text: "Сейчас открыты вакансии: агент." }]),
    });
    expect(customerRecruitmentLanguagePermissionQuestion("По таджикский можно рассказать о себе?" )).toBe(true);
    expect(result).toBe("Да, конечно. Расскажите о себе и своём опыте на таджикском.");
  });

  it("keeps exact-only language classification narrow but recognizes a mixed language and salary request", () => {
    const mixed = "Можно рассказать о себе по-таджикски и какая зарплата?";
    expect(customerRecruitmentLanguagePermissionQuestion(mixed)).toBe(false);
    expect(customerRecruitmentLanguagePermissionRequested(mixed)).toBe(true);
    expect(customerRecruitmentFactsRequested(mixed)).toBe(true);
    expect(customerRecruitmentLanguagePermissionQuestion("Можно рассказать о себе?" )).toBe(false);
    expect(customerRecruitmentLanguagePermissionRequested('«Можно рассказать о себе по-таджикски?» и какая зарплата?')).toBe(false);
    expect(customerRecruitmentFactsRequested('Не спрашиваю про зарплату.')).toBe(false);
    expect(customerRecruitmentFactsRequested('«Какая зарплата?»')).toBe(false);
    expect(customerRecruitmentFactsRequested("Зарплата")).toBe(true);
    expect(customerRecruitmentFactsRequested("Маош")).toBe(true);
    expect(customerRecruitmentFactsRequested("Не зарплата")).toBe(false);

    const position = { ...recruitmentPositionTemplates().find(row => row.key === "smm-videographer")!, isOpen: true, revision: 1 };
    const catalogFacts = { collecting: true, positions: [position] };
    const vacancies = { kind: "open_vacancies" as const, ...catalogFacts, sourceHash: recruitmentCatalogHash(catalogFacts) };
    const result = renderCustomerAgentDecision({ ...base,
      decision: { kind: "reply", refs: [], social: "none", question: "job_position" },
      inputText: mixed, language: "ru", verifiedContext: context("job", [], position.key),
      evidence: [{ ref: "e0", value: vacancies }],
    });
    expect(result).toContain("Да, конечно. Расскажите о себе и своём опыте на таджикском.");
    expect(result).toContain("Размер зарплаты и точные часы пока не опубликованы.");
    expect(result).not.toMatch(/\b\d{4,}\b/u);
    expect(result).not.toContain("Какая должность вас интересует?");
  });

  it("answers mixed Tajik-language and salary requests in Tajik from current vacancy details", () => {
    const mixed = "Метавонам дар бораи худ ба тоҷикӣ нақл кунам ва маош чанд аст?";
    const position = { ...recruitmentPositionTemplates().find(row => row.key === "smm-videographer")!, isOpen: true, revision: 1 };
    const catalogFacts = { collecting: true, positions: [position] };
    const vacancies = { kind: "open_vacancies" as const, ...catalogFacts, sourceHash: recruitmentCatalogHash(catalogFacts) };
    expect(customerRecruitmentLanguagePermissionRequested(mixed)).toBe(true);
    expect(customerRecruitmentFactsRequested(mixed)).toBe(true);
    const result = renderCustomerAgentDecision({ ...base,
      decision: { kind: "reply", refs: [], social: "none", question: "job_position" }, inputText: mixed, language: "tg",
      verifiedContext: context("job", [], position.key), evidence: [{ ref: "e0", value: vacancies }],
    });
    expect(result).toContain("Бале, албатта. Дар бораи худ ва таҷрибаатон ба тоҷикӣ нақл кунед.");
    expect(result).toContain("Маош ва соатҳои дақиқ ҳоло нашр нашудаанд.");
    expect(result).not.toMatch(/\b\d{4,}\b/u);
  });

  it("replaces repeated recruitment greetings with a bounded acknowledgement and preserves receipts", () => {
    const decision = { kind: "reply" as const, refs: ["e0"], social: "greet" as const, question: "none" as const };
    const prior = context("job", [{ role: "assistant", text: "Здравствуйте! Какая должность вас интересует?" }]);
    const withReceipt = renderCustomerAgentDecision({ ...base, decision, inputText: "Опыт работы есть.", language: "ru",
      verifiedContext: prior,
      evidence: [{ ref: "e0", value: { kind: "receipt", outcome: "job_application_saved" } }],
    });
    expect(withReceipt).toContain("Понял.");
    expect(withReceipt).toContain("Сведения добавлены к отклику на вакансию.");
    expect(renderCustomerAgentDecision({ ...base, decision: { ...decision, refs: [] }, inputText: "Опыт работы есть.", language: "ru",
      verifiedContext: prior,
    })).toBe("Понял.");
    expect(renderCustomerAgentDecision({ ...base, decision: { ...decision, refs: [] }, inputText: "Здравствуйте", language: "ru",
      verifiedContext: context("job", []),
    })).toBe("Здравствуйте!");
  });

  it("answers public single and multi-card furniture questions once and retains availability", () => {
    const sold = { propertyId: "00000000-0000-4000-8000-000000000002", shortId: 12346,
      price: null, currency: "TJS" as const, availability: "SOLD" as const, publicAddress: null,
      addressPolicy: "district_city_only" as const, builder: null, publicLink: null,
      updatedAt: "2026-01-01T00:00:00.000Z", signature: "c".repeat(64) };
    const reserved = { propertyId: "00000000-0000-4000-8000-000000000003", shortId: 12347,
      price: "72000", currency: "USD" as const, availability: "RESERVED" as const, publicAddress: null,
      addressPolicy: "district_city_only" as const, builder: null, publicLink: null,
      updatedAt: "2026-01-01T00:00:00.000Z", signature: "d".repeat(64),
      characteristics: { type: "APARTMENT" as const, rooms: 2, areaSqm: "70", landAreaSotka: null,
        floor: 2, totalFloors: 8, condition: null, marketType: null, stage: null } };
    const render = (cards: Array<typeof sold | typeof reserved>) => renderCustomerAgentDecision({ ...base, surface: "public_comment",
      decision: { kind: "reply", refs: ["e0"], social: "none", question: "rooms" },
      inputText: "Бо чизу чорааш", language: "tg",
      evidence: [{ ref: "e0", value: { kind: "publication_properties", source: { channel: "INSTAGRAM", resourceId: "test-resource", publicationId: "test-publication" },
        mappingSignature: "e".repeat(64), kinds: ["price", "characteristics"], cards } }],
    });
    const one = render([sold]);
    expect(one).toContain("№12346 аллакай фурӯхта шудааст");
    expect(one.match(/Маълумоти тасдиқшуда нест/gu)).toHaveLength(1);
    const many = render([sold, reserved]);
    expect(many).toContain("№12346 аллакай фурӯхта шудааст");
    expect(many).toContain("№12347 ҳоло дар брон аст");
    expect(many.match(/Маълумоти тасдиқшуда нест/gu)).toHaveLength(1);
    expect(many).not.toContain("72000");
    expect(many).not.toContain("70 м²");
    expect(many).not.toContain("Ҳуҷраҳо");
  });

  it("answers a mixed furniture and area question with verified area and an honest furniture unknown", () => {
    const facts = { propertyId: "00000000-0000-4000-8000-000000000004", shortId: 12348,
      price: null, currency: "TJS" as const, availability: "AVAILABLE" as const, publicAddress: null,
      addressPolicy: "district_city_only" as const, builder: null, publicLink: null,
      updatedAt: "2026-01-01T00:00:00.000Z", signature: "f".repeat(64),
      characteristics: { type: "APARTMENT" as const, rooms: 2, areaSqm: "70", landAreaSotka: null,
        floor: 2, totalFloors: 8, condition: null, marketType: null, stage: null } };
    const render = (inputText: string, language: "ru" | "tg" = "ru") => renderCustomerAgentDecision({ ...base,
      decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" }, inputText, language,
      requestedFacts: ["characteristics"],
      evidence: [{ ref: "e0", value: { kind: "facts", facts, kinds: ["characteristics"] } }],
    });
    const mixed = "Мебель остаётся и какая площадь?";
    expect(customerFurnitureQuestionRequested(mixed)).toBe(true);
    const answer = render(mixed);
    expect(answer).toContain("70 м²");
    expect(answer).toContain("В подтверждённых данных не указано, останется ли мебель и входит ли она в стоимость.");
    expect(customerFurnitureQuestionRequested("Не спрашиваю про мебель, какая площадь?")).toBe(false);
    expect(customerFurnitureQuestionRequested('«Мебель остается?» Какая площадь?')).toBe(false);
    const unrelated = render("Не спрашиваю про мебель, какая площадь?");
    expect(unrelated).toContain("70 м²");
    expect(unrelated).not.toContain("не указано, останется ли мебель");

    const tajikMixed = "Бо чизу чорааш ва масоҳаташ чанд?";
    expect(customerStandaloneFurnitureQuestion("Бо чизу чорааш")).toBe(true);
    expect(customerFurnitureQuestionRequested("Бо чизу чорааш")).toBe(true);
    expect(customerFurnitureQuestionRequested(tajikMixed)).toBe(true);
    const tajikAnswer = render(tajikMixed, "tg");
    expect(tajikAnswer).toContain("70 м²");
    expect(tajikAnswer).toContain("Маълумоти тасдиқшуда нест, ки мебел бо объект дода мешавад ё ба нарх дохил аст.");
    expect(customerFurnitureQuestionRequested("Бо чизу чорааш лозим нест, масоҳаташ чанд?")).toBe(false);
  });

  it("does not suppress proposal confirmation for conversational-looking input", () => {
    const summary = { ru: "Отклик на вакансию сохранён.", tg: "Дархости кор сабт шуд." };
    for (const inputText of ["По таджикский можно рассказать о себе?", "сайти навмай под кне 🫂🖤", "Бо чизу чорааш?", "Рустам через телеграм можно или ватсап?"]) {
      const result = renderCustomerAgentDecision({ ...base,
        decision: { kind: "propose", ref: "e0", social: "none" }, inputText, language: "ru",
        verifiedContext: context("job", [{ role: "assistant", text: "Шумо чӣ гуна кор мехоҳед?" }]),
        evidence: [{ ref: "e0", value: { kind: "proposal", summary } }],
      });
      expect(result).toBe(`${summary.ru}\nПодтверждаете?`);
    }
  });

  it("recognizes the observed follow request with trailing emoji", () => {
    expect(customerFollowRequest("сайти навмай под кне 🫂🖤")).toBe(true);
    const result = renderCustomerAgentDecision({ ...base,
      decision: { kind: "reply", refs: [], social: "none", question: "none" },
      inputText: "сайти навмай под кне 🫂🖤", language: "ru",
    });
    expect(result).toBe("Я не могу сам подписаться на сайт или аккаунт.");
  });

  it("declines a follow request without dumping company details or pretending to act", () => {
    const information = { name: "Royal Home", city: "Душанбе", office: "улица Тестовая, 1",
      services: "Продажа и помощь в покупке", hours: null };
    const result = renderCustomerAgentDecision({ ...base,
      decision: { kind: "reply", refs: ["e0"], social: "none", question: "topic" },
      inputText: "сайти навмай под кне 🫂🖤", language: "ru",
      evidence: [{ ref: "e0", value: { kind: "company_information",
        sourceHash: customerAgentCompanyInformationHash(information), information } }],
    });
    expect(result).toBe("Я не могу сам подписаться на сайт или аккаунт.");
    expect(result).not.toContain("Тестовая");
  });

  it("keeps follow-action classification narrow for a mixed request", () => {
    expect(customerFollowRequest("Подпишитесь на мой сайт и скажите адрес офиса")).toBe(false);
  });

  it("recognizes an explicit candidate language preference only", () => {
    expect(customerRecruitmentLanguagePermissionQuestion("Можно рассказать о себе?")).toBe(false);
    expect(customerRecruitmentLanguagePermissionQuestion("Можно рассказать о себе на таджикском?")).toBe(true);
  });

  it("answers a mixed messenger question only with a current-chat continuation", () => {
    const ru = "Рустам через телеграм можно или ватсап?";
    const tg = "Рустам тавассути WhatsApp навиштан мумкин аст?";
    expect(customerMessengerChannelQuestion(ru)).toBe(true);
    expect(customerMessengerChannelQuestion(tg)).toBe(true);
    expect(customerMessengerChannelQuestion('«через телеграм можно?»')).toBe(false);
    expect(customerMessengerChannelQuestion("Не пишите через телеграм, продолжим здесь.")).toBe(false);
    expect(customerMessengerChannelQuestion("Я работаю с Telegram, какая зарплата?")).toBe(false);
    const render = (inputText: string, language: "ru" | "tg") => renderCustomerAgentDecision({ ...base,
      decision: { kind: "reply", refs: [], social: "none", question: "none" }, inputText, language,
      verifiedContext: context("job", []),
    });
    expect(render(ru, "ru")).toBe("Можем продолжить здесь, в текущем чате.");
    expect(render(tg, "tg")).toBe("Метавонем ҳамин ҷо, дар ҳамин чат, идома диҳем.");
    expect(render(ru, "ru")).not.toMatch(/telegram|whatsapp|телеграм|ватсап/iu);
  });

  it("preserves an actual receipt while declining a follow request", () => {
    const result = renderCustomerAgentDecision({ ...base,
      decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" },
      inputText: "сайти навмай под кне", language: "ru",
      evidence: [{ ref: "e0", value: { kind: "receipt", outcome: "job_application_saved" } }],
    });
    expect(result).toContain("Я не могу сам подписаться на сайт или аккаунт.");
    expect(result).toContain("Сведения добавлены к отклику на вакансию.");
  });

  it("preserves a saved-application receipt alongside the current-chat answer", () => {
    const result = renderCustomerAgentDecision({ ...base,
      decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" },
      inputText: "Рустам через телеграм можно или ватсап?", language: "ru",
      evidence: [{ ref: "e0", value: { kind: "receipt", outcome: "job_application_saved" } }],
      verifiedContext: context("job", []),
    });
    expect(result).toContain("Можем продолжить здесь, в текущем чате.");
    expect(result).toContain("Сведения добавлены к отклику на вакансию.");
  });
});
