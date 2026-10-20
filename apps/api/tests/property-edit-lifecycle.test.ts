import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";

/**
 * ПРАВКА ОБЪЕКТА ПО ЭТАПАМ (владелец 07.10.2026, отменяет замок на монтаже от 23.09):
 * - до публикации (проверка, монтаж) агент правит свой объект; монтажёр и
 *   модератор получают уведомление «было → стало»;
 * - после публикации агент не меняет ничего, кроме статуса: 409
 *   PROPERTY_EDIT_LOCKED (reason PUBLISHED), а кнопки видео-исправлений — 403;
 *   директор, админ и все с правом properties.editForeign правят всегда;
 * - каждая правка пишется в хронологию «было → стало»;
 * - «Готово» рассылает подпись, где факты переписаны точечно, а не заново;
 * - цена в сохранённой подписи меняется и у неопубликованного объекта.
 *
 * Соцсети, Telegram и пуши подменены: тест никуда не ходит.
 */

const { editMessageCaption, updateFacebookVideoDescription, updateYouTubeDescription, sendMessage, sendPushToAgents, sendPushToAgent } = vi.hoisted(() => ({
  editMessageCaption: vi.fn(async () => {}),
  sendMessage: vi.fn(async (..._args: unknown[]) => {}),
  sendPushToAgents: vi.fn(async (..._args: unknown[]) => 0),
  sendPushToAgent: vi.fn(async (..._args: unknown[]) => 0),
  updateFacebookVideoDescription: vi.fn(async () => ({ ok: true })),
  updateYouTubeDescription: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  updateFacebookVideoDescription,
  updateYouTubeDescription,
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  editMessageCaption,
  sendMessage,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
  sendPushToAgent,
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  loadCredentials: async () => ({ pageToken: "page-token", pageId: "page-1", igToken: "ig-token" }),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { waitFor, waitForSettled } = await import("./helpers/waitFor.js");
const {
  rewriteCaptionFacts,
  fillReelsCaptionTemplate,
  parseReelsCaptionTemplates,
  reelsCaptionValuesFromProperty,
  REELS_FACTS_TEMPLATE,
  withPostFooter,
} =
  await import("../src/lib/reelsCaptionTemplate.js");
const { PROPERTY_EDIT_LOCKED_CODE, PROPERTY_EDIT_LOCKED_REASON_PUBLISHED, PROPERTY_PUBLISHED_ACTION_DENIED_MESSAGE } = await import("@royal-home/shared");

const runId = `${Date.now()}`.slice(-7);
const propertyIds: string[] = [];
let districtId = "";
let agentId = "";
let managerId = "";
let adminId = "";
let montajerId = "";
const montajerChatId = `tg-montajer-${`${Date.now()}`.slice(-7)}`;
let savedMontajerId: string | null = null;
let agentToken = "";
let managerToken = "";
let savedTelegramChannel: string | null = null;

async function seed(overrides: Record<string, unknown> = {}) {
  const property = await prisma.property.create({
    data: {
      title: `Правка по этапам ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 58,
      floor: 5,
      totalFloors: 9,
      price: 450000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 11",
      condition: "GOOD",
      status: "AVAILABLE",
      assignedAgentId: agentId,
      createdById: agentId,
      ...overrides,
    } as never,
  });
  propertyIds.push(property.id);
  return property;
}

function adminToken(): string {
  return signAccessToken({ sub: adminId, role: "ADMIN" });
}

function patch(id: string, token: string, body: Record<string, unknown>) {
  return request(app).patch(`/api/v1/properties/${id}`).set("Authorization", `Bearer ${token}`).send(body);
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Правка по этапам ${runId}` } })).id;
  const agent = await prisma.agent.create({
    data: { fullName: `Агент правки ${runId}`, phone: `+99293${runId}1`, role: "AGENT", passwordHash: "x" },
  });
  const manager = await prisma.agent.create({
    data: { fullName: `Руководитель правки ${runId}`, phone: `+99293${runId}2`, role: "MANAGER", passwordHash: "x" },
  });
  const admin = await prisma.agent.create({
    data: { fullName: `Модератор правки ${runId}`, phone: `+99293${runId}3`, role: "ADMIN", passwordHash: "x" },
  });
  const montajer = await prisma.agent.create({
    data: { fullName: `Монтажёр правки ${runId}`, phone: `+99293${runId}4`, role: "EDITOR", passwordHash: "x", telegramChatId: montajerChatId },
  });
  agentId = agent.id;
  managerId = manager.id;
  adminId = admin.id;
  montajerId = montajer.id;
  agentToken = signAccessToken({ sub: agentId, role: "AGENT" });
  managerToken = signAccessToken({ sub: managerId, role: "MANAGER" });
  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { telegramChannelId: true },
  });
  savedTelegramChannel = settings.telegramChannelId;
  savedMontajerId = (await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { videoMontajerAgentId: true } })).videoMontajerAgentId;
  await prisma.settings.update({ where: { id: "singleton" }, data: { telegramChannelId: "@rh-edit-test", videoMontajerAgentId: montajerId } });
});

