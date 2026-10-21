import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createCustomerCoreGoldenFixture, reply } from "./helpers/customerCoreGoldenFixture.js";

let fixture: Awaited<ReturnType<typeof createCustomerCoreGoldenFixture>>;
let oldCollecting = false;
const key = `relevance-${randomUUID()}`;
const detailsRu = "Снимать ролики и монтировать видео.\nРабота очно, с понедельника по субботу. Удалённая работа не предусмотрена.\nДружная команда, кофе и печенье.\nАдрес: Synthetic street.\nДля отклика пришлите резюме или расскажите о себе и своём опыте.";
beforeAll(async () => {
  oldCollecting = (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botCanHandleVacancies: true } })).botCanHandleVacancies;
  await prisma.settings.update({ where: { id: "singleton" }, data: { botCanHandleVacancies: true } });
  await prisma.recruitmentPosition.create({ data: { key, titleRu: "Синтетический видеограф", titleTg: "Видеографи санҷишӣ",
    detailsRu, detailsTg: "Наворбардорӣ ва таҳрири видео.", isOpen: true, revision: 1 } });
  fixture = await createCustomerCoreGoldenFixture();
});
afterAll(async () => {
  await fixture?.cleanup();
  await prisma.recruitmentPosition.deleteMany({ where: { key } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botCanHandleVacancies: oldCollecting } });
});
it("delivers one concise verified introduction through actual inbox/Core/public-read/witness/outbox, with synthetic provider only", async () => {
  const owner = await fixture.owner();
  const event = await fixture.capture(owner, "Вакансия: синтетический видеограф");
  fixture.script([[reply(["e0"], "job_experience")]]);
  const out = await fixture.deliver(event);
  fixture.assertIoClean();
  expect(out.text).toContain("Снимать ролики");
  expect(out.text).toContain("Удалённая работа не предусмотрена");
  expect(out.text).not.toMatch(/Synthetic street|кофе/u);
  expect(out.text.match(/резюме/giu)).toHaveLength(1);
  expect(fixture.physical).toEqual([out.text]);
});
