import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import { createCustomerCoreGoldenFixture, reply } from "./helpers/customerCoreGoldenFixture.js";

// Actual signed raw intake → worker/Core → proven accepted P12 question →
// current short question → actual scoped loader → deterministic reply → P12.
// ONLY external profile/model/count/social HTTP is synthetic; no grants mocked.
let f: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
beforeAll(async () => { f = await createCustomerCoreGoldenFixture(); });
afterEach(() => { f?.assertIoClean(); });
afterAll(async () => { await f?.cleanup(); });

it("Д086 companion: explains a genuinely delivered prior budget question and continues without phone or call promise", async () => {
  const owner = await f.owner(), first = await f.capture(owner, "Здравствуйте, ищу квартиру");
  f.script([[reply([], "budget")]]); const accepted = await f.deliver(first);
  expect(accepted.text).toBe("Какой бюджет вы рассматриваете?");
  const current = "Что именно?", second = await f.capture(owner, current), bodyStart = f.bodies.length;
  f.script([[reply([], "clarify_previous")]]); const out = await f.deliver(second);
  expect(out.text).toBe("Я уточнял сумму для покупки. Какой у вас бюджет?");
  expect(out.text.match(/\?/g)).toHaveLength(1); expect(out.text).not.toMatch(/номер телефона|Как к вам обращаться|позвон|запрос создан/iu);
  const request = f.bodies[bodyStart] as { contents: Array<{ role: string; parts: Array<{ text?: string }> }> };
  expect(JSON.stringify(request.contents)).toContain(accepted.text);
  expect(request.contents.at(-1)).toEqual({ role: "user", parts: [{ text: current }] });
  expect(out.row.receiptRefsJson).toEqual([]);
  expect(await prisma.customerAction.count({ where: { inquiryId: out.row.inquiryId! } })).toBe(0);
  expect(await prisma.callbackRequest.count({ where: { conversationId: out.row.originalNativeId } })).toBe(0);
});

it("a prior READY but unaccepted question is not presented as something the customer heard", async () => {
  const owner = await f.owner(), first = await f.capture(owner, "Здравствуйте, ищу квартиру");
  f.script([[reply([], "budget")]]);
  const plan = await consumeCustomerInboxTicket(first); expect(plan.status).toBe("planned");
  if (plan.status !== "planned") throw new Error("Actual first plan held");
  const pending = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: plan.partIds[0] } });
  expect(pending.status).toBe("READY"); expect(pending.acceptedAt).toBeNull();
  expect(await prisma.customerDeliveryAttempt.count({ where: { partId: pending.id } })).toBe(0);
  const second = await f.capture(owner, "Что именно?"); f.script([[reply([], "clarify_previous")]]);
  expect((await f.deliver(second)).text).toBe("Что пояснить подробнее?");
});

it("a delivered question in another exact account/peer namespace never becomes current repair context", async () => {
  const foreign = await f.owner(), first = await f.capture(foreign, "Ищу квартиру");
  f.script([[reply([], "rooms")]]); expect((await f.deliver(first)).text).toBe("Сколько комнат вам нужно?");
  const owner = await f.owner(), current = await f.capture(owner, "Что именно?");
  f.script([[reply([], "clarify_previous")]]);
  expect((await f.deliver(current)).text).toBe("Что пояснить подробнее?");
});
