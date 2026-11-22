import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { MIN_PROPERTY_PHOTOS, type PermissionId } from "@royal-home/shared";

/**
 * «ВЫВЕСТИ В ПРОДАЖУ БЕЗ INSTAGRAM» (17.11.2026, волна 2 Шабнам, живой случай ОБ-000193: ролик принят
 * 06.11, вышел в YouTube, Facebook, Telegram, TikTok, а в Instagram — нет, ключ Instagram мёртв с 12.11;
 * объект 11 дней стоял на «Монтаже»).
 *
 * Одна дверь (lib/propertyCompleteEditing.ts) — и кнопка CRM (POST /properties/:id/complete-editing),
 * и инструмент Шабнам complete_property_editing. Проверяем:
 *  - директор (право properties.delete) выводит явным withoutInstagram, если ролик принят и вышел хоть
 *    в одну сеть: статус «в продаже», запись PROPERTY_SALE_WITHOUT_INSTAGRAM, строка «Без Instagram» в превью;
 *  - агент и монтажёр — отказ с подсказкой «попросите директора»;
 *  - ролик не принят / не вышел никуда / мало фото — отказ даже директору;
 *  - ссылка Instagram есть — флаг ни на что не влияет (обычное «Готово», без записи «без Instagram»);
 *  - отказ без флага подсказывает модели, что директор может вывести без Instagram.
 *
 * Подменена только отправка на сайт (`syncPropertiesToSite`, сеть) — «сайт принял».
 */

const { syncPropertiesToSite } = vi.hoisted(() => ({
  syncPropertiesToSite: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, results: [{ externalId: "x", ok: true }] })),
}));

vi.mock("../src/lib/siteSync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/siteSync.js")>()),
  syncPropertiesToSite,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
await import("../src/ai/assistant/tools/index.js");
const { createPendingAssistantAction, confirmAssistantAction, AssistantActionError } = await import("../src/lib/assistantActions.js");
const { checkCompleteEditing, saleWithoutInstagramEligibility, publishedVideoChannelLabels, SALE_WITHOUT_INSTAGRAM_PERMISSION } = await import(
  "../src/lib/propertyCompleteEditing.js"
);
const { findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { actorFor, cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");
const { waitFor, waitForSettled } = await import("./helpers/waitFor.js");

const TOOL = "complete_property_editing";
const runId = Date.now();
const password = "testpass123";
let districtId = "";
let ownerId = "";
let editorId = "";
let directorId = "";
let ownerToken = "";
let directorToken = "";
const propertyIds: string[] = [];

const AGENT_PERMS: PermissionId[] = ["properties.requestChange"];
const EDITOR_PERMS: PermissionId[] = ["properties.editForeign", "properties.aiListing"];
const DIRECTOR_PERMS: PermissionId[] = ["properties.requestChange", "properties.editForeign", "properties.delete", "properties.moderate", "marketing.access"];

/** Как ОБ-000193: на монтаже, ролик принят и вышел в YouTube и Facebook, ссылки на Instagram нет. */
async function seed(overrides: Record<string, unknown> = {}, photos = MIN_PROPERTY_PHOTOS) {
  const property = await prisma.property.create({
    data: {
      title: `Без инсты ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 50,
      floor: 3,
      totalFloors: 9,
      price: 400000,
      currency: "TJS",
      districtId,
      address: `Без инсты ${runId}-${propertyIds.length}`,
      condition: "GOOD",
      status: "EDITING",
      createdById: ownerId,
      assignedAgentId: ownerId,
      intakeAgentId: ownerId,
      instagramUrl: null,
      clipReviewStatus: "APPROVED",
      publishedChannels: ["YOUTUBE", "FACEBOOK"],
      videoHandoffStatus: "RECEIVED",
      videoHandoffReceivedAt: new Date(Date.now() - 11 * 86_400_000),
      videoHandoffFinalPath: "/private/final-no-ig.mp4",
      ...overrides,
    } as never,
  });
  propertyIds.push(property.id);
  if (photos > 0) {
    await prisma.propertyPhoto.createMany({
      data: Array.from({ length: photos }, (_, i) => ({
        propertyId: property.id,
        url: `/uploads/noig${i}.webp`,
        thumbUrl: `/uploads/thumbs/noig${i}.webp`,
        order: i,
      })),
    });
  }
  return property;
}

async function refusalOf(agentId: string, perms: PermissionId[], args: Record<string, unknown>) {
  const error = await createPendingAssistantAction(actorFor(agentId, perms), TOOL, args).then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(AssistantActionError);
  return error as InstanceType<typeof AssistantActionError>;
}

const statusOf = async (id: string) => (await prisma.property.findUniqueOrThrow({ where: { id } })).status;
const bypassAudits = (propertyId: string) =>
  prisma.auditLog.count({ where: { entityId: propertyId, action: "PROPERTY_SALE_WITHOUT_INSTAGRAM" } });

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Без инсты район ${runId}` } })).id;
  const passwordHash = await bcrypt.hash(password, 10);
  const mk = (fullName: string, phone: string, role: "AGENT" | "DIRECTOR" | "EDITOR") =>
    prisma.agent.create({ data: { fullName, phone, role, passwordHash } });
  const [owner, editor, director] = await Promise.all([
    mk(`Агент без инсты ${runId}`, `+992961${runId}`, "AGENT"),
    mk(`Монтажёр без инсты ${runId}`, `+992962${runId}`, "EDITOR"),
    mk(`Директор без инсты ${runId}`, `+992963${runId}`, "DIRECTOR"),
  ]);
  ownerId = owner.id;
  editorId = editor.id;
  directorId = director.id;
  [ownerToken, directorToken] = await Promise.all([login(owner.phone), login(director.phone)]);
});

