import { describe, expect, it } from "vitest";
import { loadCorpusDir, selectScenarios, SYNTHETIC_CORPUS_DIR } from "./corpus.js";

// Guards the committed synthetic corpus: it must parse against the scenario schema, keep unique ids and the agreed minimum volume per category.
const MINIMUM: Record<string, number> = { buyer: 60, seller: 40, job: 50, comment: 40, link: 30, media: 20, language: 30, abuse: 15, injection: 15, "multi-turn": 20 };
describe("synthetic attack corpus", () => {
  const all = loadCorpusDir(SYNTHETIC_CORPUS_DIR);
  it("is at least 300 scenarios and parses against the schema", () => { expect(all.length).toBeGreaterThanOrEqual(300); });
  it.each(Object.entries(MINIMUM))("category %s has at least %i scenarios", (category, minimum) => {
    expect(selectScenarios(all, { category }).length).toBeGreaterThanOrEqual(minimum);
  });
  it("covers both languages and both surfaces", () => {
    const texts = all.flatMap(scenario => scenario.turns.map(turn => turn.in));
    expect(texts.some(text => /[ҳқӣӯғҷ]/u.test(text))).toBe(true);
    expect(texts.some(text => /[a-z]{4,}.*[a-z]{4,}/i.test(text) && !/[а-я]/iu.test(text))).toBe(true);
    expect(new Set(all.map(scenario => scenario.surface))).toEqual(new Set(["dm", "public_comment"]));
  });
  it("contains only obviously fake phone numbers", () => {
    const phones = all.flatMap(scenario => scenario.turns.flatMap(turn => turn.in.match(/\+?\d[\d\s()-]{8,}\d/g) ?? [])).map(phone => phone.replace(/\D/g, "")).filter(digits => digits.length <= 12); // longer runs are post/video ids in links
    for (const phone of phones) expect(phone).toMatch(/^(?:901112233|900000000)$/);
  });
});
