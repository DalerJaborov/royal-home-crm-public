import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { PermissionId } from "@royal-home/shared";

/**
 * ШАБНАМ, ПАЧКА 2 ПЛАНА docs/design/shabnam-parity-plan-2026-11-07.md (07.11.2026).
 *
 * (1) Частичный ответ («шаги кончились») — на языке собеседника: по-таджикски на «шумо»,
 *     язык берётся из того же хода (languageRouting.ts), а не из догадки.
 * (2) Журнал хода целиком (AiAssistantTurnLog): одна строка на ответ — вопрос с маской
 *     телефона, итог, число шагов, длина ответа, без текста ответа; срок хранения из настроек,
 *     чистка кроном; экран читает GET /ai/assistant-turns только с правом журналов.
 * (3) Номер удалённого объекта: «в Корзине, удалён <дата по Душанбе>, кем» вместо «не найден» —
 *     в get_property_card, find_property, быстром пути и в отказе записывающих инструментов;
 *     клиентов (продавца, контакт собственника) справка не раскрывает.
 *
 * Gemini подменён (живых вызовов нет): callGeminiTools отдаёт заранее заданные ходы.
 */

const callGeminiTools = vi.fn();
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  callGeminiTools,
}));
vi.mock("../src/ai/geminiSettings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiSettings.js")>()),
  resolveGeminiRuntime: async () => ({
    keys: ["fake-gemini-key"],
    model: "gemini-test",
    fallbackModels: [],
    transcribeModels: [],
    imageModel: "unused",
    liteModel: "",
    explicitCaching: false,
  }),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { runAssistantDetailed, MAX_TOOL_ROUNDS, OFF_TOPIC_REPLY } = await import("../src/ai/assistant.js");
const { resetAssistantRuntimeCache } = await import("../src/ai/assistant/runtime.js");
const { partialAnswerFromResults } = await import("../src/ai/assistant/partialAnswer.js");
const { tryAssistantFastPath } = await import("../src/ai/assistantFastPath.js");
const { resolvePropertyRef, parseExactPropertyRef } = await import("../src/lib/propertyRefLookup.js");
const { sweepAssistantLogs, loadAssistantLogRetentionDays } = await import("../src/lib/aiAssistantAudit.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { waitFor } = await import("./helpers/waitFor.js");
const { formatPropertyCode, ASSISTANT_LOG_RETENTION_DAYS } = await import("@royal-home/shared");

type Actor = Parameters<NonNullable<ReturnType<typeof readTool>["run"]>>[1]["actor"];
function readTool(name: string) {
  const plugin = findAssistantToolPlugin(name);
  if (!plugin || plugin.level !== "A") throw new Error(`нет инструмента ${name}`);
  return plugin;
}
const call = (name: string, args: Record<string, unknown>, actor: Actor): Promise<any> => readTool(name).run(args, { actor });

const WORD = `Пч2${String(Date.now()).slice(-6)}`;
let owner = "";
let other = "";
let director = "";
const propertyIds: string[] = [];
const clientIds: string[] = [];
let savedRetention = 90;
let savedEnabled = false;

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

let live: Awaited<ReturnType<typeof makeProperty>>;
let gone: Awaited<ReturnType<typeof makeProperty>>;
/** 25.09.2026 21:30 UTC — по Душанбе уже 26.09 (граница суток не по UTC). */
const DELETED_AT = new Date("2026-09-25T21:30:00Z");

beforeAll(async () => {
  owner = await createTestAgent(`Хозяин ${WORD}`);
  other = await createTestAgent(`Чужой ${WORD}`);
  director = await createTestAgent(`Директор ${WORD}`, "DIRECTOR");
  const seller = await prisma.client.create({
    data: { fullName: `Продавец ${WORD}`, phone: `+9929${String(Math.floor(Math.random() * 9e7)).padStart(8, "1")}`, source: "WEBSITE", kind: "SELLER", acceptedAt: new Date(), assignedAgentId: owner } as never,
  });
  clientIds.push(seller.id);
  live = await makeProperty({ assignedAgentId: owner });
  gone = await makeProperty({
    assignedAgentId: owner, sellerClientId: seller.id, ownerContact: "+992 93 111 22 33",
    deletedAt: DELETED_AT, deletedById: director, description: `коробка ${WORD}`,
  });
  const settings = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedRetention = settings.aiAssistantLogRetentionDays;
  savedEnabled = settings.aiAssistantEnabled;
  await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantEnabled: true } });
  resetAssistantRuntimeCache();
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantLogRetentionDays: savedRetention, aiAssistantEnabled: savedEnabled } });
  resetAssistantRuntimeCache();
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([owner, other, director]);
  await prisma.$disconnect();
});

