import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * Имя компании аккаунта на всех путях к клиенту, кроме основного хода (его держит
 * messenger-account-brand-name.test.ts): служебная доставка, короткие реплики,
 * комментарии, воронка лид-магнита, шаблон имени, подписи постов.
 *
 * Каждый тест сторожа проверен поломкой: убрана подмена на своём пути, и он краснеет
 * (см. запись журнала docs/journal/2026-11-08-brand-name-на-аккаунт.md).
 */

const mocks = vi.hoisted(() => ({
  model: vi.fn(), graph: vi.fn(), privateReply: vi.fn(), sendMeta: vi.fn(), log: vi.fn(),
}));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText: mocks.model,
}));
vi.mock("../src/messengers/humanPacing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/humanPacing.js")>()), sleep: async () => {},
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  callGraph: mocks.graph, sendPrivateReply: mocks.privateReply, sendMessage: mocks.sendMeta, isMetaChannelEnabled: async () => true,
  fetchWithRetry: async () => new Response(JSON.stringify({ permalink: "", caption: "Synthetic post" }), { status: 200 }),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: mocks.log,
}));
vi.mock("../src/messengers/appendMessages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/appendMessages.js")>()),
  appendConversationMessages: vi.fn(async () => undefined),
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()), sendPushToAgents: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/ownerBuyerMatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ownerBuyerMatch.js")>()), matchBuyersForListing: async () => null,
}));
vi.mock("../src/lib/leadMagnet.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/leadMagnet.js")>()),
  leadMagnetActive: async () => false, isFunnelKeyword: async () => null, hasPendingLeadMagnetDelivery: async () => false,
}));

const { deliverToConversation } = await import("../src/lib/conversationDelivery.js");
const { shortAgentReply } = await import("../src/ai/shortAgentReply.js");
const { handleComment } = await import("../src/messengers/comments.js");
const { brandedCampaign, tryLeadMagnetMessage } = await import("../src/lib/leadMagnet.js");
const { brandize, brandNameError, mentionsDefaultBrand } = await import("../src/ai/brandPattern.js");
const { saveAccount, resetAccountsCache } = await import("../src/messengers/accounts.js");
const { isOurBrandCaption, captionSaysForeign } = await import("../src/messengers/sharedMedia.js");

const tag = `brand-paths-${randomUUID().slice(0, 8)}`;
let fixture: CustomerMessengerFixture;
let conversationId = "";
let commentAccountId = "";
let commentExternal = "";
const commentRows: string[] = [];
const campaignIds: string[] = [];

async function setBrand(id: string, brandName: string | null) {
  await prisma.messengerAccount.update({ where: { id }, data: { brandName } });
  resetAccountsCache();
}
const leakLogged = () =>
  mocks.log.mock.calls.some((c) => (c[2] as { dedupKey?: string } | undefined)?.dedupKey === "brand-name-leak");

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
  conversationId = (await fixture.ensureConversation(`${tag}-dm`)).id;
  commentExternal = `${tag}-ig`;
  const account = await prisma.messengerAccount.create({
    data: { channel: "INSTAGRAM", externalId: commentExternal, title: "Brand paths comments", token: encryptSecret("fake-token"), brandName: "Арван" },
  });
  commentAccountId = account.id;
  resetAccountsCache();
});

beforeEach(() => {
  mocks.model.mockReset();
  mocks.log.mockReset();
  mocks.log.mockResolvedValue(undefined);
  mocks.sendMeta.mockReset();
  mocks.sendMeta.mockResolvedValue("mid-1");
  mocks.graph.mockReset();
  mocks.graph.mockResolvedValue({ id: `${tag}-public`, message_id: `${tag}-dm` });
  mocks.privateReply.mockReset();
  mocks.privateReply.mockResolvedValue(`${tag}-dm`);
});

afterAll(async () => {
  await prisma.instagramComment.deleteMany({ where: { id: { in: commentRows } } });
  await prisma.leadMagnetCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  await prisma.botConversation.deleteMany({ where: { subscriberId: { startsWith: `${tag}-lm` } } });
  await prisma.messengerAccount.deleteMany({ where: { id: commentAccountId } });
  await fixture?.cleanupConversations();
  await fixture?.dispose();
  resetAccountsCache();
});

