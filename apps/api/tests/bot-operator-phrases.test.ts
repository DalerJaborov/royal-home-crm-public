import { describe, expect, it } from "vitest";
import { OPERATOR_PHRASES, renderOperatorStep } from "../src/ai/operator/phrases.js";
import { OPERATOR_PHRASE_KEYS, type OperatorLanguage, type PhraseKey, type PhraseVars } from "../src/ai/operator/types.js";
import { withoutAgreementOpenings } from "../src/ai/customerAgentHumanText.js";
import { foldCustomerText } from "../src/ai/customerAgentRole.js";
import { promisesAgentContact } from "../src/ai/callbackPromiseGuard.js";

/**
 * СТОРОЖ ФРАЗ ОПЕРАТОРА (docs/bot-operator/SPEC.md: «Чего бот не делает никогда», «Тон», «Фразы»).
 * Каждый вариант каждого ключа на обоих языках, с подстановкой образцовых переменных. Новый ключ без образца
 * переменных или без таджикской версии этот тест не пропустит.
 */
const SAMPLE: Readonly<Record<PhraseKey, PhraseVars>> = {
  greet: {}, greet_assalom: {}, ask_role: {}, buyer_free: {}, identity: { brand: "Arvan estate" }, bot_identity: {},
  seller_intro: { percent: 2 }, seller_commission: { percent: 2 },
  lead_and_details_seller: { when: "завтра с 09:30" }, lead_and_details_buyer: { when: "завтра с 09:30" },
  lead_and_details_missing: { when: "завтра с 09:30", missing: ["district", "budget"] }, office_phone: { phone: "+992 00 000 00 02" },
  property_price: { id: 164, price: "520 000 сомони" },
  property_no_price: { id: 164 }, property_sold: { id: 164 }, bargain: {}, lead_known_phone: { when: "завтра с 09:30" },
  lead_callback: { time: "с 11:00 до 14:30" }, lead_text_only: { where: "WHATSAPP" }, ask_phone: {}, phone_received: { when: "в ближайшее время" },
  out_of_area_accepted: {}, callback_noted: { time: "с 11:00 до 14:30" }, text_only_noted: { where: "HERE" }, note_added: {}, welcome: {},
  where_work: {}, rent_refusal: {}, photo_ack: {}, voice_failed: {}, foreign_post: {}, jobs_list: { list: ["менеджер по продажам", "SMM-специалист"] },
  job_open: { position: "менеджер по продажам" }, job_closed: { position: "SMM", list: ["менеджер по продажам"] }, jobs_none: {},
  job_contact: { phone: "+992 00 000 00 01" }, no_call_ack: {}, rude_calm: {}, off_topic: {}, complaint_ack: {},
  bargain_seller: {}, no_agent_noted: { when: "завтра с 09:30" },
  question_noted: {}, lead_status: {}, lead_reminder: {}, work_hours: { from: "10:00", to: "22:30" }, reviewer_reset: {},
  media_received: {}, property_place: { id: 164, place: "Сино, Душанбе" },
  property_place_price: { id: 164, place: "Сино, Душанбе", price: "520 000 сомони" }, place_by_agent: {}, details_by_agent: {},
  offer_call: {}, got_it: {}, ask_phone_seller: {}, role_details_buyer: {}, role_details_seller: {},
  role_details_missing: { missing: ["district", "budget"] }, phone_where: {}, topic_by_agent: {},
  callback_time_noted: { wish: "завтра в 13:00" }, lead_callback_time: { wish: "завтра в 13:00" },
  property_details: { id: 164, facts: "комнат: 3, площадь: 95 м², этаж: 5 из 9" },
  property_details_price: { id: 164, facts: "комнат: 3, площадь: 95 м², этаж: 5 из 9", price: "520 000 сомони" },
};
const LANGUAGES: readonly OperatorLanguage[] = ["ru", "tg"];
/** Вопрос («?») — только у вопроса о роли: тогда в ответе из двух шагов вопрос всегда один. */
const QUESTION_KEYS: ReadonlySet<PhraseKey> = new Set(["ask_role"]);
const MAX_LENGTH = 160;
/** Ключи, где два одинаковых варианта — решение ведущего (19.11: «Здравствуйте!» оба раза), а не забытая правка. */
const SAME_VARIANTS_OK: ReadonlySet<string> = new Set(["greet/ru"]);
/** Слова, запрещённые владельцем в таджикских текстах (tajik-phrasebook: do-not-say.md, SKILL.md). */
const TG_BANNED = /(?:^|[^\p{L}])(?:лутфан|безахмат|мутахассис\p{L}*|муфассал\p{L}*|кулай\p{L}*|хохиш\s+мекунем|ту)(?![\p{L}])/u;
const RU_BANNED = /(?:^|[^\p{L}])(?:ты|тебе|тебя|уникальн\p{L}*|успейте|лучшие\s+условия|вернусь|через\s+\d+\s+минут\p{L}*|удобно\?)(?![\p{L}])/iu;
const EMOJI = /\p{Extended_Pictographic}/u;

