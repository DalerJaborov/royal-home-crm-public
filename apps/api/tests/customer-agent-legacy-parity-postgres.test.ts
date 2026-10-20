import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createCustomerCoreGoldenFixture, call, reply, decision } from "./helpers/customerCoreGoldenFixture.js";
import { consumeCustomerInboxTicket } from "../src/lib/customerIngressProducer.js";
import { dispatchCustomerOutboxPart } from "../src/lib/customerDeliveryDispatcher.js";
import { loadCustomerAgentFeaturePolicy } from "../src/lib/customerAgentFeaturePolicy.js";
import { readCustomerAgentPublicData, currentCustomerAgentKnowledgeHash } from "../src/lib/customerAgentPublicReads.js";

let fixture: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
let original: { workHoursStart: string; workHoursEnd: string; companyDaysOff: number[]; botCanSendLinks: boolean };
beforeAll(async () => {
  original = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
    workHoursStart: true, workHoursEnd: true, companyDaysOff: true, botCanSendLinks: true,
  } });
  fixture = await createCustomerCoreGoldenFixture();
});
afterAll(async () => {
  try { if (original) await prisma.settings.update({ where: { id: "singleton" }, data: original }); }
  finally { await fixture?.cleanup(); }
});

it("signed DM office/hours request is answered from actual company data and sent through the witnessed outbox", async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursStart: "10:15", workHoursEnd: "17:45", companyDaysOff: [] } });
  const owner = await fixture.owner(), event = await fixture.capture(owner, "Где ваш офис и часы работы?");
  fixture.script([[reply()]]); // The real core must obtain required company information itself.
  const sent = await fixture.deliver(event); fixture.assertIoClean();
  expect(sent.text).toContain("Офис Royal Home"); expect(sent.text).toContain("10:15"); expect(sent.text).toContain("17:45");
  expect(sent.text).not.toMatch(/PRIVATE|номер телефона|записал|позвонят/iu);
  expect(sent.publicData?.observations.some(value => value.kind === "company_information")).toBe(true);
});

it("a settings-hours change after planning prevents stale company facts from being physically sent", async () => {
  const owner = await fixture.owner(), event = await fixture.capture(owner, "Часы работы?");
  fixture.script([[reply(["e0"])]]);
  const planned = await consumeCustomerInboxTicket(event); expect(planned.status).toBe("planned"); fixture.assertIoClean();
  if (planned.status !== "planned") throw Error("Company reply was not planned");
  const row = await prisma.customerOutboxPart.findFirstOrThrow({ where: { ticketEventKey: event } });
  const before = fixture.physical.length;
  await prisma.settings.update({ where: { id: "singleton" }, data: { workHoursEnd: "16:35" } });
  expect((await dispatchCustomerOutboxPart(row.id)).status).not.toBe("accepted");
  expect(fixture.physical).toHaveLength(before);
});

it("literal second variant updates canonical focus; follow-up facts stay on the selected property with its fresh price", async () => {
  const owner = await fixture.owner(), items = [await fixture.publicCard(), await fixture.publicCard(), await fixture.publicCard()];
  const district = items[0].district;
  await prisma.property.updateMany({ where: { id: { in: items.map(value => value.property.id) } }, data: { districtId: district.id } });
  const first = await fixture.capture(owner, "Покажи квартиры");
  fixture.script([[call("search_public_properties", { type: "APARTMENT", districtName: district.name }, "collection")], [reply(["e0"])]]);
  const sent = await fixture.deliver(first); fixture.assertIoClean();
  const collection = sent.publicData?.observations.find(value => value.kind === "property_search");
  if (collection?.kind !== "property_search" || collection.cards.length !== 3) throw Error("Actual collection not accepted");
  const selected = collection.cards[1].facts;
  await prisma.property.update({ where: { id: selected.propertyId }, data: { price: 612345 } });
  const next = await fixture.capture(owner, "Покажите второй вариант");
  fixture.script([[call("get_property_facts", { kinds: ["price", "characteristics"] }, "selected-facts")], [reply(["e0"])]]);
  const chosen = await fixture.deliver(next); fixture.assertIoClean();
  expect(chosen.text).toContain(`№${selected.shortId}`); expect(chosen.text).toContain("612 345");
  const followup = await fixture.capture(owner, "Сколько стоит?");
  fixture.script([[reply(["e0"])]]);
  const again = await fixture.deliver(followup); fixture.assertIoClean();
  expect(again.text).toContain(`№${selected.shortId}`); expect(again.text).toContain("612 345");
  const explicit = items.find(item => item.property.id !== selected.propertyId)!.property;
  await prisma.property.update({ where: { id: explicit.id }, data: { price: 614321 } });
  const explicitEvent = await fixture.capture(owner, `Покажи объект №${explicit.shortId}`);
  fixture.script([[call("get_property_facts", { kinds: ["price", "characteristics"] }, "explicit-object-id")], [reply(["e0"])]]);
  const explicitReply = await fixture.deliver(explicitEvent); fixture.assertIoClean();
  expect(explicitReply.text).toContain(`№${explicit.shortId}`); expect(explicitReply.text).toContain("614 321");
  const other = await fixture.owner(), otherEvent = await fixture.capture(other, "Второй вариант");
  fixture.script([[call("get_property_facts", { kinds: ["price"] }, "other-not-selected")], [reply(["e0"])]]);
  const denied = await fixture.deliver(otherEvent); fixture.assertIoClean();
  expect(denied.text).not.toContain(`№${selected.shortId}`); expect(denied.text).not.toContain("612 345");
  expect(denied.text).toMatch(/Какой объект|ссылку/iu);
});