beforeEach(() => {
  editMessageCaption.mockClear();
  updateFacebookVideoDescription.mockClear();
  updateYouTubeDescription.mockClear();
  sendMessage.mockClear();
  sendPushToAgents.mockClear();
  sendPushToAgent.mockClear();
});

afterAll(async () => {
  await waitForSettled(() => prisma.auditLog.count({ where: { entityId: { in: propertyIds } } }));
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.priceChange.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.montajerMessage.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { OR: propertyIds.map((id) => ({ tag: { contains: id } })) } });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { telegramChannelId: savedTelegramChannel, videoMontajerAgentId: savedMontajerId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, managerId, adminId, montajerId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("замок правки после публикации", () => {
  it("на модерации агент правит свой объект", async () => {
    const p = await seed({ status: "PENDING_REVIEW" });
    const res = await patch(p.id, agentToken, { areaSqm: 60 });
    expect(res.status).toBe(200);
  });

  it("на монтаже агент правит цену — можно (замок на монтаже снят)", async () => {
    const p = await seed({ status: "EDITING" });
    const res = await patch(p.id, agentToken, { price: 470000 });
    expect(res.status).toBe(200);
    expect(Number((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).price)).toBe(470000);
  });

  it("после публикации агенту отказ с причиной PUBLISHED, директору и руководству можно", async () => {
    const p = await seed({ status: "AVAILABLE" });
    const res = await patch(p.id, agentToken, { price: 470000 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(PROPERTY_EDIT_LOCKED_CODE);
    expect(res.body.reason).toBe(PROPERTY_EDIT_LOCKED_REASON_PUBLISHED);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(Number(after.price)).toBe(450000);

    expect((await patch(p.id, managerToken, { price: 470000 })).status).toBe(200);
    expect((await patch(p.id, adminToken(), { price: 480000 })).status).toBe(200);
  });

  it.each(["RESERVED", "SOLD", "WITHDRAWN"])("в статусе %s агент тоже не правит параметры", async (status) => {
    const p = await seed({ status });
    const res = await patch(p.id, agentToken, { areaSqm: 70 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(PROPERTY_EDIT_LOCKED_CODE);
  });

  it("форма целиком с теми же значениями после публикации не считается правкой", async () => {
    const p = await seed({ status: "AVAILABLE" });
    const res = await patch(p.id, agentToken, { areaSqm: 58, floor: 5, price: 450000, address: "Тестовая, 11" });
    expect(res.status).toBe(200);
  });

  it("статус после публикации агент меняет в рамках переходов — это шаг, не правка", async () => {
    const p = await seed({ status: "AVAILABLE" });
    const res = await patch(p.id, agentToken, { status: "WITHDRAWN" });
    expect(res.status).toBe(200);
  });

  it("закрытый объект публикации не имеет и не запирается", async () => {
    const p = await seed({ status: "AVAILABLE", offSite: true });
    const res = await patch(p.id, agentToken, { areaSqm: 62 });
    expect(res.status).toBe(200);
  });

  it("сырое видео опубликованного объекта агент удалить не может, на монтаже — может", async () => {
    const published = await seed({ status: "AVAILABLE" });
    const video = await prisma.propertyVideo.create({
      data: { propertyId: published.id, storageKey: `${published.id}/${randomUUID()}.mp4`, filename: "raw.mp4", sizeBytes: 10, uploadedById: agentId },
    });
    const res = await request(app)
      .delete(`/api/v1/properties/${published.id}/videos/${video.id}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe(PROPERTY_EDIT_LOCKED_REASON_PUBLISHED);
    expect(await prisma.propertyVideo.count({ where: { id: video.id } })).toBe(1);

    const editing = await seed({ status: "EDITING" });
    const video2 = await prisma.propertyVideo.create({
      data: { propertyId: editing.id, storageKey: `${editing.id}/${randomUUID()}.mp4`, filename: "raw2.mp4", sizeBytes: 10, uploadedById: agentId },
    });
    const ok = await request(app)
      .delete(`/api/v1/properties/${editing.id}/videos/${video2.id}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(ok.status).toBe(204);
  });

  it("новая докачка сырого видео опубликованного объекта не начинается", async () => {
    const p = await seed({ status: "AVAILABLE" });
    const res = await request(app)
      .post(`/api/v1/properties/${p.id}/videos/upload-sessions`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ uploadKey: randomUUID(), filename: "a.mp4", sizeBytes: 1000, contentType: "video/mp4" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(PROPERTY_EDIT_LOCKED_CODE);
  });

  it("кнопки видео-исправлений после публикации агенту-владельцу закрыты (403), руководству открыты", async () => {
    const p = await seed({ status: "AVAILABLE", publishedChannels: ["TELEGRAM"], publishedPostIds: { TELEGRAM: "5" } });
    const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
      request(app).post(`/api/v1/properties/${p.id}/${path}`).set("Authorization", `Bearer ${token}`).send(body);

    const sendBack = await post("send-back-to-montajer", agentToken, { reason: "WRONG_CAPTION", comment: "цена" });
    expect(sendBack.status).toBe(403);
    expect(sendBack.body.error).toBe(PROPERTY_PUBLISHED_ACTION_DENIED_MESSAGE);
    expect((await post("video-handoff/requeue", agentToken)).status).toBe(403);
    expect((await post("refresh-captions", agentToken)).status).toBe(403);
    expect((await post("finish-edit", agentToken)).status).toBe(403);
    // «Убрать из соцсетей» — только маркетинг/директор/админ (requireMarketingRole).
    expect((await post("social-unpublish", agentToken)).status).toBe(403);
    expect((await post("refresh-captions", managerToken)).status).toBe(200);
  });
});

describe("правка до публикации — кого предупредить", () => {
  const moderatorPushes = () =>
    sendPushToAgents.mock.calls.filter(
      (c) => Array.isArray(c[0]) && (c[0] as string[]).includes(adminId) && String((c[1] as { title?: string })?.title).includes("изменена после отправки на проверку")
    );
  const montajerMessages = () =>
    sendMessage.mock.calls.filter((c) => c[0] === montajerChatId && String(c[1]).includes("В карточке"));

  it("на проверке цена изменилась — модераторам пуш «было → стало»", async () => {
    const p = await seed({ status: "PENDING_REVIEW" });
    await patch(p.id, agentToken, { price: 500000 }).expect(200);
    await waitFor(() => moderatorPushes().length > 0);
    const body = String((moderatorPushes()[0]![1] as { body: string }).body);
    expect(body).toContain("Цена: 450000 TJS → 500000 TJS");
    expect((moderatorPushes()[0]![1] as { url: string }).url).toBe(`/properties/${p.shortId}`);
  });

  it("правка поля, которого нет ни в подписи, ни в цене, никого не беспокоит", async () => {
    const p = await seed({ status: "PENDING_REVIEW" });
    await patch(p.id, agentToken, { description: "Новый текст описания" }).expect(200);
    expect(moderatorPushes()).toHaveLength(0);
  });

  it("ролик у монтажёра: Telegram монтажёру «было → стало», журнал и факты прошлой передачи обновлены", async () => {
    const p = await seed({ status: "EDITING", videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffLastFactsText: "Объект №1\nЦена: 450 000 с." });
    await patch(p.id, agentToken, { price: 520000 }).expect(200);
    await waitFor(() => montajerMessages().length > 0);
    const text = String(montajerMessages()[0]![1]);
    expect(text).toContain("Цена: 450000 TJS → 520000 TJS");
    expect(text).toContain("Учтите в монтаже");
    const logged = await waitFor(() => prisma.montajerMessage.findFirst({ where: { propertyId: p.id, kind: "FACTS_CHANGED" } }));
    expect(logged.text).toBe(text);
    const fresh = await waitFor(async () => {
      const row = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffLastFactsText: true } });
      return row.videoHandoffLastFactsText?.includes("Цена:") && !row.videoHandoffLastFactsText.includes("450 000") ? row : null;
    });
    expect(fresh.videoHandoffLastFactsText).toContain("520");
  });

  it("монтажёр не привязан к Telegram: не молчим — журнал ошибок и директору", async () => {
    await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: null } });
    try {
      const p = await seed({ status: "EDITING", videoHandoffStatus: "SENT_TO_EDITOR" });
      await patch(p.id, agentToken, { floor: 2 }).expect(200);
      const err = await waitFor(() => prisma.errorLog.findFirst({ where: { message: { contains: "монтажёр не назначен или не привязал Telegram" } } }));
      expect(err).toBeTruthy();
      expect(montajerMessages()).toHaveLength(0);
    } finally {
      await prisma.agent.update({ where: { id: montajerId }, data: { telegramChatId: montajerChatId } });
    }
  });

  it("в очереди монтажа монтажёру ничего не шлём — текст соберётся свежим при отправке", async () => {
    const p = await seed({ status: "EDITING", videoHandoffStatus: "QUEUED" });
    await patch(p.id, agentToken, { price: 530000 }).expect(200);
    expect(montajerMessages()).toHaveLength(0);
    const { buildMontajerMessageText } = await import("../src/lib/videoHandoff.js");
    const text = await buildMontajerMessageText(p.id);
    expect(text).toContain("530");
    expect(text).not.toContain("450");
  });

  it("ролик уже получен и ждёт слота: правка цифр в кадре — модераторам «цифры могли устареть»", async () => {
    const p = await seed({ status: "EDITING", videoHandoffStatus: "RECEIVED", clipReviewStatus: "APPROVED" });
    await patch(p.id, agentToken, { areaSqm: 64 }).expect(200);
    await waitFor(() =>
      sendPushToAgents.mock.calls.find((c) => String((c[1] as { body?: string })?.body).includes("Цифры в ролике могут быть устаревшими"))
    );
  });
});

describe("цена в подписи неопубликованного объекта", () => {
  it("цена в reelsCaption обновляется, даже если объект ещё не вышел в сети", async () => {
    const money = await (await import("../src/lib/money.js")).loadMoneyContext();
    const { buildPriceDisplay } = await import("../src/lib/reelsCaptionTemplate.js");
    const oldText = buildPriceDisplay(450000, "TJS", money);
    const p = await seed({ status: "PENDING_REVIEW", publishedChannels: [], reelsCaption: `Квартира.\n✅Цена: ${oldText}\nЗвоните.` });
    await patch(p.id, agentToken, { price: 500000 }).expect(200);
    const row = await waitFor(async () => {
      const r = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { reelsCaption: true } });
      return r.reelsCaption?.includes(buildPriceDisplay(500000, "TJS", money)) ? r : null;
    });
    expect(row.reelsCaption).not.toContain(oldText);
    expect(editMessageCaption).not.toHaveBeenCalled();
  });

  it("старой цены в тексте нет дословно — подпись не трогаем, ответственному уходит пуш, в истории пометка", async () => {
    const p = await seed({ status: "PENDING_REVIEW", reelsCaption: "Квартира без цены, текст правили руками." });
    await patch(p.id, agentToken, { price: 510000 }).expect(200);
    await waitFor(() => sendPushToAgent.mock.calls.find((c) => c[0] === agentId));
    const row = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { reelsCaption: true } });
    expect(row.reelsCaption).toBe("Квартира без цены, текст правили руками.");
    const entries = await waitFor(async () => {
      const list = await prisma.auditLog.findMany({ where: { entityId: p.id, action: "PROPERTY_FIELDS_CHANGED" } });
      return list.some((e) => JSON.stringify(e.meta).includes("цену в подписи нужно поправить руками")) ? list : null;
    });
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe("ссылку на ролик до одобрения агент не вставляет", () => {
  it("на проверке агенту отказ, руководителю можно; с «Ждём видео» агенту можно", async () => {
    const p = await seed({ status: "PENDING_REVIEW" });
    const res = await patch(p.id, agentToken, { instagramUrl: "https://www.instagram.com/reel/XYZ/" });
    expect(res.status).toBe(403);
    const byManager = await patch(p.id, managerToken, { instagramUrl: "https://www.instagram.com/reel/XYZ/" });
    expect(byManager.status).toBe(200);
    const v = await seed({ status: "AWAITING_VIDEO" });
    const byAgent = await patch(v.id, agentToken, { instagramUrl: "https://www.instagram.com/reel/ABC/" });
    expect(byAgent.status).toBe(200);
  });
});

describe("хронология правок", () => {
  it("правка пишется одной записью «было → стало», повтор без изменений — не пишется", async () => {
    const p = await seed();
    await patch(p.id, managerToken, { floor: 7, areaSqm: 58 }).expect(200);
    const entry = await waitFor(() =>
      prisma.auditLog.findFirst({ where: { entityId: p.id, action: "PROPERTY_FIELDS_CHANGED" } })
    );
    const changes = (entry.meta as { changes: { field: string; was: string; becomes: string }[] }).changes;
    expect(changes).toEqual([{ field: "floor", label: "Этаж", was: "5", becomes: "7" }]);

    await patch(p.id, managerToken, { floor: 7 }).expect(200);
    const count = await waitForSettled(() =>
      prisma.auditLog.count({ where: { entityId: p.id, action: "PROPERTY_FIELDS_CHANGED" } })
    );
    expect(count).toBe(1);
  });
});

describe("подпись после правки и «Готово»", () => {
  it("факты в подписи переписываются в базе сразу, в посты уходят по «Готово»", async () => {
    const p = await seed({
      publishedChannels: ["FACEBOOK", "TELEGRAM", "INSTAGRAM"],
      publishedPostIds: { FACEBOOK: "fb-1", TELEGRAM: "77" },
      reelsCaption: [
        "Уютная квартира рядом с парком.",
        "",
        fillReelsCaptionTemplate(
          REELS_FACTS_TEMPLATE,
          reelsCaptionValuesFromProperty({
            type: "APARTMENT",
            rooms: 2,
            areaSqm: 58,
            floor: 5,
            totalFloors: 9,
            price: 450000,
            currency: "TJS",
            condition: "GOOD",
            districtName: `Правка по этапам ${runId}`,
            phone: null,
            address: "Тестовая, 11",
          }),
        ),
        "",
        "Звоните, покажем в любой день.",
      ].join("\n"),
    });
    await patch(p.id, managerToken, { floor: 3 }).expect(200);
    const stored = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(stored.reelsCaption).toContain("✅Этаж: 3");
    expect(stored.reelsCaption).toContain("Уютная квартира рядом с парком.");
    expect(stored.reelsCaption).toContain("✅Цена: ");
    // Сама правка в соцсети не ходит.
    expect(editMessageCaption).not.toHaveBeenCalled();

    await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: p.id, action: "PROPERTY_FIELDS_CHANGED" } }));
    const done = await request(app)
      .post(`/api/v1/properties/${p.id}/finish-edit`)
      .set("Authorization", `Bearer ${managerToken}`)
      .expect(200);
    expect(done.body.changed).toBe(true);
    expect(done.body.captions.updated.sort()).toEqual(["FACEBOOK", "TELEGRAM"]);
    expect(done.body.captions.manual.map((m: { channel: string }) => m.channel)).toEqual(["INSTAGRAM"]);
    // В пост уходит сохранённая подпись с подвалом «Объект №» (withPostFooter) и
    // концовкой с номерами агента и агентства (applyContactFooter, #940): «Готово»
    // пишет её и в карточку, подпись в карточке и под постом совпадают до символа.
    const sent = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(sent.reelsCaption).toContain("✅Этаж: 3");
    expect(sent.reelsCaption).toContain(`Объект №${stored.shortId}`);
    expect(editMessageCaption).toHaveBeenCalledWith("@rh-edit-test", 77, sent.reelsCaption);
    expect(sent.reelsCaption).toBe(withPostFooter(sent.reelsCaption ?? "", stored.shortId));

    // Второй «Готово» без новых правок в соцсети не ходит.
    await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: p.id, action: "PROPERTY_EDIT_FINISHED" } }));
    editMessageCaption.mockClear();
    const again = await request(app)
      .post(`/api/v1/properties/${p.id}/finish-edit`)
      .set("Authorization", `Bearer ${managerToken}`)
      .expect(200);
    expect(again.body.changed).toBe(false);
    expect(editMessageCaption).not.toHaveBeenCalled();
  });
});