describe("чистые правила имени", () => {
  it.each([
    ["Роял Хоум", "Это Роял Хоум."],
    ["Ройал Хоум", "Это Ройал Хоум."],
    ["Рояль Хоум", "Это Рояль Хоум."],
    ["Royal\nHome", "Это Royal\nHome."],
    ["Royal Home", "Это Royal Home."],
    ["Royal Home Info", "Это Royal Home Info."],
  ])("подменяется: %j", (_label, text) => {
    expect(mentionsDefaultBrand(text)).toBe(true);
    expect(brandize(text, "Арван")).toBe("Это Арван.");
  });

  it.each([
    ["в Роял Хоуме", "в Арван"],
    ["у Роял Хоума", "у Арван"],
    ["Роял Хоуму", "Арван"],
    ["с Роял Хоумом", "с Арван"],
    ["Ройял Хоум", "Арван"],
    ["RoyalHome подберёт", "Арван подберёт"],
    ["Это RoyalHome.", "Это Арван."],
  ])("падежи и написания: %j", (text, expected) => {
    expect(brandize(text, "Арван")).toBe(expected);
  });

  it("домен royalhome.tj и абзац после «Royal Home» не съедаются", () => {
    expect(brandize("Сайт royalhome.tj", "Арван")).toBe("Сайт royalhome.tj");
    expect(brandize("RoyalHome.tj", "Арван")).toBe("RoyalHome.tj");
    expect(brandize("Мы Royal Home\n\nInfo о ценах", "Арван")).toBe("Мы Арван\n\nInfo о ценах");
  });

  it("слово, продолженное буквой, не ломается: «Information», «Homes», «Роял Хоумы»", () => {
    expect(brandize("Royal Home Information", "Арван")).toBe("Арван Information");
    expect(brandize("Royal Homes", "Арван")).toBe("Royal Homes");
    expect(brandize("Royal Home Info", "Арван")).toBe("Арван");
    expect(brandize("Роял Хоумы", "Арван")).toBe("Роял Хоумы");
  });

  it("сайт, ники и ссылки остаются", () => {
    const keep = "royalhome.tj @royal.home.tj https://royalhome.tj/p/1 github.com/royal-home-crm";
    expect(brandize(keep, "Арван")).toBe(keep);
  });

  it("имя со словом «Royal Home» запрещено и на проверке, и при сохранении", async () => {
    expect(brandNameError("Royal Home Arvan")).toMatch(/Royal Home/);
    expect(brandNameError("Роял Хоум")).toMatch(/Royal Home/);
    expect(brandNameError("x".repeat(21))).toMatch(/20/);
    expect(brandNameError("x".repeat(20))).toBeNull();
    expect(brandNameError("Дом")).toBeNull();
    expect(brandNameError("До")).toMatch(/3/);
    expect(brandNameError("Арван")).toBeNull();
    expect(brandNameError("")).toBeNull();
    await expect(
      saveAccount({ id: commentAccountId, channel: "INSTAGRAM", externalId: commentExternal, title: "t", brandName: "Royal Home 2" })
    ).rejects.toThrow(/Royal Home/);
    // старое имя в базе не тронуто неудачной попыткой
    expect((await prisma.messengerAccount.findUniqueOrThrow({ where: { id: commentAccountId } })).brandName).toBe("Арван");
  });
});

describe("deliverToConversation: единая дверь для служебных текстов", () => {
  const target = () => ({
    kind: "bot" as const, id: conversationId, channel: "INSTAGRAM", subscriberId: `${tag}-dm`,
    accountId: fixture.id, transport: fixture.transport,
  });
  const sentText = () => String(mocks.sendMeta.mock.calls[0]?.[2] ?? "");

  it("system и bot: «Royal Home» из шаблона заменяется именем аккаунта", async () => {
    await setBrand(fixture.id, "Арван");
    for (const sender of [undefined, { kind: "system" as const }, { kind: "bot" as const }]) {
      mocks.sendMeta.mockClear();
      const res = await deliverToConversation(target(), "Здравствуйте! Это Royal Home, напоминаем о показе.", undefined, sender ? { sender } : undefined);
      expect(res.ok).toBe(true);
      expect(sentText()).toBe("Здравствуйте! Это Арван, напоминаем о показе.");
    }
  });

  it("цель без accountId: имя находится по диалогу", async () => {
    await setBrand(fixture.id, "Арван");
    const { accountId: _skip, ...noAccount } = target();
    await deliverToConversation(noAccount, "Это Royal Home.", undefined, { sender: { kind: "system" } });
    expect(sentText()).toBe("Это Арван.");
  });

  it("живой сотрудник: текст не трогаем; аккаунт без имени: текст не трогаем", async () => {
    await setBrand(fixture.id, "Арван");
    await deliverToConversation(target(), "Я из Royal Home.", undefined, { sender: { kind: "agent", agentId: "a1", agentName: "Алишер" } });
    expect(sentText()).toBe("Я из Royal Home.");
    await setBrand(fixture.id, null);
    mocks.sendMeta.mockClear();
    await deliverToConversation(target(), "Это Royal Home.", undefined, { sender: { kind: "system" } });
    expect(sentText()).toBe("Это Royal Home.");
  });
});

