import { describe, expect, it } from "vitest";
import { LEAD_ONLY_OFFICE_PHONE_TEXT, LEAD_ONLY_WITHHELD_CUSTOMER_WRITES, leadOnlyNoAgentLine, leadOnlyReply, leadOnlyReplyAvoidingRepeat,
  leadOnlyServerLine, leadOnlyWithholdsCustomerWrite, type LeadOnlyReplyInput } from "../src/ai/leadOnlyMode.js";
import { customerAsksForStaff } from "../src/lib/customerMutationIntent.js";

/**
 * ПЯТОЕ РЕВЬЮ РЕЖИМА «ТОЛЬКО ЗАЯВКИ» (13.11.2026), чистые решения. Сквозные ходы — разделы «пятое ревью» в
 * lead-only-mode-core-postgres, lead-only-mode-legacy-postgres и lead-only-review5-13-11-postgres. Каждый тест
 * проверен внесённой поломкой (журнал docs/journal/2026-11-13-bot-lead-only-mode.md).
 */
const soon = { kind: "soon" } as const;
const exhausted = { kind: "ask" as const, asksSoFar: 2, maxAsks: 2, officeAlreadyOffered: true };
const base = { sellerCommissionPercent: 2, when: soon };

describe("№3: горячие слова и вопрос к агенту без номера, просьбы исчерпаны", () => {
  it("«хочу посмотреть» — номер офиса, а не одно «покажем»; показ не обещан", () => {
    const text = leadOnlyReply({ ...base, scenario: "hot", language: "ru", phone: exhausted });
    expect(text).toContain(LEAD_ONLY_OFFICE_PHONE_TEXT);
    expect(text).not.toMatch(/покажем|передаю|в курсе/iu);
    expect(leadOnlyReply({ ...base, scenario: "hot", language: "tg", phone: exhausted })).toContain(LEAD_ONLY_OFFICE_PHONE_TEXT);
  });
  it("номер офиса повторяется другими словами: три хода подряд — три разных текста, в каждом номер", () => {
    const input: LeadOnlyReplyInput = { ...base, scenario: "hot", language: "ru", phone: exhausted };
    const sent = [`Если удобнее, позвоните нам сами: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`];
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const text = leadOnlyReplyAvoidingRepeat(input, sent);
      expect(text).toContain(LEAD_ONLY_OFFICE_PHONE_TEXT);
      expect(seen.has(text)).toBe(false);
      seen.add(text); sent.push(text);
    }
  });
  it("вопрос к агенту — тоже номер офиса, а не одно «поможет агент»", () => {
    const text = leadOnlyReplyAvoidingRepeat({ ...base, scenario: "escalate", language: "ru", phone: exhausted }, []);
    expect(text).toContain(LEAD_ONLY_OFFICE_PHONE_TEXT);
    expect(text).not.toBe("С этим вопросом поможет агент.");
  });
  it("отказ дать номер: «Хорошо, без проблем» первым, потом «Показ назначает агент» и номер офиса", () => {
    const text = leadOnlyReply({ ...base, scenario: "hot", language: "ru",
      phone: { kind: "ask", asksSoFar: 1, maxAsks: 2, officeAlreadyOffered: false, refused: true } });
    expect(text).toBe(`Хорошо, без проблем. Показ назначает агент. Если захотите, позвоните нам сами: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`);
  });
  it("номер есть (WhatsApp) — прежнее «передаю агенту», режим офиса не включается", () => {
    expect(leadOnlyReply({ ...base, scenario: "hot", language: "ru", phone: { kind: "whatsapp" } })).toMatch(/^Хорошо, передаю агенту\./u);
  });
});

describe("№2: карточка без агента — честное «записали, свяжутся»", () => {
  it("срок из обещания звонка, без «агент», «позвонит», «передаю» и без «—»; не повторяется дословно", () => {
    const first = leadOnlyNoAgentLine({ ru: "завтра после 09:30", tg: "пагоҳ баъд аз соати 09:30" }, "ru");
    expect(first).toBe("Записали, с вами свяжутся завтра после 09:30.");
    expect(first).not.toMatch(/агент|позвонит|передаю|в курсе|—/iu);
    const second = leadOnlyNoAgentLine({ ru: "завтра после 09:30", tg: "" }, "ru", [first]);
    expect(second).not.toBe(first);
    expect(leadOnlyNoAgentLine({ ru: "", tg: "имрӯз" }, "tg")).toContain("имрӯз");
  });
});

describe("память ядра узнаёт новые ответы режима", () => {
  it.each([
    `Договориться о показе можно по телефону ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`,
    `Хорошо, без проблем. Показ назначает агент. Если захотите, позвоните нам сами: ${LEAD_ONLY_OFFICE_PHONE_TEXT}.`,
    "Показ объекта №112 назначает агент. Оставьте, пожалуйста, номер телефона, агент перезвонит.",
    "Записали, с вами свяжутся завтра после 09:30.",
    "Саволатон сабт шуд, пагоҳ баъд аз соати 09:30 бо шумо тамос мегиранд.",
  ])("%s", line => { expect(leadOnlyServerLine(line)).toBe(true); });
});

describe("№1: что режим убирает из действий ядра и как узнаёт «соедините с человеком»", () => {
  it("передача, звонок, вопрос собственнику и показ — убраны; контакт и анкета — нет", () => {
    for (const name of ["request_handover", "request_callback", "ask_owner", "book_showing"]) expect(leadOnlyWithholdsCustomerWrite(name)).toBe(true);
    for (const name of ["save_contact", "save_job_application", "get_property_facts"]) expect(leadOnlyWithholdsCustomerWrite(name)).toBe(false);
    expect(LEAD_ONLY_WITHHELD_CUSTOMER_WRITES).toHaveLength(4);
  });
  it.each(["Соедините меня с менеджером", "Хочу поговорить с оператором", "оператор", "Мне не перезвонили", "Бо корманд гап задан мехоҳам"])(
    "«%s» — просьба сотрудника", text => { expect(customerAsksForStaff(text)).toBe(true); });
  it.each(["Кто такой менеджер?", "Не надо соединять с оператором", "Хочу купить квартиру", "Менеджер звонил вчера"])(
    "«%s» — не просьба сотрудника", text => { expect(customerAsksForStaff(text)).toBe(false); });
});
