import { describe, expect, it } from "vitest";
import { customerAgentVerifiedContextSchema, type CustomerPropertyFactKind } from "@royal-home/shared";
import { renderCustomerAgentDecision, customerAgentAddressLine, customerAgentProducedFixedLines, customerAgentPropertyQuestionTexts,
  type CustomerAgentEvidence } from "../src/ai/customerAgentRenderer.js";
import { customerAgentAttachmentQuestion, FOREIGN_SHARE_LINE } from "../src/ai/customerAgentAttachmentInput.js";
import { customerAgentPublicListingSignature, customerAgentSearchFit, type CustomerAgentSearchObservation } from "../src/ai/customerAgentPublicProtocol.js";
import { customerDmHistoryLanguage, resolveCustomerDmLanguage } from "../src/ai/customerDmLanguage.js";
import { classifyCustomerPropertyFactIntent } from "../src/lib/customerPropertyFactIntent.js";

// 08.11.2026, owner: the customer bot is "очень грубый и резкий". Production 05-07.11 (68 dialogs) showed the classes below;
// each test is one class, written against the renderer, so no model and no database are needed.

const hash = "a".repeat(64);
type Turn = { role: "user" | "assistant"; text: string };
const context = (turns: Turn[], language: "ru" | "tg" | "unknown" = "unknown") => customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: hash, turns,
  publicState: { language, topic: "buyer", openQuestion: "none" } });
const user = (text: string): Turn => ({ role: "user", text });
const bot = (text: string): Turn => ({ role: "assistant", text });
const facts = (kinds: CustomerPropertyFactKind[], publicAddress: string | null = "Сино, Душанбе"): CustomerAgentEvidence => ({ ref: "e0", value: { kind: "facts", kinds, facts: {
  propertyId: "00000000-0000-4000-8000-000000000192", shortId: 192, publicLink: null, publicAddress, addressPolicy: "district_city_only",
  price: "500000", currency: "TJS", availability: "AVAILABLE", builder: null, updatedAt: "2026-11-01T00:00:00.000Z", signature: "s".repeat(64),
  characteristics: { type: "APARTMENT", rooms: 2, areaSqm: "65", landAreaSotka: null, floor: 5, totalFloors: 9, condition: "GOOD", marketType: null, stage: null } } } as never });
function render(input: { language?: "ru" | "tg"; text?: string; turns?: Turn[] | null; evidence?: CustomerAgentEvidence[]; requestedFacts?: CustomerPropertyFactKind[];
  decision?: object; stored?: "ru" | "tg" | "unknown"; attachment?: { kinds: string[] }; knownPhone?: boolean; history?: string[] }) {
  const evidence = input.evidence ?? [];
  return renderCustomerAgentDecision({ decision: { kind: "reply", refs: evidence.map(e => e.ref), social: "none", question: "none", ...input.decision } as never,
    evidence, language: input.language ?? "ru", requestedFacts: input.requestedFacts ?? [], knownPhoneSource: input.knownPhone ? "scoped_contact" : "none",
    maxOutputChars: 4000, surface: "dm", inputText: input.text ?? "вопрос", attachmentInput: input.attachment as never,
    verifiedContext: input.turns === null ? undefined : context(input.turns ?? [], input.stored),
    ...(input.history ? { botMessages: input.history } : {}) });
}

