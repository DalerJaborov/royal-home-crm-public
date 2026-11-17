import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { PermissionId } from "@royal-home/shared";

/**
 * ШАБНАМ, ПАЧКА 1 ПЛАНА docs/design/shabnam-parity-plan-2026-11-07.md (07.11.2026).
 *
 * (а) Корзина по решению владельца (lib/trashAccess.ts): удалённые объекты — справка для всех
 *     агентов; вернуть объект — директор/админ или хозяин объекта, карточкой «Восстановить»
 *     (restore_property) и той же кнопкой REST (одна дверь restorePropertyFromTrash); удалённые
 *     клиенты — только хозяину карточки и руководству, в общей группе — никому.
 * (б) Ориентиры: «у Воданасоса» не отдаёт дома Навбахора / Военного городка / Гипрозема
 *     (Сино), даже если модель подставила район Сино; «91 мкр» не находит «191 мкр».
 * (в) Журнал помощницы хранит текст вопроса (с маской телефона).
 *
 * Gemini не нужен: плагины и брокер действий вызываются напрямую, геослой в базе тестов пуст —
 * «Воданасос» разбирается народным списком (ai/folkPlaces.ts), как на проде без точки.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
await import("../src/ai/assistant/tools/index.js");
const { findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { createPendingAssistantAction, confirmAssistantAction, AssistantActionError } = await import("../src/lib/assistantActions.js");
const { actorFor, cleanupAssistantActionAgents } = await import("./helpers/assistantActionFixture.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { waitFor } = await import("./helpers/waitFor.js");
const { runAuditedTool } = await import("../src/ai/assistant.js");
const { auditQuestionText } = await import("../src/lib/aiAssistantAudit.js");
const { formatPropertyCode } = await import("@royal-home/shared");

type Actor = Parameters<NonNullable<ReturnType<typeof readTool>["run"]>>[1]["actor"];
function readTool(name: string) {
  const plugin = findAssistantToolPlugin(name);
  if (!plugin || plugin.level !== "A") throw new Error(`нет инструмента ${name}`);
  return plugin;
}
const call = (name: string, args: Record<string, unknown>, actor: Actor): Promise<any> => readTool(name).run(args, { actor });

const WORD = `Крз${String(Date.now()).slice(-6)}`;
let owner = "";
let other = "";
let director = "";
const propertyIds: string[] = [];
const clientIds: string[] = [];
const districtIds: Record<string, string> = {};

function actor(id: string, role: string, perms: PermissionId[], surface?: Actor["surface"]): Actor {
  return {
    id, role, ...(surface ? { surface } : {}),
    canViewAllClients: perms.includes("clients.viewAll"), canViewPhone: false, canViewReports: false,
    canViewFinance: false, canViewAllDeals: false, canAssignClients: false, canEditForeignProperties: false,
    canModerate: false, canRequestChange: false, permissions: new Set<PermissionId>(perms),
  } as Actor;
}
const rankOf = (id: string, surface?: Actor["surface"]) => actor(id, "AGENT", [], surface);
const boss = () => actor(director, "DIRECTOR", ["archive.view", "clients.viewAll", "properties.delete"]);

async function makeProperty(data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: { title: `Объект ${WORD}`, type: "APARTMENT", areaSqm: 80, price: 90000, currency: "USD", condition: "GOOD", ...data } as never,
  });
  propertyIds.push(p.id);
  return p;
}
async function trashed(data: Record<string, unknown> = {}) {
  return makeProperty({ deletedAt: new Date(), deletedById: director, publishedOnSite: true, ...data });
}
/** Районы, которые завёл этот файл (в базе тестов их могло не быть) — их и только их убираем. */
const createdDistrictIds: string[] = [];
/** Официальный район: уже был — берём как есть (он общий с другими файлами), не было — заводим и потом убираем. */
async function district(name: string): Promise<string> {
  const created = await prisma.district.createMany({ data: [{ name }], skipDuplicates: true });
  const id = (await prisma.district.findUniqueOrThrow({ where: { name } })).id;
  if (created.count === 1) createdDistrictIds.push(id);
  return id;
}
async function tokenOf(agentId: string): Promise<string> {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password: "testpass123" });
  return res.body.accessToken as string;
}

