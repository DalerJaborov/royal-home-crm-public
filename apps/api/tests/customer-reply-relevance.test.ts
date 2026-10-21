import { describe, expect, it } from "vitest";
import { renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";
import { recruitmentCatalogHash } from "../src/ai/customerAgentRecruitmentProtocol.js";
import { recruitmentPositionTemplates } from "../src/lib/recruitmentPositionTemplates.js";

const positions = recruitmentPositionTemplates().map(row => ({ ...row, isOpen: true, revision: 1 }));
const catalog = { kind: "open_vacancies" as const, collecting: true, positions,
  sourceHash: recruitmentCatalogHash({ collecting: true, positions }) };
const video = positions.find(row => row.key === "smm-videographer")!;
const renderJob = (inputText: string, language: "ru" | "tg" = "ru", question = "none", extra = {}) => renderCustomerAgentDecision({
  decision: { kind: "reply", refs: ["e0"], social: "none", question }, evidence: [{ ref: "e0", value: catalog }],
  requestedFacts: [], knownPhoneSource: "none", surface: "dm", language, inputText, maxOutputChars: 4000,
  verifiedContext: { surface: "dm", revisionId: "a".repeat(64), turns: [],
    publicState: { language, topic: "job", openQuestion: "none", jobPositionKey: video.key } }, ...extra,
} as Parameters<typeof renderCustomerAgentDecision>[0]);

describe("relevant verified answers instead of complete cards", () => {
  it.each(["ru", "tg"] as const)("introduces the selected role briefly in %s with one application invitation", language => {
    const result = renderJob(language === "ru" ? "Видеограф" : "Ба шумо видеограф лозим?", language, "job_experience")!;
    const paragraphs = (language === "ru" ? video.detailsRu : video.detailsTg).split("\n");
    expect(result).toContain(paragraphs[0]); expect(result).toContain(paragraphs[1]);
    expect(result).not.toContain(paragraphs[2]); expect(result).not.toContain(paragraphs[3]);
    expect(result.match(/резюме/giu)).toHaveLength(1);
    expect(result).not.toMatch(/зарплат|Маош/u);
  });
  it.each([["ru", "Можно работать удалённо?"], ["tg", "Аз хона кор кардан мешавад?"]] as const)(
    "answers the %s work-format question without the office tour or application form", (language, input) => {
      const result = renderJob(input, language)!;
      const paragraphs = (language === "ru" ? video.detailsRu : video.detailsTg).split("\n");
      expect(result).toContain(paragraphs[1]);
      expect(result).not.toContain(paragraphs[0]); expect(result).not.toContain(paragraphs[3]);
      expect(result).not.toMatch(/резюме|кофе|қаҳва/iu);
    });
  it("answers pay from the selected role without inventing the other role's commission", () => {
    const result = renderJob("Какая зарплата?")!;
    expect(result).toContain(video.detailsRu.split("\n").at(-1));
    expect(result).not.toContain(video.detailsRu.split("\n")[0]);
    expect(result).not.toMatch(/\d+%|Бухоро|кофе/iu);
  });
  it("keeps all published conditions when the person explicitly asks for them, without repeating the CV invitation", () => {
    const result = renderJob("Расскажите все условия подробнее", "ru", "job_experience")!;
    for (const paragraph of video.detailsRu.split("\n")) expect(result).toContain(paragraph);
    expect(result.match(/резюме/giu)).toHaveLength(1);
  });
  it("does not trim a condition into a promise when salary and a restriction share a paragraph", () => {
    const detailsRu = "Если работа очная, оплата обсуждается. Удалённая работа не предусмотрена.\nТолько после обсуждения возможен другой график.";
    const changed = [{ ...video, detailsRu }];
    const value = { ...catalog, positions: changed, sourceHash: recruitmentCatalogHash({ collecting: true, positions: changed }) };
    const result = renderJob("Можно удалённо?", "ru", "none", { evidence: [{ ref: "e0", value }] })!;
    for (const paragraph of detailsRu.split("\n")) expect(result).toContain(paragraph);
  });
  it("keeps an unfamiliar staff paragraph intact instead of guessing the answer from keywords", () => {
    const detailsRu = "Особый порядок выплат описывается индивидуально при встрече.";
    const changed = [{ ...video, detailsRu }];
    const value = { ...catalog, positions: changed, sourceHash: recruitmentCatalogHash({ collecting: true, positions: changed }) };
    expect(renderJob("Какая зарплата?", "ru", "none", { evidence: [{ ref: "e0", value }] })).toContain(detailsRu);
  });
  it("acknowledges a saved portfolio and asks the next professional question without repeating the vacancy", () => {
    const result = renderJob("Вот примеры моих работ", "ru", "job_tools", {
      decision: { kind: "reply", refs: ["e0", "e1"], social: "none", question: "job_tools" },
      evidence: [{ ref: "e0", value: catalog }, { ref: "e1", value: { kind: "receipt", outcome: "job_application_saved" } }],
    })!;
    expect(result).toContain("Сведения добавлены к отклику");
    expect(result).toContain("Какими программами");
    expect(result).not.toMatch(/Бухоро|резюме|Снимать недвижимость|Открыта вакансия/u);
  });
  it("does not conceal an explicit salary question just because an application was saved in the same turn", () => {
    const result = renderJob("Я прислал работы. Какая зарплата?", "ru", "none", {
      decision: { kind: "reply", refs: ["e0", "e1"], social: "none", question: "none" },
      evidence: [{ ref: "e0", value: catalog }, { ref: "e1", value: { kind: "receipt", outcome: "job_application_saved" } }],
    })!;
    expect(result).toContain("Размер зарплаты"); expect(result).toContain("Сведения добавлены к отклику");
    expect(result).not.toContain("Бухоро");
  });
  it.each(["Вот работы. Сколько платите?", "Сколько платите"])("preserves the conditions question alongside a saved application: %s", input => {
    const result = renderJob(input, "ru", "none", {
      decision: { kind: "reply", refs: ["e0", "e1"], social: "none", question: "none" },
      evidence: [{ ref: "e0", value: catalog }, { ref: "e1", value: { kind: "receipt", outcome: "job_application_saved" } }],
    })!;
    expect(result).toContain("Размер зарплаты");
    expect(result).toContain("Сведения добавлены к отклику");
  });
  it.each(["ru", "tg"] as const)("invites a public candidate to private messages in %s without requesting their CV publicly or claiming a DM was sent", language => {
    const result = renderJob(language === "ru" ? "Есть вакансии?" : "Ҷойи кор ҳаст?", language, "job_experience", { surface: "public_comment" })!;
    expect(result).toContain(language === "ru" ? "в личные сообщения" : "Дар паёми шахсӣ");
    expect(result).not.toMatch(/телефон|написали вам|фиристодем|сообщение отправлено/iu);
  });
  it("keeps the private-channel invitation when full public conditions already contain a CV prompt", () => {
    const result = renderJob("Все условия вакансии", "ru", "job_experience", { surface: "public_comment" })!;
    expect(result).toContain("Обсудить отклик можно в личных сообщениях.");
    expect(result.match(/резюме/giu)).toHaveLength(1);
  });
});

const facts = { propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "123456.78", currency: "TJS" as const,
  availability: "AVAILABLE" as const, publicAddress: "Synthetic district", addressPolicy: "district_city_only" as const,
  builder: null, publicLink: null, updatedAt: "2026-10-15T00:00:00.000Z", signature: "a".repeat(64) };
describe("explicit property fact selection", () => {
  it.each(["dm", "public_comment"] as const)("answers the actual price question in %s even when the model read extra fields", surface => {
    const result = renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" },
      evidence: [{ ref: "e0", value: { kind: "facts", facts, kinds: ["price", "address", "builder"] } }],
      requestedFacts: ["price"], knownPhoneSource: "none", surface, language: "ru", inputText: "Сколько стоит?", maxOutputChars: 2000 })!;
    expect(result).toContain("123 456.78 сомони");
    expect(result).not.toMatch(/застройщик|Synthetic/u);
  });
  it("preserves an explicitly requested unknown builder alongside the exact price", () => {
    const result = renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" },
      evidence: [{ ref: "e0", value: { kind: "facts", facts, kinds: ["price", "address", "builder"] } }],
      requestedFacts: ["price", "builder"], knownPhoneSource: "none", surface: "dm", language: "ru", maxOutputChars: 2000 })!;
    expect(result).toContain("123 456.78 сомони"); expect(result).toContain("Нет подтверждённых данных о застройщике");
    expect(result).not.toContain("Synthetic");
  });
});
