/**
 * «Как человек» (ревизия бота 02.10.2026, сравнение с лучшими ассистентами):
 * раздражение клиента видно модели, суть заявки — в пуше агенту.
 */
import { describe, expect, it } from "vitest";
import { looksFrustrated } from "../src/ai/frustrationGuard.js";
import { leadGist } from "../src/services/leads/intake.js";
import { locationHint } from "../src/messengers/sharedMedia.js";

describe("раздражение клиента", () => {
  it.each([
    "Вы меня не понимаете",
    "Третий раз пишу, ответьте уже",
    "сколько можно ждать",
    "ВЫ ВООБЩЕ ЧИТАЕТЕ ЧТО Я ПИШУ",
    "Ну и где ответ???",
    "Шумо намефаҳмед",
    "Чанд бор навиштам",
  ])("«%s» — раздражён", (text) => {
    expect(looksFrustrated(text)).toBe(true);
  });
  it.each([
    "Не понимаю, какой район лучше",
    "Спасибо!!!",
    "Второй раз смотрю эту квартиру, нравится",
    "Нафаҳмидам, кадом ноҳия беҳтар аст?",
    "OK",
    "ЖК",
  ])("«%s» — спокойно", (text) => {
    expect(looksFrustrated(text)).toBe(false);
  });
});

describe("суть заявки в пуше агенту", () => {
  it("первые слова запроса, без переносов и не длиннее 90 знаков", () => {
    expect(leadGist("2-комн в Сино\nдо 45 000 $")).toBe(": 2-комн в Сино; до 45 000 $");
    expect(leadGist(null)).toBe("");
    expect(leadGist("а".repeat(200)).length).toBeLessThanOrEqual(92);
  });
});

describe("геометка", () => {
  it("подсказка называет район и запрещает переспрашивать", () => {
    const hint = locationHint("Сино");
    expect(hint).toContain("район Сино");
    expect(hint).toContain("не спрашивай");
  });
});

import { afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { shownShortIdsInOtherChannels } from "../src/messengers/propertyShowcase.js";

describe("показанное в других каналах того же человека", () => {
  const run = `hl0210-${Date.now()}`;
  let profileId = "";
  afterAll(async () => {
    await prisma.shownProperty.deleteMany({ where: { recipientId: { startsWith: run } } });
    await prisma.botConversation.deleteMany({ where: { subscriberId: { startsWith: run } } });
    if (profileId) await prisma.contactProfile.deleteMany({ where: { id: profileId } });
  });

  it("объект, показанный в Instagram, считается показанным и в WhatsApp", async () => {
    profileId = (await prisma.contactProfile.create({ data: {} })).id;
    await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `${run}-ig`, contactProfileId: profileId } });
    await prisma.botConversation.create({ data: { channel: "WHATSAPP", subscriberId: `${run}-wa`, contactProfileId: profileId } });
    await prisma.shownProperty.create({ data: { channel: "INSTAGRAM", recipientId: `${run}-ig`, shortId: 987654 } });

    expect(await shownShortIdsInOtherChannels(profileId, "WHATSAPP", `${run}-wa`)).toEqual([987654]);
    // Свой канал сюда не входит — его считает recentlyShownShortIds.
    expect(await shownShortIdsInOtherChannels(profileId, "INSTAGRAM", `${run}-ig`)).toEqual([]);
    expect(await shownShortIdsInOtherChannels(null, "WHATSAPP", `${run}-wa`)).toEqual([]);
  });
});