const TAJIK_QUESTION = "Салом, лутфан барои ман хонаи дуҳуҷрагӣ дар Сино ёбед, рақамам +992 93 555 44 33";

describe("(1) частичный ответ на языке собеседника", () => {
  const found = () => [
    { name: "find_property", result: { items: [{ code: "ОБ-000130", title: "Ашан", price: 500000, currency: "TJS", inTrash: true }] } },
  ];

  it("по-русски — как раньше", () => {
    const text = partialAnswerFromResults(found(), "ru");
    expect(text).toContain("Собрала пока вот что");
    expect(text).toContain("ОБ-000130");
    expect(text).toMatch(/500\s000 с\./u);
    expect(text).toContain("в Корзине");
  });

  it("по-таджикски (и вперемешку) — таджикские фразы на «шумо», номер и сумма как есть", () => {
    for (const lang of ["tg", "mixed"] as const) {
      const text = partialAnswerFromResults(found(), lang);
      expect(text).toContain("Ҳоло инҳоро ёфтам");
      expect(text).toContain("Лутфан нишона ё ноҳияро аниқтар гӯед");
      expect(text).toContain("ОБ-000130");
      expect(text).toMatch(/500\s000 сомонӣ/u);
      expect(text).toContain("дар Корзина");
      expect(text).not.toMatch(/Собрала|Скажите/);
      // На «шумо»: повелительное во множественном/вежливом (-ед), без «ту» и «гӯй».
      expect(text).not.toMatch(/(?:^|\s)ту(?:\s|$)|гӯй(?:\s|[.,!]|$)/u);
    }
  });

  it("ничего не нашлось — просьба уточнить тоже на языке собеседника", () => {
    expect(partialAnswerFromResults([{ name: "x", result: { error: "no" } }], "tg")).toMatch(/^Ман 1 санҷиш кардам.*нишона ё кӯча/su);
    expect(partialAnswerFromResults([{ name: "x", result: { error: "no" } }])).toMatch(/ориентир/);
  });

  it("ход по-таджикски, шаги кончились — ответ по-таджикски, в журнале «частично»", async () => {
    resetAssistantRuntimeCache();
    callGeminiTools.mockReset();
    callGeminiTools.mockImplementation(async () => ({
      text: "",
      calls: [{ name: "find_property", args: { ref: formatPropertyCode(live.shortId) } }],
      modelParts: [{ functionCall: { name: "find_property", args: { ref: formatPropertyCode(live.shortId) } } }],
      tokens: 1,
    }));
    const outcome = await runAssistantDetailed([{ role: "user", content: TAJIK_QUESTION }], rankOf(owner));
    expect(callGeminiTools).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reply).toContain("Ҳоло инҳоро ёфтам");
    expect(outcome.reply).toContain(formatPropertyCode(live.shortId));

    const row = await waitFor(() =>
      prisma.aiAssistantTurnLog.findFirst({ where: { agentId: owner, outcome: "partial" }, orderBy: { createdAt: "desc" } }),
    );
    expect(row).toMatchObject({ outcome: "partial", reason: "rounds", route: "tools", rounds: MAX_TOOL_ROUNDS, toolCalls: MAX_TOOL_ROUNDS, channel: "crm" });
    expect(row!.replyChars).toBe(outcome.reply.length);
    // Вопрос — с маской телефона, как у строк инструментов; текста ответа в строке нет вовсе.
    expect(row!.question).toContain("Салом");
    expect(row!.question).not.toContain("555 44 33");
    expect(JSON.stringify(row)).not.toContain("Ҳоло инҳоро ёфтам");
  });
});