function rendered(): Array<{ key: PhraseKey; language: OperatorLanguage; variant: number; text: string }> {
  return OPERATOR_PHRASE_KEYS.flatMap(key => LANGUAGES.flatMap(language => OPERATOR_PHRASES[key][language].map((_, variant) =>
    ({ key, language, variant, text: renderOperatorStep({ key, vars: SAMPLE[key], variant }, language) }))));
}

describe("сторож фраз оператора", () => {
  it("у каждого ключа обе версии, по 2–3 варианта, и варианты не повторяют друг друга", () => {
    for (const key of OPERATOR_PHRASE_KEYS) for (const language of LANGUAGES) {
      const variants = OPERATOR_PHRASES[key]?.[language];
      expect(variants, `${key}/${language}`).toBeDefined();
      expect(variants!.length, `${key}/${language}`).toBeGreaterThanOrEqual(2);
      expect(variants!.length, `${key}/${language}`).toBeLessThanOrEqual(3);
      if (!SAME_VARIANTS_OK.has(`${key}/${language}`)) expect(new Set(variants).size, `${key}/${language}`).toBe(variants!.length);
    }
    expect(Object.keys(OPERATOR_PHRASES).sort()).toEqual([...OPERATOR_PHRASE_KEYS].sort());
  });

  it("ни «Рудаки / Рӯдакӣ», ни «—», ни смайликов, ни «Royal Home» строкой в шаблоне", () => {
    for (const key of OPERATOR_PHRASE_KEYS) for (const language of LANGUAGES) for (const template of OPERATOR_PHRASES[key][language]) {
      expect(foldCustomerText(template), `${key}/${language}: ${template}`).not.toMatch(/рудаки|rudaki/u);
      expect(template, `${key}/${language}`).not.toMatch(/[—–]/u);
      expect(template, `${key}/${language}`).not.toMatch(EMOJI);
      expect(template, `${key}/${language}`).not.toMatch(/royal\s*home|arvan/iu);
    }
  });

  it("каждый вариант — одно предложение до 160 знаков, «?» только у вопроса о роли", () => {
    for (const { key, language, text } of rendered()) {
      const where = `${key}/${language}: ${text}`;
      expect(text.length, where).toBeLessThanOrEqual(MAX_LENGTH);
      expect(text, where).toMatch(/[.!?]$/u);
      const sentences = text.split(/(?<=[.!?])\s+(?=\p{Lu})/u).filter(Boolean);
      expect(sentences.length, where).toBe(1);
      const questions = (text.match(/\?/gu) ?? []).length;
      expect(questions, where).toBe(QUESTION_KEYS.has(key) ? 1 : 0);
      expect(text, where).not.toMatch(/\{\w+\}/u);
    }
  });

  it("на «вы» / «шумо», без запрещённых слов и штампов продавца", () => {
    for (const { key, language, text } of rendered()) {
      const folded = foldCustomerText(text);
      if (language === "tg") expect(folded, `${key}: ${text}`).not.toMatch(TG_BANNED);
      else expect(text, `${key}: ${text}`).not.toMatch(RU_BANNED);
    }
  });

  it("последняя дверь режима (без начала-согласия) фразу не меняет: «Хорошо, …» / «Хуб, …» / «Да, …» не бывает", () => {
    for (const { key, language, text } of rendered()) {
      expect(withoutAgreementOpenings(text).text, `${key}/${language}`).toBe(text);
    }
  });

  it("покупателю ни одна фраза не называет комиссию; комиссия — только во фразах продавца", () => {
    const commissionKeys = new Set(rendered().filter(row => /%|комисси/iu.test(row.text)).map(row => row.key));
    expect([...commissionKeys].sort()).toEqual(["seller_commission", "seller_intro"]);
  });

  it("сторож лидов (#301, promisesAgentContact): фразы заявки — обещание агента; фразы до заявки — нет (иначе заявка жалобщику, грубияну)", () => {
    // Фразы, которые звучат ТОЛЬКО вместе с принятой заявкой: сторож обязан узнать в них обещание, иначе незаведённая заявка
    // прошла бы мимо него. Пометки после заявки (callback_noted, text_only_noted, note_added, no_agent_noted) — свободны.
    const LEAD_KEYS = ["lead_and_details_seller", "lead_and_details_buyer", "lead_and_details_missing", "lead_known_phone", "lead_callback",
      "lead_callback_time", "lead_text_only", "phone_received", "out_of_area_accepted"];
    // next_step («делать ничего не нужно, агент свяжется») звучит только после заявки (decide.ts: `s.leadAccepted`).
    const AFTER_LEAD = ["callback_noted", "callback_time_noted", "text_only_noted", "note_added", "no_agent_noted", "question_noted", "lead_status", "lead_reminder",
      "next_step"];
    for (const { key, language, text } of rendered()) {
      if (LEAD_KEYS.includes(key)) expect(promisesAgentContact(text), `${key}/${language}: ${text}`).toBe(true);
      else if (!AFTER_LEAD.includes(key)) expect(promisesAgentContact(text), `${key}/${language}: ${text}`).toBe(false);
    }
  });

  it("переменная из данных не протаскивает тире и переносы, неизвестная переменная — ошибка, а не «{price}» клиенту", () => {
    const text = renderOperatorStep({ key: "job_open", vars: { position: "SMM — специалист\nстарший" }, variant: 0 }, "ru");
    expect(text).toBe("Вакансия «SMM, специалист старший» открыта.");
    expect(() => renderOperatorStep({ key: "property_price", vars: { id: 1 }, variant: 0 }, "ru")).toThrow(/price/u);
  });
});

describe("без «одним сообщением» и без допроса (владелец 20.11.2026)", () => {
  it("ни одна фраза оператора не просит писать «одним сообщением» / «дар як паём»", () => {
    for (const { key, language, text } of rendered()) expect(text, `${key}/${language}`).not.toMatch(/одним\s+сообщени|як\s+паём/iu);
  });
  it("вопрос о деталях с заявкой — мягкий и короткий: «можете рассказать», не больше трёх пунктов", () => {
    for (const key of ["lead_and_details_seller", "lead_and_details_buyer"] as const) {
      for (const language of LANGUAGES) {
        for (const variant of [0, 1]) {
          const text = renderOperatorStep({ key, vars: SAMPLE[key], variant }, language);
          expect(text, `${key}/${language}`).toMatch(language === "ru" ? /можете\s+рассказать/iu : /метавонед/iu);
          expect(text).not.toMatch(/площадь|этаж|ремонт|квадрат|ошёна|таъмир/iu);
        }
      }
    }
  });
});