describe("class 1: the exact address loop (seven identical 'Ҷойгиршавӣ: Сино, Душанбе.' to one customer)", () => {
  it("the district is a sentence that names the object and says the agent gives the exact address", () => {
    expect(customerAgentAddressLine({ shortId: 192, publicAddress: "Сино, Душанбе" }, "tg"))
      .toBe("Объекти №192 дар ноҳияи Сино, Душанбе ҷойгир аст. Суроғаи аниқ ва нишонаро агенти мо пеш аз тамошо мегӯяд.");
    expect(customerAgentAddressLine({ shortId: 192, publicAddress: "Сино, Душанбе" }, "ru"))
      .toBe("Объект №192 находится в районе Сино, Душанбе. Точный адрес и ориентир агент подскажет перед показом.");
    expect(customerAgentAddressLine({ shortId: 7, publicAddress: "Душанбе" }, "ru")).toBe("Расположение объекта №7: Душанбе. Точный адрес и ориентир агент подскажет перед показом.");
    expect(customerAgentAddressLine({ shortId: 7, publicAddress: null }, "tg")).toContain("агенти мо мегӯяд");
  });
  it("Tajik: the same address question seven times (as in production) never says 'Бори дигар такрор мекунам' and never repeats itself", () => {
    const said: string[] = [];
    let turns: Turn[] = [];
    for (let index = 0; index < 7; index++) {
      // The dialogue BEFORE this message as the server loads it: the memory window keeps the last six turns.
      // The message history (every bot reply) is passed as in production; the memory sees the last six turns only.
      const text = render({ language: "tg", text: "куҷо?", turns: turns.slice(-6), evidence: [facts(["address"])], requestedFacts: ["address"], history: [...said] })!;
      expect(text).not.toMatch(/Бори дигар|такрор мекунам|номафҳум|лутфан/iu);
      if (index > 0) expect(text).not.toBe(said[index - 1]);
      said.push(text); turns = [...turns, user("куҷо?"), bot(text)];
    }
    expect(said[0]).toMatch(/^Ассалому алайкум!\nОбъекти №192 дар ноҳияи Сино/u);
    expect(said[1]).toContain("Барои тамос кадом рақами телефонро мегузоред?");
    // Production: seven district lines. Now: exactly once, and the answers after it say why there is nothing more and who knows it.
    expect(said.filter(text => text.includes("ноҳияи Сино, Душанбе ҷойгир")).length).toBe(1);
    expect(said.filter(text => /рақами телефон/u.test(text)).length).toBeLessThanOrEqual(2);
    expect(new Set(said).size).toBeGreaterThanOrEqual(5);
  });
  it("a phone already known is not asked for again", () => {
    const first = render({ text: "где?", evidence: [facts(["address"])], requestedFacts: ["address"], knownPhone: true })!;
    const second = render({ text: "где?", turns: [user("где?"), bot(first)], evidence: [facts(["address"])], requestedFacts: ["address"], knownPhone: true })!;
    expect(second).not.toContain("номер телефона");
    expect(second).toContain("указан только район");
  });
  it("'Харид' answered by the model with the facts already given: never the bare «Ҷойгиршавӣ:» line, not the same reply again", () => {
    const first = render({ language: "tg", text: "нархаш чанд?", evidence: [facts(["price", "address"])] })!;
    const harid = render({ language: "tg", text: "Харид", turns: [user("нархаш чанд?"), bot(first)], evidence: [facts(["price", "address"])] })!;
    expect(harid).not.toContain("Ҷойгиршавӣ:");
    expect(harid).not.toBe(first);
    // Nothing was asked: the card the previous reply gave is not repeated; the way to the agent with the phone instead.
    expect(harid).not.toContain("500 000");
    expect(harid).toBe("Агар бо агент гап задан қулай бошад, бемалол рақами телефонатонро нависед, ӯ ба ҳамаи саволҳо ҷавоб медиҳад.");
    // «Хуб» next: still no card, and not the same reply twice in a row.
    const hub = render({ language: "tg", text: "Хуб", turns: [user("нархаш чанд?"), bot(first), user("Харид"), bot(harid)], evidence: [facts(["price", "address"])],
      history: [first, harid] })!;
    expect(hub).not.toContain("500 000");
    expect(hub).not.toBe(harid);
  });
  it("Tajik address words reach the server's fact read: суроға, ориентир, аниқ", () => {
    expect(classifyCustomerPropertyFactIntent("суроғааш куҷо?", { hasPropertyContext: true })).toEqual(["address"]);
    expect(classifyCustomerPropertyFactIntent("суроғаи аниқ", { hasPropertyContext: true })).toEqual(["address"]);
    expect(classifyCustomerPropertyFactIntent("точный адрес?", { hasPropertyContext: true })).toEqual(["address"]);
    expect(classifyCustomerPropertyFactIntent("ориентир?", { hasPropertyContext: true })).toEqual(["address"]);
  });
});

