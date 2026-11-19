import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Номер, оставленный в комментарии, не теряется (17.11.2026, messengers/commentPhoneLead.ts).
 * Без базы: prisma, приём заявки и createLeadFromChannel подменены. Номера — тестовые.
 */
const mocks = vi.hoisted(() => ({
  findConversation: vi.fn(),
  acceptLead: vi.fn(),
  createLead: vi.fn(),
  findOwners: vi.fn(),
  log: vi.fn(),
}));

vi.mock("../src/db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db.js")>()),
  prisma: { botConversation: { findUnique: mocks.findConversation }, $disconnect: async () => undefined },
}));
vi.mock("../src/messengers/conversation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/conversation.js")>()),
  acceptLead: mocks.acceptLead,
}));
vi.mock("../src/services/leads/intake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/leads/intake.js")>()),
  createLeadFromChannel: mocks.createLead,
}));
vi.mock("../src/lib/clientPhones.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientPhones.js")>()),
  findPhoneOwners: mocks.findOwners,
}));
vi.mock("../src/lib/workingHours.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/workingHours.js")>()),
  isWithinWorkingHours: async () => true,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: mocks.log,
}));

import { StaffPhoneLeadError } from "../src/lib/staffPhoneGuard.js";
import {
  captureCommentPhoneIntoConversation,
  COMMENT_HISTORY_PREFIX,
  createLeadFromCommentPhone,
} from "../src/messengers/commentPhoneLead.js";

const PHONE_TEXT = "Нарх чанд? Занг занед 900000001";
const row = (text = PHONE_TEXT) => ({
  channel: "INSTAGRAM",
  commentId: "c-1",
  authorId: "author-1",
  authorName: "test_author",
  text,
});
const conversation = (over: Record<string, unknown> = {}) => ({
  clientId: null,
  leadDraft: null,
  messages: [],
  name: null,
  spamFlaggedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.acceptLead.mockResolvedValue({ reply: "", ready: true, accepted: true, shouldReply: false });
  mocks.createLead.mockResolvedValue({ clientId: "client-1", created: true });
  mocks.findOwners.mockResolvedValue([]);
  mocks.findConversation.mockResolvedValue(conversation());
});

describe("captureCommentPhoneIntoConversation (Instagram/Facebook/YouTube)", () => {
  it("номер в комментарии уходит в тихий приём заявки, комментарий ложится в переписку приёмом", async () => {
    const result = await captureCommentPhoneIntoConversation(row(), "conv-1");
    expect(result).toEqual({ outcome: "accepted", recordedInHistory: true });
    expect(mocks.acceptLead).toHaveBeenCalledTimes(1);
    const [conversationId, channel, , phone, , , options] = mocks.acceptLead.mock.calls[0]!;
    expect(conversationId).toBe("conv-1");
    expect(channel).toBe("INSTAGRAM");
    expect(phone).toBe("+992900000001");
    expect(options).toMatchObject({ silent: true, clientText: `${COMMENT_HISTORY_PREFIX}${PHONE_TEXT}` });
    expect(options.fromHistory).toBeUndefined();
  });

  it("комментарий без номера ничего не делает и не ходит в базу", async () => {
    const result = await captureCommentPhoneIntoConversation(row("Цена? Площадь 58, этаж 15"), "conv-1");
    expect(result.outcome).toBe("no_phone");
    expect(mocks.findConversation).not.toHaveBeenCalled();
    expect(mocks.acceptLead).not.toHaveBeenCalled();
  });

  it("повтор разбора: у диалога уже есть карточка — второй заявки нет", async () => {
    mocks.findConversation.mockResolvedValue(conversation({ clientId: "client-1" }));
    const result = await captureCommentPhoneIntoConversation(row(), "conv-1");
    expect(result.outcome).toBe("already");
    expect(mocks.acceptLead).not.toHaveBeenCalled();
  });

  it("повтор разбора: комментарий уже лежит в переписке — заново не заводим", async () => {
    mocks.findConversation.mockResolvedValue(
      conversation({ messages: [{ role: "user", content: `${COMMENT_HISTORY_PREFIX}${PHONE_TEXT}` }] })
    );
    const result = await captureCommentPhoneIntoConversation(row(), "conv-1");
    expect(result).toEqual({ outcome: "already", recordedInHistory: true });
    expect(mocks.acceptLead).not.toHaveBeenCalled();
  });

  it("диалог, помеченный как рассылка, заявкой не становится", async () => {
    mocks.findConversation.mockResolvedValue(conversation({ spamFlaggedAt: new Date() }));
    const result = await captureCommentPhoneIntoConversation(row(), "conv-1");
    expect(result.outcome).toBe("spam");
    expect(mocks.acceptLead).not.toHaveBeenCalled();
  });

  it("отказ приёма (аренда, номер сотрудника) — не заявка, комментарий приёмом не записан", async () => {
    mocks.acceptLead.mockResolvedValue({ reply: "", ready: true, accepted: false });
    const result = await captureCommentPhoneIntoConversation(row(), "conv-1");
    expect(result).toEqual({ outcome: "declined", recordedInHistory: false });
  });

  it("сбой приёма не бросает наружу, но пишет тревогу: номер есть, карточки нет", async () => {
    mocks.acceptLead.mockRejectedValue(new Error("db down"));
    const result = await captureCommentPhoneIntoConversation(row(), "conv-1");
    expect(result.outcome).toBe("failed");
    expect(mocks.log).toHaveBeenCalledWith("ai", expect.stringContaining("[alarm]"));
  });
});