beforeAll(async () => {
  owner = await createTestAgent(`Хозяин корзины ${WORD}`);
  other = await createTestAgent(`Чужой агент ${WORD}`);
  director = await createTestAgent(`Директор корзины ${WORD}`, "DIRECTOR");
  for (const name of ["Сино", "Исмоили Сомони", "Шохмансур"]) districtIds[name] = await district(name);
});

afterAll(async () => {
  await prisma.aiAssistantAuditLog.deleteMany({ where: { agentId: { in: [owner, other, director] } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await cleanupAssistantActionAgents([owner, other, director]);
  // Свой район мог успеть понадобиться соседнему файлу — тогда он остаётся (ошибка внешнего ключа не валит прогон).
  for (const id of createdDistrictIds) await prisma.district.delete({ where: { id } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("(а) Корзина объектов — справка для всех", () => {
  it("рядовой агент видит удалённый объект с датой и тем, кто удалил; canRestore — только у хозяина", async () => {
    const mine = await trashed({ landmark: `у ${WORD}-а`, assignedAgentId: owner });
    const foreign = await trashed({ landmark: `у ${WORD}-а`, assignedAgentId: director });
    const asOwner = await call("find_properties_by_place", { landmark: `у ${WORD}`, scope: "trash" }, rankOf(owner));
    const byCode = (res: any, shortId: number) => res.items.find((i: any) => i.code === formatPropertyCode(shortId));
    expect(byCode(asOwner, mine.shortId)).toMatchObject({ inTrash: true, canRestore: true });
    expect(byCode(asOwner, mine.shortId).deletedAt).toBeTruthy();
    expect(byCode(asOwner, mine.shortId).deletedBy).toContain("Директор корзины");
    expect(byCode(asOwner, foreign.shortId)).toMatchObject({ inTrash: true, canRestore: false });
    expect(asOwner.error).toBeUndefined();
    // По умолчанию — и живые, и Корзина: «нет» не говорится без Корзины.
    const both = await call("find_properties_by_place", { landmark: `у ${WORD}` }, rankOf(other));
    expect(both.searched.scope).toBe("both");
    expect(byCode(both, mine.shortId)).toMatchObject({ canRestore: false });
  });

  it("в общей группе Telegram удалённые объекты тоже справка, а удалённый продавец — нет", async () => {
    const seller = (await prisma.client.create({
      data: { fullName: `Продавец ${WORD}`, phone: `+9927${WORD.slice(3)}1`, source: "WEBSITE", kind: "SELLER", acceptedAt: new Date(),
        assignedAgentId: owner, deletedAt: new Date() } as never,
    })).id;
    clientIds.push(seller);
    const p = await trashed({ landmark: `возле ${WORD}-б`, assignedAgentId: owner, sellerClientId: seller });
    const viewOwners: PermissionId[] = ["properties.viewOwners"];
    const inGroup = await call("find_properties_by_place", { landmark: `возле ${WORD}-б`, scope: "trash" }, actor(owner, "AGENT", viewOwners, "telegram-group"));
    const item = inGroup.items.find((i: any) => i.code === formatPropertyCode(p.shortId));
    expect(item?.inTrash).toBe(true);
    expect(item?.seller).toBeUndefined();
    const inPrivate = await call("find_properties_by_place", { landmark: `возле ${WORD}-б`, scope: "trash" }, actor(owner, "AGENT", viewOwners, "telegram-private"));
    expect(inPrivate.items.find((i: any) => i.code === formatPropertyCode(p.shortId))?.seller?.inTrash).toBe(true);
    const foreignAgent = await call("find_properties_by_place", { landmark: `возле ${WORD}-б`, scope: "trash" }, actor(other, "AGENT", viewOwners, "telegram-private"));
    expect(foreignAgent.items.find((i: any) => i.code === formatPropertyCode(p.shortId))?.seller).toBeUndefined();
  });
});

describe("(а) restore_property — карточкой и только тем, кому можно", () => {
  async function expectRefused(agentId: string, perms: PermissionId[], args: Record<string, unknown>, status: number, text?: RegExp) {
    const error = await createPendingAssistantAction(actorFor(agentId, perms), "restore_property", args).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AssistantActionError);
    expect((error as InstanceType<typeof AssistantActionError>).status).toBe(status);
    if (text) expect((error as Error).message).toMatch(text);
  }

  it("хозяин: превью ничего не пишет; «Восстановить» возвращает объект, без сайта; повтор — тот же итог", async () => {
    const p = await trashed({ assignedAgentId: owner });
    const pending = await createPendingAssistantAction(actorFor(owner), "restore_property", { ref: formatPropertyCode(p.shortId) });
    expect(pending.preview.title).toContain("Восстановить");
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).deletedAt).not.toBeNull();
    const done = await confirmAssistantAction(pending.id, actorFor(owner));
    expect(done.replay).toBe(false);
    const row = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.deletedAt).toBeNull();
    expect(row.deletedById).toBeNull();
    expect(row.publishedOnSite).toBe(false);
    expect((await confirmAssistantAction(pending.id, actorFor(owner))).replay).toBe(true);
  });

  it("приёмщик — хозяин; директор — любой; чужой агент — 403; живой — 409; слова вместо номера — 404", async () => {
    const intake = await trashed({ assignedAgentId: director, intakeAgentId: owner });
    const pending = await createPendingAssistantAction(actorFor(owner), "restore_property", { ref: String(intake.shortId) });
    await confirmAssistantAction(pending.id, actorFor(owner));
    expect((await prisma.property.findUniqueOrThrow({ where: { id: intake.id } })).deletedAt).toBeNull();

    const foreign = await trashed({ assignedAgentId: director, intakeAgentId: director, createdById: other });
    await expectRefused(other, [], { ref: String(foreign.shortId) }, 403, /директор, администратор или агент/);
    const byBoss = await createPendingAssistantAction(actorFor(director, ["properties.delete"]), "restore_property", { ref: foreign.id });
    await confirmAssistantAction(byBoss.id, actorFor(director, ["properties.delete"]));
    expect((await prisma.property.findUniqueOrThrow({ where: { id: foreign.id } })).deletedAt).toBeNull();

    const live = await makeProperty({ assignedAgentId: owner });
    await expectRefused(owner, [], { ref: String(live.shortId) }, 409, /не в Корзине/);
    await expectRefused(owner, [], { ref: `квартира у ${WORD}` }, 404);
  });

  it("право проверяется и при нажатии: объект передали другому агенту после превью — отказ, объект остаётся в Корзине", async () => {
    const p = await trashed({ assignedAgentId: owner });
    const pending = await createPendingAssistantAction(actorFor(owner), "restore_property", { ref: String(p.shortId) });
    await prisma.property.update({ where: { id: p.id }, data: { assignedAgentId: other } });
    await expect(confirmAssistantAction(pending.id, actorFor(owner))).rejects.toBeInstanceOf(AssistantActionError);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).deletedAt).not.toBeNull();
  });

  it("REST «Восстановить» — та же дверь: хозяин 204, чужой агент 403, не из Корзины 404", async () => {
    const p = await trashed({ assignedAgentId: owner });
    const foreignToken = await tokenOf(other);
    const denied = await request(app).post(`/api/v1/properties/${p.id}/restore`).set("Authorization", `Bearer ${foreignToken}`);
    expect(denied.status).toBe(403);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).deletedAt).not.toBeNull();
    const ownerToken = await tokenOf(owner);
    const ok = await request(app).post(`/api/v1/properties/${p.id}/restore`).set("Authorization", `Bearer ${ownerToken}`);
    expect(ok.status).toBe(204);
    const again = await request(app).post(`/api/v1/properties/${p.id}/restore`).set("Authorization", `Bearer ${ownerToken}`);
    expect(again.status).toBe(404);
  });
});

