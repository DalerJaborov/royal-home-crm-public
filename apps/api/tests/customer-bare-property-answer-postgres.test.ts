import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { call, createCustomerCoreGoldenFixture, reply } from "./helpers/customerCoreGoldenFixture.js";

let f: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
beforeAll(async () => { f = await createCustomerCoreGoldenFixture(); });
afterEach(() => { f?.assertIoClean(); });
afterAll(async () => { await f?.cleanup(); });

it("resolves a bare public number after its own genuinely ACCEPTED object question, without treating it as phone consent", async () => {
  const owner = await f.owner(), { property } = await f.publicCard();
  const question = await f.capture(owner, "Какой адрес и цена объекта?");
  f.script([[reply(["e0"], "phone")]]);
  expect((await f.deliver(question)).text).toContain("номер объекта или ссылку");
  const answer = await f.capture(owner, String(property.shortId));
  f.script([[call("get_property_facts", { kinds: ["price", "address"] }, "facts")], [reply(["e0"])]]);
  const out = await f.deliver(answer);
  expect(out.text).toContain(`Цена объекта №${property.shortId}: 500 000 сомони.`);
  expect(out.text).not.toContain(property.address);
  expect(JSON.stringify(f.bodies)).not.toContain(property.id);
  expect(out.text).not.toMatch(/номер телефона|номер объекта или ссылку/iu);
  expect(await prisma.customerAction.count({ where: { inquiry: { conversationId: out.row.conversationId! } } })).toBe(0);
});
it("another customer's accepted object question does not turn this customer's number into a property reference", async () => {
  const first = await f.owner(), second = await f.owner(), { property } = await f.publicCard();
  f.script([[reply(["e0"], "phone")]]);
  await f.deliver(await f.capture(first, "Какой адрес и цена объекта?"));
  f.script([[call("get_property_facts", { kinds: ["price"] }, "facts")], [reply(["e0"])]]);
  const out = await f.deliver(await f.capture(second, String(property.shortId)));
  expect(out.text).toContain("номер объекта или ссылку");
  expect(out.text).not.toContain("500 000");
});
