import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_PROPERTY_PHOTOS, type PermissionId } from "@royal-home/shared";

/**
 * «МОНТАЖ ГОТОВ» ЧЕРЕЗ ШАБНАМ (17.11.2026, живой случай ОБ-000193): объект на этапе «Монтаж» без
 * ссылки на ролик в Instagram не выходил в продажу, а помощница не знала причины и предлагала
 * заявку «сменить статус». Здесь: инструмент complete_property_editing — тонкая обёртка над той же
 * функцией, что кнопка «Готово» (lib/propertyCompleteEditing.ts); get_property_work_status называет
 * причину; change_property_status направляет на новый инструмент вместо заявки «Другое».
 *
 * Идёт через настоящий брокер подтверждений и настоящую функцию «Готово». Подменена только
 * отправка на сайт (`syncPropertiesToSite`, сеть): по умолчанию «сайт принял», в одном тесте — отказал.
 */

const { syncPropertiesToSite } = vi.hoisted(() => ({
  syncPropertiesToSite: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, results: [{ externalId: "x", ok: true }] })),
}));

vi.mock("../src/lib/siteSync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/siteSync.js")>()),
  syncPropertiesToSite,
}));

const { prisma } = await import("../src/db.js");
await import("../src/ai/assistant/tools/index.js");
const { createPendingAssistantAction, confirmAssistantAction, AssistantActionError, getAssistantActionExecutor } = await import(
  "../src/lib/assistantActions.js"
);
const { completeEditing, saleBlockerAdvice } = await import("../src/lib/propertyCompleteEditing.js");
const { blockersForSale } = await import("../src/lib/propertyPipeline.js");
const { findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { runAssistantToolPlugin } = await import("../src/ai/assistant/tools/run.js");
const { getPropertyWorkStatusTool } = await import("../src/ai/assistant/tools/getPropertyWorkStatus.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");
const { groupHiddenToolsForTests } = await import("../src/telegram/assistantBot.js");
const { actorFor, cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { waitFor, waitForSettled } = await import("./helpers/waitFor.js");

const TOOL = "complete_property_editing";
const runId = Date.now();
let districtId = "";
let ownerId = "";
let otherId = "";
let directorId = "";
let shareholderId = "";
const propertyIds: string[] = [];

const AGENT_PERMS: PermissionId[] = ["properties.requestChange"];
const DIRECTOR_PERMS: PermissionId[] = ["properties.requestChange", "properties.editForeign", "properties.delete", "properties.moderate", "marketing.access"];

const REEL = "https://www.instagram.com/reel/AbCdEf123/";

async function seed(overrides: Record<string, unknown> = {}, photos = MIN_PROPERTY_PHOTOS) {
  const property = await prisma.property.create({
    data: {
      title: `Монтаж-готов ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 50,
      floor: 3,
      totalFloors: 9,
      price: 400000,
      currency: "TJS",
      districtId,
      address: `Монтажная ${runId}-${propertyIds.length}`,
      condition: "GOOD",
      status: "EDITING",
      createdById: ownerId,
      assignedAgentId: ownerId,
      intakeAgentId: ownerId,
      instagramUrl: REEL,
      ...overrides,
    } as never,
  });
  propertyIds.push(property.id);
  if (photos > 0) {
    await prisma.propertyPhoto.createMany({
      data: Array.from({ length: photos }, (_, i) => ({
        propertyId: property.id,
        url: `/uploads/ce${i}.webp`,
        thumbUrl: `/uploads/thumbs/ce${i}.webp`,
        order: i,
      })),
    });
  }
  return property;
}

const preview = (agentId: string, perms: PermissionId[], tool: string, args: Record<string, unknown>) =>
  createPendingAssistantAction(actorFor(agentId, perms), tool, args);

async function refusalOf(agentId: string, perms: PermissionId[], args: Record<string, unknown>, tool = TOOL) {
  const error = await preview(agentId, perms, tool, args).then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(AssistantActionError);
  return error as InstanceType<typeof AssistantActionError>;
}

const statusOf = async (id: string) => (await prisma.property.findUniqueOrThrow({ where: { id } })).status;
const pendingCards = (agentId: string) => prisma.assistantAction.count({ where: { agentId, tool: TOOL } });
const doneAudits = (propertyId: string) => prisma.auditLog.count({ where: { entityId: propertyId, action: "PROPERTY_EDITING_DONE" } });

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Монтаж-готов-район ${runId}` } })).id;
  ownerId = await createTestAgent(`Агент монтаж-готов ${runId}`);
  otherId = await createTestAgent(`Чужой монтаж-готов ${runId}`);
  directorId = await createTestAgent(`Директор монтаж-готов ${runId}`, "DIRECTOR");
  shareholderId = (
    await prisma.agent.create({
      data: { fullName: `Акционер монтаж-готов ${runId}`, phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, role: "SHAREHOLDER", passwordHash: "x" },
    })
  ).id;
});

