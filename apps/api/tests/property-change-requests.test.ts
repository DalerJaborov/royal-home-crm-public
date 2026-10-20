import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { waitFor } from "./helpers/waitFor.js";

/**
 * ЗАЯВКИ АГЕНТА НА ИЗМЕНЕНИЕ ОПУБЛИКОВАННОГО ОБЪЕКТА (07.10.2026, решение владельца).
 * routes/properties/changeRequests.ts + changeRequestExecutor.ts.
 *
 * Сети (цена в посты, снятие, перемонтаж, пересбор подписей), сайт и push подменены — тест
 * никуда не ходит; проверяется, что исполнитель ЗОВЁТ их с правильными аргументами и
 * правильно собирает итог (что сделано / что руками / FAILED).
 */

const { sendPushToAgent, syncPublishedPriceChange, sendBackToMontajer, removeFromSocial, refreshPublishedCaptions } =
  vi.hoisted(() => ({
    sendPushToAgent: vi.fn(async () => 0),
    syncPublishedPriceChange: vi.fn(async () => ({ updated: ["FACEBOOK"], failed: [], skipped: null })),
    sendBackToMontajer: vi.fn(async () => ({ ok: true, queued: true, message: "Ролик отправлен монтажёру" })),
    removeFromSocial: vi.fn(async () => ({
      removed: ["FACEBOOK"],
      failed: [],
      manual: [{ channel: "INSTAGRAM", url: null, reason: "снимите Reels в приложении" }],
      notes: [],
    })),
    refreshPublishedCaptions: vi.fn(async () => ({ caption: "", updated: ["FACEBOOK"], failed: [], manual: [] })),
  }));

vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent,
}));
vi.mock("../src/lib/publishedListingSync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/publishedListingSync.js")>()),
  syncPublishedPriceChange,
}));
vi.mock("../src/lib/publishedVideoFix.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/publishedVideoFix.js")>()),
  sendBackToMontajer,
  removeFromSocial,
  refreshPublishedCaptions,
}));
vi.mock("../src/lib/siteSync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/siteSync.js")>()),
  resyncPhotosIfPublished: vi.fn(async () => {}),
  syncPropertiesToSite: vi.fn(async () => ({ ok: true, results: [] })),
}));

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");

const runId = Date.now();
const password = "testpass123";
const api = "/api/v1/properties";

let districtId = "";
let agentId = "";
let agentToken = "";
let otherId = "";
let otherToken = "";
let directorId = "";
let directorToken = "";
let marketingId = "";
const propertyIds: string[] = [];

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

/** Опубликованный объект агента: в продаже, ролик вышел в Facebook и Instagram. */
async function seedProperty(overrides: Record<string, unknown> = {}) {
  const property = await prisma.property.create({
    data: {
      title: `Заявка изменения ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 50,
      floor: 3,
      totalFloors: 9,
      price: 400000,
      currency: "TJS",
      districtId,
      address: "Заявочная, 5",
      condition: "GOOD",
      status: "AVAILABLE",
      createdById: agentId,
      assignedAgentId: agentId,
      publishedChannels: ["FACEBOOK", "INSTAGRAM"],
      publishedPostIds: { FACEBOOK: "fb-1" },
      ...overrides,
    } as never,
  });
  propertyIds.push(property.id);
  return property;
}

const post = (token: string, id: string, body: unknown) =>
  request(app).post(`${api}/${id}/change-requests`).set("Authorization", `Bearer ${token}`).send(body as object);

const decide = (token: string, rid: string, action: "approve" | "reject" | "cancel", body: object = {}) =>
  request(app).post(`${api}/change-requests/${rid}/${action}`).set("Authorization", `Bearer ${token}`).send(body);

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Заявки изменений ${runId}` } })).id;
  const passwordHash = await bcrypt.hash(password, 10);
  const mk = (fullName: string, phone: string, role: "AGENT" | "DIRECTOR" | "MARKETING") =>
    prisma.agent.create({ data: { fullName, phone, role, passwordHash } });
  const [agent, other, director, marketing] = await Promise.all([
    mk(`Агент заявок ${runId}`, `+992971${runId}`, "AGENT"),
    mk(`Чужой агент заявок ${runId}`, `+992972${runId}`, "AGENT"),
    mk(`Директор заявок ${runId}`, `+992973${runId}`, "DIRECTOR"),
    mk(`Маркетинг заявок ${runId}`, `+992974${runId}`, "MARKETING"),
  ]);
  agentId = agent.id;
  otherId = other.id;
  directorId = director.id;
  marketingId = marketing.id;
  [agentToken, otherToken, directorToken] = await Promise.all([
    login(agent.phone),
    login(other.phone),
    login(director.phone),
  ]);
});