describe("(а) Корзина клиентов — хозяину и руководству", () => {
  it("агент видит свою удалённую карточку и не видит чужую; директор — обе; в группе — никто", async () => {
    const mine = (await prisma.client.create({
      data: { fullName: `Мой удалённый ${WORD}`, phone: `+9927${WORD.slice(3)}2`, source: "WEBSITE", kind: "BUYER",
        acceptedAt: new Date(), assignedAgentId: owner, deletedAt: new Date() } as never,
    })).id;
    const foreign = (await prisma.client.create({
      data: { fullName: `Чужой удалённый ${WORD}`, phone: `+9927${WORD.slice(3)}3`, source: "WEBSITE", kind: "BUYER",
        acceptedAt: new Date(), assignedAgentId: other, deletedAt: new Date() } as never,
    })).id;
    clientIds.push(mine, foreign);
    const ids = (res: any) => (res.items ?? []).map((i: any) => i.id);

    const own = await call("find_clients", { q: WORD, scope: "trash" }, rankOf(owner));
    expect(ids(own)).toContain(mine);
    expect(ids(own)).not.toContain(foreign);
    expect(own.searched.trashOwnOnly).toBeTruthy();

    // Руководитель без права «Архив» (видит всех живых) — тоже только свои удалённые.
    const viewAllNoArchive = await call("find_clients", { q: WORD, scope: "trash" }, actor(other, "HEAD_OF_SALES", ["clients.viewAll"]));
    expect(ids(viewAllNoArchive)).toEqual([foreign]);

    const all = await call("find_clients", { q: WORD, scope: "trash" }, boss());
    expect(ids(all)).toEqual(expect.arrayContaining([mine, foreign]));

    const group = await call("find_clients", { q: WORD, scope: "trash" }, rankOf(owner, "telegram-group"));
    expect(group.error).toMatch(/личном чате/);
    const groupBoth = await call("find_clients", { q: WORD, scope: "both" }, actor(director, "DIRECTOR", ["clients.viewAll"], "telegram-group"));
    expect(ids(groupBoth)).not.toContain(mine);
    expect(groupBoth.searched.trashNotChecked).toBeTruthy();
  });
});

