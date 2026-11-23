import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { AGAIN_LEAD, customerAgentAnswerVerdict, customerAgentLastDoor, renderCustomerAgentDecision, renderCustomerAgentDecisionChecked } from "../src/ai/customerAgentRenderer.js";
import { renderCustomerAgentText } from "../src/ai/customerAgentCore.js";
import { readCustomerAgentCompanyKnowledge } from "../src/lib/customerAgentPublicReads.js";
import { customerAgentCompanyKnowledgeHash } from "../src/ai/customerAgentPublicProtocol.js";
import { HUMAN_PHRASES, humanPhraseGroups, humanPhraseOnlyAgrees, withoutAgreementOpenings } from "../src/ai/customerAgentHumanText.js";
import { validateCustomerAgentSay, CUSTOMER_AGENT_SAY_GUIDANCE } from "../src/ai/customerAgentSay.js";
import { GUARD_LABELS } from "../src/ai/guardMetrics.js";
import { customerAgentSayDropReasonSchema } from "@royal-home/shared";
import { prisma } from "../src/db.js";

/**
 * Seventh review of #211 (17.11.2026, HEAD 40a472cb; scratchpad/r7/p1–p6 of the review session).
 *  п.1 The repeat lead went on top of the template's own thanks: «Спасибо за ваш вопрос.\nСпасибо!\nЦена…». One meaning once now holds
 *      for the server's text too.
 *  п.2 The last door cut a consent word with no mark after it: «Согласны ли вы на звонок?» → «Ли вы на звонок?». Only a word that stands
 *      alone (a mark or the end follows) is cut; a guard runs the door over EVERY Cyrillic literal of the files the renderer and the
 *      core import (the reviewer's p3) and fails on any change but the explicit list below.
 *  п.3 A `say` with an agreement word is refused by the say check (reason `agree`, a counter); the error journal gets only a cut of a
 *      SERVER template line.
 *  п.4 The Tajik repeat lead was also a vetted model lead; a model that said it made the next repeat read «already said once more».
 *  п.5 An agreement-only phrase («Конечно», «Да», «Бале», «Албатта», …) has the reason `agree`, not `claim`.
 */
const hash = "a".repeat(64);
const kh = customerAgentCompanyKnowledgeHash(readCustomerAgentCompanyKnowledge());
const facts = { propertyId: "00000000-0000-4000-8000-000000000001", shortId: 123, price: "1250000", currency: "TJS", availability: "AVAILABLE",
  publicAddress: "Сино, Душанбе", addressPolicy: "district_city_only", builder: null, publicLink: null, updatedAt: "2026-10-15T00:00:00.000Z", signature: hash };
const price = [{ ref: "e0", value: { kind: "facts", facts, kinds: ["price"] } }];
type Turn = { role: "user" | "assistant"; text: string };
const input = (o: { language: "ru" | "tg"; inputText: string; turns?: Turn[]; social?: string; question?: string; evidence?: unknown[]; answer?: unknown; say?: string;
  requestedFacts?: string[] }) => {
  const evidence = o.evidence ?? [];
  const decision = { kind: "reply", refs: evidence.length ? ["e0"] : [], social: o.social ?? "none", question: o.question ?? "none",
    ...(o.answer === undefined ? {} : { answer: o.answer }), ...(o.say === undefined ? {} : { say: o.say }) };
  return { knownPhoneSource: "none", maxOutputChars: 2000, surface: "dm", knowledgeSourceHash: kh, language: o.language, inputText: o.inputText,
    requestedFacts: o.requestedFacts ?? (evidence.length ? ["price"] : []), evidence, decision,
    ...(o.turns ? { verifiedContext: { surface: "dm", revisionId: hash, publicState: { topic: "unknown" }, turns: o.turns } } : {}) } as never;
};
const verdict = (o: Parameters<typeof input>[0]) => customerAgentAnswerVerdict(input(o)) as { ok: boolean; text?: string; reason?: string } | null;
const lines = (text: string | null) => (text ?? "").split("\n").map(line => line.trim()).filter(Boolean);
const QUESTION = { ru: "Цена объекта 123?", tg: "Нархи объекти 123 чанд?" } as const;