describe("(2) журнал хода целиком", () => {
  it("обычный ответ — answer, один шаг, без инструментов", async () => {
    resetAssistantRuntimeCache();
    callGeminiTools.mockReset();
    callGeminiTools.mockResolvedValueOnce({ text: "Готово, всё в порядке.", calls: [], modelParts: [{ text: "Готово, всё в порядке." }], tokens: 1 });
    const outcome = await runAssistantDetailed([{ role: "user", content: `Проверка ${WORD} ответ` }], rankOf(other));
    expect(outcome).toEqual({ ok: true, reply: "Готово, всё в порядке." });
    const row = await waitFor(() => prisma.aiAssistantTurnLog.findFirst({ where: { agentId: other, question: { contains: "ответ" } } }));
    expect(row).toMatchObject({ outcome: "answer", reason: null, rounds: 1, toolCalls: 0, replyChars: "Готово, всё в порядке.".length });
  });

  it("вопрос не про работу — refusal / off_topic", async () => {
    resetAssistantRuntimeCache();
    callGeminiTools.mockReset();
    callGeminiTools.mockResolvedValueOnce({ text: OFF_TOPIC_REPLY, calls: [], modelParts: [{ text: OFF_TOPIC_REPLY }], tokens: 1 });
    await runAssistantDetailed([{ role: "user", content: `Погода ${WORD} завтра` }], rankOf(other));
    const row = await waitFor(() => prisma.aiAssistantTurnLog.findFirst({ where: { agentId: other, question: { contains: "Погода" } } }));
    expect(row).toMatchObject({ outcome: "refusal", reason: "off_topic", route: "off_topic" });
  });

  it("сбой модели без находок — error с кодом, длины ответа нет", async () => {
    resetAssistantRuntimeCache();
    callGeminiTools.mockReset();
    callGeminiTools.mockResolvedValueOnce({ text: "", calls: [], modelParts: [], tokens: 1 });
    const outcome = await runAssistantDetailed([{ role: "user", content: `Пусто ${WORD} сбой` }], rankOf(other));
    expect(outcome.ok).toBe(false);
    const row = await waitFor(() => prisma.aiAssistantTurnLog.findFirst({ where: { agentId: other, question: { contains: "сбой" } } }));
    expect(row).toMatchObject({ outcome: "error", reason: "empty_reply", replyChars: null });
  });

  it("быстрый путь без модели тоже даёт строку хода (номер удалённого объекта — справка)", async () => {
    const res = await request(app)
      .post("/api/v1/ai/assistant")
      .set("Authorization", `Bearer ${signAccessToken({ sub: other, role: "AGENT" })}`)
      .send({ messages: [{ role: "user", content: formatPropertyCode(gone.shortId) }] });
    expect(res.status).toBe(200);
    expect(res.text).toContain("в Корзине");
    const row = await waitFor(() =>
      prisma.aiAssistantTurnLog.findFirst({ where: { agentId: other, route: "fast_path" }, orderBy: { createdAt: "desc" } }),
    );
    expect(row).toMatchObject({ outcome: "answer", reason: null, rounds: 0, toolCalls: 1 });
  });

  it("экран: ходы видит только право журналов; фильтр «где не справилась» убирает обычные ответы", async () => {
    const denied = await request(app)
      .get("/api/v1/ai/assistant-turns")
      .set("Authorization", `Bearer ${signAccessToken({ sub: other, role: "AGENT" })}`);
    expect(denied.status).toBe(403);

    const res = await request(app)
      .get(`/api/v1/ai/assistant-turns?agentId=${other}&outcome=failed`)
      .set("Authorization", `Bearer ${signAccessToken({ sub: director, role: "DIRECTOR" })}`);
    expect(res.status).toBe(200);
    expect(res.body.retentionDays).toBeGreaterThanOrEqual(ASSISTANT_LOG_RETENTION_DAYS.min);
    const outcomes = (res.body.items as { outcome: string }[]).map((i) => i.outcome);
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes).not.toContain("answer");
    expect(Object.keys(res.body.items[0])).not.toContain("reply");

    const bad = await request(app)
      .get("/api/v1/ai/assistant-turns?outcome=whatever")
      .set("Authorization", `Bearer ${signAccessToken({ sub: director, role: "DIRECTOR" })}`);
    expect(bad.status).toBe(400);
  });
});