it("the existing links switch is enforced for collection delivery", async () => {
  const owner = await fixture.owner(), { district } = await fixture.publicCard();
  await prisma.settings.update({ where: { id: "singleton" }, data: { botCanSendLinks: false } });
  expect((await loadCustomerAgentFeaturePolicy()).links).toBe(false);
  const event = await fixture.capture(owner, "Покажи квартиры");
  fixture.script([[call("search_public_properties", { type: "APARTMENT", districtName: district.name }, "without-links")], [reply(["e0"])]]);
  const sent = await fixture.deliver(event); fixture.assertIoClean();
  const search = sent.publicData?.observations.find(value => value.kind === "property_search");
  expect(search?.kind === "property_search" && search.linksAllowed).toBe(false);
  expect(search?.kind === "property_search" && search.cards.some(card => card.facts.publicLink)).toBe(true);
  expect(sent.text).not.toMatch(/https?:\/\//iu);
});

it("a bare room-count answer after a collection ending with a rooms question does not select its second card", async () => {
  const owner = await fixture.owner(), items = [await fixture.publicCard(), await fixture.publicCard()];
  const district = items[0].district;
  await prisma.property.updateMany({ where: { id: { in: items.map(value => value.property.id) } }, data: { districtId: district.id } });
  const first = await fixture.capture(owner, "Покажите варианты");
  fixture.script([[call("search_public_properties", { type: "APARTMENT", districtName: district.name }, "rooms-not-position")],
    [decision({ kind: "reply", refs: ["e0"], social: "none", question: "rooms" })]]);
  const sent = await fixture.deliver(first); fixture.assertIoClean();
  expect(sent.text).toContain("Сколько комнат вам нужно?");
  const second = await fixture.capture(owner, "2");
  fixture.script([[decision({ kind: "clarify", refs: [], social: "none", question: "budget" })]]);
  await fixture.deliver(second); fixture.assertIoClean();
  const native = await prisma.botConversation.findFirstOrThrow({ where: { accountId: owner.id, subscriberId: owner.peer } });
  expect((native.customerPropertyFocus as { propertyId?: string } | null)?.propertyId).toBeFalsy();
});

it("normalizes spoken RU/TG districts through the legacy resolver; unknown/suburban places never widen to all city", async () => {
  const { property, district } = await fixture.publicCard();
  const actual = await prisma.district.findFirst({ where: { name: "Сино" } });
  if (actual) await prisma.property.update({ where: { id: property.id }, data: { districtId: actual.id } });
  else await prisma.district.update({ where: { id: district.id }, data: { name: "Сино" } });
  const options = { knowledgeSourceHash: currentCustomerAgentKnowledgeHash() };
  for (const districtName of ["в районе Сино", "дар ноҳияи Сино"]) {
    const result = await readCustomerAgentPublicData({ name: "search_public_properties", args: { districtName } }, options);
    expect(result.status).toBe("observed");
    if (result.status !== "observed" || result.observation.kind !== "property_search") throw Error("Actual normalized read missing");
    expect(result.observation.resolvedDistrictName).toBe("Сино");
    expect(result.observation.districtWasNormalized).toBe(true);
    expect(result.observation.cards.every(card => card.listing.districtName === "Сино")).toBe(true);
  }
  for (const districtName of ["unknown-synthetic-place-789", "Вахдат"]) {
    expect(await readCustomerAgentPublicData({ name: "search_public_properties", args: { districtName } }, options))
      .toMatchObject({ status: "denied", reason: "district_not_resolved" });
  }
});
