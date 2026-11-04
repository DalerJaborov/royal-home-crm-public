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
const { buildPriceDisplay } = await import("../src/lib/reelsCaptionTemplate.js");
await import("../src/ai/assistant/tools/index.js");
const { createPendingAssistantAction, confirmAssistantAction, undoAssistantAction, AssistantActionError } = await import(
  "../src/lib/assistantActions.js"
);
const { createPropertyChangeRequest } = await import("../src/lib/propertyChangeRequestService.js");
const { ASSISTANT_PRICE_UNDO_JOB } = await import("../src/lib/assistantPriceUndoJournal.js");
const { jobHandlerOf } = await import("../src/jobs/registry.js");
const { approvePropertyChangeRequest } = await import("../src/routes/properties/changeRequestExecutor.js");
const { withPropertyLock } = await import("../src/lib/videoHandoff.js");
const { actorFor, cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { waitForSettled } = await import("./helpers/waitFor.js");
const { formatPropertyCode } = await import("@royal-home/shared");
const { runAssistantToolPlugin } = await import("../src/ai/assistant/tools/run.js");
const { findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");

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

function undoAudits(actionId: string) {
  return prisma.auditLog.findMany({
    where: {
      meta: { path: ["actionId"], equals: actionId },
      action: { in: ["ASSISTANT_CHANGE_PROPERTY_STATUS_UNDO", "ASSISTANT_CHANGE_PROPERTY_PRICE_UNDO", "PROPERTY_CHANGE_REQUEST_CANCELLED"] },
    },
    select: { action: true },
    orderBy: { action: "asc" },
  });
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
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map(id => `site-resync:${id}`) } } });
  const reversals = await prisma.propertyChangeRequest.findMany({
    where: { propertyId: { in: propertyIds }, kind: "PRICE_CHANGE" }, select: { id: true },
  });
  if (reversals.length) {
    await prisma.backgroundJob.deleteMany({
      where: { type: ASSISTANT_PRICE_UNDO_JOB, OR: reversals.map(({ id }) => ({ payload: { path: ["requestId"], equals: id } })) },
    });
  }
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

  it("сбой записи отката сохраняет цену и прежние задания, воркер продолжает тот же откат", async () => {
    const property = await seed({
      publishedOnSite: true,
      publishedChannels: ["FACEBOOK"],
      publishedPostIds: { FACEBOOK: "fixture-post" },
      reelsCaption: `Цена: ${buildPriceDisplay(400000, "TJS")}`,
    });
    const siteKey = `site-resync:${property.id}`;
    const actor = actorFor(ownerId, AGENT_PERMS);
    const pending = await preview(ownerId, AGENT_PERMS, "change_property_price", {
      ref: String(property.shortId), newPrice: 370000,
    });
    await confirmAssistantAction(pending.id, actor);
    const firstSiteJob = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: siteKey } });
    await prisma.$executeRaw`
      CREATE FUNCTION test_fail_applied_price_undo() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.tool = 'change_property_price' AND NEW.status = 'UNDONE' THEN
          RAISE EXCEPTION 'synthetic failure recording applied price undo';
        END IF;
        RETURN NEW;
      END $$`;
    try {
      await prisma.$executeRaw`
        CREATE TRIGGER test_fail_applied_price_undo BEFORE UPDATE ON "AssistantAction"
        FOR EACH ROW EXECUTE FUNCTION test_fail_applied_price_undo()`;
      const failed = await undoAssistantAction(pending.id, actor).catch((err: unknown) => err);
      expect(Number((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).price)).toBe(370000);
      expect((await prisma.assistantAction.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("EXECUTED");
      expect(await prisma.priceChange.count({ where: { propertyId: property.id } })).toBe(1);
      expect(await undoAudits(pending.id)).toEqual([]);
      expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: siteKey } })).payload).toEqual(firstSiteJob.payload);
      expect(await prisma.publicationMetadataSync.count({ where: { propertyId: property.id } })).toBe(1);
      expect((await requests(property.id, "PRICE_CHANGE")).map((request) => request.status).sort())
        .toEqual(["APPROVED", "PENDING"]);
      expect(failed).toMatchObject({ status: 503, code: "UNDO_RETRY" });
    } finally {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS test_fail_applied_price_undo ON "AssistantAction"`;
      await prisma.$executeRaw`DROP FUNCTION test_fail_applied_price_undo()`;
    }
    const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: `${ASSISTANT_PRICE_UNDO_JOB}:${pending.id}` } });
    await import("../src/jobs/handlers.js");
    const handler = jobHandlerOf(job.type);
    expect(handler).toBeDefined();
    await handler!.run(handler!.schema.parse(job.payload));
    // A repeated worker delivery and the original UI after restart both read the committed receipt.
    await handler!.run(handler!.schema.parse(job.payload));
    const retry = await undoAssistantAction(pending.id, actor, { now: new Date(Date.now() + 16 * 60_000) });
    expect(retry).toMatchObject({ action: { status: "UNDONE" }, replay: true });
    expect(Number((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).price)).toBe(400000);
    expect(await prisma.priceChange.count({ where: { propertyId: property.id } })).toBe(2);
    expect(await undoAudits(pending.id)).toContainEqual({ action: "ASSISTANT_CHANGE_PROPERTY_PRICE_UNDO" });
    expect(await requests(property.id, "PRICE_CHANGE")).toHaveLength(2);
    expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: siteKey } })).payload).not.toEqual(firstSiteJob.payload);
    const deliveries = await prisma.publicationMetadataSync.findMany({ where: { propertyId: property.id } });
    expect(deliveries.map(row => row.status).sort()).toEqual(["PENDING", "SUPERSEDED"]);
    expect(deliveries.find(row => row.status === "PENDING")?.payload).toMatchObject({ caption: `Цена: ${buildPriceDisplay(400000, "TJS")}` });
  });

  it("одновременные запросы отката возвращают один сохранённый итог", async () => {
    const property = await seed({ publishedChannels: [] });
    const actor = actorFor(ownerId, AGENT_PERMS);
    const action = await preview(ownerId, AGENT_PERMS, "change_property_price", {
      ref: String(property.shortId), newPrice: 370000,
    });
    await confirmAssistantAction(action.id, actor);
    const results = await Promise.all([undoAssistantAction(action.id, actor), undoAssistantAction(action.id, actor)]);
    expect(results.map(({ action }) => action.status)).toEqual(["UNDONE", "UNDONE"]);
    expect(results.map(({ replay }) => replay).sort()).toEqual([false, true]);
    expect(await prisma.priceChange.count({ where: { propertyId: property.id } })).toBe(2);
    expect(await undoAudits(action.id)).toEqual([{ action: "ASSISTANT_CHANGE_PROPERTY_PRICE_UNDO" }]);
    expect(await requests(property.id, "PRICE_CHANGE")).toHaveLength(2);
  });

  it("после потери подтверждения COMMIT откат читается без повторной записи и сохраняет следующую цену", async () => {
    const property = await seed({ publishedChannels: [] });
    const actor = actorFor(ownerId, AGENT_PERMS);
    const action = await preview(ownerId, AGENT_PERMS, "change_property_price", {
      ref: String(property.shortId), newPrice: 370000,
    });
    await confirmAssistantAction(action.id, actor);
    const transaction = prisma.$transaction.bind(prisma);
    const intercepted = vi.spyOn(prisma, "$transaction");
    let lostAck = false;
    intercepted.mockImplementation((async (...args: Parameters<typeof transaction>) => {
      const outcome = await transaction(...args);
      if (!lostAck && outcome && typeof outcome === "object" && "write" in outcome &&
        "property" in outcome && (outcome.property as { id?: string } | null)?.id === property.id) {
        lostAck = true;
        throw new Error("injected loss of applied-price undo commit acknowledgement");
      }
      return outcome;
    }) as typeof prisma.$transaction);
    try {
      expect(await undoAssistantAction(action.id, actor)).toMatchObject({ action: { status: "UNDONE" }, replay: true });
      expect(lostAck).toBe(true);
    } finally {
      intercepted.mockRestore();
    }
    await prisma.property.update({ where: { id: property.id }, data: { price: 410000, version: { increment: 1 } } });
    expect(await undoAssistantAction(action.id, actor)).toMatchObject({ action: { status: "UNDONE" }, replay: true });
    expect(Number((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).price)).toBe(410000);
    expect(await prisma.priceChange.count({ where: { propertyId: property.id } })).toBe(2);
    expect(await undoAudits(action.id)).toEqual([{ action: "ASSISTANT_CHANGE_PROPERTY_PRICE_UNDO" }]);
  });

  it("воркер после потери ответа о постановке проверяет права и более свежую цену", async () => {
    const property = await seed({ publishedChannels: [] });
    const actor = actorFor(ownerId, AGENT_PERMS);
    const action = await preview(ownerId, AGENT_PERMS, "change_property_price", {
      ref: String(property.shortId), newPrice: 370000,
    });
    await confirmAssistantAction(action.id, actor);
    const transaction = prisma.$transaction.bind(prisma);
    const interrupted = vi.spyOn(prisma, "$transaction");
    interrupted.mockImplementationOnce((async (...args: Parameters<typeof transaction>) => {
      await transaction(...args);
      throw new Error("injected loss of undo staging acknowledgement");
    }) as typeof prisma.$transaction);
    try {
      await expect(undoAssistantAction(action.id, actor)).rejects.toMatchObject({ status: 503, code: "UNDO_RETRY" });
    } finally {
      interrupted.mockRestore();
    }
    const job = await prisma.backgroundJob.findUniqueOrThrow({ where: { dedupeKey: `${ASSISTANT_PRICE_UNDO_JOB}:${action.id}` } });
    expect((await requests(property.id, "PRICE_CHANGE")).map((request) => request.status).sort()).toEqual(["APPROVED", "PENDING"]);
    await import("../src/jobs/handlers.js");
    const handler = jobHandlerOf(job.type);
    expect(handler).toBeDefined();
    await prisma.agent.update({ where: { id: ownerId }, data: { permissions: { revoked: ["properties.requestChange"] } } });
    try {
      await expect(handler!.run(handler!.schema.parse(job.payload))).rejects.toThrow("Could not apply staged assistant price undo");
      expect((await prisma.assistantAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("EXECUTED");
    } finally {
      await prisma.agent.update({ where: { id: ownerId }, data: { permissions: {} } });
    }
    await prisma.property.update({ where: { id: property.id }, data: { price: 395000, version: { increment: 1 } } });
    await handler!.run(handler!.schema.parse(job.payload));
    await expect(undoAssistantAction(action.id, actor)).rejects.toMatchObject({ status: 409, code: "UNDO_STALE" });
    expect((await prisma.propertyChangeRequest.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("CANCELLED");
    expect(Number((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).price)).toBe(395000);
    expect(await undoAudits(action.id)).toEqual([]);
  });

  it("старое выполненное действие с записью цены в журнале остаётся доступным для отката", async () => {
    const property = await seed({ publishedChannels: [] });
    const actor = actorFor(ownerId, AGENT_PERMS);
    const action = await preview(ownerId, AGENT_PERMS, "change_property_price", {
      ref: String(property.shortId), newPrice: 370000,
    });
    const applied = await confirmAssistantAction(action.id, actor);
    const legacy = { ...(applied.action.result as { requestId: string; appliedPropertyVersion?: number }) };
    delete legacy.appliedPropertyVersion;
    await prisma.assistantAction.update({ where: { id: action.id }, data: { result: legacy } });
    expect(await undoAssistantAction(action.id, actor)).toMatchObject({ action: { status: "UNDONE" }, replay: false });
    expect(Number((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).price)).toBe(400000);
  });

  it("старый захват без связанной заявки требует сверки и не меняет цену", async () => {
    const property = await seed({ publishedChannels: [] });
    const actor = actorFor(ownerId, AGENT_PERMS);
    const action = await preview(ownerId, AGENT_PERMS, "change_property_price", {
      ref: String(property.shortId), newPrice: 370000,
    });
    await confirmAssistantAction(action.id, actor);
    await prisma.assistantAction.update({ where: { id: action.id }, data: { undoClaimedAt: new Date() } });
    await expect(undoAssistantAction(action.id, actor)).rejects.toMatchObject({ status: 409, code: "UNDO_UNCERTAIN" });
    expect(Number((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).price)).toBe(370000);
    expect(await requests(property.id, "PRICE_CHANGE")).toHaveLength(1);
  });

  it.each([
    { name: "новая цена", interveningPrices: [390000], expectedPrice: 390000 },
    { name: "цена снова прежняя", interveningPrices: [390000, 370000], expectedPrice: 370000 },
  ])("откат не затирает правки после создания встречной заявки ($name)", async ({ interveningPrices, expectedPrice }) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled in test"); }));
    const read = prisma.propertyChangeRequest.findUnique.bind(prisma.propertyChangeRequest);
    const hook = vi.spyOn(prisma.propertyChangeRequest, "findUnique");
    try {
      const property = await seed({ publishedChannels: [] });
      const actor = actorFor(ownerId, AGENT_PERMS);
      const pending = await preview(ownerId, AGENT_PERMS, "change_property_price", {
        ref: String(property.shortId), newPrice: 370000,
      });
      await confirmAssistantAction(pending.id, actor);
      let reversalId: string | undefined;
      hook.mockImplementationOnce((async (...args: Parameters<typeof read>) => {
        const staged = await read(...args);
        if (staged?.propertyId === property.id && staged.status === "PENDING") {
          reversalId = staged.id;
          for (const price of interveningPrices) {
            await prisma.property.update({
              where: { id: property.id }, data: { price, version: { increment: 1 } },
            });
          }
        }
        return staged;
      }) as typeof prisma.propertyChangeRequest.findUnique);

      await expect(undoAssistantAction(pending.id, actor)).rejects.toMatchObject({ status: 409, code: "UNDO_STALE" });
      expect(reversalId).toBeDefined();
      const request = await prisma.propertyChangeRequest.findUniqueOrThrow({ where: { id: reversalId! } });
      expect(request.status).toBe("CANCELLED");
      // The same approval function is used by the director's regular CRM screen.
      await expect(approvePropertyChangeRequest({ requestId: request.id, actorId: directorId, note: null }))
        .resolves.toMatchObject({ ok: false, status: 409 });
      const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
      expect(Number(after.price)).toBe(expectedPrice);
      expect(await prisma.priceChange.count({ where: { propertyId: property.id } })).toBe(1);
      expect((await prisma.assistantAction.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("EXECUTED");
    } finally {
      hook.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("откат видит смену версии до встречной заявки, даже когда цену снова вернули", async () => {
    const property = await seed({ publishedChannels: [] });
    const actor = actorFor(ownerId, AGENT_PERMS);
    const pending = await preview(ownerId, AGENT_PERMS, "change_property_price", {
      ref: String(property.shortId), newPrice: 370000,
    });
    const applied = await confirmAssistantAction(pending.id, actor);
    expect(applied.action.result).toMatchObject({ applied: true, appliedPropertyVersion: property.version + 1 });

    for (const price of [390000, 370000]) {
      await prisma.property.update({
        where: { id: property.id }, data: { price, version: { increment: 1 } },
      });
    }

    await expect(undoAssistantAction(pending.id, actor)).rejects.toMatchObject({ status: 409, code: "UNDO_STALE" });
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(Number(after.price)).toBe(370000);
    expect(after.version).toBe(property.version + 3);
    expect(await requests(property.id, "PRICE_CHANGE")).toHaveLength(1);
  });

  it("обычное одобрение закрывает ещё ждущий устаревший откат, не применяя его", async () => {
    const property = await seed({ publishedChannels: [] });
    const created = await createPropertyChangeRequest({
      propertyId: property.id,
      actor: actorFor(ownerId, AGENT_PERMS),
      expect: { priceCents: 40000000, currency: "TJS", status: property.status, guardPriceUndo: true },
      body: { kind: "PRICE_CHANGE", payload: { newPrice: 370000, currency: "TJS", remake: false } },
    });
    if (!created.ok) throw new Error(created.error);
    expect(created.request.status).toBe("PENDING");
    expect(created.request.payload).toEqual({ newPrice: 370000, currency: "TJS", remake: false });
    await prisma.property.update({ where: { id: property.id }, data: { price: 390000 } });

    await expect(approvePropertyChangeRequest({ requestId: created.request.id, actorId: directorId, note: null }))
      .resolves.toMatchObject({ ok: false, status: 409, code: "UNDO_STALE" });
    expect((await prisma.propertyChangeRequest.findUniqueOrThrow({ where: { id: created.request.id } })).status)
      .toBe("CANCELLED");
    expect(Number((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).price)).toBe(390000);
    expect(await prisma.priceChange.count({ where: { propertyId: property.id } })).toBe(0);
  });

  it("СВОЙ объект: превью ничего не пишет; подтверждение меняет цену сразу (заявка создана и принята автором), повтор — тот же результат", async () => {
    const property = await seed();
    const code = formatPropertyCode(property.shortId);
    const pending = await preview(ownerId, AGENT_PERMS, "change_property_price", { ref: code, newPrice: 380000 });

    expect(pending.preview.was.Цена).toMatch(/400/);
    expect(pending.preview.becomes.Цена).toMatch(/380/);
    expect(pending.preview.becomes.Заявка).toBeUndefined();
    expect(pending.preview.risk).toMatch(/сразу/i);
    expect(await requests(property.id)).toHaveLength(0);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).price.toString()).toBe("400000");

    const actor = actorFor(ownerId, AGENT_PERMS);
    const first = await confirmAssistantAction(pending.id, actor);
    const second = await confirmAssistantAction(pending.id, actor);
    expect(second.replay).toBe(true);
    expect((first.action.result as { applied: boolean }).applied).toBe(true);

    const rows = await requests(property.id, "PRICE_CHANGE");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("APPROVED");
    expect(rows[0].authorId).toBe(ownerId);
    expect(rows[0].decidedById).toBe(ownerId);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).price.toString()).toBe("380000");
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

  it("сквозь run.ts: «несколько подходят» — модель получает кандидатов (id как есть, адрес в обёртке), а не голое «ошибка»", async () => {
    const a = await seed({ address: `Кандидатная ${runId} <b>1</b>` });
    const b = await seed({ address: `Кандидатная ${runId} 2` });
    const answer = (await runAssistantToolPlugin(
      findAssistantToolPlugin("change_property_price")!,
      { ref: `Кандидатная ${runId}`, newPrice: 1 },
      actorFromAccess(ownerId, { role: "AGENT", permissions: new Set(AGENT_PERMS) }),
      { channel: "crm" },
    )) as { error: string; code: string; details: { candidates: Array<{ id: string; shortId: number; address: string }> } };
    expect(answer.code).toBe("REF_AMBIGUOUS");
    expect(answer.error).toMatch(/несколько/);
    expect(answer.details.candidates.map((c) => c.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    for (const c of answer.details.candidates) {
      expect(typeof c.shortId).toBe("number");
      expect(c.address).toContain("<client_content");
    }
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

  it("откат применённой цены возвращает прежнюю; если цену успели поменять ещё раз — откат отказывает и чужую правку не затирает", async () => {
    const property = await seed();
    const actor = actorFor(ownerId, AGENT_PERMS);
    const pending = await preview(ownerId, AGENT_PERMS, "change_property_price", { ref: String(property.shortId), newPrice: 370000 });
    const done = await confirmAssistantAction(pending.id, actor);
    expect(done.action.undoUntil).not.toBeNull();
    await undoAssistantAction(pending.id, actor);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).price.toString()).toBe("400000");

    const other = await seed();
    const pending2 = await preview(ownerId, AGENT_PERMS, "change_property_price", { ref: String(other.shortId), newPrice: 360000 });
    await confirmAssistantAction(pending2.id, actor);
    await prisma.property.update({ where: { id: other.id }, data: { price: 355000 } });
    const error = (await undoAssistantAction(pending2.id, actor).catch((e: unknown) => e)) as InstanceType<typeof AssistantActionError>;
    expect(error).toBeInstanceOf(AssistantActionError);
    expect(error.status).toBe(409);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: other.id } })).price.toString()).toBe("355000");
  });
});

describe("change_property_status", () => {
  async function pendingStatusUndo() {
    const property = await seed();
    const actor = actorFor(ownerId, AGENT_PERMS);
    const action = await preview(ownerId, AGENT_PERMS, "change_property_status", { ref: String(property.shortId), status: "WITHDRAWN" });
    await confirmAssistantAction(action.id, actor);
    const [request] = await requests(property.id, "OTHER");
    return { property, actor, action, request };
  }

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

  it("падение финальной записи отката не отзывает заявку и позволяет повторить", async () => {
    const { property, actor, action } = await pendingStatusUndo();
    const livePublish = await import("../src/lib/livePublish.js");
    const publish = vi.spyOn(livePublish, "publishRequestUpdated");
    await prisma.$executeRaw`
      CREATE FUNCTION test_fail_pending_assistant_undo() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'UNDONE' AND NEW.tool = 'change_property_status' THEN
          RAISE EXCEPTION 'synthetic assistant undo final write failure';
        END IF;
        RETURN NEW;
      END $$`;
    try {
      await prisma.$executeRaw`
        CREATE TRIGGER test_fail_pending_assistant_undo BEFORE UPDATE ON "AssistantAction"
        FOR EACH ROW EXECUTE FUNCTION test_fail_pending_assistant_undo()`;
      const failure = await undoAssistantAction(action.id, actor).catch((err: unknown) => err);
      expect((await requests(property.id, "OTHER"))[0].status).toBe("PENDING");
      expect(await prisma.assistantAction.findUniqueOrThrow({ where: { id: action.id } }))
        .toMatchObject({ status: "EXECUTED", undoClaimedAt: null, undoneAt: null });
      expect(await undoAudits(action.id)).toEqual([]);
      expect(publish).not.toHaveBeenCalled();
      expect(failure).toMatchObject({ status: 503, code: "UNDO_RETRY" });
    } finally {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS test_fail_pending_assistant_undo ON "AssistantAction"`;
      await prisma.$executeRaw`DROP FUNCTION test_fail_pending_assistant_undo()`;
      publish.mockRestore();
    }
    const retried = await undoAssistantAction(action.id, actor);
    expect(retried).toMatchObject({ action: { status: "UNDONE" }, replay: false });
    expect((await requests(property.id, "OTHER"))[0].status).toBe("CANCELLED");
  });

  it("две одновременные отмены отзывают заявку один раз и не дублируют аудит", async () => {
    const { property, actor, action } = await pendingStatusUndo();
    const outcome = await Promise.all([undoAssistantAction(action.id, actor), undoAssistantAction(action.id, actor)]);
    expect(outcome.map((result) => result.action.status)).toEqual(["UNDONE", "UNDONE"]);
    expect(outcome.map((result) => result.replay).sort()).toEqual([false, true]);
    expect((await requests(property.id, "OTHER"))[0].status).toBe("CANCELLED");
    expect(await undoAudits(action.id)).toEqual([
      { action: "ASSISTANT_CHANGE_PROPERTY_STATUS_UNDO" },
      { action: "PROPERTY_CHANGE_REQUEST_CANCELLED" },
    ]);
  });

  it("потеря ответа COMMIT возвращает сохранённый откат без повторной записи", async () => {
    const { property, actor, action } = await pendingStatusUndo();
    const realTransaction = prisma.$transaction.bind(prisma);
    const transaction = vi.spyOn(prisma, "$transaction");
    transaction.mockImplementationOnce((async (...args: Parameters<typeof realTransaction>) => {
      await realTransaction(...args);
      throw new Error("injected loss of undo commit acknowledgement");
    }) as typeof prisma.$transaction);
    try {
      expect(await undoAssistantAction(action.id, actor)).toMatchObject({ action: { status: "UNDONE" }, replay: true });
      expect(await undoAssistantAction(action.id, actor)).toMatchObject({ action: { status: "UNDONE" }, replay: true });
    } finally {
      transaction.mockRestore();
    }
    expect((await requests(property.id, "OTHER"))[0].status).toBe("CANCELLED");
    expect(await undoAudits(action.id)).toEqual([
      { action: "ASSISTANT_CHANGE_PROPERTY_STATUS_UNDO" },
      { action: "PROPERTY_CHANGE_REQUEST_CANCELLED" },
    ]);
  });

  it("проверяет автора и свежие права даже при повторе с устаревшим контекстом сотрудника", async () => {
    const { property, actor, action, request } = await pendingStatusUndo();
    const impersonator = actorFor(directorId, DIRECTOR_PERMS);
    await expect(undoAssistantAction(action.id, impersonator)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await prisma.propertyChangeRequest.update({ where: { id: request.id }, data: { authorId: otherId } });
    try {
      await expect(undoAssistantAction(action.id, actor)).rejects.toMatchObject({ status: 403, code: "REFUSED" });
    } finally {
      await prisma.propertyChangeRequest.update({ where: { id: request.id }, data: { authorId: ownerId } });
    }
    await prisma.agent.update({ where: { id: ownerId }, data: { permissions: { revoked: ["properties.requestChange"] } } });
    try {
      await expect(undoAssistantAction(action.id, actor)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
      expect((await requests(property.id, "OTHER"))[0].status).toBe("PENDING");
      expect(await prisma.assistantAction.findUniqueOrThrow({ where: { id: action.id } }))
        .toMatchObject({ status: "EXECUTED", undoClaimedAt: null });
      expect(await undoAudits(action.id)).toEqual([]);
      await prisma.agent.update({ where: { id: ownerId }, data: { permissions: {} } });
      await undoAssistantAction(action.id, actor);
      await prisma.agent.update({ where: { id: ownerId }, data: { isActive: false } });
      await expect(undoAssistantAction(action.id, actor)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    } finally {
      await prisma.agent.update({ where: { id: ownerId }, data: { permissions: {}, isActive: true } });
    }
  });

  it.each(["approve", "undo"] as const)("отмена и одобрение не перезаписывают друг друга: первым ждёт %s", async (first) => {
    const { property, actor, action, request } = await pendingStatusUndo();
    let ready!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const blocker = withPropertyLock(property.id, async () => {
      ready();
      await released;
    });
    const approve = () => approvePropertyChangeRequest({ requestId: request.id, actorId: directorId, note: null });
    const undo = () => undoAssistantAction(action.id, actor).catch((err: unknown) => err);
    const waitForWaiters = (count: number) => vi.waitFor(async () => {
      const [waiting] = await prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
          AND objid::bigint = (hashtext(${property.id})::bigint & 4294967295)
          AND classid::bigint = ((hashtext(${property.id})::bigint >> 32) & 4294967295)
      `;
      expect(waiting.count).toBe(count);
    });
    await locked;
    const firstResult = first === "approve" ? approve() : undo();
    try {
      await waitForWaiters(1);
      const secondResult = first === "approve" ? undo() : approve();
      await waitForWaiters(2);
      release();
      if (first === "approve") {
        expect(await firstResult).toMatchObject({ ok: true });
        expect(await secondResult).toMatchObject({ status: 409, code: "UNDO_STALE" });
        expect((await requests(property.id, "OTHER"))[0].status).toBe("APPROVED");
        expect(await undoAudits(action.id)).toEqual([]);
      } else {
        expect(await firstResult).toMatchObject({ action: { status: "UNDONE" }, replay: false });
        expect(await secondResult).toMatchObject({ ok: false, status: 409 });
        expect((await requests(property.id, "OTHER"))[0].status).toBe("CANCELLED");
      }
    } finally {
      release();
      await blocker;
    }
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
    // Цена теперь применяется сразу и меняет снимок объекта, поэтому заявку «Другое» подтверждаем первой.
    await confirmAssistantAction(note.id, actor);
    await confirmAssistantAction(price.id, actor);
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
    // Сухая проверка (dryRun) отрабатывает, но запись не вызывается. Пустой список
    // вызовов `.every` тоже дал бы true — поэтому сначала: сухая проверка БЫЛА.
    expect(sendBackToMontajer.mock.calls.length).toBeGreaterThan(0);
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

describe("П8: свои объекты — удаление в Корзину и замок REST", () => {
  it("delete_property: свой объект — в Корзину после подтверждения, повтор не удаляет дважды; чужой — 403; насовсем из чата нельзя", async () => {
    const mine = await seed();
    const actor = actorFor(ownerId, AGENT_PERMS);
    const pending = await preview(ownerId, AGENT_PERMS, "delete_property", { ref: String(mine.shortId) });
    expect(pending.preview.risk).toMatch(/Корзин/);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: mine.id } })).deletedAt).toBeNull();
    await confirmAssistantAction(pending.id, actor);
    const again = await confirmAssistantAction(pending.id, actor);
    expect(again.replay).toBe(true);
    const row = await prisma.property.findUniqueOrThrow({ where: { id: mine.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(await prisma.property.count({ where: { id: mine.id } })).toBe(1);

    const foreign = await seed({ assignedAgentId: directorId, intakeAgentId: directorId, createdById: directorId });
    await expectRefused(ownerId, AGENT_PERMS, "delete_property", { ref: String(foreign.shortId) }, 403, /Нет доступа/);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: foreign.id } })).deletedAt).toBeNull();
  });

  it("создатель, передавший объект коллеге, чужое объявление не удаляет; резерв — цена заявкой, а не сразу", async () => {
    const handed = await seed({ assignedAgentId: directorId, intakeAgentId: directorId, createdById: ownerId });
    await expectRefused(ownerId, AGENT_PERMS, "delete_property", { ref: String(handed.shortId) }, 403, /Нет доступа/);

    const reserved = await seed({ status: "RESERVED" });
    const pending = await preview(ownerId, AGENT_PERMS, "change_property_price", { ref: String(reserved.shortId), newPrice: 350000 });
    expect(pending.preview.risk).toMatch(/заявк/i);
    await confirmAssistantAction(pending.id, actorFor(ownerId, AGENT_PERMS));
    expect((await prisma.property.findUniqueOrThrow({ where: { id: reserved.id } })).price.toString()).toBe("400000");
  });
});