describe("(2) срок хранения журнала", () => {
  it("старше срока: ход удаляется, у строки инструмента стирается только вопрос; свежее не трогается", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantLogRetentionDays: 30 } });
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const fresh = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
    const base = { agentId: director, channel: "crm", outcome: "answer", route: "tools", rounds: 1, toolCalls: 0, ms: 10 };
    const oldTurn = await prisma.aiAssistantTurnLog.create({ data: { ...base, question: `старый ${WORD}`, createdAt: old } });
    const freshTurn = await prisma.aiAssistantTurnLog.create({ data: { ...base, question: `свежий ${WORD}`, createdAt: fresh } });
    const oldTool = await prisma.aiAssistantAuditLog.create({ data: { agentId: director, tool: "find_property", question: `старый ${WORD}`, createdAt: old } });
    const freshTool = await prisma.aiAssistantAuditLog.create({ data: { agentId: director, tool: "find_property", question: `свежий ${WORD}`, createdAt: fresh } });

    const result = await sweepAssistantLogs();
    expect(result.days).toBe(30);
    expect(result.turnsDeleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.aiAssistantTurnLog.findUnique({ where: { id: oldTurn.id } })).toBeNull();
    expect(await prisma.aiAssistantTurnLog.findUnique({ where: { id: freshTurn.id } })).not.toBeNull();
    const toolOld = await prisma.aiAssistantAuditLog.findUniqueOrThrow({ where: { id: oldTool.id } });
    expect(toolOld.question).toBeNull();
    expect(toolOld.tool).toBe("find_property");
    expect((await prisma.aiAssistantAuditLog.findUniqueOrThrow({ where: { id: freshTool.id } })).question).toBe(`свежий ${WORD}`);
  });

  it("значение вне пределов в базе зажимается: меньше недели не бывает", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantLogRetentionDays: 0 } });
    expect(await loadAssistantLogRetentionDays()).toBe(ASSISTANT_LOG_RETENTION_DAYS.min);
    await prisma.settings.update({ where: { id: "singleton" }, data: { aiAssistantLogRetentionDays: 99999 } });
    expect(await loadAssistantLogRetentionDays()).toBe(ASSISTANT_LOG_RETENTION_DAYS.max);
  });

  it("чистка стоит в расписании ночью по Душанбе", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/cron.ts", import.meta.url), "utf8");
    expect(src).toMatch(/scheduleTracked\(\s*"assistant-log-retention",\s*"25 4 \* \* \*"/);
    expect(src).toMatch(/sweepAssistantLogs\(\)/);
  });
});

