import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { acceptLead } from "../src/messengers/conversation.js";
import { findDistrictIdByName } from "../src/lib/districtLookup.js";
import type { LeadDraft } from "../src/ai/leadQualifier.js";

/**
 * РАЙОН ИЗ РАЗГОВОРА НАХОДИТСЯ БЕЗ УЧЁТА РЕГИСТРА И В КАНАЛАХ META
 * (ночная проверка 24.09.2026, «горячие файлы» №5).
 *
 * Модель пишет «сино», в справочнике «Сино». Приём с сайта и оба Telegram-приёма
 * давно искали район через `mode: "insensitive"`, а приём в каналах Meta
 * (messengers/conversation.ts, acceptLead) сравнивал точно — район из разговора
 * молча не попадал в карточку. Теперь все четыре места зовут одну функцию
 * `findDistrictIdByName` (lib/districtLookup.ts).
 *
 * Приём — тихий (`silent: true`): модель не зовётся, ответа клиенту нет, а
 * карточка заводится тем же путём, что и в обычном приёме.
 */

const runId = Date.now().toString(36);
const SUBSCRIBER = `district-case-${runId}`;
const DISTRICT_NAME = `Сино-${runId}`;
/** Девять цифр — нормализуется в «+992…». */
const PHONE = `92${Date.now().toString().slice(-7)}`;

let districtId: string;
let conversationId: string;

beforeAll(async () => {
  await prisma.client.deleteMany({ where: { phone: `+992${PHONE}` } });
  await prisma.district.deleteMany({ where: { name: DISTRICT_NAME } });
  districtId = (await prisma.district.create({ data: { name: DISTRICT_NAME } })).id;
  conversationId = (
    await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: SUBSCRIBER,
        // Как модель записала: строчными, не так, как в справочнике.
        leadDraft: { stage: "awaiting_phone", intent: "buy", districtName: DISTRICT_NAME.toLowerCase() } as never,
        messages: [{ role: "user", content: "хона дар сино мехарам", at: new Date().toISOString() }] as never,
      },
    })
  ).id;
});

afterAll(async () => {
  const conv = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { clientId: true } });
  await prisma.botConversation.deleteMany({ where: { id: conversationId } });
  if (conv?.clientId) {
    await prisma.interaction.deleteMany({ where: { clientId: conv.clientId } });
    await prisma.client.deleteMany({ where: { id: conv.clientId } });
  }
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("findDistrictIdByName — одно правило на все каналы", () => {
  it("находит район в любом регистре и с пробелами по краям, а пустое имя не ищет", async () => {
    expect(await findDistrictIdByName(DISTRICT_NAME.toLowerCase())).toBe(districtId);
    expect(await findDistrictIdByName(` ${DISTRICT_NAME.toUpperCase()} `)).toBe(districtId);
    expect(await findDistrictIdByName(undefined)).toBeUndefined();
    expect(await findDistrictIdByName("")).toBeUndefined();
  });
});

describe("Приём заявки в каналах Meta", () => {
  it("район, записанный моделью строчными, попадает в карточку", async () => {
    const draft: LeadDraft = { stage: "awaiting_phone", intent: "buy", districtName: DISTRICT_NAME.toLowerCase() };
    const result = await acceptLead(conversationId, "INSTAGRAM", "Тест", PHONE, draft, [], {
      silent: true,
      deferAssignment: true,
    });
    expect(result.accepted).toBe(true);

    const conv = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { clientId: true } });
    expect(conv?.clientId).toBeTruthy();
    const client = await prisma.client.findUnique({
      where: { id: conv!.clientId! },
      select: { desiredDistrictId: true },
    });
    // Без починки: точное сравнение «сино-…» ≠ «Сино-…» → desiredDistrictId пуст.
    expect(client?.desiredDistrictId).toBe(districtId);
  });
});
