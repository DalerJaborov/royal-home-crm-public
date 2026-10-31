import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionId } from "@royal-home/shared";

/**
 * ИНСТРУМЕНТЫ ПОМОЩНИКА ПО ОБЪЕКТАМ (П3, группа «prop», 31.10.2026):
 * change_property_price, change_property_status, request_property_change, send_to_remake.
 *
 * Идут через настоящий брокер подтверждений (lib/assistantActions.ts) и настоящие
 * сервисы заявок (lib/propertyChangeRequestService.ts). Подменён только
 * `sendBackToMontajer` (Telegram монтажёра, сети) — с теми же условиями
 * guard / dryRun, что у настоящей функции: сами они проверяются отдельно в
 * assistant-send-back-guard.test.ts на настоящей функции.
 *
 * Права рядового агента, чужого агента, руководителя, роли без права и роли «только
 * просмотр»; превью без записи; повтор подтверждения не дублирует; устаревшее
 * состояние → 409 STALE; откат заявки.
 */

const { sendBackToMontajer } = vi.hoisted(() => ({
  sendBackToMontajer: vi.fn(
    async (
      _propertyId: string,
      _byId: string,
      _reason: string,
      _comment: unknown,
      _replace: unknown,
      options?: { dryRun?: boolean; guard?: { videoRemakeCount: number } },
    ) => {
      if (options?.dryRun) return { ok: true as const, queued: false, message: "dry" };
      return { ok: true as const, queued: true, message: "Поставлено в очередь монтажёру." };
    },
  ),
}));

vi.mock("../src/lib/publishedVideoFix.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/publishedVideoFix.js")>()),
  sendBackToMontajer,
}));

