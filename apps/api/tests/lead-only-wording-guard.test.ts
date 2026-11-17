import { describe, expect, it } from "vitest";
import { leadOnlyOutgoing, leadOnlyPhraseCatalog, leadOnlyReply, leadOnlyReplyAvoidingRepeat, leadOnlyEscalateLine, leadOnlyCallbackNotedLine,
  leadOnlyNoCallNotedLine, leadOnlyNoAgentLine, leadOnlyGivenLineAvoidingRepeat, type LeadOnlyReplyInput, type LeadOnlyPhoneState } from "../src/ai/leadOnlyMode.js";
import { withoutAgreementOpenings, informalAddress, foreignLanguageWord } from "../src/ai/customerAgentHumanText.js";

/**
 * СТОРОЖ ФОРМУЛИРОВОК РЕЖИМА «ТОЛЬКО ЗАЯВКИ» (17.11.2026, «один мозг»).
 *
 * Ответ режима идёт мимо рендерера ядра, а значит и мимо его фильтра согласия: «Хорошо, …» / «Хуб, …» / «Конечно» / «Майлаш»
 * после «Скидку сделаете?» или «Беру за 900» читаются как «да». Каждая фраза режима, ru и tg, во всех сценариях и состояниях
 * номера проходит `withoutAgreementOpenings` без изменений, без обращения на «ты» и без слов другого языка. Цена и валюта —
 * данные из базы, не формулировка: перед проверкой языка вырезаются.
 */
const LANGUAGES = ["ru", "tg"] as const;
const DATA = /\d[\d  ]*(?:\s(?:USD|сомони|сомонӣ))?/gu;

function check(text: string, language: "ru" | "tg"): string[] {
  const problems: string[] = [];
  const agreement = withoutAgreementOpenings(text);
  if (agreement.removed.length) problems.push(`agreement opening: ${agreement.removed.join(" | ")}`);
  const informal = informalAddress(text, language);
  if (informal) problems.push(`informal address: ${informal}`);
  const foreign = foreignLanguageWord(text.replace(DATA, " "), language);
  if (foreign) problems.push(`foreign word: ${foreign}`);
  return problems.map(problem => `[${language}] «${text}»: ${problem}`);
}

const phoneStates: LeadOnlyPhoneState[] = [{ kind: "whatsapp" }, { kind: "given" }, { kind: "card" },
  ...[0, 1, 2, 3].flatMap(asksSoFar => [false, true].flatMap(refused => [false, true].map(officeAlreadyOffered =>
    ({ kind: "ask", asksSoFar, maxAsks: 2, officeAlreadyOffered, refused }) as LeadOnlyPhoneState)))];
const whens = [{ kind: "soon" }, { kind: "today_from", from: "09:30" }, { kind: "tomorrow_from", from: "09:30" }] as const;
const properties = [null, { shortId: 112, price: "520000", currency: "TJS", sold: false }, { shortId: 112, price: null, currency: "TJS", sold: false },
  { shortId: 112, price: "60000", currency: "USD", sold: true }];
const markets = [null, { districtName: "Сино", minPrice: "350000", currency: "TJS" }, { districtName: null, minPrice: "40000", currency: "USD" }];

function* composedReplies(language: "ru" | "tg"): Generator<string> {
  for (const scenario of ["hot", "property", "seller", "buyer", "escalate"] as const)
    for (const phone of phoneStates) for (const when of whens) for (const property of properties) for (const market of markets)
      for (const agentInformed of [undefined, true, false]) {
        const input: LeadOnlyReplyInput = { scenario, language, phone, when, property, market, sellerCommissionPercent: 2,
          ...(agentInformed === undefined ? {} : { agentInformed }) };
        yield leadOnlyReply(input);
        // Everything already said once: the repeat-avoiding variants (waiting line, short acknowledgements).
        const said: string[] = [];
        for (let round = 0; round < 6; round++) { const next = leadOnlyReplyAvoidingRepeat(input, said); yield next; said.push(next); }
      }
}
function* sequentialVariants(language: "ru" | "tg"): Generator<string> {
  const lines: Array<(sent: string[]) => string> = [
    sent => leadOnlyEscalateLine(language, true, sent), sent => leadOnlyEscalateLine(language, false, sent),
    sent => leadOnlyCallbackNotedLine(language, sent), sent => leadOnlyNoCallNotedLine(language, sent),
    sent => leadOnlyNoAgentLine({ ru: "завтра после 09:30", tg: "пагоҳ баъд аз соати 09:30" }, language, sent),
    sent => leadOnlyGivenLineAvoidingRepeat({ kind: "soon" }, language, sent),
    sent => leadOnlyGivenLineAvoidingRepeat({ kind: "tomorrow_from", from: "09:30" }, language, sent),
  ];
  for (const line of lines) { const sent: string[] = []; for (let round = 0; round < 8; round++) { const text = line(sent); yield text; sent.push(text); } }
}

describe("формулировки режима «только заявки»: без согласия, без «ты», без чужого языка", () => {
  it.each(LANGUAGES)("каталог фраз (%s)", language => {
    const catalog = leadOnlyPhraseCatalog(language);
    expect(catalog.length).toBeGreaterThan(30);
    expect(catalog.flatMap(text => check(text, language))).toEqual([]);
  });
  it.each(LANGUAGES)("все сценарии × состояния номера × объект × рынок (%s)", language => {
    const problems = new Set<string>();
    let count = 0;
    for (const text of composedReplies(language)) { count++; for (const problem of check(text, language)) problems.add(problem); }
    expect(count).toBeGreaterThan(1000);
    expect([...problems]).toEqual([]);
  });
  it.each(LANGUAGES)("варианты без повтора: передача, время звонка, «не звоните», без агента, «номер получил» (%s)", language => {
    const problems = new Set<string>();
    for (const text of sequentialVariants(language)) for (const problem of check(text, language)) problems.add(problem);
    expect([...problems]).toEqual([]);
  });
});

describe("последняя дверь текста режима (leadOnlyOutgoing)", () => {
  it("будущая фраза с согласием в начале теряет его; пустой ответ — нейтральное спасибо", () => {
    expect(leadOnlyOutgoing("Хорошо, передаю агенту.", "ru")).toBe("Передаю агенту.");
    expect(leadOnlyOutgoing("Хуб, ба агент мерасонам.", "tg")).toBe("Ба агент мерасонам.");
    expect(leadOnlyOutgoing("Конечно.", "ru")).toBe("Спасибо за ваше сообщение.");
    expect(leadOnlyOutgoing("Майлаш.", "tg")).toBe("Ташаккур барои паёматон.");
  });
  it("фактическое «да» перед содержанием остаётся (решение сервера по фактам)", () => {
    expect(leadOnlyOutgoing("Да, поможем продать. Комиссия агентства 2%.", "ru")).toBe("Да, поможем продать. Комиссия агентства 2%.");
    expect(leadOnlyOutgoing("Бале, вариантҳо ҳастанд, аз 350 000 сомонӣ.", "tg")).toBe("Бале, вариантҳо ҳастанд, аз 350 000 сомонӣ.");
  });
});