beforeEach(() => {
  syncPropertiesToSite.mockClear();
});

afterAll(async () => {
  await prisma.propertyChangeRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: propertyIds.map((id) => `publish-failed-${id}`) } } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  const agents = [ownerId, otherId, directorId, shareholderId];
  await cleanupAssistantActionAgents(agents);
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("complete_property_editing: не готов — карточки нет, причина словами", () => {
  it("нет ссылки на ролик в Instagram: отказ с причиной и шагом, статус не тронут, карточка не создана", async () => {
    const property = await seed({ instagramUrl: null });
    const error = await refusalOf(ownerId, AGENT_PERMS, { ref: String(property.shortId) });
    expect(error.status).toBe(409);
    expect(error.code).toBe("NOT_READY_FOR_SALE");
    expect(error.message).toMatch(/нет ссылки на видео-обзор в Instagram/);
    expect(error.message).toMatch(/ролик не опубликован в Instagram/);
    expect(error.message).toMatch(/Что сделать:.*ссылку/);
    expect(await statusOf(property.id)).toBe("EDITING");
    expect(await pendingCards(ownerId)).toBe(0);
    expect(syncPropertiesToSite).not.toHaveBeenCalled();
  });

  it("мало фото и чужая ссылка называются обе", async () => {
    const property = await seed({ instagramUrl: "https://example.com/video" }, 2);
    const error = await refusalOf(ownerId, AGENT_PERMS, { ref: String(property.shortId) });
    expect(error.code).toBe("NOT_READY_FOR_SALE");
    expect(error.message).toMatch(new RegExp(`фото меньше минимума \\(2 из ${MIN_PROPERTY_PHOTOS}\\)`));
    expect(error.message).toMatch(/ссылка не на Instagram/);
  });

  it("через плагин модель получает { error, code } без карточки подтверждения", async () => {
    const property = await seed({ instagramUrl: null });
    const plugin = findAssistantToolPlugin(TOOL)!;
    expect(plugin).toBeDefined();
    const onConfirm = vi.fn();
    const actor = actorFromAccess(ownerId, { role: "AGENT", permissions: new Set(AGENT_PERMS) }, "crm-private");
    const result = (await runAssistantToolPlugin(plugin, { ref: String(property.shortId) }, actor, { channel: "crm", onConfirm })) as {
      error?: string;
      code?: string;
    };
    expect(result.code).toBe("NOT_READY_FOR_SALE");
    expect(result.error).toMatch(/нет ссылки на видео-обзор в Instagram/);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("не на монтаже: в продаже — «уже в продаже»; до монтажа — «этапы ведёт маркетинг»", async () => {
    const selling = await seed({ status: "AVAILABLE" });
    expect((await refusalOf(ownerId, AGENT_PERMS, { ref: String(selling.shortId) })).message).toMatch(/уже в продаже/);
    const early = await seed({ status: "AWAITING_VIDEO" });
    const error = await refusalOf(ownerId, AGENT_PERMS, { ref: String(early.shortId) });
    expect(error.code).toBe("NOT_EDITING");
    expect(error.message).toMatch(/до монтажа ещё не дошёл/);
  });
});

describe("complete_property_editing: права", () => {
  it("чужой объект рядовому агенту — отказ, объект на монтаже", async () => {
    const property = await seed();
    const error = await refusalOf(otherId, AGENT_PERMS, { ref: String(property.shortId) });
    expect(error.status).toBe(403);
    expect(await statusOf(property.id)).toBe("EDITING");
    expect(await pendingCards(otherId)).toBe(0);
  });

  it("роль «только просмотр» не пишет, даже если объект её", async () => {
    const property = await seed({ createdById: shareholderId, assignedAgentId: shareholderId, intakeAgentId: shareholderId });
    expect((await refusalOf(shareholderId, AGENT_PERMS, { ref: String(property.shortId) })).status).toBe(403);
  });

  it("руководитель с правкой чужих выводит чужой объект", async () => {
    const property = await seed();
    const action = await preview(directorId, DIRECTOR_PERMS, TOOL, { ref: String(property.shortId) });
    expect(action.status).toBe("PENDING");
    await confirmAssistantAction(action.id, actorFor(directorId, DIRECTOR_PERMS));
    expect(await statusOf(property.id)).toBe("AVAILABLE");
  });

  it("только личка: скрыт в общей группе, у брокера privateTelegram", () => {
    expect(groupHiddenToolsForTests().has(TOOL)).toBe(true);
    expect(getAssistantActionExecutor(TOOL)?.privateTelegram).toBe(true);
  });
});

describe("complete_property_editing: подтверждение", () => {
  it("превью ничего не пишет; «Подтвердить» — AVAILABLE, сайт, журнал от имени нажавшего", async () => {
    const property = await seed();
    const action = await preview(ownerId, AGENT_PERMS, TOOL, { ref: String(property.shortId) });
    expect(action.preview.title).toMatch(/из монтажа в продажу/);
    expect(action.preview.was).toMatchObject({ Фото: MIN_PROPERTY_PHOTOS, "Ссылка на видео-обзор": "есть" });
    expect(await statusOf(property.id)).toBe("EDITING");
    expect(syncPropertiesToSite).not.toHaveBeenCalled();

    const outcome = await confirmAssistantAction(action.id, actorFor(ownerId, AGENT_PERMS));
    expect(outcome.action.result).toMatchObject({ status: "APPLIED", applied: true, from: "EDITING", to: "AVAILABLE", propertyShortId: property.shortId });
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.status).toBe("AVAILABLE");
    expect(after.publishedOnSite).toBe(true);
    expect(syncPropertiesToSite).toHaveBeenCalledTimes(1);
    expect(syncPropertiesToSite.mock.calls[0]?.[1]).toBe("publish");

    const audit = await waitFor(() =>
      prisma.auditLog.findFirst({ where: { entityId: property.id, action: "PROPERTY_EDITING_DONE" } }),
      { label: "запись PROPERTY_EDITING_DONE" },
    );
    expect(audit.agentId).toBe(ownerId);
    expect(audit.meta).toMatchObject({ source: "assistant", tool: TOOL, actionId: action.id });
  });

  it("сайт не принял: статус в CRM сменился, ответ честный — PARTIAL с причиной", async () => {
    const property = await seed();
    syncPropertiesToSite.mockResolvedValueOnce({ ok: false, error: "сайт недоступен (тест)", retryable: true });
    const action = await preview(ownerId, AGENT_PERMS, TOOL, { ref: String(property.shortId) });
    const outcome = await confirmAssistantAction(action.id, actorFor(ownerId, AGENT_PERMS));
    expect(outcome.action.result).toMatchObject({ status: "PARTIAL", applied: true });
    expect((outcome.action.result as { message: string }).message).toMatch(/сайт его пока не принял \(сайт недоступен \(тест\)\)/);
    expect(await statusOf(property.id)).toBe("AVAILABLE");
  });

  it("повторное «Подтвердить» не публикует второй раз", async () => {
    const property = await seed();
    const action = await preview(ownerId, AGENT_PERMS, TOOL, { ref: String(property.shortId) });
    const actor = actorFor(ownerId, AGENT_PERMS);
    await confirmAssistantAction(action.id, actor);
    await confirmAssistantAction(action.id, actor);
    expect(syncPropertiesToSite).toHaveBeenCalledTimes(1);
    expect(await waitForSettled(() => doneAudits(property.id))).toBe(1);
  });

  it("объект успели вывести между превью и «Подтвердить» — отказ, второй публикации нет", async () => {
    const property = await seed();
    const action = await preview(ownerId, AGENT_PERMS, TOOL, { ref: String(property.shortId) });
    await prisma.property.update({ where: { id: property.id }, data: { status: "AVAILABLE" } });
    await expect(confirmAssistantAction(action.id, actorFor(ownerId, AGENT_PERMS))).rejects.toBeInstanceOf(AssistantActionError);
    expect(syncPropertiesToSite).not.toHaveBeenCalled();
    expect(await waitForSettled(() => doneAudits(property.id))).toBe(0);
  });

  it("дверь: два одновременных «Готово» — одна публикация, второе получает «не на монтаже»", async () => {
    const property = await seed();
    const call = () =>
      completeEditing({ propertyId: property.id, actor: { agentId: ownerId, can: () => false }, audit: { agentId: ownerId } });
    const results = await Promise.all([call(), call()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const lost = results.find((r) => !r.ok);
    expect(lost).toMatchObject({ ok: false, status: 409, code: "NOT_EDITING" });
    expect(syncPropertiesToSite).toHaveBeenCalledTimes(1);
    expect(await waitForSettled(() => doneAudits(property.id))).toBe(1);
  });
});

describe("change_property_status: объект на монтаже направляется на «Готово», а не в заявку", () => {
  it("«верни в продажу» для объекта на монтаже — отказ с названием инструмента, заявка «Другое» не создана", async () => {
    const property = await seed({ instagramUrl: null });
    const error = await refusalOf(directorId, DIRECTOR_PERMS, { ref: String(property.shortId), status: "AVAILABLE" }, "change_property_status");
    expect(error.code).toBe("USE_COMPLETE_EDITING");
    expect(error.message).toMatch(/complete_property_editing/);
    expect(await prisma.propertyChangeRequest.count({ where: { propertyId: property.id } })).toBe(0);
    expect(await statusOf(property.id)).toBe("EDITING");
  });
});

describe("get_property_work_status: причина, почему объект не в продаже", () => {
  const actor = () => actorFromAccess(ownerId, { role: "AGENT", permissions: new Set(AGENT_PERMS) }, "crm-private");
  type Readiness = {
    inSale: false;
    stage: string;
    readyForSale: boolean;
    blockers: { problem: string; fix: string }[];
    video: string;
    nextStep: string;
  };
  const readinessOf = async (shortId: number) =>
    ((await getPropertyWorkStatusTool.run({ ref: String(shortId) }, { actor: actor() })) as { saleReadiness?: Readiness }).saleReadiness;

  it("живой случай 193: ролик принят 11 дней назад, ссылки нет — причина и шаг, не заявка", async () => {
    const received = new Date(Date.now() - 11 * 86_400_000);
    const property = await seed({
      instagramUrl: null,
      videoHandoffStatus: "RECEIVED",
      videoHandoffReceivedAt: received,
      videoHandoffFinalPath: "/private/final.mp4",
    });
    const readiness = await readinessOf(property.shortId);
    expect(readiness).toMatchObject({ inSale: false, stage: "Монтаж", readyForSale: false });
    expect(readiness!.video).toMatch(/готовый ролик принят \(11 дн\. назад\)/);
    expect(readiness!.blockers.map((b) => b.problem).join(" ")).toMatch(/нет ссылки на видео-обзор в Instagram/);
    expect(readiness!.nextStep).toMatch(/не предлагай/);
  });

  it("всё есть, а «Готово» не нажали — readyForSale и подсказка про complete_property_editing", async () => {
    const property = await seed();
    const readiness = await readinessOf(property.shortId);
    expect(readiness).toMatchObject({ readyForSale: true, blockers: [] });
    expect(readiness!.nextStep).toMatch(/complete_property_editing/);
  });

  it("до монтажа — этап и «ведёт маркетинг»; в продаже — поля нет", async () => {
    const early = await seed({ status: "AWAITING_PHOTOS", instagramUrl: null }, 0);
    expect((await readinessOf(early.shortId))!.nextStep).toMatch(/Этапы подготовки двигает маркетинг/);
    const selling = await seed({ status: "AVAILABLE" });
    expect(await readinessOf(selling.shortId)).toBeUndefined();
  });

  it("описание зовёт на русские и таджикские фразы про «не в продаже»", () => {
    expect(getPropertyWorkStatusTool.description).toMatch(/почему ОБ-193 не в продаже/);
    expect(getPropertyWorkStatusTool.description).toMatch(/чаро ба фурӯш набаромад/);
  });
});

describe("saleBlockerAdvice идёт в ногу с blockersForSale", () => {
  it("число причин совпадает на всех сочетаниях фото и ссылки", () => {
    const photoCounts = [0, 1, MIN_PROPERTY_PHOTOS - 1, MIN_PROPERTY_PHOTOS, MIN_PROPERTY_PHOTOS + 4];
    const links = [null, "", "   ", "https://example.com/video", "https://www.instagram.com/reel/AbC123/", "instagram.com/p/XyZ/"];
    for (const photoCount of photoCounts) {
      for (const instagramUrl of links) {
        const input = { instagramUrl, photoCount };
        expect(saleBlockerAdvice(input).length, JSON.stringify(input)).toBe(blockersForSale(input).length);
      }
    }
  });
});