describe("rewriteCaptionFacts", () => {
  const base = {
    type: "Квартира",
    district: "Сино",
    rooms: "2",
    areaSqm: "58",
    floor: "5",
    totalFloors: "9",
    condition: "хорошее",
    price: "450 000 с.",
    phone: null,
    address: "Тестовая, 11",
    documents: null,
    windowCount: null,
    bathroom: null,
    landAreaSotka: null,
    marketType: null,
    amenities: null,
  };

  it("подпись, вышедшая до строк «Рынок» и «Удобства», тоже переписывается", () => {
    const withMarket = { ...base, marketType: "Вторичное жильё", amenities: "Лифт" };
    const legacyBlock = REELS_FACTS_TEMPLATE.split("\n")
      .filter((l: string) => !/\{\{(marketType|landAreaSotka|amenities)\}\}/.test(l))
      .join("\n");
    const caption = `Уютная квартира.\n\n${fillReelsCaptionTemplate(legacyBlock, withMarket)}\n\nЗвоните.`;
    const next = rewriteCaptionFacts(caption, withMarket, { ...withMarket, floor: "3" }, null);
    expect(next).not.toBeNull();
    expect(next).toContain("✅Этаж: 3");
    expect(next).not.toContain("✅Этаж: 5");
    expect(next).toContain("Уютная квартира.");
  });

  it("шаблонная подпись: тот же шаблон, новые факты, цена остаётся как в тексте", () => {
    const template = parseReelsCaptionTemplates(null)[0]!;
    const caption = fillReelsCaptionTemplate(template, { ...base, price: "400 000 с. (по старому курсу)" });
    const next = rewriteCaptionFacts(caption, base, { ...base, floor: "3" }, null);
    expect(next).toBe(fillReelsCaptionTemplate(template, { ...base, floor: "3", price: "400 000 с. (по старому курсу)" }));
  });

  it("подпись от ИИ: меняется только блок фактов", () => {
    const caption = `Начало.\n\n${fillReelsCaptionTemplate(REELS_FACTS_TEMPLATE, base)}\n\nКонец.`;
    const next = rewriteCaptionFacts(caption, base, { ...base, areaSqm: "60" }, null);
    expect(next).toBe(`Начало.\n\n${fillReelsCaptionTemplate(REELS_FACTS_TEMPLATE, { ...base, areaSqm: "60" })}\n\nКонец.`);
  });

  it("подпись правили руками — не трогаем", () => {
    expect(rewriteCaptionFacts("Своими словами про квартиру", base, { ...base, floor: "3" }, null)).toBeNull();
  });
});
