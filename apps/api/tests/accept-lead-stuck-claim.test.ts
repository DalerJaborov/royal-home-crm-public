import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ЗАВИСШИЙ ЗАХВАТ ПРИЁМА ЗАЯВКИ (AI-DIALOGUE01, аудит 04.10.2026).
 *
 * acceptLead первым делом ставит stage='accepting' (атомарный захват хода). Откат
 * стадии был только на ошибку createLeadFromChannel; если падал следующий шаг
 * (привязка карточки к диалогу) или процесс умирал после захвата, диалог навсегда
 * оставался «accepting»: повтор получал claimed=0 и возвращал accepted:true без
 * карточки, без ответа и без тревоги. Модель и транспорт подменены.
 */

const { callAiText } = vi.hoisted(() => ({ callAiText: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText,
}));

const { prisma } = await import("../src/db.js");
const { acceptLead } = await import("../src/messengers/conversation.js");

const runId = Date.now().toString(36);
const botConvIds: string[] = [];

function freshDigits(): string {
  return `93${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
}

const draftBase = { stage: "awaiting_phone" as const, intent: "buy" as const, confident: true, budgetMax: 400000 };

async function seed(leadDraft: Record<string, unknown>) {
  const digits = freshDigits();
  const history = [{ role: "user" as const, content: "Салом, 2 хонагӣ дар Сино лозим" }];
  const conv = await prisma.botConversation.create({
    data: {
      channel: "INSTAGRAM",
      subscriberId: `stuck-claim-${runId}-${digits}`,
      leadDraft: leadDraft as object,
      messages: history as object[],
    },
  });
  botConvIds.push(conv.id);
  return { conv, digits, history };
}

async function stageOf(id: string): Promise<string | undefined> {
  const row = await prisma.botConversation.findUnique({ where: { id }, select: { leadDraft: true } });
  return (row?.leadDraft as { stage?: string } | null)?.stage;
}

beforeAll(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
});

beforeEach(() => {
  callAiText.mockReset();
  callAiText.mockResolvedValue(null);
});

afterAll(async () => {
  vi.restoreAllMocks();
  const convs = await prisma.botConversation.findMany({
    where: { id: { in: botConvIds } },
    select: { clientId: true },
  });
  const clientIds = convs.map((c) => c.clientId).filter((x): x is string => !!x);
  await prisma.botConversation.deleteMany({ where: { id: { in: botConvIds } } });
  if (clientIds.length > 0) {
    await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  }
});

describe("acceptLead: захват хода не зависает навсегда", () => {
  it("упала привязка карточки к диалогу: стадия откатывается, повтор доводит привязку", async () => {
    const { conv, digits, history } = await seed({ ...draftBase });
    const original = prisma.botConversation.update.bind(prisma.botConversation);
    let thrown = false;
    vi.spyOn(prisma.botConversation, "update").mockImplementation(((args: { data?: { clientId?: string } }) => {
      if (!thrown && args?.data?.clientId) {
        thrown = true;
        return Promise.reject(new Error("синтетический сбой привязки"));
      }
      return (original as (a: unknown) => unknown)(args);
    }) as never);

    await expect(
      acceptLead(conv.id, "INSTAGRAM", "Фируз", `+992${digits}`, { ...draftBase }, history, {
        clientText: digits,
        deferAssignment: true,
      })
    ).rejects.toThrow("синтетический сбой привязки");
    vi.restoreAllMocks();
    // Стадия вернулась к той, что была до захвата, а не застряла в «accepting».
    expect(await stageOf(conv.id)).toBe("awaiting_phone");

    const second = await acceptLead(conv.id, "INSTAGRAM", "Фируз", `+992${digits}`, { ...draftBase }, history, {
      clientText: digits,
      deferAssignment: true,
    });
    expect(second.accepted).toBe(true);
    const after = await prisma.botConversation.findUnique({ where: { id: conv.id }, select: { clientId: true } });
    expect(after?.clientId).toBeTruthy();
    expect(await stageOf(conv.id)).toBe("done");
  });

  it("процесс умер после захвата: «accepting» старше порога перезахватывается, карточка заводится", async () => {
    const { conv, digits, history } = await seed({
      ...draftBase,
      stage: "accepting",
      acceptingAt: Date.now() - 10 * 60_000,
    });

    const res = await acceptLead(conv.id, "INSTAGRAM", "Фируз", `+992${digits}`, { ...draftBase }, history, {
      clientText: digits,
      deferAssignment: true,
    });

    expect(res.accepted).toBe(true);
    const after = await prisma.botConversation.findUnique({ where: { id: conv.id }, select: { clientId: true } });
    expect(after?.clientId).toBeTruthy();
    expect(await stageOf(conv.id)).toBe("done");
  });

  it("захват свежий (победитель гонки ещё работает): опоздавший молча уходит, второй карточки нет", async () => {
    const { conv, digits, history } = await seed({
      ...draftBase,
      stage: "accepting",
      acceptingAt: Date.now() - 5_000,
    });

    const res = await acceptLead(conv.id, "INSTAGRAM", "Фируз", `+992${digits}`, { ...draftBase }, history, {
      clientText: digits,
      deferAssignment: true,
    });

    expect(res.shouldReply).toBe(false);
    const after = await prisma.botConversation.findUnique({ where: { id: conv.id }, select: { clientId: true } });
    expect(after?.clientId).toBeNull();
    expect(await stageOf(conv.id)).toBe("accepting");
  });
});

describe("acceptLead: досье человека связывается с новой карточкой сразу (AI-DIALOGUE04)", () => {
  it("диалог с досье без карточки: после приёма ContactProfile.clientId равен созданной карточке", async () => {
    const profile = await prisma.contactProfile.create({ data: {} });
    const digits = freshDigits();
    const history = [{ role: "user" as const, content: "Салом, 2 хонагӣ дар Сино лозим" }];
    const conv = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `stuck-claim-${runId}-${digits}`,
        contactProfileId: profile.id,
        leadDraft: { ...draftBase } as object,
        messages: history as object[],
      },
    });
    botConvIds.push(conv.id);

    await acceptLead(conv.id, "INSTAGRAM", "Фируз", `+992${digits}`, { ...draftBase }, history, {
      clientText: digits,
      deferAssignment: true,
    });

    const linkedConv = await prisma.botConversation.findUnique({ where: { id: conv.id }, select: { clientId: true } });
    const profileAfter = await prisma.contactProfile.findUnique({ where: { id: profile.id }, select: { clientId: true } });
    expect(linkedConv?.clientId).toBeTruthy();
    expect(profileAfter?.clientId).toBe(linkedConv?.clientId);
    await prisma.botConversation.update({ where: { id: conv.id }, data: { contactProfileId: null } });
    await prisma.contactProfile.delete({ where: { id: profile.id } });
  });
});
