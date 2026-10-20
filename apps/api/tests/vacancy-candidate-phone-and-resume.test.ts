import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { recordJobApplication } from "../src/lib/jobApplications.js";
import { fillChannelPhones } from "../src/lib/rescoreJobApplications.js";

/**
 * HR 25.09.2026: «не вижу номера этих людей и полной информации».
 *
 *  1. Кандидат из WhatsApp не печатал номер — номер всё равно в анкете: он и есть
 *     адрес переписки (wa_id). Напечатанный кандидатом номер главнее канального.
 *  2. Пересчёт старых анкет дописывает такой номер и тем, кто пришёл до правки.
 *  3. Сотрудник с разделом вакансий, но без права на номера КЛИЕНТОВ, видит номер
 *     в переписке кандидата целиком, а список отдаёт язык переписки из досье.
 */

const tail = String(Date.now()).slice(-6);
const WA_NEW = `99291${tail}1`;
const WA_OLD = `99291${tail}2`;
const WA_TYPED = `99291${tail}3`;
const CONV_NEW = `vac-ph-new-${tail}`;
const CONV_OLD = `vac-ph-old-${tail}`;
const CONV_TYPED = `vac-ph-typ-${tail}`;
const CONVS = [CONV_NEW, CONV_OLD, CONV_TYPED];
let managerId = "";
let token = "";
let profileId = "";

async function cleanup(): Promise<void> {
  await prisma.jobApplication.deleteMany({ where: { conversationId: { in: CONVS } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: CONVS } } });
  if (profileId) await prisma.contactProfile.deleteMany({ where: { id: profileId } });
}

beforeAll(async () => {
  await cleanup();
  const manager = await prisma.agent.create({
    data: {
      fullName: `HR вакансий ${tail}`,
      phone: `+99298${tail}7`,
      role: "MANAGER",
      passwordHash: "x",
    },
  });
  managerId = manager.id;
  token = signAccessToken({ sub: manager.id, role: "MANAGER" });
  const profile = await prisma.contactProfile.create({ data: { language: "tg" } });
  profileId = profile.id;
  await prisma.botConversation.create({
    data: {
      id: CONV_NEW,
      channel: "WHATSAPP",
      subscriberId: WA_NEW,
      contactProfileId: profileId,
      messages: [
        { role: "user", content: "Салом, мне 27 лет, звоните 90 555 12 34" },
        { role: "assistant", content: "Спасибо! Где работаете сейчас?" },
      ],
    },
  });
  await prisma.botConversation.create({ data: { id: CONV_OLD, channel: "WHATSAPP", subscriberId: WA_OLD } });
  await prisma.botConversation.create({ data: { id: CONV_TYPED, channel: "WHATSAPP", subscriberId: WA_TYPED } });
});

afterAll(async () => {
  await cleanup();
  await prisma.agent.deleteMany({ where: { id: managerId } });
});

describe("номер кандидата из WhatsApp", () => {
  it("попадает в анкету, даже если кандидат его не печатал", async () => {
    await recordJobApplication({ conversationId: CONV_NEW, channel: "WHATSAPP", draft: { age: 27 } });
    const row = await prisma.jobApplication.findUnique({ where: { conversationId: CONV_NEW } });
    expect(row?.phone).toBe(`+${WA_NEW}`);
  });

  it("напечатанный кандидатом номер главнее канального", async () => {
    await recordJobApplication({
      conversationId: CONV_TYPED,
      channel: "WHATSAPP",
      draft: { phone: "+992900112233" },
    });
    await recordJobApplication({ conversationId: CONV_TYPED, channel: "WHATSAPP", draft: { age: 30 } });
    const row = await prisma.jobApplication.findUnique({ where: { conversationId: CONV_TYPED } });
    expect(row?.phone).toBe("+992900112233");
  });

  it("пересчёт дописывает номер старой анкете без номера", async () => {
    await prisma.jobApplication.create({ data: { conversationId: CONV_OLD, channel: "WHATSAPP", status: "REVIEWED" } });
    const only = { conversationId: CONV_OLD };
    const dry = await fillChannelPhones(false, only);
    const oldId = (await prisma.jobApplication.findUnique({ where: { conversationId: CONV_OLD } }))!.id;
    expect(dry.map((r) => r.id)).toEqual([oldId]);
    expect((await prisma.jobApplication.findUnique({ where: { id: oldId } }))?.phone).toBeNull();

    await fillChannelPhones(true, only);
    expect((await prisma.jobApplication.findUnique({ where: { id: oldId } }))?.phone).toBe(`+${WA_OLD}`);
  });
});

describe("экран вакансий у сотрудника без права на номера клиентов", () => {
  it("переписка кандидата отдаёт номер целиком", async () => {
    const id = (await prisma.jobApplication.findUnique({ where: { conversationId: CONV_NEW } }))!.id;
    const res = await request(app).get(`/api/v1/vacancies/${id}/conversation`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const first = res.body.messages[0].content as string;
    expect(first).toContain("90 555 12 34");
    expect(first).not.toContain("•");
  });

  it("список отдаёт язык переписки из досье", async () => {
    const res = await request(app)
      .get(`/api/v1/vacancies?q=${WA_NEW.slice(-7)}&includeNoPhone=true`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const item = (res.body.items as { conversationId: string; chatLanguage: string | null; contactProfile?: unknown }[]).find(
      (i) => i.conversationId === CONV_NEW
    );
    expect(item?.chatLanguage).toBe("tg");
    expect(item && "contactProfile" in item).toBe(false);
  });
});