describe("п.1 one meaning once in the server's text: one thanks when the question is asked again", () => {
  it.each(["ru", "tg"] as const)("%s: the repeat lead replaces the template's own thanks, the facts stay", language => {
    const inputText = QUESTION[language];
    const first = renderCustomerAgentDecision(input({ language, inputText, evidence: price, social: "thank" }))!;
    expect(lines(first)[0]).toBe(language === "ru" ? "Спасибо!" : "Ташаккур!");
    const again = renderCustomerAgentDecision(input({ language, inputText, evidence: price, social: "thank", turns: [{ role: "user", text: inputText }, { role: "assistant", text: first }] }))!;
    expect(again).toBe([AGAIN_LEAD[language], ...lines(first).slice(1)].join("\n"));
    expect(lines(again).filter(line => humanPhraseGroups(line).includes("thanks"))).toEqual([AGAIN_LEAD[language]]);
    // The third ask: the lead is the marker, the facts go once more (requested), still one thanks at most.
    const third = renderCustomerAgentDecision(input({ language, inputText, evidence: price, social: "thank",
      turns: [{ role: "user", text: inputText }, { role: "assistant", text: first }, { role: "user", text: inputText }, { role: "assistant", text: again }] }))!;
    expect(lines(third).filter(line => humanPhraseGroups(line).includes("thanks")).length).toBeLessThanOrEqual(1);
  });
  it("no thanks of its own: the facts after the lead, unchanged (review6 case)", () => {
    for (const language of ["ru", "tg"] as const) {
      const inputText = QUESTION[language];
      const first = renderCustomerAgentDecision(input({ language, inputText, evidence: price }))!;
      const again = renderCustomerAgentDecision(input({ language, inputText, evidence: price, turns: [{ role: "user", text: inputText }, { role: "assistant", text: first }] }));
      expect(again).toBe(`${AGAIN_LEAD[language]}\n${first}`);
    }
  });
});

describe("п.2 the last door cuts only a consent word that stands alone", () => {
  it.each(["Согласны ли вы на звонок?", "Розӣ ҳастед, ки агент занг занад?", "Хуб аст, ки навиштед.", "Хорошо, что вы написали.", "Хуб, ки навиштед.",
    "Принято считать, что цена окончательная.", "Сделаем всё, чтобы найти вариант.", "Хорошо подходит для семьи с детьми.", "Хорошо?",
    "Албатта занг мезанем, агар хоҳед.", "Без проблем доедете на маршрутке.", "Отлично подходит под ипотеку."])("unchanged: %j", text => {
    expect(withoutAgreementOpenings(text)).toEqual({ text, removed: [] });
  });
  it.each([["Хорошо, принято.", ""], ["Конечно!", ""], ["Майлаш", ""], ["«Хорошо», понял.", "Понял."], ["Хорошо — понял.", "Понял."], ["Ок. Цена 900 000.", "Цена 900 000."],
    ["Конечно, цена 1 250 000 сомони за 95 м².", "Цена 1 250 000 сомони за 95 м²."], ["Без проблем, обязательно позвоним.", "Обязательно позвоним."]])("%j → %j", (text, expected) => {
    expect(withoutAgreementOpenings(text).text).toBe(expected);
  });

  /**
   * THE GUARD (CI): every Cyrillic string literal of every file the renderer and the core import (transitively, the shared package
   * included) passes the last door unchanged, except the explicit list: retired lines kept only for the memory of older chats, and the
   * one-word dictionaries the guards themselves match against (never a customer sentence). A new template line that the door would cut
   * fails here, before a customer ever sees it.
   */
  const ALLOWED: Record<string, readonly string[]> = {
    // RETIRED_AGAIN_LEAD: memory of older chats, never rendered.
    "apps/api/src/ai/customerAgentRenderer.ts": ["Конечно.", "Бале."],
    // RETIRED_AGREEMENT_LINES: memory of older chats, never rendered.
    "apps/api/src/ai/customerAgentLiveWording.ts": ["Хорошо, принято.", "Хуб, қабул шуд.", "Хорошо, записал.", "Хуб, қайд кардам.", "Конечно.", "Бале."],
    // Word lists of the checks themselves.
    "apps/api/src/ai/customerAgentHumanText.ts": ["хорошо", "конечно", "ладно", "да", "можно", "отлично", "хуб", "бале", "мешавад", "бемалол", "майлаш", "ага", "ха", "ҳа",
      "мумкин", "разумеется", "албатта", "ҳатман", "сделаем", "123бемалол123"],
    "apps/api/src/ai/customerDmLanguage.ts": ["ок", "окей", "хорошо", "ладно", "да", "ага", "отлично", "хуб", "майлаш", "бале", "ха"],
    // A status label of the staff screens («Принято» = request accepted), not a customer text.
    "packages/shared/src/propertyChangeRequest.ts": ["Принято"],
  };
  it("guard: the last door changes no Cyrillic literal of the renderer / core import graph but the explicit list", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..").split("\\").join("/") + "/";
    const resolveImport = (from: string, spec: string) => {
      if (spec.startsWith("@royal-home/shared")) return root + "packages/shared/src/index.ts";
      if (!spec.startsWith(".")) return null;
      const path = resolve(dirname(from), spec).split("\\").join("/").replace(/[.]js$/u, ".ts");
      return [path, `${path}.ts`, `${path}/index.ts`].find(candidate => candidate.endsWith(".ts") && existsSync(candidate)) ?? null;
    };
    const seen = new Set<string>(), queue = [root + "apps/api/src/ai/customerAgentRenderer.ts", root + "apps/api/src/ai/customerAgentCore.ts"];
    const changed: string[] = [];
    let literals = 0;
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file) || file.includes("/generated/")) continue;
      seen.add(file);
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const relative = file.slice(root.length);
      const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const target = resolveImport(file, node.moduleSpecifier.text);
          if (target) queue.push(target);
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          const target = resolveImport(file, node.arguments[0].text);
          if (target) queue.push(target);
        }
        let text: string | null = null;
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
        else if (ts.isTemplateExpression(node)) text = node.head.text + node.templateSpans.map(span => `123${span.literal.text}`).join("");
        if (text !== null && /\p{Script=Cyrillic}/u.test(text)) {
          literals++;
          if (withoutAgreementOpenings(text).removed.length && !(ALLOWED[relative] ?? []).includes(text)) changed.push(`${relative}: ${JSON.stringify(text.slice(0, 160))}`);
        }
        if (!ts.isTemplateExpression(node)) ts.forEachChild(node, visit);
        else node.templateSpans.forEach(span => visit(span.expression));
      };
      visit(source);
    }
    expect(seen.size).toBeGreaterThan(150);
    expect(literals).toBeGreaterThan(3000);
    expect(changed).toEqual([]);
  });
});