beforeEach(() => {
  sendPushToAgent.mockClear();
  syncPublishedPriceChange.mockClear();
  sendBackToMontajer.mockClear();
  removeFromSocial.mockClear();
  refreshPublishedCaptions.mockClear();
});

afterAll(async () => {
  await prisma.propertyChangeRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: "property-change-request-" } } });
  await prisma.priceChange.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: [agentId, otherId, directorId, marketingId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherId, directorId, marketingId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Подача заявки", () => {
  it("опубликованный объект: 201, заявка в базе, директору ушёл аларм, в журнале запись", async () => {
    const property = await seedProperty();
    const res = await post(agentToken, property.id, {
      kind: "PRICE_CHANGE",
      payload: { newPrice: 380000 },
      comment: "Хозяин снизил",
    });
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({
      kind: "PRICE_CHANGE",
      status: "PENDING",
      propertyId: property.id,
      author: { id: agentId },
    });

    const alert = await waitFor(() =>
      prisma.pendingDirectorAlert.findFirst({ where: { tag: `property-change-request-${res.body.request.id}` } })
    );
    expect(alert).toMatchObject({ recipientPermission: "properties.delete", kind: "property-change-request" });
    expect(alert!.body).toContain("→");

    const audit = await waitFor(() =>
      prisma.auditLog.findFirst({ where: { entityId: property.id, action: "PROPERTY_CHANGE_REQUEST" } })
    );
    expect(audit).toBeTruthy();
  });

  it("объект ещё в конвейере — 409 «до публикации правьте сами»", async () => {
    const property = await seedProperty({ status: "AWAITING_PHOTOS" });
    const res = await post(agentToken, property.id, { kind: "PRICE_CHANGE", payload: { newPrice: 1 } });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("До публикации");
  });

  it("вторая ждущая заявка того же вида — 409, другой вид — можно", async () => {
    const property = await seedProperty();
    const body = { kind: "PRICE_CHANGE", payload: { newPrice: 390000 } };
    expect((await post(agentToken, property.id, body)).status).toBe(201);
    const dup = await post(agentToken, property.id, body);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("Такая заявка уже отправлена");
    const other = await post(agentToken, property.id, { kind: "OTHER", payload: { text: "Нужно что-то поменять в ролике" } });
    expect(other.status).toBe(201);
  });

  it("чужой объект — 403; несуществующий — 404", async () => {
    const property = await seedProperty();
    const res = await post(otherToken, property.id, { kind: "PRICE_CHANGE", payload: { newPrice: 390000 } });
    expect(res.status).toBe(403);
    const missing = await post(agentToken, "00000000-0000-4000-8000-000000000000", {
      kind: "PRICE_CHANGE",
      payload: { newPrice: 390000 },
    });
    expect(missing.status).toBe(404);
  });

  it("цена не отличается от текущей — 400; данные не из набора фактов (цена) — 400; снятие без публикаций — 409", async () => {
    const property = await seedProperty();
    const same = await post(agentToken, property.id, { kind: "PRICE_CHANGE", payload: { newPrice: 400000 } });
    expect(same.status).toBe(400);
    const foreign = await post(agentToken, property.id, { kind: "CARD_DATA", payload: { patch: { price: 1 } } });
    expect(foreign.status).toBe(400);
    const noop = await post(agentToken, property.id, { kind: "CARD_DATA", payload: { patch: { floor: 3 } } });
    expect(noop.status).toBe(400);

    const bare = await seedProperty({ publishedChannels: [], publishedPostIds: {} });
    const none = await post(agentToken, bare.id, { kind: "UNPUBLISH", payload: {} });
    expect(none.status).toBe(409);
  });

  it("неверное тело — 400", async () => {
    const property = await seedProperty();
    expect((await post(agentToken, property.id, { kind: "PRICE_CHANGE", payload: {} })).status).toBe(400);
    expect((await post(agentToken, property.id, { kind: "WHATEVER", payload: {} })).status).toBe(400);
  });
});