const { prisma } = await import("../src/db.js");
await import("../src/ai/assistant/tools/index.js");
const { createPendingAssistantAction, confirmAssistantAction, undoAssistantAction, AssistantActionError } = await import(
  "../src/lib/assistantActions.js"
);
const { createPropertyChangeRequest } = await import("../src/lib/propertyChangeRequestService.js");
const { actorFor, cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { waitForSettled } = await import("./helpers/waitFor.js");
const { formatPropertyCode } = await import("@royal-home/shared");

const runId = Date.now();
let districtId = "";
let ownerId = "";
let otherId = "";
let directorId = "";
let marketingId = "";
let shareholderId = "";
let clientId = "";
const propertyIds: string[] = [];

const AGENT_PERMS: PermissionId[] = ["properties.requestChange"];
const DIRECTOR_PERMS: PermissionId[] = ["properties.requestChange", "properties.editForeign", "properties.delete", "properties.moderate"];
const MARKETING_PERMS: PermissionId[] = ["properties.requestChange", "properties.editForeign"];

async function seed(overrides: Record<string, unknown> = {}) {
  const property = await prisma.property.create({
    data: {
      title: `Помощник-объект ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 50,
      floor: 3,
      totalFloors: 9,
      price: 400000,
      currency: "TJS",
      districtId,
      address: `Помощниковая ${runId}-${propertyIds.length}`,
      condition: "GOOD",
      status: "AVAILABLE",
      createdById: ownerId,
      assignedAgentId: ownerId,
      publishedChannels: ["FACEBOOK", "INSTAGRAM"],
      ...overrides,
    } as never,
  });
  propertyIds.push(property.id);
  return property;
}

const requests = (propertyId: string, kind?: string) =>
  prisma.propertyChangeRequest.findMany({ where: { propertyId, ...(kind ? { kind: kind as never } : {}) } });

/** Создать действие и поймать отказ как AssistantActionError. */
async function preview(agentId: string, perms: PermissionId[], tool: string, args: Record<string, unknown>) {
  return createPendingAssistantAction(actorFor(agentId, perms), tool, args);
}

async function expectRefused(
  agentId: string,
  perms: PermissionId[],
  tool: string,
  args: Record<string, unknown>,
  status: number,
  text?: RegExp,
) {
  const error = await preview(agentId, perms, tool, args).then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(AssistantActionError);
  expect((error as InstanceType<typeof AssistantActionError>).status).toBe(status);
  if (text) expect((error as Error).message).toMatch(text);
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Помощник-объекты ${runId}` } })).id;
  ownerId = await createTestAgent(`Агент-владелец ${runId}`);
  otherId = await createTestAgent(`Чужой агент ${runId}`);
  directorId = await createTestAgent(`Директор ${runId}`, "DIRECTOR");
  const mk = (fullName: string, role: "MARKETING" | "SHAREHOLDER") =>
    prisma.agent.create({
      data: { fullName, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, role, passwordHash: "x" },
    });
  marketingId = (await mk(`Маркетинг ${runId}`, "MARKETING")).id;
  shareholderId = (await mk(`Акционер ${runId}`, "SHAREHOLDER")).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Покупатель помощника ${runId}`, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, source: "PHONE_CALL" },
    })
  ).id;
});

beforeEach(() => {
  sendBackToMontajer.mockClear();
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyChangeRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: "property-change-request-" } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  const agents = [ownerId, otherId, directorId, marketingId, shareholderId];
  await waitForSettled(() => prisma.auditLog.count({ where: { agentId: { in: agents } } }));
  await prisma.auditLog.deleteMany({ where: { agentId: { in: agents } } });
  await cleanupAssistantActionAgents(agents);
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("change_property_price", () => {
  it("превью ничего не пишет и показывает было → станет; подтверждение подаёт ровно одну заявку", async () => {
    const property = await seed();
    const code = formatPropertyCode(property.shortId);
    const pending = await preview(ownerId, AGENT_PERMS, "change_property_price", { ref: code, newPrice: 380000 });

    expect(pending.preview.was.Цена).toMatch(/400/);
    expect(pending.preview.becomes.Цена).toMatch(/380/);
    expect(pending.preview.risk).toMatch(/заявк/i);
    expect(await requests(property.id)).toHaveLength(0);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).price.toString()).toBe("400000");

    const actor = actorFor(ownerId, AGENT_PERMS);
    const first = await confirmAssistantAction(pending.id, actor);
    const second = await confirmAssistantAction(pending.id, actor);
    expect(second.replay).toBe(true);
    expect((first.action.result as { requestId: string }).requestId).toBe((second.action.result as { requestId: string }).requestId);

    const rows = await requests(property.id, "PRICE_CHANGE");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].authorId).toBe(ownerId);
    expect(rows[0].payload).toMatchObject({ newPrice: 380000, remake: false });
    // Цена объекта не тронута: её меняет только решение руководителя.
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).price.toString()).toBe("400000");
  });

  it("ref понимает номер ОБ-, короткий номер и id; цена округляется до копейки через lib/money", async () => {
    const property = await seed();
    for (const ref of [formatPropertyCode(property.shortId), String(property.shortId), property.id]) {
      const pending = await preview(ownerId, AGENT_PERMS, "change_property_price", { ref, newPrice: 1234.567 });
      expect(pending.preview.becomes.Цена).toMatch(/1\s?234,57|1234,57|1 234,57/);
    }
    const pending = await preview(ownerId, AGENT_PERMS, "change_property_price", { ref: String(property.shortId), newPrice: 1234.567 });
    await confirmAssistantAction(pending.id, actorFor(ownerId, AGENT_PERMS));
    const [row] = await requests(property.id, "PRICE_CHANGE");
    expect((row.payload as { newPrice: number }).newPrice).toBe(1234.57);
  });

  it("не нашли / несколько подходят — отказ со списком, а не выбор за человека", async () => {
    const a = await seed({ address: `Двойная улица ${runId}, 1` });
    const b = await seed({ address: `Двойная улица ${runId}, 2` });
    const error = (await preview(ownerId, AGENT_PERMS, "change_property_price", { ref: `Двойная улица ${runId}`, newPrice: 1 }).catch(
      (e: unknown) => e,
    )) as InstanceType<typeof AssistantActionError>;
    expect(error).toBeInstanceOf(AssistantActionError);
    expect(error.status).toBe(409);
    const ids = (error.extra.candidates as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));

    await expectRefused(ownerId, AGENT_PERMS, "change_property_price", { ref: "ОБ-999999999", newPrice: 1 }, 404);
    await expectRefused(ownerId, AGENT_PERMS, "change_property_price", { ref: "   ", newPrice: 1 }, 400);
  });

  it("общий разбор ссылки (lib/propertyRefLookup): голый номер без карточки не угадывается по адресу; Somon — отказ; фото-пост Instagram — находит", async () => {
    // Номер, которого нет среди карточек, но который стоит в адресе другого объекта:
    // для записи «88» — это карточка №88, а не «что-то с 88 в адресе».
    const missing = 900_000_000 + (runId % 1_000_000);
    await seed({ address: `Цифровая ${missing}` });
    await expectRefused(ownerId, AGENT_PERMS, "change_property_price", { ref: String(missing), newPrice: 1 }, 404);
    await expectRefused(ownerId, AGENT_PERMS, "change_property_price", { ref: "https://somon.tj/adv/123_x", newPrice: 1 }, 404, /Somon/);

    // Фото-пост (карусель) — разбор чтения find_property, теперь общий и для записи.
    const property = await seed();
    const code = `Ph${runId}`;
    await prisma.propertyPhotoPost.create({
      data: { propertyId: property.id, channel: "INSTAGRAM", status: "PUBLISHED", permalink: `https://www.instagram.com/p/${code}/` },
    });
    const pending = await preview(ownerId, AGENT_PERMS, "change_property_price", {
      ref: `https://instagram.com/p/${code}/?igsh=abc`,
      newPrice: 390000,
    });
    expect(pending.preview.was.Объект).toContain(formatPropertyCode(property.shortId));
  });

  it("права: свой — можно; чужой агент — 403; руководитель — можно; без права на заявки — 403; акционер — 403", async () => {
    const property = await seed();
    const args = { ref: String(property.shortId), newPrice: 390000 };
    await preview(ownerId, AGENT_PERMS, "change_property_price", args);
    await preview(directorId, DIRECTOR_PERMS, "change_property_price", args);
    await preview(marketingId, MARKETING_PERMS, "change_property_price", args);
    await expectRefused(otherId, AGENT_PERMS, "change_property_price", args, 403);
    await expectRefused(ownerId, [], "change_property_price", args, 403);
    await expectRefused(shareholderId, AGENT_PERMS, "change_property_price", args, 403, /просмотр/i);
    expect(await requests(property.id)).toHaveLength(0);
  });

  it("отказы как у REST: до публикации, та же цена, проданный, уже есть ждущая заявка", async () => {
    const draft = await seed({ status: "PENDING_REVIEW" });
    await expectRefused(ownerId, AGENT_PERMS, "change_property_price", { ref: String(draft.shortId), newPrice: 1 }, 409, /до публикации/i);

    const same = await seed();
    await expectRefused(ownerId, AGENT_PERMS, "change_property_price", { ref: String(same.shortId), newPrice: 400000 }, 400, /совпадает/);

    const sold = await seed({ status: "SOLD" });
    await expectRefused(ownerId, AGENT_PERMS, "change_property_price", { ref: String(sold.shortId), newPrice: 1 }, 409, /проданного/);

    const dup = await seed();
    const pending = await preview(ownerId, AGENT_PERMS, "change_property_price", { ref: String(dup.shortId), newPrice: 350000 });
    await confirmAssistantAction(pending.id, actorFor(ownerId, AGENT_PERMS));
    await expectRefused(ownerId, AGENT_PERMS, "change_property_price", { ref: String(dup.shortId), newPrice: 340000 }, 409, /уже есть/);
  });

  it("цену успели поменять после превью — 409 STALE, заявка не создана", async () => {
    const property = await seed();
    const pending = await preview(ownerId, AGENT_PERMS, "change_property_price", { ref: String(property.shortId), newPrice: 380000 });
    await prisma.property.update({ where: { id: property.id }, data: { price: 410000 } });
    const error = (await confirmAssistantAction(pending.id, actorFor(ownerId, AGENT_PERMS)).catch((e: unknown) => e)) as InstanceType<
      typeof AssistantActionError
    >;
    expect(error).toBeInstanceOf(AssistantActionError);
    expect(error.code).toBe("STALE");
    expect(await requests(property.id)).toHaveLength(0);
  });

  it("условие записи держится и под замком объекта: устаревшее ожидание → STALE без заявки (гонка после сравнения снимка)", async () => {
    const property = await seed();
    await prisma.property.update({ where: { id: property.id }, data: { price: 420000 } });
    const result = await createPropertyChangeRequest({
      propertyId: property.id,
      actor: { agentId: ownerId, can: (p) => AGENT_PERMS.includes(p) },
      body: { kind: "PRICE_CHANGE", payload: { newPrice: 380000, remake: false } },
      expect: { priceCents: 40000000, currency: "TJS", status: "AVAILABLE" },
    });
    expect(result).toMatchObject({ ok: false, status: 409, code: "STALE" });
    expect(await requests(property.id)).toHaveLength(0);
    await prisma.property.update({ where: { id: property.id }, data: { status: "WITHDRAWN" } });
    const byStatus = await createPropertyChangeRequest({
      propertyId: property.id,
      actor: { agentId: ownerId, can: (p) => AGENT_PERMS.includes(p) },
      body: { kind: "PRICE_CHANGE", payload: { newPrice: 380000, remake: false } },
      expect: { priceCents: 42000000, currency: "TJS", status: "AVAILABLE" },
    });
    expect(byStatus).toMatchObject({ ok: false, code: "STALE" });
  });

  it("откат отзывает заявку, пока она ждёт решения; после решения откатить нельзя", async () => {
    const property = await seed();
    const actor = actorFor(ownerId, AGENT_PERMS);
    const pending = await preview(ownerId, AGENT_PERMS, "change_property_price", { ref: String(property.shortId), newPrice: 370000 });
    const done = await confirmAssistantAction(pending.id, actor);
    expect(done.action.undoUntil).not.toBeNull();
    await undoAssistantAction(pending.id, actor);
    const [row] = await requests(property.id, "PRICE_CHANGE");
    expect(row.status).toBe("CANCELLED");

    // Вторая заявка: руководитель успел решить — откат отказывает, решение не затёрто.
    const other = await seed();
    const pending2 = await preview(ownerId, AGENT_PERMS, "change_property_price", { ref: String(other.shortId), newPrice: 360000 });
    await confirmAssistantAction(pending2.id, actor);
    const [created] = await requests(other.id, "PRICE_CHANGE");
    await prisma.propertyChangeRequest.update({
      where: { id: created.id },
      data: { status: "APPROVED", decidedById: directorId, decidedAt: new Date() },
    });
    const error = (await undoAssistantAction(pending2.id, actor).catch((e: unknown) => e)) as InstanceType<typeof AssistantActionError>;
    expect(error).toBeInstanceOf(AssistantActionError);
    expect(error.status).toBe(409);
    expect((await requests(other.id, "PRICE_CHANGE"))[0].status).toBe("APPROVED");
  });
});