describe("п.3 a model agreement word is the model's mistake: refused by its own check, counted, never the error journal", () => {
  it("say «Хорошо, понимаю вас.» → reason agree; the reply goes out without it and with nothing to report", () => {
    expect(validateCustomerAgentSay({ say: "Хорошо, понимаю вас.", language: "ru", surface: "dm", inputText: "Беру за 900" })).toEqual({ ok: false, reason: "agree" });
    for (const say of ["Ок, понимаю вас.", "Ладно, понимаю вас.", "Понимаю вас, хорошо."]) {
      expect(validateCustomerAgentSay({ say, language: "ru", surface: "dm", inputText: "Беру за 900" })).toEqual({ ok: false, reason: "agree" });
    }
    const rendered = renderCustomerAgentDecisionChecked(input({ language: "ru", inputText: "Беру за 900", say: "Хорошо, понимаю вас.", social: "acknowledge" }));
    expect(rendered.agreement).toEqual([]);
    expect(rendered.text ?? "").not.toMatch(/хорошо/iu);
    expect(customerAgentSayDropReasonSchema.options).toContain("agree");
    expect(GUARD_LABELS.say_dropped_agree).toMatch(/согласия/u);
    // The model is told what the server refuses (owner rule: never ask the model for what the server drops).
    expect(CUSTOMER_AGENT_SAY_GUIDANCE).toMatch(/без слов согласия/u);
  });
  it("the core writes no journal row for the model's agreement word", async () => {
    const where = { message: { contains: "«Хорошо, понимаю вас.»" } };
    const before = await prisma.errorLog.count({ where });
    expect(renderCustomerAgentText(input({ language: "ru", inputText: "Беру за 900", say: "Хорошо, понимаю вас.", social: "acknowledge" }))).not.toMatch(/хорошо/iu);
    await new Promise(done => setTimeout(done, 1_000));
    expect(await prisma.errorLog.count({ where })).toBe(before);
  });
  it("the last door reports only what the SERVER template said", () => {
    const limits = { language: "ru", maxOutputChars: 2000 } as const;
    // A template line with consent: cut and reported.
    expect(customerAgentLastDoor("Хорошо, принято.\nЦена 900 000.", () => "Хорошо, принято.\nЦена 900 000.", limits))
      .toEqual({ text: "Цена 900 000.", agreement: ["Хорошо, принято."] });
    // The model's sentence (absent from the template): cut, never reported.
    expect(customerAgentLastDoor("Хорошо, понимаю вас.\nЦена 900 000.", () => "Цена 900 000.", limits))
      .toEqual({ text: "Понимаю вас.\nЦена 900 000.", agreement: [] });
    // Nothing cut: the template is never rendered a second time.
    let reads = 0;
    expect(customerAgentLastDoor("Цена 900 000.", () => { reads++; return null; }, limits)).toEqual({ text: "Цена 900 000.", agreement: [] });
    expect(reads).toBe(0);
  });
});