describe("class 2: the same sentence twice in one message", () => {
  const query = { type: "APARTMENT" as const, rooms: 2, budget: { max: "100000", currency: "TJS" as const } };
  const empty = (policy: string): CustomerAgentSearchObservation => ({ kind: "property_search", query, coverage: "bounded_ranked_pool", poolLimit: 500,
    policyHash: policy.repeat(64), cards: [] });
  it("two empty searches print the 'nothing found' line once", () => {
    const text = render({ language: "tg", turns: [bot("Салом!"), user("хона")], evidence: [{ ref: "e0", value: empty("c") }, { ref: "e1", value: empty("d") }] })!;
    expect(text.match(/Аз рӯи ин дархост ҳоло ягон вариант нест\./gu)).toHaveLength(1);
  });
  it("two cards in the same district keep both address lines (facts are never merged)", () => {
    const data = { type: "APARTMENT" as const, rooms: 2, districtName: "Сино" };
    const card = (id: number) => {
      const f = { propertyId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`, shortId: id, price: "90000.00", currency: "TJS" as const,
        availability: "AVAILABLE" as const, publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only" as const, builder: null, publicLink: null,
        updatedAt: "2026-11-01T00:00:00.000Z", signature: String(id % 10).repeat(64) };
      const listing = { ...data, signature: customerAgentPublicListingSignature(f.signature, data) };
      return { facts: f, listing, match: customerAgentSearchFit(query, listing, { cardTjs: 90000, minTjs: null, maxTjs: 100000 }) };
    };
    const value: CustomerAgentSearchObservation = { ...empty("c"), cards: [card(11), card(12)] };
    const text = render({ turns: [bot("Здравствуйте!"), user("двушка")], evidence: [{ ref: "e0", value }] })!;
    expect(text.match(/Расположение: Сино, Душанбе\./gu)).toHaveLength(2);
  });
});

describe("class 3: no greeting, no politeness", () => {
  it("the first answer of a dialogue says hello in the customer's language", () => {
    expect(render({ text: "цена?", evidence: [facts(["price"])], requestedFacts: ["price"] })).toMatch(/^Здравствуйте!\nЦена объекта №192/u);
    expect(render({ language: "tg", text: "нарх?", evidence: [facts(["price"])], requestedFacts: ["price"] })).toMatch(/^Ассалому алайкум!\nНархи объект №192/u);
  });
  it("later answers do not greet again; without the server context nothing is guessed", () => {
    expect(render({ text: "цена?", turns: [bot("Здравствуйте!"), user("цена?")], evidence: [facts(["price"])], requestedFacts: ["price"] })).not.toMatch(/Здравствуйте/u);
    expect(render({ text: "цена?", turns: null, evidence: [facts(["price"])], requestedFacts: ["price"] })).not.toMatch(/Здравствуйте/u);
  });
  it("a model 'Понял.' on the first turn becomes the greeting, not a cold acknowledgement", () => {
    expect(render({ text: "хочу квартиру", decision: { social: "acknowledge", question: "location" } })).toBe("Здравствуйте!\nКакой район вам подходит?");
  });
});

describe("class 4: language of a turn without words", () => {
  it("a foreign post on first contact: one short, softer answer in Tajik and Russian, no thanks (owner 30.10)", () => {
    const text = render({ text: "", attachment: { kinds: ["foreign_share"] }, turns: [], decision: { kind: "clarify", question: "clarify_previous" } })!;
    expect(text).toBe(`Ассалому алайкум!\n${FOREIGN_SHARE_LINE.tg}\nЗдравствуйте!\n${FOREIGN_SHARE_LINE.ru}`);
    expect(text).not.toContain("Эта публикация не наша.");
    expect(text).not.toMatch(/Спасибо|Ташаккур/u);
    // Earlier turns of only attachments say nothing about the language either: still both languages, no second greeting.
    const later = render({ text: "", attachment: { kinds: ["foreign_share"] }, turns: [user('{"incomingAttachments":["image"]}'), bot("Здравствуйте!")],
      decision: { kind: "clarify", question: "clarify_previous" } })!;
    expect(later).toBe(`${FOREIGN_SHARE_LINE.tg}\n${FOREIGN_SHARE_LINE.ru}`);
  });
  it("a Tajik dialogue keeps Tajik for an attachment without words", () => {
    // The turn resolves the language from history (lib/customerDmAgentTurn.ts) and the renderer keeps it: Tajik only.
    expect(customerDmHistoryLanguage(["ба ман хона лозим аст"])).toBe("tg");
    expect(resolveCustomerDmLanguage("", ["ба ман хона лозим аст"])).toBe("tg");
    const text = render({ language: "tg", text: "", attachment: { kinds: ["foreign_share"] }, turns: [user("ба ман хона лозим аст"), bot("Ассалому алайкум!")],
      decision: { kind: "clarify", question: "clarify_previous" } })!;
    expect(text).toBe(FOREIGN_SHARE_LINE.tg);
  });
  it("history helper: nothing decisive is null, the stored dialogue language counts", () => {
    expect(customerDmHistoryLanguage([])).toBeNull();
    expect(customerDmHistoryLanguage(['{"incomingAttachments":["share"]}'])).toBeNull();
    expect(customerDmHistoryLanguage([], "tg")).toBe("tg");
    expect(resolveCustomerDmLanguage("", [])).toBe("ru");
  });
});

describe("class 5: a photo with a fact question", () => {
  it("says the photo cannot be matched instead of the generic 'which object do you mean'", () => {
    const unresolved: CustomerAgentEvidence = { ref: "e0", value: { kind: "property_unresolved", status: "missing", reason: "no_reference" } };
    const text = render({ language: "tg", text: "нархаш чанд?", attachment: { kinds: ["image"] }, evidence: [unresolved], requestedFacts: ["price"],
      decision: { kind: "clarify", question: "property" }, turns: [bot("Салом!"), user("нархаш чанд?")] })!;
    expect(text).toBe("Аз рӯи акс объектро аниқ муайян карда наметавонам. Рақами объект ё пайванди эълонро фиристед.");
    // A bare number in the next message is still read as the answer to this question.
    expect(customerAgentPropertyQuestionTexts("tg")).toContain(text);
  });
});

describe("class guard: no fixed customer line carries the owner's banned wording", () => {
  // ai/agencyVoice.ts (owner 01.08, 16.08, 17.09.2026) and the no-dash rule for public texts.
  const BANNED = /[—–]|лутфан|илтимос|безаҳмат|муфассал|мутахассис|сипос|хоҳиш мекун|бори дигар такрор|повторю ещ[её] раз/iu;
  it("every fixed line the renderer can produce", () => {
    const bad = [...customerAgentProducedFixedLines()].filter(line => BANNED.test(line));
    expect(bad).toEqual([]);
  });
  it("every attachment question, address and fact line", () => {
    const lines: string[] = [];
    for (const language of ["ru", "tg"] as const) {
      for (const kind of ["image", "audio", "video", "document", "share", "foreign_share", "own_share_unlinked", "link", "ephemeral", "unknown"] as const) {
        for (const hasProperty of [false, true]) lines.push(customerAgentAttachmentQuestion({ kinds: [kind] }, language, hasProperty));
      }
      for (const kinds of [["price"], ["address"], ["builder"], ["characteristics"], ["availability"]] as CustomerPropertyFactKind[][]) {
        lines.push(render({ language, evidence: [facts(kinds)], requestedFacts: kinds, turns: [bot("x"), user("y")] }) ?? "");
      }
    }
    expect(lines.filter(line => BANNED.test(line))).toEqual([]);
  });
});