describe("change_property_status", () => {
  it("снять с продажи: заявка «Другое» с понятным текстом, статус объекта не меняется", async () => {
    const property = await seed();
    const actor = actorFor(ownerId, AGENT_PERMS);
    const pending = await preview(ownerId, AGENT_PERMS, "change_property_status", { ref: String(property.shortId), status: "WITHDRAWN" });
    expect(pending.preview.was.Статус).toBe("В продаже");
    expect(pending.preview.becomes.Статус).toBe("Снято с продажи");
    expect(await requests(property.id)).toHaveLength(0);

    await confirmAssistantAction(pending.id, actor);
    const [row] = await requests(property.id, "OTHER");
    expect(row.status).toBe("PENDING");
    expect((row.payload as { text: string }).text).toMatch(/В продаже.*Снято с продажи/);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).status).toBe("AVAILABLE");
  });

  it("открытая сделка: снять и продать нельзя — теми же словами, что карточка", async () => {
    const property = await seed();
    await prisma.deal.create({ data: { clientId, propertyId: property.id, agentId: ownerId, stage: "NEGOTIATION" } });
    await expectRefused(ownerId, AGENT_PERMS, "change_property_status", { ref: String(property.shortId), status: "SOLD" }, 409, /открытая сделка/);
    await expectRefused(ownerId, AGENT_PERMS, "change_property_status", { ref: String(property.shortId), status: "WITHDRAWN" }, 409, /открытая сделка/);
  });

  it("смена статуса и «попросить руководителя» обе идут видом «Другое»: вторая — понятный отказ, что именно ждёт", async () => {
    const property = await seed();
    const ref = String(property.shortId);
    const pending = await preview(ownerId, AGENT_PERMS, "change_property_status", { ref, status: "WITHDRAWN" });
    await confirmAssistantAction(pending.id, actorFor(ownerId, AGENT_PERMS));
    expect(await requests(property.id, "OTHER")).toHaveLength(1);

    const text = "Поправьте, пожалуйста, описание подъезда";
    await expectRefused(ownerId, AGENT_PERMS, "request_property_change", { ref, kind: "OTHER", text }, 409, /ждущая заявка «Другое».*дождитесь решения/);
    // И в обратную сторону: ждущая «Другое» не даёт подать смену статуса.
    const other = await seed();
    const ref2 = String(other.shortId);
    const req = await preview(ownerId, AGENT_PERMS, "request_property_change", { ref: ref2, kind: "OTHER", text });
    await confirmAssistantAction(req.id, actorFor(ownerId, AGENT_PERMS));
    await expectRefused(ownerId, AGENT_PERMS, "change_property_status", { ref: ref2, status: "WITHDRAWN" }, 409, /смену статуса через помощника/);
    // REST-правило не менялось: заявка одна.
    expect(await requests(other.id, "OTHER")).toHaveLength(1);
  });

  it("резерв без сделки, этапы подготовки, тот же статус, чужой объект, акционер", async () => {
    const property = await seed();
    const ref = String(property.shortId);
    await expectRefused(ownerId, AGENT_PERMS, "change_property_status", { ref, status: "RESERVED" }, 409, /оформляет сделка/);
    await expectRefused(ownerId, AGENT_PERMS, "change_property_status", { ref, status: "EDITING" }, 409, /маркетинг/);
    await expectRefused(ownerId, AGENT_PERMS, "change_property_status", { ref, status: "AVAILABLE" }, 400, /уже в статусе/);
    await expectRefused(otherId, AGENT_PERMS, "change_property_status", { ref, status: "WITHDRAWN" }, 403);
    await expectRefused(shareholderId, AGENT_PERMS, "change_property_status", { ref, status: "WITHDRAWN" }, 403);
    await expectRefused(ownerId, [], "change_property_status", { ref, status: "WITHDRAWN" }, 403);
    expect(await requests(property.id)).toHaveLength(0);
  });

  it("возврат снятого в продажу — шаг маркетинга: рядовому агенту отказ, руководителю (с готовностью) — проверка готовности", async () => {
    const property = await seed({ status: "WITHDRAWN" });
    const ref = String(property.shortId);
    await expectRefused(ownerId, AGENT_PERMS, "change_property_status", { ref, status: "AVAILABLE" }, 403, /маркетинг/i);
    // Руководитель шаг делает, но объект без фото и ссылки на ролик «не готов к продаже» — как в карточке.
    await expectRefused(directorId, DIRECTOR_PERMS, "change_property_status", { ref, status: "AVAILABLE" }, 409, /не готов к продаже/);
  });

  it("откат отзывает заявку на статус", async () => {
    const property = await seed();
    const actor = actorFor(ownerId, AGENT_PERMS);
    const pending = await preview(ownerId, AGENT_PERMS, "change_property_status", { ref: String(property.shortId), status: "WITHDRAWN" });
    await confirmAssistantAction(pending.id, actor);
    await undoAssistantAction(pending.id, actor);
    expect((await requests(property.id, "OTHER"))[0].status).toBe("CANCELLED");
  });
});