describe("shortAgentReply: напоминания и подтверждения", () => {
  it("промт подменён, утёкшее имя в ответе заменено и записано в журнал", async () => {
    await setBrand(fixture.id, "Арван");
    mocks.model.mockResolvedValue({ reply: "Мы из Royal Home, ещё актуально?" });
    const text = await shortAgentReply([{ role: "user", content: "Здравствуйте" }], "Напомни клиенту.", undefined, conversationId);
    const arg = mocks.model.mock.calls[0]![0] as { system: string };
    expect(arg.system).toContain("Арван");
    expect(arg.system).not.toMatch(/Royal[  ]+Home/i);
    expect(text).toContain("Арван");
    expect(text).not.toMatch(/Royal Home/);
    expect(leakLogged()).toBe(true);
  });

  it("без имени аккаунта и без диалога: прежнее поведение", async () => {
    await setBrand(fixture.id, null);
    mocks.model.mockResolvedValue({ reply: "Мы из Royal Home, ещё актуально?" });
    const withConv = await shortAgentReply([{ role: "user", content: "Здравствуйте" }], "Напомни клиенту.", undefined, conversationId);
    const arg = mocks.model.mock.calls[0]![0] as { system: string };
    expect(arg.system).toMatch(/Royal Home/);
    expect(withConv).toContain("Royal Home");
    expect(leakLogged()).toBe(false);
    mocks.model.mockResolvedValue({ reply: "Мы из Royal Home, ещё актуально?" });
    expect(await shortAgentReply([{ role: "user", content: "Здравствуйте" }], "Напомни клиенту.")).toContain("Royal Home");
  });
});

describe("комментарии аккаунта с именем", () => {
  async function comment() {
    const peer = `${tag}-c-${commentRows.length}`;
    const row = await prisma.instagramComment.create({
      data: { channel: "INSTAGRAM", commentId: peer, mediaId: `${tag}-media`, accountExternalId: commentExternal, authorId: peer, text: "Цена?", replyDueAt: new Date() },
    });
    commentRows.push(row.id);
    return row;
  }

  it("промт без «Royal Home», публичный ответ и личное с утёкшим именем исправлены", async () => {
    mocks.model.mockResolvedValue({ action: "reply", reply: "Салом! Мы Royal Home, поможем.", dm: "Это Royal Home, напишите нам." });
    const row = await comment();
    expect(await handleComment(row as never)).toBe("replied");
    const arg = mocks.model.mock.calls[0]![0] as { system: string; systemStable: string };
    expect(arg.system + arg.systemStable).toContain("Арван");
    expect(arg.system + arg.systemStable).not.toMatch(/Royal[  ]+Home/i);
    const stored = await prisma.instagramComment.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.replyText).toContain("Арван");
    expect(stored.replyText).not.toMatch(/Royal Home/);
    expect(stored.dmText ?? "").not.toMatch(/Royal Home/);
    expect(mocks.privateReply.mock.calls.map((c) => String(c[1])).join(" ")).not.toMatch(/Royal Home/);
    expect(leakLogged()).toBe(true);
  });
});

