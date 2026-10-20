import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { customerClaimedContactSchema } from "@royal-home/shared";
import { customerDeliveryReceiptsSchema } from "../src/lib/customerDeliveryContracts.js";
import { prisma } from "../src/db.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import { call, createCustomerCoreGoldenFixture, invalidDecision, reply } from "./helpers/customerCoreGoldenFixture.js";

// Synthetic companions to immutable historical specifications, NOT historical
// replay or live-model quality. Normal Vitest setup, compiled shared, owned DB.
let f: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
beforeAll(async () => { f = await createCustomerCoreGoldenFixture(); });
afterEach(() => { f?.assertIoClean(); });
afterAll(async () => { await f?.cleanup(); });
const phone = () => `+99293${String(parseInt(randomUUID().replaceAll("-", "").slice(0, 6), 16)).padStart(7, "0").slice(-7)}`;
const noPersonalQuestion = (text: string) => expect(text).not.toMatch(/Какой номер телефона|Как к вам обращаться|рақами телефон|муроҷиат кунам/iu);
async function noActions(eventKey: string) {
  const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey } });
  expect(ticket.conversationId).toBeTruthy();
  expect(await prisma.customerAction.count({ where: { inquiry: { conversationId: ticket.conversationId! } } })).toBe(0);
  expect(await prisma.callbackRequest.count({ where: { conversationId: ticket.conversationId! } })).toBe(0);
}

