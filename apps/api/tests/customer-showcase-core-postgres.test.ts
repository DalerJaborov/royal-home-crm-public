import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createCustomerCoreGoldenFixture, call, reply } from "./helpers/customerCoreGoldenFixture.js";
let fixture: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
beforeAll(async () => { fixture = await createCustomerCoreGoldenFixture(); });
afterAll(async () => { await fixture?.cleanup(); });

it("signed DM → bounded CRM collection → accepted receipt → next collection excludes actually sent cards", async () => {
  const owner = await fixture.owner(), items = [];
  for (let index = 0; index < 4; index++) items.push(await fixture.publicCard());
  const district = items[0].district;
  await prisma.property.updateMany({ where: { id: { in: items.map(value => value.property.id) } }, data: { districtId: district.id } });
  const args = { type: "APARTMENT", districtName: district.name, rooms: 2 };
  const first = await fixture.capture(owner, "Покажите двухкомнатные квартиры");
  fixture.script([[call("search_public_properties", args, "first-search")], [reply(["e0"])]]);
  const sent = await fixture.deliver(first); fixture.assertIoClean();
  const cards = sent.publicData?.observations.find(value => value.kind === "property_search");
  expect(cards?.kind).toBe("property_search"); if (cards?.kind !== "property_search") throw Error("Actual search sideband missing");
  expect(cards.cards).toHaveLength(3); expect(sent.text).toContain("65"); expect(sent.text).not.toContain("PRIVATE");
  const next = await fixture.capture(owner, "Ещё варианты");
  fixture.script([[call("search_public_properties", { ...args, nextPage: true }, "next-search")], [reply(["e0"])]]);
  const more = await fixture.deliver(next); fixture.assertIoClean();
  const nextCards = more.publicData?.observations.find(value => value.kind === "property_search");
  expect(nextCards?.kind).toBe("property_search"); if (nextCards?.kind !== "property_search") throw Error("Next search missing");
  expect(nextCards.cards).toHaveLength(1);
  expect(cards.cards.map(value => value.facts.shortId)).not.toContain(nextCards.cards[0].facts.shortId);
  const other = await fixture.owner(), otherEvent = await fixture.capture(other, "Ещё двухкомнатные квартиры");
  fixture.script([[call("search_public_properties", { ...args, nextPage: true }, "other-search")], [reply(["e0"])]]);
  const otherSent = await fixture.deliver(otherEvent); fixture.assertIoClean();
  const otherCards = otherSent.publicData?.observations.find(value => value.kind === "property_search");
  expect(otherCards?.kind === "property_search" && otherCards.cards.length).toBe(3);
});

it("revoking the original account removes its presentation memory without retrying a send", async () => {
  async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (cause) { throw new Error(`Showcase revocation step: ${name}`, { cause }); }
  }
  const owner = await step("create original account", () => fixture.owner());
  const { property, district } = await step("create public card", () => fixture.publicCard());
  const args = { type: "APARTMENT", districtName: district.name };
  const first = await step("capture original input", () => fixture.capture(owner, "Покажи квартиру"));
  fixture.script([[call("search_public_properties", args, "search-unknown")], [reply(["e0"])]]);
  const sent = await step("deliver accepted collection", () => fixture.deliver(first)); fixture.assertIoClean();
  const { prepareCustomerDmInboxCoreContext } = await import("../src/lib/customerDmCoreContext.js");
  const { readCustomerShownSearchProperties } = await import("../src/lib/customerSearchHistory.js");
  const next = await step("capture next input", () => fixture.capture(owner, "Ещё"));
  const prepared = await step("prepare original principal", () => prepareCustomerDmInboxCoreContext(next));
  expect(prepared.status).toBe("prepared"); if (prepared.status !== "prepared") throw Error("Actual context missing");
  expect(await step("read accepted history", () => readCustomerShownSearchProperties(prepared.lane.principal))).toContain(property.shortId);
  // A source/account epoch change also removes presentation memory.
  await step("revoke original account", () => prisma.messengerAccount.update({ where: { id: owner.id }, data: { enabled: false } }));
  expect(await step("deny revoked history", () => readCustomerShownSearchProperties(prepared.lane.principal))).toEqual([]);
  expect(sent.row.status).toBe("ACCEPTED");
});

it("a planned but unsent collection does not become already-shown memory", async () => {
  const owner = await fixture.owner(), { property, district } = await fixture.publicCard();
  const first = await fixture.capture(owner, "Покажи квартиры");
  fixture.script([[call("search_public_properties", { type: "APARTMENT", districtName: district.name }, "pending-search")], [reply(["e0"])]]);
  const { consumeCustomerInboxTicket } = await import("../src/lib/customerIngressProducer.js");
  const planned = await consumeCustomerInboxTicket(first); expect(planned.status).toBe("planned"); fixture.assertIoClean();
  const next = await fixture.capture(owner, "Ещё варианты");
  const { prepareCustomerDmInboxCoreContext } = await import("../src/lib/customerDmCoreContext.js");
  const { readCustomerShownSearchProperties } = await import("../src/lib/customerSearchHistory.js");
  const prepared = await prepareCustomerDmInboxCoreContext(next);
  expect(prepared.status).toBe("prepared"); if (prepared.status !== "prepared") throw Error("Actual context missing");
  expect(await readCustomerShownSearchProperties(prepared.lane.principal)).not.toContain(property.shortId);
});