describe("воронка лид-магнита", () => {
  const campaign = {
    id: "c1", name: "Чек-лист", enabled: true, accountId: null, postUrl: null, mediaId: null, keywords: ["чек"], anyComment: false,
    publicReplies: ["Отправили в директ от Royal Home"], inviteText: "Это Royal Home, нажмите кнопку", inviteButton: "Получить от Royal Home",
    requireFollow: true, followText: "Подпишитесь на Royal Home", followButton: "Я подписался", notFollowingText: "Не вижу подписки на Royal Home",
    maxFollowChecks: 2, deliverIfUnsure: false, deliverOnSecondClaim: false, requireFollowAll: false, postUrls: [], mediaIds: [],
    deliveredText: "Держите чек-лист от Royal Home. Сайт royalhome.tj", filePath: null, fileName: null, link: null, handoffToBot: false,
  };

  it("кампания без аккаунта отдаёт тексты под именем аккаунта-получателя; сайт остаётся", async () => {
    const out = await brandedCampaign(campaign, commentAccountId);
    for (const t of [...out.publicReplies, out.inviteText, out.inviteButton, out.followText, out.notFollowingText, out.deliveredText]) {
      expect(t).not.toMatch(/Royal Home/);
    }
    expect(out.inviteText).toBe("Это Арван, нажмите кнопку");
    expect(out.deliveredText).toContain("royalhome.tj");
    expect(out.name).toBe("Чек-лист");
  });

  it("аккаунт без имени и без аккаунта: тот же объект кампании", async () => {
    expect(await brandedCampaign(campaign, null)).toBe(campaign);
    expect(await brandedCampaign(campaign, fixture.id)).toBe(campaign);
  });
});

describe("воронка: реальные входы tryLeadMagnetMessage и повторная выдача", () => {
  async function seed(state: "INVITED" | "DELIVERED", deliveredAt: Date | null) {
    const campaign = await prisma.leadMagnetCampaign.create({
      data: {
        name: `${tag} чек-лист`, enabled: true, accountId: null, keywords: ["чек"], inviteText: "Это Royal Home", inviteButton: "Хочу",
        requireFollow: false, followText: "Подпишитесь на Royal Home", notFollowingText: "Нет подписки на Royal Home",
        deliveredText: "Держите от Royal Home", link: "https://example.com/list", handoffToBot: false,
      },
    });
    campaignIds.push(campaign.id);
    const igUserId = `${tag}-lm-${campaignIds.length}`;
    await prisma.leadMagnetDelivery.create({ data: { campaignId: campaign.id, igUserId, state, deliveredAt } });
    return { campaign, igUserId };
  }
  const allSent = () => mocks.sendMeta.mock.calls.map((c) => String(c[2])).join(" | ");

  it("первая выдача (tryLeadMagnetMessage): тексты под именем аккаунта", async () => {
    const { campaign, igUserId } = await seed("INVITED", null);
    const handled = await tryLeadMagnetMessage({
      channel: "INSTAGRAM", senderId: igUserId, accountExternalId: commentExternal, text: "чек", payload: `lm:${campaign.id}`,
    });
    expect(handled).toBe(true);
    expect(allSent()).toContain("Держите от Арван");
    expect(allSent()).not.toMatch(/Royal Home/);
  });

  it("повторная выдача (tryRedeliver): тексты под именем аккаунта", async () => {
    const { igUserId } = await seed("DELIVERED", new Date(Date.now() - 60 * 60 * 1000));
    const handled = await tryLeadMagnetMessage({
      channel: "INSTAGRAM", senderId: igUserId, accountExternalId: commentExternal, text: "где чек-лист? не пришёл",
    });
    expect(handled).toBe(true);
    expect(allSent()).toContain("Держите от Арван");
    expect(allSent()).not.toMatch(/Royal Home/);
  });
});

describe("подписи постов бренда", () => {
  it("с именем аккаунта пост узнаётся как свой; без имени поведение прежнее", () => {
    expect(isOurBrandCaption("Арван Estate: новая квартира")).toBe(false);
    expect(isOurBrandCaption("Арван Estate: новая квартира", "Арван")).toBe(true);
    expect(captionSaysForeign("Арван Estate #dushanbe", "Арван")).toBe(false);
    expect(captionSaysForeign("Арван Estate #dushanbe")).toBe(true);
    // Короткое имя не делает своей любую подпись: по границе слова, не по куску.
    expect(isOurBrandCaption("Дома в Душанбе, недорого", "Дом")).toBe(false);
    expect(isOurBrandCaption("Дом", "До")).toBe(false);
    expect(isOurBrandCaption("Купить Арван.Estate", "Арван")).toBe(true);
    expect(isOurBrandCaption("Royal Home 🏡")).toBe(true);
  });
});