describe("п.4 the repeat lead is never a phrase the model may write", () => {
  it("AGAIN_LEAD is in no vetted list (exact) and is no vetted lead in any spelling", () => {
    const key = (text: string) => text.toLowerCase().replace(/[.,!…«»"':;]/gu, " ").replace(/\s+/gu, " ").trim();
    for (const language of ["ru", "tg"] as const) {
      for (const role of ["lead", "close"] as const) for (const [text] of HUMAN_PHRASES[language][role]) {
        expect(text).not.toBe(AGAIN_LEAD.ru);
        expect(text).not.toBe(AGAIN_LEAD.tg);
      }
      for (const lead of [...HUMAN_PHRASES.ru.lead, ...HUMAN_PHRASES.tg.lead]) expect(key(lead[0])).not.toBe(key(AGAIN_LEAD[language]));
    }
    expect(AGAIN_LEAD.tg).toBe("Раҳмат барои саволатон.");
  });
  it("tg: the model's own «Ташаккур барои саволатон.» before the facts does not count as the repeat already said", () => {
    const language = "tg", inputText = QUESTION.tg;
    const facts = renderCustomerAgentDecision(input({ language, inputText, evidence: price }))!;
    const modelTurn = `Ташаккур барои саволатон.\n${facts}`;
    const turns: Turn[] = [{ role: "user", text: inputText }, { role: "assistant", text: modelTurn }];
    // Nothing requested this turn: before, the model's phrase read as the marker and the turn went to a person.
    const again = renderCustomerAgentDecision(input({ language, inputText, evidence: price, requestedFacts: [], turns }));
    expect(again).toBe(facts);
    // The real marker still works: after the server's own repeat lead the next ask goes to a person.
    const afterLead = renderCustomerAgentDecision(input({ language, inputText, evidence: price, requestedFacts: [],
      turns: [{ role: "user", text: inputText }, { role: "assistant", text: `${AGAIN_LEAD.tg}\n${facts}` }] }));
    expect(afterLead).not.toBe(facts);
    expect(afterLead).not.toContain(AGAIN_LEAD.tg);
  });
});

describe("п.5 an agreement-only phrase has the reason `agree`", () => {
  const ONLY = { ru: ["Конечно.", "Конечно!", "Да.", "Да, конечно!", "Отлично!", "Договорились.", "Сделаем.", "Хорошо."],
    tg: ["Бале.", "Албатта.", "Ҳатман.", "Бале, албатта.", "Хуб.", "Майлаш."] } as const;
  it.each((["ru", "tg"] as const).flatMap(language => ONLY[language].map(text => [language, text] as const)))("%s %j: answer lead and close → agree", (language, text) => {
    expect(humanPhraseOnlyAgrees(text)).toBe(true);
    for (const role of ["lead", "close"] as const) {
      expect(verdict({ language, inputText: language === "ru" ? "Беру за 900 тысяч" : "Мегирам", evidence: price, answer: { [role]: text } })).toEqual({ ok: false, reason: "agree" });
    }
  });
  it.each(["Конечно!", "Да.", "Договорились.", "Хорошо."])("say (ru) %j → agree", say => {
    expect(validateCustomerAgentSay({ say, language: "ru", surface: "dm", inputText: "Беру" })).toEqual({ ok: false, reason: "agree" });
  });
  it("a fact keeps its own reason: «Да, свободен.» is a claim, not an agreement only", () => {
    expect(humanPhraseOnlyAgrees("Да, свободен.")).toBe(false);
    expect(verdict({ language: "ru", inputText: "Свободен?", question: "budget", answer: { lead: "Да, свободен." } })?.reason).toBe("claim");
    expect(humanPhraseOnlyAgrees("Понимаю вас.")).toBe(false);
    expect(humanPhraseOnlyAgrees("")).toBe(false);
  });
});