describe("new Core: bounded synthetic golden companions, not golden200 grading", () => {
  it("C01 / Д905 related: real current public price is answered before a questionnaire and private address never enters wire", async () => {
    const o = await f.owner(), { property } = await f.publicCard(), before = f.counts(), modelStart = f.bodies.length;
    const event = await f.capture(o, `Какая цена объекта №${property.shortId}?`);
    // Price is a genuine mandatory server observation before the FIRST model call.
    // The script does not supply a property UUID or manufacture a fact observation.
    f.script([[reply(["e0"], "budget")]]);
    const out = await f.deliver(event);
    expect(out.text).toContain(`Цена объекта №${property.shortId}: 500 000 сомони.`);
    expect(out.text.indexOf("500 000")).toBeLessThan(out.text.indexOf("Какой бюджет"));
    noPersonalQuestion(out.text); expect(out.text.match(/\?/g)).toHaveLength(1);
    const firstBody = f.bodies[modelStart] as { contents: { parts: { text?: string }[] }[] };
    expect(firstBody.contents.flatMap(c => c.parts).some(p => p.text?.includes('"price":"500000"'))).toBe(true);
    const modelBody = JSON.stringify(f.bodies.slice(modelStart)); expect(modelBody).not.toContain(property.id);
    expect(modelBody).not.toContain(property.address); expect(out.text).not.toContain(property.address);
    expect(f.counts().generated - before.generated).toBe(1); await noActions(event);
  });

  it("C02 / Д789 public-location subset: an unidentified object asks its number, not a private phone or invented address", async () => {
    const o = await f.owner(), event = await f.capture(o, "Какой адрес и цена объекта?");
    f.script([[reply(["e0"], "phone")]]);
    const out = await f.deliver(event);
    expect(out.text).toContain("номер объекта или ссылку"); noPersonalQuestion(out.text);
    expect(out.text).not.toMatch(/500 000|PRIVATE|Точный адрес|собственник/iu); await noActions(event);
    // Unreadable-media explanation is separately UNAVAILABLE in GAP-MANIFEST;
    // this positive proves missing-object clarification, never media interpretation.
  });

  it("C03 / Д247: current canonical commission answers in TG before contact, with buyer/seller clarification", async () => {
    const o = await f.owner(), event = await f.capture(o, "Нархи хизмат чанд?");
    f.script([[call("get_company_policy", { topic: "commission" }, "commission")], [reply(["e0"], "role")]]);
    const out = await f.deliver(event);
    expect(out.text).toContain("барои фурӯшанда 2%, барои харидор 0%");
    expect(out.text).toContain("Шумо амвол харидан мехоҳед ё фурӯхтан?"); noPersonalQuestion(out.text);
    expect(out.publicData).toMatchObject({ observations: [{ kind: "company_policy", topic: "commission" }] });
    await noActions(event);
  });

  it("C04 / Д005 policy subset: real rental/payment policy is useful without inventing financing or offering a different flat", async () => {
    const o = await f.owner(), event = await f.capture(o, "Нужна маленькая квартира. Вы работаете с арендой? Есть рассрочка или ипотека?");
    const before = f.counts();
    f.script([[call("get_company_policy", { topic: "rental" }, "rental"), call("get_company_policy", { topic: "payment" }, "payment")],
      [reply(["e0", "e1"])]]);
    const out = await f.deliver(event);
    expect(out.text).toContain("Сейчас арендой не занимаемся"); expect(out.text).toContain("Рассрочки нет. Ипотеки нет.");
    expect(out.text).not.toMatch(/кредит одобрен|нашёл|одобрена|Запрос на звонок|квадратных/iu); noPersonalQuestion(out.text);
    expect(f.counts().generated - before.generated).toBe(2); expect(f.counts().counted - before.counted).toBe(2);
    const native = await prisma.botConversation.findUniqueOrThrow({ where: { id: out.row.originalNativeId! } });
    expect(native.aiTurnsToday).toBe(1); await noActions(event);
    // Retaining/acknowledging an exact current area constraint is NOT graded here.
  });

  it("C05 / Д709: negotiation is conditional company policy, never an owner contact or agreed discount receipt", async () => {
    const o = await f.owner(), event = await f.capture(o, "Можно договориться о скидке?");
    f.script([[call("get_company_policy", { topic: "negotiation" }, "negotiation")], [reply(["e0"], "property")]]);
    const out = await f.deliver(event);
    expect(out.text).toContain("Вопрос торга агент обсуждает с собственником.");
    expect(out.text).toContain("Размер скидки пока не могу подтвердить."); expect(out.text).toContain("номер объекта или ссылку");
    expect(out.text).not.toMatch(/собственник согласился|уточнил у|Вопрос собственнику сохранён|скидка \d/iu);
    expect(customerDeliveryReceiptsSchema.parse(out.row.receiptRefsJson)).toEqual([]); await noActions(event);
  });

  it("C06 / Д221: a detail opener with no subject asks housing/work topic instead of forcing property/phone", async () => {
    const o = await f.owner(), event = await f.capture(o, "Можно подробнее?");
    f.script([[reply([], "topic")]]); const out = await f.deliver(event);
    expect(out.text).toBe("Вы хотите узнать о недвижимости или о работе?");
    expect(out.text).not.toContain("объект"); noPersonalQuestion(out.text); await noActions(event);
  });

  it("C07 / Д037: actual protected phone receipt then current stated name yields a second real receipt without phone reask", async () => {
    const o = await f.owner(), statedPhone = phone(), a = await f.capture(o, `Мой номер ${statedPhone}`);
    f.script([[call("save_contact", { phone: statedPhone }, "phone")], [reply(["e0"], "budget")]]);
    const first = await f.deliver(a);
    expect(customerDeliveryReceiptsSchema.parse(first.row.receiptRefsJson)).toMatchObject([{ kind: "contact", outcome: "contact_saved" }]);
    const b = await f.capture(o, "Меня зовут Рустам");
    f.script([[call("save_contact", { name: "Рустам" }, "name")], [reply(["e0"], "phone")]]);
    const second = await f.deliver(b);
    expect(second.text).toBe("Контактные данные сохранены."); noPersonalQuestion(second.text);
    const receipts = customerDeliveryReceiptsSchema.parse(second.row.receiptRefsJson);
    expect(receipts).toMatchObject([{ kind: "contact", outcome: "contact_saved" }]);
    const inquiry = await prisma.customerInquiry.findUniqueOrThrow({ where: { id: second.row.inquiryId! } });
    expect(customerClaimedContactSchema.parse(inquiry.claimedContact)).toMatchObject({ name: "Рустам", phone: statedPhone });
    expect(await prisma.customerAction.count({ where: { inquiryId: inquiry.id, kind: "contact", status: "COMMITTED" } })).toBe(2);
    expect(await prisma.callbackRequest.count({ where: { conversationId: second.row.originalNativeId } })).toBe(0);
    expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: second.row.originalNativeId! } })).clientId).toBeNull();
    // Natural name-specific acknowledgment and general dialogue fluency remain unavailable.
  });

  it("C08 / Д086 continuity security: an old quoted callback request remains inert while current payment question gets a useful reply", async () => {
    const o = await f.owner(), statedPhone = phone(), a = await f.capture(o, `Мой номер ${statedPhone}. Позвоните мне.`);
    f.script([[call("save_contact", { phone: statedPhone }, "phone")], [reply(["e0"], "budget")]]);
    await f.deliver(a);
    const current = "А рассрочка?", event = await f.capture(o, current), bodyStart = f.bodies.length;
    f.script([[call("request_callback", { topic: "Позвоните мне" }, "quoted-old-call")],
      [call("get_company_policy", { topic: "payment" }, "payment")], [reply(["e0"])]]);
    const out = await f.deliver(event);
    expect(out.text).toBe("Рассрочки нет. Ипотеки нет.");
    expect(JSON.stringify(f.bodies.slice(bodyStart))).toContain("Позвоните мне");
    expect(JSON.stringify(f.bodies.slice(bodyStart))).toContain('"status":"denied"');
    expect(JSON.stringify(f.bodies.slice(bodyStart))).not.toContain(statedPhone);
    const firstBody = f.bodies[bodyStart] as { contents: { role: string; parts: { text?: string }[] }[] };
    expect(firstBody.contents.at(-1)).toEqual({ role: "user", parts: [{ text: current }] });
    expect(await prisma.customerAction.count({ where: { inquiryId: out.row.inquiryId!, kind: "callback" } })).toBe(0);
    expect(await prisma.callbackRequest.count({ where: { conversationId: out.row.originalNativeId } })).toBe(0);
    expect(customerDeliveryReceiptsSchema.parse(out.row.receiptRefsJson)).toEqual([]);
  });

  it("N01 / Д893 and Д789: unsupported free-prose update/media success cannot fabricate a reply, receipt or listing change", async () => {
    // This is a DENIAL control, not a passing media explanation/price-change companion.
    const { property } = await f.publicCard();
    for (const claim of ["Цена изменена на 450000 сомони, рекламу запустил.", "Я просмотрел вложение и подтвердил точный адрес."]) {
      const o = await f.owner(), event = await f.capture(o, `Объект №${property.shortId}. Я собственник, прошу цену 450000 и помощь с рекламой.`);
      f.script([[invalidDecision({ kind: "reply", refs: [], social: "none", question: "none", text: claim })]]);
      const before = f.physical.length, result = await consumeCustomerInboxTicket(event);
      expect(result.status).toBe("held"); expect(f.physical).toHaveLength(before);
      expect(await prisma.customerOutboxPart.count({ where: { ticketEventKey: event } })).toBe(0);
      expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).price.toString()).toBe("500000");
      await noActions(event);
    }
  });
});