describe("(б) ориентиры: Воданасос, 91 мкр", () => {
  it("«у Воданасоса» не отдаёт Навбахор, Военный городок и Гипрозем (Сино) — даже если модель подставила Сино", async () => {
    const navbahor = await makeProperty({ type: "HOUSE", price: 2_000_000, currency: "TJS", districtId: districtIds["Сино"], address: `1-я улица Навбахор ${WORD}` });
    const voenny = await makeProperty({ type: "HOUSE", price: 2_100_000, currency: "TJS", districtId: districtIds["Сино"], address: `Военный городок ${WORD}` });
    const giprozem = await makeProperty({ type: "HOUSE", price: 2_200_000, currency: "TJS", districtId: districtIds["Сино"], address: `улица Гипрозем ${WORD}` });
    const near = await makeProperty({ type: "HOUSE", price: 2_400_000, currency: "TJS", districtId: districtIds["Исмоили Сомони"], address: `Воданасос, ${WORD}` });
    const codes = (res: any) => res.items.map((i: any) => i.code);
    const sino = [navbahor, voenny, giprozem].map((p) => formatPropertyCode(p.shortId));

    for (const args of [
      { landmark: "у Воданасоса", type: "HOUSE", maxPrice: 2_500_000, currency: "TJS", scope: "live" },
      { landmark: "в стороне Воданасоса", districtName: "Сино", type: "HOUSE", maxPrice: 2_500_000, currency: "TJS", scope: "live", limit: 20 },
    ]) {
      const res = await call("find_properties_by_place", args, boss());
      expect(res.error).toBeUndefined();
      expect(codes(res)).toContain(formatPropertyCode(near.shortId));
      for (const code of sino) expect(codes(res)).not.toContain(code);
      expect(res.searched.zoneOnly).toMatch(/Исмоили Сомони/);
      if (args.districtName) expect(res.searched.districtIgnored).toMatch(/Сино/);
    }
  });

  it("«91 мкр» находит 91-й и не находит «191 мкр» в Шохмансуре", async () => {
    const mkr91 = await makeProperty({ districtId: districtIds["Сино"], address: `91 мкр, дом ${WORD}` });
    const mkr191 = await makeProperty({ districtId: districtIds["Шохмансур"], address: `191 мкр, дом ${WORD}` });
    const res = await call("find_properties_by_place", { landmark: "около 91 мкр", scope: "live", limit: 20 }, boss());
    const codes = res.items.map((i: any) => i.code);
    expect(codes).toContain(formatPropertyCode(mkr91.shortId));
    expect(codes).not.toContain(formatPropertyCode(mkr191.shortId));
  });
});

describe("(в) журнал помощницы хранит текст вопроса", () => {
  it("вопрос пишется рядом с инструментом, телефон закрыт маской, длина ограничена", async () => {
    const question = `Найди коробку у Ашана ${WORD}, собственник +992 93 123 45 67`;
    await runAuditedTool({ name: "find_properties_by_place", args: { landmark: `у ${WORD}` } }, boss(), {
      channel: "crm", confirmUi: false, writeBudget: { left: 0 }, question,
    } as never);
    const row = await waitFor(() =>
      prisma.aiAssistantAuditLog.findFirst({ where: { agentId: director, tool: "find_properties_by_place", question: { contains: "коробку у Ашана" } } }),
    );
    expect(row?.question).toContain("коробку у Ашана");
    expect(row?.question).not.toContain("123 45 67");
    expect(auditQuestionText("x".repeat(900))?.length).toBe(500);
    expect(auditQuestionText("   ")).toBeNull();
  });
});