describe("request_property_change", () => {
  it("OTHER: текст уходит в заявку; слишком короткий — отказ схемы", async () => {
    const property = await seed();
    const actor = actorFor(ownerId, AGENT_PERMS);
    await expectRefused(ownerId, AGENT_PERMS, "request_property_change", { ref: String(property.shortId), kind: "OTHER", text: "мало" }, 400, /10 символов/);
    const pending = await preview(ownerId, AGENT_PERMS, "request_property_change", {
      ref: String(property.shortId),
      kind: "OTHER",
      text: "Собственник просит убрать объект из рекламы на неделю",
    });
    await confirmAssistantAction(pending.id, actor);
    const [row] = await requests(property.id, "OTHER");
    expect((row.payload as { text: string }).text).toMatch(/убрать объект из рекламы/);
  });

  it("CARD_DATA: поле из набора подписи принимается, постороннее — нет; было → станет в превью", async () => {
    const property = await seed();
    const ref = String(property.shortId);
    const pending = await preview(ownerId, AGENT_PERMS, "request_property_change", { ref, kind: "CARD_DATA", patch: { rooms: 3 } });
    expect(pending.preview.was.rooms).toBe(2);
    expect(pending.preview.becomes.rooms).toBe(3);
    await confirmAssistantAction(pending.id, actorFor(ownerId, AGENT_PERMS));
    expect((await requests(property.id, "CARD_DATA"))[0].payload).toMatchObject({ patch: { rooms: 3 } });

    await expectRefused(ownerId, AGENT_PERMS, "request_property_change", { ref: String(property.shortId), kind: "CARD_DATA", patch: { assignedAgentId: otherId } }, 400);
    await expectRefused(ownerId, AGENT_PERMS, "request_property_change", { ref, kind: "CARD_DATA" }, 400);
  });

  it("UNPUBLISH: нечего снимать — 409; чужие каналы — 400; чужой объект — 403", async () => {
    const none = await seed({ publishedChannels: [] });
    await expectRefused(ownerId, AGENT_PERMS, "request_property_change", { ref: String(none.shortId), kind: "UNPUBLISH" }, 409, /снимать нечего/);
    const published = await seed();
    await expectRefused(ownerId, AGENT_PERMS, "request_property_change", { ref: String(published.shortId), kind: "UNPUBLISH", channels: ["TIKTOK"] }, 400, /TIKTOK/);
    await expectRefused(otherId, AGENT_PERMS, "request_property_change", { ref: String(published.shortId), kind: "UNPUBLISH" }, 403);
    const ok = await preview(ownerId, AGENT_PERMS, "request_property_change", { ref: String(published.shortId), kind: "UNPUBLISH", channels: ["FACEBOOK"] });
    expect(ok.preview.becomes["Снять из"]).toBe("FACEBOOK");
  });

  it("заявки разных видов на один объект не мешают друг другу, одинаковые — дубль", async () => {
    const property = await seed();
    const actor = actorFor(ownerId, AGENT_PERMS);
    const ref = String(property.shortId);
    const price = await preview(ownerId, AGENT_PERMS, "change_property_price", { ref, newPrice: 300000 });
    const note = await preview(ownerId, AGENT_PERMS, "request_property_change", { ref, kind: "OTHER", text: "Просьба по объекту, подробности по телефону" });
    await confirmAssistantAction(price.id, actor);
    await confirmAssistantAction(note.id, actor);
    expect(await requests(property.id)).toHaveLength(2);
  });
});