beforeEach(() => {
  syncPropertiesToSite.mockClear();
});

afterAll(async () => {
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: propertyIds.map((id) => `publish-failed-${id}`) } } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await cleanupAssistantActionAgents([ownerId, editorId, directorId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("правило «без Instagram» — чистые функции двери", () => {
  it("право — properties.delete (директор и админ по пресету)", () => {
    expect(SALE_WITHOUT_INSTAGRAM_PERMISSION).toBe("properties.delete");
  });

  it("годность: принят (или проверка не требовалась) и вышел хоть в одну сеть", () => {
    expect(saleWithoutInstagramEligibility({ clipReviewStatus: "APPROVED", publishedChannels: ["YOUTUBE"] })).toEqual({
      eligible: true,
      channels: ["YouTube"],
    });
    expect(saleWithoutInstagramEligibility({ clipReviewStatus: "NONE", publishedChannels: ["TELEGRAM"] }).eligible).toBe(true);
    expect(saleWithoutInstagramEligibility({ clipReviewStatus: "PENDING", publishedChannels: ["YOUTUBE"] }).eligible).toBe(false);
    expect(saleWithoutInstagramEligibility({ clipReviewStatus: "REJECTED", publishedChannels: ["YOUTUBE"] }).eligible).toBe(false);
    expect(saleWithoutInstagramEligibility({ clipReviewStatus: "APPROVED", publishedChannels: [] }).eligible).toBe(false);
    // Служебные метки в списке каналов сетью не считаются.
    expect(publishedVideoChannelLabels(["FACEBOOK_POST", "TIKTOK", "FACEBOOK"])).toEqual(["Facebook", "TikTok"]);
  });

  it("мало фото — отказ даже директору с флагом: «без Instagram» снимает только причину про Instagram", () => {
    const failure = checkCompleteEditing(
      {
        status: "EDITING",
        deletedAt: null,
        intakeAgentId: "x",
        instagramUrl: null,
        photoCount: 0,
        clipReviewStatus: "APPROVED",
        publishedChannels: ["YOUTUBE"],
      },
      { agentId: "d", can: (p) => DIRECTOR_PERMS.includes(p) },
      { withoutInstagram: true },
    );
    expect(failure).toMatchObject({ code: "NOT_READY" });
    expect(failure!.error).toMatch(/фото меньше минимума/);
  });
});

describe("Шабнам: complete_property_editing без Instagram", () => {
  it("директор: отказ без флага подсказывает модели вывести без Instagram; с флагом — превью с явной строкой; «Подтвердить» — в продаже и запись в журнале", async () => {
    const property = await seed();
    const ref = String(property.shortId);

    const hint = await refusalOf(directorId, DIRECTOR_PERMS, { ref });
    expect(hint.code).toBe("NOT_READY_FOR_SALE");
    expect(hint.message).toMatch(/вышел в Facebook, YouTube/);
    expect(hint.message).toMatch(/withoutInstagram: true/);
    expect(await statusOf(property.id)).toBe("EDITING");

    const action = await createPendingAssistantAction(actorFor(directorId, DIRECTOR_PERMS), TOOL, { ref, withoutInstagram: true });
    expect(action.status).toBe("PENDING");
    expect(action.preview.title).toMatch(/без Instagram/);
    expect(action.preview.becomes).toMatchObject({ "Без Instagram": "ролик вышел в Facebook, YouTube" });
    expect(await statusOf(property.id)).toBe("EDITING");

    const outcome = await confirmAssistantAction(action.id, actorFor(directorId, DIRECTOR_PERMS));
    expect(outcome.action.result).toMatchObject({ applied: true, to: "AVAILABLE", withoutInstagram: true, channels: ["Facebook", "YouTube"] });
    expect(await statusOf(property.id)).toBe("AVAILABLE");
    expect(syncPropertiesToSite).toHaveBeenCalledTimes(1);

    const audit = await waitFor(
      () => prisma.auditLog.findFirst({ where: { entityId: property.id, action: "PROPERTY_SALE_WITHOUT_INSTAGRAM" } }),
      { label: "запись PROPERTY_SALE_WITHOUT_INSTAGRAM" },
    );
    expect(audit.agentId).toBe(directorId);
    expect(audit.meta).toMatchObject({ channels: ["Facebook", "YouTube"], source: "assistant", tool: TOOL, actionId: action.id });
  });

  it("агент (хозяин объекта): с флагом — 403 «попросите директора»; без флага — подсказка про директора, статус не тронут", async () => {
    const property = await seed();
    const ref = String(property.shortId);
    const forbidden = await refusalOf(ownerId, AGENT_PERMS, { ref, withoutInstagram: true });
    expect(forbidden.status).toBe(403);
    expect(forbidden.code).toBe("WITHOUT_INSTAGRAM_FORBIDDEN");
    expect(forbidden.message).toMatch(/попросите директора/);

    const plain = await refusalOf(ownerId, AGENT_PERMS, { ref });
    expect(plain.code).toBe("NOT_READY_FOR_SALE");
    expect(plain.message).toMatch(/директор или администратор может вывести объект в продажу без Instagram/);
    expect(plain.message).not.toMatch(/withoutInstagram: true/);
    expect(await statusOf(property.id)).toBe("EDITING");
    expect(await waitForSettled(() => bypassAudits(property.id))).toBe(0);
  });

  it("монтажёр (правка чужих, без права руководства) — 403, объект на монтаже", async () => {
    const property = await seed();
    const error = await refusalOf(editorId, EDITOR_PERMS, { ref: String(property.shortId), withoutInstagram: true });
    expect(error.code).toBe("WITHOUT_INSTAGRAM_FORBIDDEN");
    expect(await statusOf(property.id)).toBe("EDITING");
  });

  it("ролик ждёт проверки — отказ даже директору", async () => {
    const property = await seed({ clipReviewStatus: "PENDING", clipReviewRequestedAt: new Date() });
    const error = await refusalOf(directorId, DIRECTOR_PERMS, { ref: String(property.shortId), withoutInstagram: true });
    expect(error.code).toBe("WITHOUT_INSTAGRAM_NOT_ALLOWED");
    expect(error.message).toMatch(/не принят/);
    expect(await statusOf(property.id)).toBe("EDITING");
  });

  it("ролик не вышел ни в одну сеть — отказ даже директору", async () => {
    const property = await seed({ publishedChannels: [] });
    const error = await refusalOf(directorId, DIRECTOR_PERMS, { ref: String(property.shortId), withoutInstagram: true });
    expect(error.code).toBe("WITHOUT_INSTAGRAM_NOT_ALLOWED");
    expect(error.message).toMatch(/не вышел ни в одну сеть/);
    expect(await statusOf(property.id)).toBe("EDITING");
  });

  it("ссылка на Instagram есть — флаг ни на что не влияет: обычное «Готово», без записи «без Instagram»", async () => {
    const property = await seed({ instagramUrl: "https://www.instagram.com/reel/HasLink1/" });
    const action = await createPendingAssistantAction(actorFor(directorId, DIRECTOR_PERMS), TOOL, {
      ref: String(property.shortId),
      withoutInstagram: true,
    });
    expect(action.preview.title).not.toMatch(/без Instagram/);
    expect(action.preview.becomes).not.toHaveProperty("Без Instagram");
    await confirmAssistantAction(action.id, actorFor(directorId, DIRECTOR_PERMS));
    expect(await statusOf(property.id)).toBe("AVAILABLE");
    expect(await waitForSettled(() => bypassAudits(property.id))).toBe(0);
  });

  it("описание и схема инструмента объясняют модели withoutInstagram", () => {
    const plugin = findAssistantToolPlugin(TOOL)!;
    expect(plugin.description).toMatch(/БЕЗ INSTAGRAM/);
    expect(JSON.stringify(plugin.parameters)).toMatch(/withoutInstagram/);
  });
});

describe("кнопка CRM: POST /properties/:id/complete-editing { withoutInstagram }", () => {
  const post = (token: string, id: string, body?: object) => {
    const req = request(app).post(`/api/v1/properties/${id}/complete-editing`).set("Authorization", `Bearer ${token}`);
    return body ? req.send(body) : req;
  };

  it("директор без флага — 409 с подсказкой allowed для экрана; с флагом — объект в продаже, запись в журнале", async () => {
    const property = await seed();
    const refused = await post(directorToken, property.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "NOT_READY", withoutInstagram: { allowed: true, channels: ["Facebook", "YouTube"] } });

    const done = await post(directorToken, property.id, { withoutInstagram: true });
    expect([200, 207]).toContain(done.status);
    expect(await statusOf(property.id)).toBe("AVAILABLE");
    const audit = await waitFor(
      () => prisma.auditLog.findFirst({ where: { entityId: property.id, action: "PROPERTY_SALE_WITHOUT_INSTAGRAM" } }),
      { label: "запись PROPERTY_SALE_WITHOUT_INSTAGRAM (CRM)" },
    );
    expect(audit.agentId).toBe(directorId);
    expect(audit.meta).toMatchObject({ source: "crm", channels: ["Facebook", "YouTube"] });
  });

  it("агент — 403 с кодом и подсказкой «попросите директора»; кнопки для него нет (allowed: false)", async () => {
    const property = await seed();
    const plain = await post(ownerToken, property.id);
    expect(plain.status).toBe(409);
    expect(plain.body.withoutInstagram).toMatchObject({ allowed: false, needsDirector: true });
    expect(plain.body.error).toMatch(/попросите директора/);

    const forced = await post(ownerToken, property.id, { withoutInstagram: true });
    expect(forced.status).toBe(403);
    expect(forced.body.code).toBe("WITHOUT_INSTAGRAM_FORBIDDEN");
    expect(await statusOf(property.id)).toBe("EDITING");
  });

  it("неверное тело — 400, ничего не меняется", async () => {
    const property = await seed();
    const res = await post(directorToken, property.id, { withoutInstagram: "да" });
    expect(res.status).toBe(400);
    expect(await statusOf(property.id)).toBe("EDITING");
  });
});
