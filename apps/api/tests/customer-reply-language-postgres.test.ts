import { afterAll, beforeAll, expect, it } from "vitest";
import { createCustomerCoreGoldenFixture, decision } from "./helpers/customerCoreGoldenFixture.js";

let fixture: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
beforeAll(async () => { fixture = await createCustomerCoreGoldenFixture(); });
afterAll(async () => { await fixture?.cleanup(); });
async function acknowledge(owner: Awaited<ReturnType<typeof fixture.owner>>, text: string) {
  const event = await fixture.capture(owner, text);
  fixture.script([[decision({ kind: "reply", refs: [], social: "acknowledge", question: "none" })]]);
  const out = await fixture.deliver(event);
  fixture.assertIoClean(); return out.text;
}

it.each(["Дхонага", "Маяковский"])("keeps actual TG user context for the neutral follow-up %s through inbox/Core/outbox", async input => {
  const owner = await fixture.owner();
  expect(await acknowledge(owner, "Салом, мехоҳам хона харам")).toBe("Фаҳмидам.");
  expect(await acknowledge(owner, input)).toBe("Фаҳмидам.");
});
it("uses a newly decisive RU input instead of stubbornly preserving prior TG", async () => {
  const owner = await fixture.owner();
  expect(await acknowledge(owner, "Салом, мехоҳам хона харам")).toBe("Фаҳмидам.");
  expect(await acknowledge(owner, "Спасибо, я хочу посмотреть квартиру")).toBe("Понял.");
});
it("uses a newly decisive TG input instead of stubbornly preserving prior RU", async () => {
  const owner = await fixture.owner();
  expect(await acknowledge(owner, "Здравствуйте, я хочу посмотреть квартиру")).toBe("Понял.");
  expect(await acknowledge(owner, "Салом, мехоҳам хона харам")).toBe("Фаҳмидам.");
});
it("does not reuse a different customer's language", async () => {
  const tajik = await fixture.owner(), separate = await fixture.owner();
  expect(await acknowledge(tajik, "Салом, мехоҳам хона харам")).toBe("Фаҳмидам.");
  expect(await acknowledge(separate, "Маяковский")).toBe("Понял.");
});
it("honors a colloquial explicit TG request even after prior RU replies", async () => {
  const owner = await fixture.owner();
  expect(await acknowledge(owner, "Здравствуйте, мне нужна работа")).toBe("Понял.");
  expect(await acknowledge(owner, "Точикиш мегрифти хуб мешид ака")).toBe("Фаҳмидам.");
  expect(await acknowledge(owner, "SMM")).toBe("Фаҳмидам.");
});
it("honors an explicit RU preference expressed using Tajik words", async () => {
  const owner = await fixture.owner();
  expect(await acknowledge(owner, "Салом, мехоҳам хона харам")).toBe("Фаҳмидам.");
  expect(await acknowledge(owner, "бо забони русӣ нависед")).toBe("Понял.");
});