describe("«Принять»: цена", () => {
  it("цена обновилась, PriceChange записан, посты синхронизированы, Instagram — руками, push автору и маркетингу", async () => {
    const property = await seedProperty({ assignedAgentId: marketingId });
    const created = await post(agentToken, property.id, { kind: "PRICE_CHANGE", payload: { newPrice: 380000 } });
    expect(created.status).toBe(201);

    const res = await decide(directorToken, created.body.request.id, "approve", { note: "ок" });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("APPROVED");
    expect(res.body.request.decidedBy.id).toBe(directorId);
    expect(res.body.request.result.applied.join(" ")).toContain("Цена в карточке");
    expect(res.body.request.result.applied.join(" ")).toContain("Facebook");
    const manual = res.body.request.result.manual as { channel: string; text: string }[];
    expect(manual.map((m) => m.channel)).toEqual(["INSTAGRAM"]);

    const fresh = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(Number(fresh.price)).toBe(380000);
    const change = await prisma.priceChange.findFirst({ where: { propertyId: property.id } });
    expect(Number(change!.oldPrice)).toBe(400000);
    expect(Number(change!.newPrice)).toBe(380000);
    expect(change!.changedById).toBe(directorId);

    expect(syncPublishedPriceChange).toHaveBeenCalledWith(property.id, 400000, "TJS");

    const pushedTo = sendPushToAgent.mock.calls.map((c) => c[0]);
    expect(pushedTo).toContain(agentId); // автору — итог
    expect(pushedTo).toContain(marketingId); // ответственному/маркетингу — «руками»
    const marketingPush = sendPushToAgent.mock.calls.find((c) => c[0] === marketingId)![1] as { body: string };
    expect(marketingPush.body).toContain("Instagram");
    expect(sendPushToAgent.mock.calls.find((c) => c[0] === directorId)).toBeUndefined();

    // повторное «Принять» — 409, цена второй раз не пишется
    const again = await decide(directorToken, created.body.request.id, "approve");
    expect(again.status).toBe(409);
    expect(await prisma.priceChange.count({ where: { propertyId: property.id } })).toBe(1);
  });

  it("remake=true: после цены ролик уходит монтажёру, старые посты снимаются", async () => {
    const property = await seedProperty();
    const created = await post(agentToken, property.id, {
      kind: "PRICE_CHANGE",
      payload: { newPrice: 350000, remake: true },
      comment: "Цена в кадре",
    });
    const res = await decide(directorToken, created.body.request.id, "approve");
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("APPROVED");
    expect(res.body.request.result.remakeQueued).toBe(true);
    expect(sendBackToMontajer).toHaveBeenCalledTimes(1);
    const args = sendBackToMontajer.mock.calls[0] as unknown as unknown[];
    expect(args[0]).toBe(property.id);
    expect(args[2]).toBe("CARD_DATA_CHANGED");
    expect(String(args[3])).toContain("Новая цена");
    expect(args[5]).toEqual({ removeFromSocial: true });
  });
});