describe("send_to_remake", () => {
  const MARKETING_ROLE_ARGS = (ref: string) => ({ ref, reason: "NO_MUSIC" });

  it("необратимо: превью помечено, текст монтажёру и последствия есть, до подтверждения ничего не вызвано", async () => {
    const property = await seed();
    const pending = await preview(directorId, DIRECTOR_PERMS, "send_to_remake", MARKETING_ROLE_ARGS(String(property.shortId)));
    expect(pending.preview.irreversible).toBe(true);
    expect(pending.preview.risk).toMatch(/НЕОБРАТИМО/);
    expect(pending.preview.becomes["Текст монтажёру"]).toBeTruthy();
    expect(pending.undoUntil).toBeNull();
    // Сухая проверка (dryRun) отрабатывает, но запись не вызывается.
    expect(sendBackToMontajer.mock.calls.every((c) => (c[5] as { dryRun?: boolean })?.dryRun === true)).toBe(true);
  });

  it("руководитель подтверждает: функция возврата вызвана один раз с причиной и счётчиком; откат недоступен", async () => {
    const property = await seed({ videoRemakeCount: 2 });
    const actor = actorFor(directorId, DIRECTOR_PERMS);
    const pending = await preview(directorId, DIRECTOR_PERMS, "send_to_remake", { ref: String(property.shortId), reason: "OTHER", comment: "Не тот ракурс" });
    const done = await confirmAssistantAction(pending.id, actor);
    await confirmAssistantAction(pending.id, actor);

    const real = sendBackToMontajer.mock.calls.filter((c) => !(c[5] as { dryRun?: boolean })?.dryRun);
    expect(real).toHaveLength(1);
    expect(real[0].slice(0, 5)).toEqual([property.id, directorId, "OTHER", "Не тот ракурс", null]);
    expect(real[0][5]).toMatchObject({ guard: { videoRemakeCount: 2 } });
    expect(done.action.undoUntil).toBeNull();
    const error = (await undoAssistantAction(pending.id, actor).catch((e: unknown) => e)) as InstanceType<typeof AssistantActionError>;
    expect(error.code).toBe("NOT_UNDOABLE");
  });

  it("права: рядовой агент после публикации — 403 (руководству), чужой — 403, акционер — 403", async () => {
    const property = await seed();
    const args = MARKETING_ROLE_ARGS(String(property.shortId));
    await expectRefused(ownerId, AGENT_PERMS, "send_to_remake", args, 403);
    await expectRefused(otherId, AGENT_PERMS, "send_to_remake", args, 403);
    await expectRefused(shareholderId, DIRECTOR_PERMS, "send_to_remake", args, 403);
    // Объект ещё не опубликован: свой агент может вернуть монтажёру сам.
    const draft = await seed({ status: "EDITING" });
    await preview(ownerId, AGENT_PERMS, "send_to_remake", MARKETING_ROLE_ARGS(String(draft.shortId)));
    // …а чужой агент чужой неопубликованный объект — нет (проверка «чей объект» отдельно от замка публикации).
    await expectRefused(otherId, AGENT_PERMS, "send_to_remake", MARKETING_ROLE_ARGS(String(draft.shortId)), 403, /Недостаточно прав/);
  });

  it("снять из соцсетей — только маркетинг, директор, админ", async () => {
    const draft = await seed({ status: "EDITING" });
    const args = { ref: String(draft.shortId), reason: "NO_MUSIC", removeFromSocial: true };
    await expectRefused(ownerId, AGENT_PERMS, "send_to_remake", args, 403);
    const asDirector = await preview(directorId, DIRECTOR_PERMS, "send_to_remake", args);
    expect(asDirector.preview.becomes["Старый ролик"]).toMatch(/снят/);
    await preview(marketingId, MARKETING_PERMS, "send_to_remake", args);
  });

  it("комментарий обязателен для «Другое» и «Неверная надпись»; отказ функции возврата показан в превью", async () => {
    const property = await seed();
    await expectRefused(directorId, DIRECTOR_PERMS, "send_to_remake", { ref: String(property.shortId), reason: "OTHER" }, 400, /нужен комментарий/);
    sendBackToMontajer.mockImplementationOnce(async () => ({ ok: false as const, error: "Объект уже у монтажёра или стоит в очереди — второй раз отправлять нечего." }));
    await expectRefused(directorId, DIRECTOR_PERMS, "send_to_remake", { ref: String(property.shortId), reason: "NO_MUSIC" }, 409, /уже у монтажёра/);
  });

  it("объект перемонтировали после превью — 409 STALE, второй возврат не уходит", async () => {
    const property = await seed({ videoRemakeCount: 0 });
    const actor = actorFor(directorId, DIRECTOR_PERMS);
    const pending = await preview(directorId, DIRECTOR_PERMS, "send_to_remake", MARKETING_ROLE_ARGS(String(property.shortId)));
    await prisma.property.update({ where: { id: property.id }, data: { videoRemakeCount: 1 } });
    const error = (await confirmAssistantAction(pending.id, actor).catch((e: unknown) => e)) as InstanceType<typeof AssistantActionError>;
    expect(error.code).toBe("STALE");
    expect(sendBackToMontajer.mock.calls.filter((c) => !(c[5] as { dryRun?: boolean })?.dryRun)).toHaveLength(0);
  });
});