describe("правки ревью 07.11 (пачка 1)", () => {
  /** Вызов с вопросом человека — так плагин получает его от ядра (tools/run.ts). */
  const ask = (args: Record<string, unknown>, who: Actor, question?: string): Promise<any> =>
    readTool("find_properties_by_place").run(args, { actor: who, ...(question ? { question } : {}) });

  it("район, который додумала модель, не перебивает место; район, названный человеком, — главнее точки", async () => {
    // «Караболо» — народная точка (ai/folkPlaces.ts, FOLK_PINS), район по народному списку — Сино.
    const nearPin = await makeProperty({ districtId: districtIds["Сино"], lat: 38.5714, lng: 68.7356, address: `рядом ${WORD}-кб` });
    const inShoh = await makeProperty({ districtId: districtIds["Шохмансур"], address: `Шохмансур ${WORD}-кб`, lat: 38.546, lng: 68.836 });
    const codes = (res: any) => res.items.map((i: any) => i.code);
    const args = { landmark: "у Караболо", districtName: "Шохмансур", scope: "live", limit: 20 };

    // Модель подставила Шохмансур, человек его не называл: ищем у точки, район отброшен.
    const byModel = await ask(args, boss(), "квартиру у Караболо");
    expect(byModel.searched.districtIgnored).toMatch(/Шохмансур/);
    expect(codes(byModel)).toContain(formatPropertyCode(nearPin.shortId));
    expect(codes(byModel)).not.toContain(formatPropertyCode(inShoh.shortId));

    // Человек сам сказал «в Шохмансуре»: точку из Сино не берём, ищем в Шохмансуре.
    const byHuman = await ask(args, boss(), "квартиру у Караболо в Шохмансуре");
    expect(byHuman.searched.placeOutsideDistrict).toMatch(/Шохмансур/);
    expect(byHuman.searched.districtIgnored).toBeUndefined();
    expect(codes(byHuman)).toContain(formatPropertyCode(inShoh.shortId));
    expect(codes(byHuman)).not.toContain(formatPropertyCode(nearPin.shortId));
  });

  it("поиск «везде»: живые выше удалённых, Корзина не вытесняет их из выдачи и показывается не больше пяти", async () => {
    const mark = `${WORD}-жив`;
    for (let i = 0; i < 8; i++) await trashed({ landmark: `у ${mark}`, assignedAgentId: director });
    const live1 = await makeProperty({ landmark: `у ${mark}` });
    const live2 = await makeProperty({ landmark: `у ${mark}` });
    const res = await ask({ landmark: `у ${mark}`, scope: "both", limit: 3 }, rankOf(owner));
    const flags = res.items.map((i: any) => i.inTrash);
    expect(flags.slice(0, 2)).toEqual([false, false]);
    expect(res.items.slice(0, 2).map((i: any) => i.code).sort()).toEqual(
      [formatPropertyCode(live1.shortId), formatPropertyCode(live2.shortId)].sort(),
    );
    expect(flags.filter(Boolean).length).toBe(3);
    expect(res.searched.trashFound).toBe(8);
    const wide = await ask({ landmark: `у ${mark}`, scope: "both", limit: 20 }, rankOf(owner));
    expect(wide.items.filter((i: any) => i.inTrash).length).toBe(5);
    const onlyTrash = await ask({ landmark: `у ${mark}`, scope: "trash", limit: 20 }, rankOf(owner));
    expect(onlyTrash.items.length).toBe(8);
  });

  it("restore_property принимает code и href из ответа поиска", async () => {
    const byCode = await trashed({ assignedAgentId: owner });
    const byHref = await trashed({ assignedAgentId: owner });
    const a = await createPendingAssistantAction(actorFor(owner), "restore_property", { ref: formatPropertyCode(byCode.shortId) });
    const b = await createPendingAssistantAction(actorFor(owner), "restore_property", { ref: `/properties/${byHref.shortId}` });
    expect(a.preview.title).toContain(formatPropertyCode(byCode.shortId));
    expect(b.preview.title).toContain(formatPropertyCode(byHref.shortId));
  });
});