describe("«Принять»: данные, перемонтаж, снятие, другое", () => {
  it("CARD_DATA: поле обновилось, подписи пересобраны, заявка принята", async () => {
    const property = await seedProperty({ reelsCaption: "текст" });
    const created = await post(agentToken, property.id, { kind: "CARD_DATA", payload: { patch: { floor: 5 } } });
    expect(created.status).toBe(201);
    const res = await decide(directorToken, created.body.request.id, "approve");
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("APPROVED");
    const fresh = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(fresh.floor).toBe(5);
    expect(res.body.request.result.applied.join(" ")).toContain("Карточка обновлена");
  });

  it("REMAKE_VIDEO: sendBackToMontajer получает причину, комментарий и снятие из соцсетей", async () => {
    const property = await seedProperty();
    const created = await post(agentToken, property.id, {
      kind: "REMAKE_VIDEO",
      payload: { reason: "WRONG_CAPTION", removeFromSocial: true },
      comment: "В кадре старая площадь",
    });
    const res = await decide(directorToken, created.body.request.id, "approve");
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("APPROVED");
    expect(res.body.request.result.remakeQueued).toBe(true);
    expect(sendBackToMontajer).toHaveBeenCalledWith(
      property.id,
      directorId,
      "WRONG_CAPTION",
      "В кадре старая площадь",
      null,
      { removeFromSocial: true }
    );
  });

  it("REMAKE_VIDEO: отказ перемонтажа — FAILED с текстом отказа, ответ 200, заявка остаётся видимой", async () => {
    sendBackToMontajer.mockResolvedValueOnce({ ok: false, error: "Монтажёр не назначен" } as never);
    const property = await seedProperty();
    const created = await post(agentToken, property.id, {
      kind: "REMAKE_VIDEO",
      payload: { reason: "POOR_EDIT", removeFromSocial: false },
    });
    const res = await decide(directorToken, created.body.request.id, "approve");
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("FAILED");
    expect(res.body.request.error).toBe("Монтажёр не назначен");
    expect(res.body.message).toContain("Не выполнилось");
    const row = await prisma.propertyChangeRequest.findUniqueOrThrow({ where: { id: created.body.request.id } });
    expect(row.status).toBe("FAILED");
    // автор узнал о сбое
    const authorPush = sendPushToAgent.mock.calls.find((c) => c[0] === agentId)![1] as { title: string };
    expect(authorPush.title).toContain("не выполнилась");
  });

  it("UNPUBLISH: снятое — в «сделано», остаток (Instagram) — руками", async () => {
    const property = await seedProperty();
    const created = await post(agentToken, property.id, { kind: "UNPUBLISH", payload: {} });
    const res = await decide(directorToken, created.body.request.id, "approve");
    expect(res.status).toBe(200);
    expect(removeFromSocial).toHaveBeenCalledWith(property.id, undefined);
    expect(res.body.request.result.applied.join(" ")).toContain("Facebook: ролик снят");
    expect(res.body.request.result.manual[0].channel).toBe("INSTAGRAM");
  });

  it("OTHER: ничего не выполняется, итог — «к сведению»", async () => {
    const property = await seedProperty();
    const created = await post(agentToken, property.id, {
      kind: "OTHER",
      payload: { text: "Хозяин просит убрать фото кухни" },
    });
    const res = await decide(directorToken, created.body.request.id, "approve");
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("APPROVED");
    expect(res.body.request.result.applied[0]).toContain("к сведению");
    expect(syncPublishedPriceChange).not.toHaveBeenCalled();
    expect(sendBackToMontajer).not.toHaveBeenCalled();
    expect(removeFromSocial).not.toHaveBeenCalled();
  });
});

