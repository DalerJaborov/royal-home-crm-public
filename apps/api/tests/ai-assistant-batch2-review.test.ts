import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { PermissionId } from "@royal-home/shared";

/**
 * ШАБНАМ, ПАЧКА 2 — ДОРАБОТКА ПО РЕВЬЮ И РЕШЕНИЯМ ВЛАДЕЛЬЦА (07.11.2026).
 *
 *  - фильтр журнала «с — по» считает сутки по Душанбе, а не по UTC;
 *  - человек ушёл до ответа — отдельный итог aborted, не «где не справилась»;
 *  - отказ помощницы — на языке собеседника (ru/tg);
 *  - пределы рубильников в PATCH /settings: срок журнала 7–730, шагов 3–50, срок ответа 20–180 с;
 *  - «агенту не показывать телефон удаленного клиента» (владелец): хозяин видит свою удалённую
 *    карточку без контактов, руководство с «Архивом» — с телефоном;
 *  - «Рудаки 177» — точка дома из справочника домов, поиск по радиусу вокруг неё;
 *  - шагов и срок — из Настроек; повтор того же вызова не исполняется, после двух повторов —
 *    честный частичный ответ (reason «loop» в журнале хода).
 * Gemini подменён: живых вызовов нет.
 */

const callGeminiTools = vi.fn();
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  callGeminiTools,
}));
vi.mock("../src/ai/geminiSettings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: async () => ({
    keys: ["fake-gemini-key"], model: "gemini-test", fallbackModels: [], transcribeModels: [],
    imageModel: "unused", liteModel: "", explicitCaching: false,
  }),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const { findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { runAssistantDetailed, assistantErrorMessage, ASSISTANT_ERROR_MESSAGES, ASSISTANT_ERROR_MESSAGES_TG } = await import("../src/ai/assistant.js");
const { resetAssistantRuntimeCache, loadAssistantSettings } = await import("../src/ai/assistant/runtime.js");
const { resolveSearchPlace, HOUSE_SEARCH_RADIUS_M } = await import("../src/lib/searchPlace.js");
const { tryAssistantFastPath } = await import("../src/ai/assistantFastPath.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { waitFor } = await import("./helpers/waitFor.js");

type Actor = Parameters<NonNullable<ReturnType<typeof readTool>["run"]>>[1]["actor"];
function readTool(name: string) {
  const plugin = findAssistantToolPlugin(name);
  if (!plugin || plugin.level !== "A") throw new Error(`нет инструмента ${name}`);
  return plugin;
}
const call = (name: string, args: Record<string, unknown>, actor: Actor): Promise<any> => readTool(name).run(args, { actor });

const RUN = String(Date.now()).slice(-6);
const WORD = `Рвю${RUN}`;
let agent = "";
let director = "";
const clientIds: string[] = [];
const propertyIds: string[] = [];
let districtId = "";
let streetId = "";
let buildingSourceId = "";
let saved: { aiAssistantLogRetentionDays: number; aiAssistantMaxRounds: number; aiAssistantDeadlineSec: number; aiAssistantEnabled: boolean };

function actor(id: string, role: string, perms: PermissionId[], canViewPhone = false): Actor {
  return {
    id, role, canViewAllClients: perms.includes("clients.viewAll"), canViewPhone, canViewReports: false,
    canViewFinance: false, canViewAllDeals: false, canAssignClients: false, canEditForeignProperties: false,
    canModerate: false, canRequestChange: false, permissions: new Set<PermissionId>(perms),
  } as Actor;
}
const tokenOf = (id: string, role: string) => signAccessToken({ sub: id, role });

/** Юг за городом — чужие дома и объекты справочника не мешают. */
const HOUSE = { lat: 38.312, lng: 68.512 };
const M_LAT = 1 / 111_000;

beforeAll(async () => {
  agent = await createTestAgent(`Агент ревью ${WORD}`);
  director = await createTestAgent(`Директор ревью ${WORD}`, "DIRECTOR");
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = {
    aiAssistantLogRetentionDays: settings.aiAssistantLogRetentionDays,
    aiAssistantMaxRounds: settings.aiAssistantMaxRounds,
    aiAssistantDeadlineSec: settings.aiAssistantDeadlineSec,
    aiAssistantEnabled: settings.aiAssistantEnabled,
  };
  await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: true } });
  resetAssistantRuntimeCache();

  // «Рудаки 177»: улица, её синоним в справочнике и дом с этим номером.
  districtId = (await prisma.district.create({ data: { name: `Район ревью ${WORD}`, lat: HOUSE.lat, lng: HOUSE.lng } })).id;
  streetId = (await prisma.street.create({
    data: { sourceId: `test-street-${WORD}`, name: "проспект Рудаки", kind: "проспект", lat: HOUSE.lat + 0.05, lng: HOUSE.lng, districtId },
  })).id;
  await prisma.geoAlias.create({ data: { text: "Рудаки", normalized: "рудаки", targetType: "street", targetId: streetId, source: "test" } });
  buildingSourceId = `test-building-${WORD}`;
  await prisma.building.create({
    data: { sourceId: buildingSourceId, street: "проспект Рудаки", houseNumber: "177", districtId, lat: HOUSE.lat, lng: HOUSE.lng },
  });
  const near = await prisma.property.create({
    data: { title: `Рядом ${WORD}`, type: "APARTMENT", areaSqm: 70, price: 60000, currency: "USD", condition: "GOOD", lat: HOUSE.lat + 200 * M_LAT, lng: HOUSE.lng } as never,
  });
  const far = await prisma.property.create({
    data: { title: `Далеко ${WORD}`, type: "APARTMENT", areaSqm: 70, price: 60000, currency: "USD", condition: "GOOD", lat: HOUSE.lat + 4000 * M_LAT, lng: HOUSE.lng } as never,
  });
  propertyIds.push(near.id, far.id);
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  resetAssistantRuntimeCache();
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.building.deleteMany({ where: { sourceId: buildingSourceId } });
  await prisma.geoAlias.deleteMany({ where: { targetId: streetId } });
  await prisma.street.deleteMany({ where: { id: streetId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await deleteAgentsWithTraces([agent, director]);
  await prisma.$disconnect();
});

describe("журнал: сутки по Душанбе", () => {
  it("«с 07.11 по 07.11» — весь день 07.11 по Душанбе (00:30 и 23:30 местного), без 00:30 следующего", async () => {
    const base = { agentId: director, channel: "crm", outcome: "answer", route: "tools", rounds: 1, toolCalls: 0, ms: 5 };
    const at = (iso: string) => new Date(iso);
    // 07.11 00:30 Душанбе = 06.11 19:30 UTC; 07.11 23:30 = 07.11 18:30 UTC; 08.11 00:30 = 07.11 19:30 UTC.
    for (const iso of ["2026-11-06T19:30:00Z", "2026-11-07T18:30:00Z", "2026-11-07T19:30:00Z"]) {
      await prisma.aiAssistantTurnLog.create({ data: { ...base, question: `сутки ${WORD}`, createdAt: at(iso) } });
      await prisma.aiAssistantAuditLog.create({ data: { agentId: director, tool: "find_property", question: `сутки ${WORD}`, createdAt: at(iso) } });
    }
    const q = `agentId=${director}&from=2026-11-07&to=2026-11-07`;
    const turns = await request(app).get(`/api/v1/ai/assistant-turns?${q}`).set("Authorization", `Bearer ${tokenOf(director, "DIRECTOR")}`);
    expect(turns.status).toBe(200);
    const turnTimes = (turns.body.items as { createdAt: string }[]).map((i) => i.createdAt).sort();
    expect(turnTimes).toEqual(["2026-11-06T19:30:00.000Z", "2026-11-07T18:30:00.000Z"]);
    const audit = await request(app).get(`/api/v1/ai/assistant-audit?${q}`).set("Authorization", `Bearer ${tokenOf(director, "DIRECTOR")}`);
    expect(audit.status).toBe(200);
    const auditTimes = (audit.body.items as { createdAt: string }[]).map((i) => i.createdAt).sort();
    expect(auditTimes).toEqual(["2026-11-06T19:30:00.000Z", "2026-11-07T18:30:00.000Z"]);
  });
});

describe("итог aborted и язык отказа", () => {
  it("человек закрыл окно до ответа — aborted, и в «где не справилась» его нет", async () => {
    const gone = new AbortController();
    gone.abort();
    const outcome = await runAssistantDetailed([{ role: "user", content: `Ушёл ${WORD}` }], actor(agent, "AGENT", []), { signal: gone.signal });
    expect(outcome).toMatchObject({ ok: false, code: "aborted" });
    const row = await waitFor(() => prisma.aiAssistantTurnLog.findFirst({ where: { agentId: agent, question: { contains: "Ушёл" } } }));
    expect(row).toMatchObject({ outcome: "aborted", reason: "aborted" });
    const failed = await request(app)
      .get(`/api/v1/ai/assistant-turns?agentId=${agent}&outcome=failed`)
      .set("Authorization", `Bearer ${tokenOf(director, "DIRECTOR")}`);
    expect((failed.body.items as { outcome: string }[]).some((i) => i.outcome === "aborted")).toBe(false);
  });

  it("текст отказа по-таджикски для таджикского разговора, иначе по-русски; таблицы полные", () => {
    const tg = [{ role: "user", content: "Салом, лутфан барои ман хонаи дуҳуҷрагӣ ёбед" }];
    const ru = [{ role: "user", content: "Найди двушку в Сино" }];
    expect(assistantErrorMessage("deadline", tg)).toBe(ASSISTANT_ERROR_MESSAGES_TG.deadline);
    expect(assistantErrorMessage("deadline", ru)).toBe(ASSISTANT_ERROR_MESSAGES.deadline);
    expect(Object.keys(ASSISTANT_ERROR_MESSAGES_TG).sort()).toEqual(Object.keys(ASSISTANT_ERROR_MESSAGES).sort());
    for (const text of Object.values(ASSISTANT_ERROR_MESSAGES_TG)) expect(text).not.toMatch(/(?:^|\s)ту(?:\s|$)/u);
  });
});

describe("PATCH /settings: пределы рубильников помощницы", () => {
  it.each([
    ["aiAssistantLogRetentionDays", 6, 731, 30],
    ["aiAssistantMaxRounds", 2, 51, 12],
    ["aiAssistantDeadlineSec", 19, 181, 90],
  ] as const)("%s: %i и %i — 400, %i — сохраняется", async (field, low, high, good) => {
    grantElevation(director);
    const patch = (value: number) =>
      request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${tokenOf(director, "DIRECTOR")}`).send({ [field]: value });
    expect((await patch(low)).status).toBe(400);
    expect((await patch(high)).status).toBe(400);
    const ok = await patch(good);
    expect(ok.status).toBe(200);
    const row = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(row[field]).toBe(good);
  });
});

describe("удалённый клиент: телефон — только руководству (решение владельца 07.11)", () => {
  it("хозяин-агент видит свою удалённую карточку без телефона и адреса; директор с «Архивом» — с телефоном", async () => {
    const phone = `+99293${RUN}1`;
    const c = await prisma.client.create({
      data: {
        fullName: `Удалённый ${WORD}`, phone, source: "WEBSITE", kind: "SELLER", acceptedAt: new Date(),
        assignedAgentId: agent, address: `ул. Тестовая 5, тел ${phone}`, deletedAt: new Date(),
      } as never,
    });
    clientIds.push(c.id);
    const own = await call("find_clients", { q: `Удалённый ${WORD}`, scope: "trash" }, actor(agent, "AGENT", ["clients.viewPhone"], true));
    const mine = own.items.find((i: { id: string }) => i.id === c.id);
    expect(mine).toBeDefined();
    expect(mine.inTrash).toBe(true);
    expect(mine.phone).toBeNull();
    expect(mine.address).toBeNull();
    expect(JSON.stringify(mine)).not.toContain(phone.slice(-7));

    const head = await call(
      "find_clients",
      { q: `Удалённый ${WORD}`, scope: "trash" },
      actor(director, "DIRECTOR", ["archive.view", "clients.viewAll", "clients.viewPhone"], true),
    );
    const seen = head.items.find((i: { id: string }) => i.id === c.id);
    expect(seen.phone).toContain(phone.slice(-7));
  });

  it("REST не отдаёт удалённого клиента агенту: карточка — 404, Корзина — только с «Архивом»", async () => {
    const c = await prisma.client.create({
      data: { fullName: `Удалённый REST ${WORD}`, phone: `+99293${RUN}2`, source: "WEBSITE", kind: "SELLER", acceptedAt: new Date(), assignedAgentId: agent, deletedAt: new Date() } as never,
    });
    clientIds.push(c.id);
    const card = await request(app).get(`/api/v1/clients/${c.id}`).set("Authorization", `Bearer ${tokenOf(agent, "AGENT")}`);
    expect(card.status).toBe(404);
    const trash = await request(app).get("/api/v1/clients/trash").set("Authorization", `Bearer ${tokenOf(agent, "AGENT")}`);
    expect(trash.status).toBe(403);
  });
});

describe("«Рудаки 177» — точка дома, а не середина проспекта", () => {
  it("адрес «улица + номер» геокодится в дом и ищет объекты по радиусу вокруг него", async () => {
    const place = await resolveSearchPlace("у Рудаки 177");
    expect(place.place).toMatchObject({ lat: HOUSE.lat, lng: HOUSE.lng, radiusM: HOUSE_SEARCH_RADIUS_M });
    const res = await call("find_properties_by_place", { landmark: "Рудаки 177", scope: "live" }, actor(agent, "AGENT", []));
    expect(res.searched.placeResolved).toBe(true);
    const titles = JSON.stringify((res.items as { title: unknown }[]).map((i) => i.title));
    expect(titles, JSON.stringify(res.searched)).toContain(`Рядом ${WORD}`);
    expect(titles).not.toContain(`Далеко ${WORD}`);
  });

  it("улица без номера — прежний путь (точка улицы), номер не выдумывается", async () => {
    const place = await resolveSearchPlace("Рудаки 999999");
    expect(place.place?.radiusM).not.toBe(HOUSE_SEARCH_RADIUS_M);
  });
});

describe("шаги и срок из Настроек, защита от кругов", () => {
  it("шагов — из Settings.aiAssistantMaxRounds; срок — из aiAssistantDeadlineSec", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantMaxRounds: 4, aiAssistantDeadlineSec: 45 } });
    resetAssistantRuntimeCache();
    expect(await loadAssistantSettings()).toMatchObject({ maxRounds: 4, deadlineMs: 45_000 });
    callGeminiTools.mockReset();
    let n = 0;
    callGeminiTools.mockImplementation(async () => {
      n += 1;
      const args = { ref: `ОБ-99${RUN}${n}` };
      return { text: "", calls: [{ name: "find_property", args }], modelParts: [{ functionCall: { name: "find_property", args } }], tokens: 1 };
    });
    const outcome = await runAssistantDetailed([{ role: "user", content: `Шаги ${WORD}` }], actor(agent, "AGENT", []));
    expect(outcome.ok).toBe(true);
    expect(callGeminiTools).toHaveBeenCalledTimes(4);
    const row = await waitFor(() => prisma.aiAssistantTurnLog.findFirst({ where: { agentId: agent, question: { contains: "Шаги" } } }));
    expect(row).toMatchObject({ outcome: "partial", reason: "rounds", rounds: 4, toolCalls: 4 });
  });

  it("тот же вызов с теми же аргументами не исполняется повторно; после двух повторов — частичный ответ «loop»", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantMaxRounds: 30 } });
    resetAssistantRuntimeCache();
    callGeminiTools.mockReset();
    const args = { ref: `ОБ-98${RUN}` };
    callGeminiTools.mockImplementation(async () => ({
      text: "", calls: [{ name: "find_property", args }], modelParts: [{ functionCall: { name: "find_property", args } }], tokens: 1,
    }));
    const plugin = findAssistantToolPlugin("find_property")!;
    const spy = vi.spyOn(plugin as { run: (...a: unknown[]) => unknown }, "run");
    try {
      const outcome = await runAssistantDetailed([{ role: "user", content: `Круг ${WORD}` }], actor(agent, "AGENT", []));
      expect(outcome.ok).toBe(true);
      // Первый вызов исполнен, два повтора взяли прошлый ответ, на втором повторе ход завершён.
      expect(callGeminiTools).toHaveBeenCalledTimes(3);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    const row = await waitFor(() => prisma.aiAssistantTurnLog.findFirst({ where: { agentId: agent, question: { contains: "Круг" } } }));
    expect(row).toMatchObject({ outcome: "partial", reason: "loop", rounds: 3, toolCalls: 1 });
  });
});

describe("журнал прода 05–07.11: «мои клиенты» и ссылка на reel", () => {
  it("find_clients agentName «me» / «я» / «мои» — клиенты спрашивающего, без ошибки и без общего списка", async () => {
    const mine = await prisma.client.create({
      data: { fullName: `Мой клиент ${WORD}`, phone: `+99293${RUN}3`, source: "WEBSITE", kind: "BUYER", acceptedAt: new Date(), assignedAgentId: agent } as never,
    });
    const foreign = await prisma.client.create({
      data: { fullName: `Чужой клиент ${WORD}`, phone: `+99293${RUN}4`, source: "WEBSITE", kind: "BUYER", acceptedAt: new Date(), assignedAgentId: director } as never,
    });
    clientIds.push(mine.id, foreign.id);
    for (const self of ["me", "я", "Мои"]) {
      const res = await call("find_clients", { agentName: self, q: WORD }, actor(agent, "AGENT", []));
      expect(res.error, self).toBeUndefined();
      const ids = res.items.map((i: { id: string }) => i.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(foreign.id);
    }
    // Руководство с «видеть всех»: «мои» — всё равно только свои, а не всё агентство.
    const head = await call("find_clients", { agentName: "me", q: WORD }, actor(director, "DIRECTOR", ["clients.viewAll"]));
    const headIds = head.items.map((i: { id: string }) => i.id);
    expect(headIds).toContain(foreign.id);
    expect(headIds).not.toContain(mine.id);
  });

  it("find_property по ссылке на reel (с ником и ?igsh=) находит то же, что быстрый путь; код — точно", async () => {
    const code = `Rv${RUN}Xy`;
    const p = await prisma.property.create({
      data: { title: `Рилс ${WORD}`, type: "APARTMENT", areaSqm: 60, price: 50000, currency: "USD", condition: "GOOD", instagramUrl: `https://www.instagram.com/reel/${code}/` } as never,
    });
    const longer = await prisma.property.create({
      data: { title: `Рилс длиннее ${WORD}`, type: "APARTMENT", areaSqm: 60, price: 50000, currency: "USD", condition: "GOOD", instagramUrl: `https://www.instagram.com/reel/${code}Z/` } as never,
    });
    propertyIds.push(p.id, longer.id);
    for (const link of [
      `https://www.instagram.com/reel/${code}/?igsh=MTRrZ2Fk`,
      `instagram.com/royalhome.tj/reel/${code}`,
      `https://instagram.com/reels/${code}?utm_source=ig_web_copy_link`,
    ]) {
      const res = await call("find_property", { ref: link }, actor(agent, "AGENT", []));
      expect(res.items.map((i: { id: string }) => i.id), link).toEqual([p.id]);
    }
    const fast = await tryAssistantFastPath(`https://www.instagram.com/reel/${code}/?igsh=MTRrZ2Fk`, actor(agent, "AGENT", []) as never);
    expect(fast?.cards.map((c) => c.id)).toEqual([p.id]);
  });
});
