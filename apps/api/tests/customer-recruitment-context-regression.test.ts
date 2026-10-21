import { describe, expect, it } from "vitest";
import { recruitmentCatalogHash, selectedRecruitmentPosition } from "../src/ai/customerAgentRecruitmentProtocol.js";
import { renderCustomerAgentDecision } from "../src/ai/customerAgentRenderer.js";
import { legacyRecruitmentCatalogBlock } from "../src/ai/legacyRecruitmentCatalog.js";
import { recruitmentPositionTemplates } from "../src/lib/recruitmentPositionTemplates.js";

const positions = recruitmentPositionTemplates().map(row => ({ ...row, isOpen: true, revision: 1 }));
const facts = { collecting: true, positions };
const catalog = { kind: "open_vacancies" as const, ...facts, sourceHash: recruitmentCatalogHash(facts) };
const perception = { language: "tg" as const, speech: "clear" as const, subject: "person" as const,
  transcript: "Royal Home агенти фурӯши хона меҷӯяд. Ба кор қабул мекунем.", readableText: "ВАКАНСИЯ Агент",
  visible: ["furniture" as const] };
const render = (change = {}) => renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["e0", "e1"], social: "none", question: "none" },
  evidence: [{ ref: "e0", value: catalog }, { ref: "e1", value: structuredClone(catalog) }], language: "ru", requestedFacts: [],
  surface: "dm", knownPhoneSource: "none", maxOutputChars: 4000, inputText: "Вакансия видеографа актуальна?", ...change });

describe("actual recruitment failure mechanisms with synthetic facts", () => {
  it("renders identical prefetched/model-read catalogs once while preserving the requested role", () => {
    const text = render()!;
    expect(text.match(/Открыта вакансия:/gu)).toHaveLength(1);
    expect(text.match(/SMM-специалист \/ видеограф/gu)).toHaveLength(1);
    expect(text).not.toContain("оклада нет");
  });
  it("still validates an edited duplicate before deduplication", () => {
    expect(render({ evidence: [{ ref: "e0", value: catalog }, { ref: "e1", value: { ...catalog,
      positions: [{ ...positions[0], detailsRu: "invented" }] } }] })).toBeNull();
  });
  it("does not describe the recruiter's chair as the topic of an own vacancy reel", () => {
    const text = render({ inputText: "Дар бораи кор маълумот диҳед", language: "tg", mediaPerception: perception })!;
    expect(text).toContain("Агент"); expect(text).not.toContain("мебел");
    expect(text).not.toContain("SMM");
  });
  it("retains the visual description for actual property media", () => {
    const text = render({ inputText: "Что на фото?", evidence: [], decision: { kind: "reply", refs: [], social: "none", question: "none" },
      mediaPerception: { ...perception, speech: "none", transcript: "", readableText: "", language: "unknown", subject: "home_interior" } })!;
    expect(text).toContain("мебель");
  });
  it("matches configured CONTENT and repeated identical rows without inventing an ambiguous role", () => {
    expect(selectedRecruitmentPosition([...positions, ...positions], "Контент")?.key).toBe("smm-videographer");
    expect(selectedRecruitmentPosition([positions[0], { ...positions[0], revision: 2 }], "", positions[0].key)).toBeNull();
  });
  it("feeds both current roles and optional CV terms to the legacy prompt, separately from old agent-only defaults", () => {
    const text = legacyRecruitmentCatalogBlock(catalog, "Вакансия SMM");
    expect(text).toContain("SMM-специалист / видеограф");
    expect(text).toContain("Резюме необязательно");
    expect(text).toContain("с понедельника по субботу");
    expect(text).not.toContain("оклада нет");
    expect(() => legacyRecruitmentCatalogBlock({ ...catalog, sourceHash: "f".repeat(64) }, "")).toThrow();
  });
  it("keeps the vacancy from the preceding perceived reel on a later genuine generic question", () => {
    const text = render({ inputText: "Можно подробнее о работе?", verifiedContext: { surface: "dm", revisionId: "a".repeat(64),
      turns: [{ role: "user", text: perception.transcript }], publicState: { language: "ru", topic: "job", openQuestion: "none" } } })!;
    expect(text).toContain("Агент по недвижимости"); expect(text).toContain("оклада нет"); expect(text).not.toContain("SMM-специалист");
    const switched = render({ inputText: "Теперь интересует вакансия видеографа", verifiedContext: { surface: "dm", revisionId: "a".repeat(64),
      turns: [{ role: "user", text: perception.transcript }], publicState: { language: "ru", topic: "job", openQuestion: "none" } } })!;
    expect(switched).toContain("SMM-специалист"); expect(switched).not.toContain("оклада нет");
  });
});