describe("(3) номер удалённого объекта — «в Корзине», а не «не найден»", () => {
  it("get_property_card: агенту — когда (по Душанбе) и кем, без ссылки на закрытую страницу и без клиентов", async () => {
    const res = await call("get_property_card", { propertyId: formatPropertyCode(gone.shortId) }, rankOf(other));
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({ code: formatPropertyCode(gone.shortId), inTrash: true, deletedAt: "2026-09-26", canRestore: false });
    expect(res.deletedBy).toContain("Директор");
    expect(res.note).toContain("26.09.2026");
    expect(res.note).toMatch(/Вернуть его может директор/);
    expect(res.href).toBeUndefined();
    const json = JSON.stringify(res);
    expect(json).not.toContain("Продавец");
    expect(json).not.toContain("111 22 33");
    expect(json).not.toContain("коробка");
  });

  it("хозяину — «можете вернуть»; руководству с «Архивом» — ещё и ссылка на страницу", async () => {
    const own = await call("get_property_card", { propertyId: String(gone.shortId) }, rankOf(owner));
    expect(own).toMatchObject({ inTrash: true, canRestore: true });
    expect(own.note).toContain("можете вы");
    const head = await call("get_property_card", { propertyId: gone.id }, boss());
    expect(head).toMatchObject({ inTrash: true, canRestore: true, href: `/properties/${gone.shortId}` });
  });

  it("в общей группе Telegram справка тоже есть (объекты — справка для всех), клиентов нет", async () => {
    const res = await call("get_property_card", { propertyId: formatPropertyCode(gone.shortId) }, rankOf(other, "telegram-group"));
    expect(res.inTrash).toBe(true);
    expect(JSON.stringify(res)).not.toContain("Продавец");
  });

  it("find_property: удалённый по номеру — первой строкой inTrash; по словам адреса Корзина не ищется", async () => {
    const byCode = await call("find_property", { ref: formatPropertyCode(gone.shortId) }, rankOf(other));
    expect(byCode.total).toBe(1);
    expect(byCode.note).toBeUndefined();
    expect(byCode.items[0]).toMatchObject({ inTrash: true, code: formatPropertyCode(gone.shortId) });
    const byWords = await call("find_property", { ref: `Объект ${WORD}` }, rankOf(other));
    expect(byWords.items.every((i: { inTrash?: boolean }) => !i.inTrash)).toBe(true);
    expect(byWords.items.map((i: { code: string }) => i.code)).toContain(formatPropertyCode(live.shortId));
  });

  it("живой объект с номером — обычная карточка, справки Корзины нет", async () => {
    const res = await call("get_property_card", { propertyId: formatPropertyCode(live.shortId) }, rankOf(other));
    expect(res.inTrash).toBeUndefined();
    expect(res.code ?? res.brief?.code).toBeDefined();
  });

  it("несуществующий номер — по-прежнему «не найден»", async () => {
    const res = await call("get_property_card", { propertyId: "ОБ-99999999" }, rankOf(other));
    expect(res.error).toMatch(/не найден/);
  });

  it("быстрый путь по номеру — та же справка вместо «Не нашла объект»", async () => {
    const fast = await tryAssistantFastPath(formatPropertyCode(gone.shortId), rankOf(other) as never);
    expect(fast).not.toBeNull();
    expect(fast!.cards).toEqual([]);
    expect(fast!.trashed).toBe(1);
    expect(fast!.reply).toContain("в Корзине");
    expect(fast!.reply).toContain("26.09.2026");
    expect(fast!.reply).not.toMatch(/Не нашла/);
  });

  it("записывающие инструменты (цена, статус…) на удалённый объект говорят «в Корзине», а не «не найден»", async () => {
    const res = await resolvePropertyRef(formatPropertyCode(gone.shortId));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("в Корзине");
    expect(res.message).not.toMatch(/не найден/);
  });

  it("один разбор точной ссылки: номер, голый номер, href и id; слова — не ссылка", () => {
    expect(parseExactPropertyRef("ОБ-000130")).toEqual({ shortId: 130 });
    expect(parseExactPropertyRef("130")).toEqual({ shortId: 130 });
    expect(parseExactPropertyRef("/properties/130")).toEqual({ shortId: 130 });
    expect(parseExactPropertyRef(gone.id.toUpperCase())).toEqual({ id: gone.id });
    expect(parseExactPropertyRef("квартира у Ашана")).toBeNull();
  });

  it("find_properties_by_place: у удалённого объекта ссылка только тому, кому страница откроется", async () => {
    const forAgent = await call("find_properties_by_place", { landmark: WORD, scope: "trash" }, rankOf(other));
    for (const item of forAgent.items ?? []) if (item.inTrash) expect(item.href).toBeUndefined();
  });
});