describe("createLeadFromCommentPhone (обсуждение Telegram-канала, диалога нет)", () => {
  const tg = (text = PHONE_TEXT) => ({ ...row(text), channel: "TELEGRAM" as const });

  it("новый номер — карточка через createLeadFromChannel, источник Telegram", async () => {
    expect(await createLeadFromCommentPhone(tg())).toBe("accepted");
    expect(mocks.createLead).toHaveBeenCalledTimes(1);
    expect(mocks.createLead.mock.calls[0]![0]).toMatchObject({ phone: "+992900000001", source: "TELEGRAM" });
  });

  it("повтор: номер уже у карточки — второй не заводим", async () => {
    mocks.findOwners.mockResolvedValue([{ id: "client-1", deletedAt: null }]);
    expect(await createLeadFromCommentPhone(tg())).toBe("already");
    expect(mocks.createLead).not.toHaveBeenCalled();
  });

  it("аренда и вакансия карточкой клиента не становятся", async () => {
    expect(await createLeadFromCommentPhone(tg("Хонаи иҷора доред? 900000001"))).toBe("declined");
    expect(await createLeadFromCommentPhone(tg("Нужна работа, звоните 900000001"))).toBe("declined");
    expect(mocks.createLead).not.toHaveBeenCalled();
  });

  it("без номера — ничего; сбой карточки (номер сотрудника) — тревога, не исключение", async () => {
    expect(await createLeadFromCommentPhone(tg("Цена?"))).toBe("no_phone");
    mocks.createLead.mockRejectedValue(new Error("staff phone"));
    expect(await createLeadFromCommentPhone(tg())).toBe("failed");
    expect(mocks.log).toHaveBeenCalledWith("ai", expect.stringContaining("[alarm]"));
  });
});

describe("номер самой компании не клиент", () => {
  it("комментарий цитирует публичный номер агентства — заявки нет (диалог и без диалога)", async () => {
    const ours = "Звоните нам: +992 44 650 14 14";
    expect((await captureCommentPhoneIntoConversation(row(ours), "conv-1")).outcome).toBe("no_phone");
    expect(mocks.findConversation).not.toHaveBeenCalled();
    expect(await createLeadFromCommentPhone({ ...row(ours), channel: "TELEGRAM" })).toBe("no_phone");
    expect(mocks.acceptLead).not.toHaveBeenCalled();
    expect(mocks.createLead).not.toHaveBeenCalled();
  });

  it("свой номер рядом с номером компании: берётся клиентский", async () => {
    await captureCommentPhoneIntoConversation(row("Ваш 446501414, мой 900000001"), "conv-1");
    expect(mocks.acceptLead.mock.calls[0]![3]).toBe("+992900000001");
  });
});

describe("ревью 17.11: кому заявка не полагается", () => {
  const MONEY = "Помогите деньгами на лечение ребёнка, 900000001";
  it("просьба о деньгах с номером — заявки нет ни с диалогом, ни без (полное молчание, как в личке)", async () => {
    expect((await captureCommentPhoneIntoConversation(row(MONEY), "conv-1")).outcome).toBe("declined");
    expect(await createLeadFromCommentPhone({ ...row(MONEY), channel: "TELEGRAM" })).toBe("declined");
    expect(mocks.acceptLead).not.toHaveBeenCalled();
    expect(mocks.createLead).not.toHaveBeenCalled();
  });

  it("объявление собственника и реклама агентства не становятся клиентом (ветка managed их не разбирает)", async () => {
    const ad = "Продаю 3-комн. квартиру, 58 кв, 15 этаж, тел 900000001";
    expect(await createLeadFromCommentPhone({ ...row(ad), channel: "INSTAGRAM" })).toBe("declined");
    expect((await captureCommentPhoneIntoConversation(row(ad), "conv-1")).outcome).toBe("declined");
    expect(mocks.createLead).not.toHaveBeenCalled();
    expect(mocks.acceptLead).not.toHaveBeenCalled();
  });

  it("номер сотрудника: отказ без ложной тревоги «заведите карточку руками»", async () => {
    const staff = new StaffPhoneLeadError({ agentId: "a", fullName: "x", phone: "+992900000001", matchedPhone: "+992900000001" });
    mocks.createLead.mockRejectedValue(staff);
    mocks.acceptLead.mockRejectedValue(staff);
    expect(await createLeadFromCommentPhone({ ...row(), channel: "TELEGRAM" })).toBe("declined");
    expect((await captureCommentPhoneIntoConversation(row(), "conv-1")).outcome).toBe("declined");
    expect(mocks.log).not.toHaveBeenCalledWith("ai", expect.stringContaining("[alarm]"));
  });

  it("номер удалённой карточки: заявка не заводится, тревоги нет", async () => {
    mocks.findOwners.mockResolvedValue([{ id: "c", deletedAt: new Date() }]);
    expect(await createLeadFromCommentPhone({ ...row(), channel: "TELEGRAM" })).toBe("already");
    expect(mocks.log).not.toHaveBeenCalled();
  });
});
