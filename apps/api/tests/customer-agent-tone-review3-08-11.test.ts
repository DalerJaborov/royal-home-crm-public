import { describe, expect, it } from "vitest";
import { customerAgentVerifiedContextSchema, type CustomerPropertyFactKind } from "@royal-home/shared";
import { renderCustomerAgentDecision, customerAgentAddressLine, customerAgentAddressLoopLines, type CustomerAgentEvidence } from "../src/ai/customerAgentRenderer.js";

// Third review (cd2dd6b58, 08.11.2026). INVARIANT: every fact the customer asks for this turn and the card has is in the reply;
// the only exception is the exact address of an object whose address loop is open (the previous reply had its district line or
// one of its loop lines). Production-like dialogue: the core memory sees six turns, the history every bot reply.
type Turn = { role: "user" | "assistant"; text: string };
const context = (turns: Turn[]) => customerAgentVerifiedContextSchema.parse({ surface: "dm", revisionId: "a".repeat(64), turns,
  publicState: { language: "unknown", topic: "buyer", openQuestion: "none" } });
const card = (id: number) => ({ propertyId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`, shortId: id, publicLink: null,
  publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only", price: "500000", currency: "TJS", availability: "AVAILABLE", builder: null,
  updatedAt: "2026-11-01T00:00:00.000Z", signature: "s".repeat(64),
  characteristics: { type: "APARTMENT", rooms: 2, areaSqm: "65", landAreaSotka: null, floor: 5, totalFloors: 9, condition: "GOOD", marketType: null, stage: null } });
const facts = (id: number, kinds: CustomerPropertyFactKind[]): CustomerAgentEvidence => ({ ref: "e0", value: { kind: "facts", kinds, facts: card(id) } as never });

type Ask = { text: string; req: CustomerPropertyFactKind[]; ev?: CustomerPropertyFactKind[] };
const ASKS: Record<string, Ask> = {
  где: { text: "где?", req: ["address"] },
  цена: { text: "цена?", req: ["price"] },
  этаж: { text: "этаж?", req: ["characteristics"] },
  комнаты: { text: "сколько комнат?", req: ["characteristics"] },
  "цена и адрес": { text: "цена и адрес?", req: ["price", "address"] },
  карточка: { text: "расскажите", req: [], ev: ["price", "address", "characteristics"] },
};
function dialogue(language: "ru" | "tg" = "ru") {
  let turns: Turn[] = [];
  const said: string[] = [];
  return {
    said,
    ask(name: string, id = 192) {
      const ask = ASKS[name];
      const ev = [facts(id, ask.ev ?? ask.req)];
      const reply = renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" }, evidence: ev, language,
        requestedFacts: ask.req, knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm", inputText: ask.text,
        verifiedContext: context(turns.slice(-6)), recentBotMessage: said.length > 0, botMessages: [...said] })!;
      turns = [...turns, { role: "user", text: ask.text }, { role: "assistant", text: reply }];
      said.push(reply);
      return reply;
    },
  };
}
/** The fact lines a fresh answer to this question contains (no history, so no greeting/loop decisions besides the greeting). */
function expectedLines(name: string, id = 192): string[] {
  const ask = ASKS[name];
  const fresh = renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" }, evidence: [facts(id, ask.ev ?? ask.req)],
    language: "ru", requestedFacts: ask.req, knownPhoneSource: "none", maxOutputChars: 4000, surface: "dm", inputText: ask.text })!;
  return fresh.split("\n").filter(line => line.trim());
}
function checkInvariant(sequence: string[]) {
  const d = dialogue();
  for (const [index, name] of sequence.entries()) {
    const reply = d.ask(name), previous = index > 0 ? d.said[index - 1] : "";
    const address = customerAgentAddressLine(card(192), "ru"), loop = new Set(customerAgentAddressLoopLines(card(192)));
    for (const line of expectedLines(name)) {
      if (reply.split("\n").includes(line)) continue;
      // The one exception: the address, with the loop open by the previous reply, replaced by a loop line of this object.
      const loopOpen = previous.split("\n").some(prior => prior === address || loop.has(prior));
      expect({ sequence, turn: index, missing: line, exception: line === address && loopOpen && reply.split("\n").some(part => loop.has(part)) })
        .toMatchObject({ exception: true });
    }
  }
}

describe("review3 A/B/C: the facts asked are in the reply", () => {
  it("A: card → «где?» → «где?» → «цена и адрес?»: the price is there", () => {
    const d = dialogue();
    for (const name of ["карточка", "где", "где"]) d.ask(name);
    const reply = d.ask("цена и адрес");
    expect(reply).toContain("Цена объекта №192: 500 000 сомони.");
    expect(reply).toMatch(/№192/u);
  });
  it("B: card → «цена?» → «цена?» → «этаж?»: the floor is there, no «want to know more» line", () => {
    const d = dialogue();
    for (const name of ["карточка", "цена", "цена"]) d.ask(name);
    const reply = d.ask("этаж");
    expect(reply).toContain("Этаж: 5 из 9.");
    expect(reply).not.toMatch(/хочется узнать больше|Больше данных/u);
  });
  it("«где?» right after the full card: the loop line names the district (final review)", () => {
    const d = dialogue();
    d.ask("карточка");
    expect(d.ask("где")).toContain("По объекту №192 в карточке указан только район Сино, Душанбе: точный адрес и ориентир подскажет агент перед показом.");
    const tg = dialogue("tg");
    tg.ask("карточка");
    expect(tg.ask("где")).toContain("Дар карточкаи объекти №192 танҳо ноҳия нишон дода шудааст: Сино, Душанбе.");
  });
  it("«Харид»/«Хуб»/«Ок» after the card: the card is not repeated, the way to the agent is", () => {
    const d = dialogue();
    d.ask("карточка");
    for (let i = 0; i < 3; i++) {
      const reply = d.ask("карточка");
      expect(reply).not.toContain("Цена объекта №192");
      expect(reply).not.toBe(d.said.at(-2));
    }
  });
  it("C: card → «этаж?» → «цена?» → the first «где?»: the district is there", () => {
    const d = dialogue();
    for (const name of ["карточка", "этаж", "цена"]) d.ask(name);
    expect(d.ask("где")).toContain("Объект №192 находится в районе Сино, Душанбе.");
  });
  it("C': a customer back days later: an old district line in the history does not open the loop", () => {
    const d = dialogue();
    d.ask("где"); d.ask("цена");
    expect(d.ask("где")).toContain("Объект №192 находится в районе Сино, Душанбе.");
  });
  it("a repeated ordinary fact is given again (behind «Напомню:» when the reply would equal the previous one)", () => {
    const d = dialogue();
    d.ask("цена");
    const again = d.ask("цена");
    expect(again).toContain("Цена объекта №192: 500 000 сомони.");
    expect(again).not.toBe(d.said[0]);
    const third = d.ask("цена");
    expect(third).toContain("Цена объекта №192: 500 000 сомони.");
    expect(third).not.toBe(again);
  });
  it("another object's address is a new answer even inside a loop", () => {
    const d = dialogue();
    d.ask("где"); d.ask("где");
    expect(d.ask("где", 250)).toContain("Объект №250 находится в районе Сино, Душанбе.");
  });
});

describe("review3 invariant: every sequence of up to 4 questions about one object", () => {
  const names = ["где", "цена", "этаж", "комнаты", "цена и адрес"];
  const sequences: string[][] = [];
  const grow = (prefix: string[]) => { if (prefix.length) sequences.push(prefix); if (prefix.length < 4) for (const name of names) grow([...prefix, name]); };
  grow([]);
  it(`holds for all ${sequences.length} sequences`, () => {
    expect(sequences.length).toBe(5 + 25 + 125 + 625);
    for (const sequence of sequences) checkInvariant(sequence);
    // And after the card, too.
    for (const sequence of sequences.filter(s => s.length <= 3)) checkInvariant(["карточка", ...sequence]);
  });
});

describe("review3: ten identical «где?»", () => {
  it.each(["ru", "tg"] as const)("%s: district once, phone at most twice, never the same reply twice in a row", language => {
    const d = dialogue(language);
    for (let i = 0; i < 10; i++) d.ask("где");
    const district = language === "tg" ? "дар ноҳияи Сино, Душанбе ҷойгир" : "находится в районе Сино, Душанбе";
    expect(d.said.filter(text => text.includes(district))).toHaveLength(1);
    expect(d.said.filter(text => /номер телефона|рақами телефон/u.test(text)).length).toBeLessThanOrEqual(2);
    for (let i = 1; i < d.said.length; i++) expect(d.said[i]).not.toBe(d.said[i - 1]);
  });
});