describe("Отказ, отзыв, права", () => {
  it("reject без причины — 400; с причиной — REJECTED, автору push; повторное решение — 409", async () => {
    const property = await seedProperty();
    const created = await post(agentToken, property.id, { kind: "PRICE_CHANGE", payload: { newPrice: 390000 } });
    const rid = created.body.request.id as string;

    expect((await decide(directorToken, rid, "reject", {})).status).toBe(400);
    expect((await decide(directorToken, rid, "reject", { note: "  " })).status).toBe(400);

    const ok = await decide(directorToken, rid, "reject", { note: "Цену пока не трогаем" });
    expect(ok.status).toBe(200);
    expect(ok.body.request).toMatchObject({ status: "REJECTED", decisionNote: "Цену пока не трогаем" });
    const push = sendPushToAgent.mock.calls.find((c) => c[0] === agentId)![1] as { body: string };
    expect(push.body).toContain("Цену пока не трогаем");
    expect(await prisma.priceChange.count({ where: { propertyId: property.id } })).toBe(0);

    expect((await decide(directorToken, rid, "reject", { note: "ещё раз" })).status).toBe(409);
    expect((await decide(directorToken, rid, "approve")).status).toBe(409);
  });

  it("cancel: чужой — 403, автор — CANCELLED, после этого «Принять» — 409", async () => {
    const property = await seedProperty();
    const created = await post(agentToken, property.id, { kind: "PRICE_CHANGE", payload: { newPrice: 390000 } });
    const rid = created.body.request.id as string;

    expect((await decide(otherToken, rid, "cancel")).status).toBe(403);
    const mine = await decide(agentToken, rid, "cancel");
    expect(mine.status).toBe(200);
    expect(mine.body.request.status).toBe("CANCELLED");
    expect((await decide(directorToken, rid, "approve")).status).toBe(409);
    expect((await decide(agentToken, rid, "cancel")).status).toBe(409);
  });

  it("агент не может ни принять, ни отклонить, ни смотреть общую очередь", async () => {
    const property = await seedProperty();
    const created = await post(agentToken, property.id, { kind: "PRICE_CHANGE", payload: { newPrice: 390000 } });
    const rid = created.body.request.id as string;
    expect((await decide(agentToken, rid, "approve")).status).toBe(403);
    expect((await decide(agentToken, rid, "reject", { note: "сам себе" })).status).toBe(403);
    const list = await request(app).get(`${api}/change-requests`).set("Authorization", `Bearer ${agentToken}`);
    expect(list.status).toBe(403);
    // заявка осталась ждать решения
    const row = await prisma.propertyChangeRequest.findUniqueOrThrow({ where: { id: rid } });
    expect(row.status).toBe("PENDING");
  });
});

describe("Списки", () => {
  it("очередь руководства: PENDING по умолчанию, предел и курсор; по объекту автор видит свои, чужой агент — 403", async () => {
    const property = await seedProperty();
    for (const kind of ["PRICE_CHANGE", "UNPUBLISH", "OTHER"] as const) {
      const payload =
        kind === "PRICE_CHANGE" ? { newPrice: 390000 } : kind === "UNPUBLISH" ? {} : { text: "Что-то другое в карточке" };
      expect((await post(agentToken, property.id, { kind, payload })).status).toBe(201);
    }

    const page1 = await request(app).get(`${api}/change-requests?limit=2`).set("Authorization", `Bearer ${directorToken}`);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    expect(page1.body.items.every((i: { status: string }) => i.status === "PENDING")).toBe(true);
    const page2 = await request(app)
      .get(`${api}/change-requests?limit=100&cursor=${page1.body.nextCursor}`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(page2.status).toBe(200);
    expect(page2.body.items.length).toBeGreaterThan(0);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);

    const mine = await request(app).get(`${api}/${property.id}/change-requests`).set("Authorization", `Bearer ${agentToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(3);
    const foreign = await request(app).get(`${api}/${property.id}/change-requests`).set("Authorization", `Bearer ${otherToken}`);
    expect(foreign.status).toBe(403);
    const boss = await request(app).get(`${api}/${property.id}/change-requests`).set("Authorization", `Bearer ${directorToken}`);
    expect(boss.body.items).toHaveLength(3);
  });
});

describe("Корзина", () => {
  it("объект ушёл в Корзину — ждущие заявки закрываются как CANCELLED", async () => {
    const property = await seedProperty();
    const created = await post(agentToken, property.id, { kind: "PRICE_CHANGE", payload: { newPrice: 390000 } });
    const rid = created.body.request.id as string;

    const del = await request(app).delete(`${api}/${property.id}`).set("Authorization", `Bearer ${directorToken}`);
    expect(del.status).toBeLessThan(300);

    const row = await prisma.propertyChangeRequest.findUniqueOrThrow({ where: { id: rid } });
    expect(row.status).toBe("CANCELLED");
    expect(row.decisionNote).toContain("Корзин");
    expect((await decide(directorToken, rid, "approve")).status).toBe(409);
  });
});
