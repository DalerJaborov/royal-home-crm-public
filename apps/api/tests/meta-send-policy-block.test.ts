import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * META НЕ ПРОПУСКАЕТ ОТПРАВКУ ПО ПРАВИЛАМ (18.11.2026, lib/metaSendBlock.ts).
 *
 * Живой случай 17.11: Instagram Arvan — три отказа 368 за шесть минут на одну
 * переписку, четвёртую попытку остановил щит, директору ушло «бот написал 4 раза
 * подряд»; повтор зависших готовился к 46 попыткам с новым текстом каждый раз; подкод
 * Meta съела обрезка журнала. Здесь — по одному тесту на каждое обещание правки.
 * Ни одного живого вызова Meta или модели: Graph отвечает подменённый fetch.
 */

const { processMessengerTurn, admitOutbound } = vi.hoisted(() => ({
  processMessengerTurn: vi.fn(),
  admitOutbound: vi.fn(async () => ({ allowed: true as const })),
}));
vi.mock("../src/messengers/conversation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/conversation.js")>()), processMessengerTurn,
}));
// Щит исходящих проверяется своими тестами; здесь важно одно — дошла ли до него отправка.
vi.mock("../src/lib/outboundShield.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/outboundShield.js")>()), admitOutbound,
}));
vi.mock("../src/messengers/humanPacing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/humanPacing.js")>()), sleep: vi.fn(async () => undefined),
}));

const { prisma } = await import("../src/db.js");
const { callGraph, sendMessage, GRAPH_VERSION, instagramApiUrl } = await import("../src/messengers/meta.js");
const block = await import("../src/lib/metaSendBlock.js");
const { retryStuckConversation } = await import("../src/lib/stuckConversations.js");
const { runAsActor } = await import("../src/lib/requestActor.js");
const { withAuthenticatedManualCustomerReply } = await import("../src/lib/customerManualDeliveryIntent.js");
const { resetMetaEternalCache } = await import("../src/lib/metaEternalTokens.js");

const run = randomUUID().slice(0, 8);
let arvan: CustomerMessengerFixture;
let royal: CustomerMessengerFixture;
let staffId = "";
const IG_MESSAGES = () => instagramApiUrl(`/${GRAPH_VERSION}/me/messages`);
const PEER = `arvan-peer-${run}`;

/** Как «отвечает Meta» каждому маркеру. */
const meta = new Map<string, () => Response | Promise<Response>>();
const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const href = String(url);
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace(/^Bearer /, "");
  const token = auth ?? new URL(href).searchParams.get("access_token") ?? "";
  const reply = meta.get(token);
  if (!reply) throw new Error(`unexpected Graph call ${href}`);
  return reply();
});
const callsFor = (token: string) => fetchMock.mock.calls.filter(([u, i]) => {
  const auth = (i?.headers as Record<string, string> | undefined)?.Authorization?.replace(/^Bearer /, "");
  return (auth ?? new URL(String(u)).searchParams.get("access_token")) === token;
}).length;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ok = () => json({ recipient_id: PEER, message_id: `mid.${randomUUID()}` });
const policy368 = () => json({ error: {
  message: "Исходя из предыдущего использования этой функции, мы решили временно запретить вашему аккаунту выполнять это действие.",
  type: "OAuthException", code: 368, error_subcode: 1390008, error_data: { sentry_block_data: "x".repeat(400) }, fbtrace_id: "AbCtrace368",
} }, 400);

// Каждый текст свой: учёт физической отправки не даёт повторить ровно то же сообщение тому же человеку.
const warning613 = () => json({ error: {
  message: "Warning! You are engaging in behavior that may be considered bothersome or abusive by users.",
  type: "OAuthException", code: 613, error_subcode: 2018338, fbtrace_id: "Warn613",
} }, 400);

const dm = (peer = PEER, text = `Ассалому алейкум ${randomUUID().slice(0, 6)}`) => ({ recipient: { id: peer }, message: { text } });
const originalFetch = globalThis.fetch;

async function cleanBlocks() {
  const keys = [arvan, royal].filter(Boolean).flatMap((f) => [`account:${f.id}`]);
  const rows = await prisma.metaSendBlock.findMany({ where: { accountKey: { in: keys } }, select: { id: true, accountKey: true, surface: true } });
  await prisma.auditLog.deleteMany({ where: { entityType: "MetaSendBlock", entityId: { in: rows.map((r) => r.id) } } });
  await prisma.metaSendBlock.deleteMany({ where: { accountKey: { in: keys } } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { OR: [
    { tag: { in: keys.flatMap((k) => [`meta-send-block:${k}:dm`, `meta-send-unblock:${k}:dm`, `meta-send-block:${k}:comment`, `meta-send-warning:${k}:dm`]) } },
    { tag: { startsWith: "client-waiting-" }, body: { contains: run } },
  ] } });
  await prisma.processedMessage.deleteMany({ where: { channel: { in: ["meta-send-block-handoff", "meta-send-warning-turn"] } } });
  block.resetMetaSendBlockCache();
}

/** Переписка Arvan, где клиент ждёт ответа. */
async function waitingChat(peer = PEER, at = new Date(Date.now() - 2 * 60_000)) {
  const chat = await arvan.ensureConversation(peer);
  return prisma.botConversation.update({
    where: { id: chat.id },
    data: { name: `Клиент ${run}`, lastMessageAt: at, messages: [{ role: "user", content: `Нарх чанд? ${run}`, at: at.toISOString() }] },
  });
}

async function blockRow(fixture: CustomerMessengerFixture) {
  return prisma.metaSendBlock.findUnique({ where: { accountKey_surface: { accountKey: `account:${fixture.id}`, surface: "dm" } } });
}

beforeAll(async () => {
  arvan = await createCustomerMessengerFixture("INSTAGRAM");
  royal = await createCustomerMessengerFixture("INSTAGRAM");
  await prisma.messengerAccount.update({ where: { id: arvan.id }, data: { title: `Arvan Estate ${run}` } });
  staffId = (await prisma.agent.create({ data: {
    fullName: `Сотрудник ${run}`, phone: `+99293${Date.now().toString().slice(-7)}`, role: "AGENT", passwordHash: "x", isActive: true,
  } })).id;
  resetMetaEternalCache();
});

beforeEach(async () => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockClear();
  admitOutbound.mockClear();
  processMessengerTurn.mockReset();
  meta.clear();
  meta.set(arvan.token, policy368);
  meta.set(royal.token, ok);
  await cleanBlocks();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await arvan.cleanupConversations();
  await royal.cleanupConversations();
});

afterAll(async () => {
  await cleanBlocks();
  await arvan.dispose();
  await royal.dispose();
  await prisma.agent.deleteMany({ where: { id: staffId } });
  resetMetaEternalCache();
});

describe("коды Meta — один список, сверенный с документацией", () => {
  it("368 с любым подкодом и задокументированные родственники — запрет; лимит, окно 24 ч, плохой параметр — нет", () => {
    const of = (code: number | null, subcode: number | null = null) => block.metaPolicyBlockOf({ code, subcode });
    expect(of(368)).not.toBeNull();
    expect(of(368, 1390008)).not.toBeNull();
    expect(of(10, 1893063)).not.toBeNull();
    expect(of(100, 2534029)).not.toBeNull();
    expect(of(613, 2018338)).not.toBeNull();
    // 613/2018338 — предупреждение, не запрет; остальные — запрет.
    expect(of(613, 2018338)?.warning).toBe(true);
    expect(block.META_SEND_POLICY_BLOCKS.filter((b) => b.warning).map((b) => `${b.code}/${b.subcode}`)).toEqual(["613/2018338"]);
    expect(of(4, 2207051)).not.toBeNull();
    expect(of(25, 2207050)).not.toBeNull();
    // Не запрет по правилам: лимит запросов, нет права, закрытое окно 24 ч, плохой параметр, нет кода вовсе.
    expect(of(4)).toBeNull();
    expect(of(10)).toBeNull();
    expect(of(10, 2534022)).toBeNull();
    expect(of(100)).toBeNull();
    expect(of(100, 2534014)).toBeNull();
    expect(of(null)).toBeNull();
    for (const b of block.META_SEND_POLICY_BLOCKS) expect(b.doc).toMatch(/^https:\/\/developers\.facebook\.com\//);
  });

  it("код, подкод и fbtrace разбираются полями даже из длинного тела, которое журнал обрезал бы", async () => {
    const parsed = block.parseMetaGraphError(400, await policy368().text());
    expect(parsed).toMatchObject({ code: 368, subcode: 1390008, fbtraceId: "AbCtrace368", type: "OAuthException" });
  });

  it("лесенка проб: 1 ч → 3 ч → 6 ч, дальше 6 ч", () => {
    expect([0, 1, 2, 3, 9].map((s) => block.metaSendProbeDelayMs(s) / 3_600_000)).toEqual([1, 3, 6, 6, 6]);
  });
});

describe("368 на отправке: метка аккаунта, тишина бота, один сигнал человеку, одна тревога", () => {
  it("первый отказ ставит метку с кодом и подкодом; вторая и «печатает…» в Meta не уходят; Royal Home шлёт как раньше", async () => {
    const chat = await waitingChat();
    const first = await callGraph(IG_MESSAGES(), arvan.token, dm(), "POST", undefined, arvan.transport).catch((e) => e);
    expect(first).toBeInstanceOf(block.MetaSendPolicyError);
    expect(callsFor(arvan.token)).toBe(1);

    const row = await blockRow(arvan);
    expect(row).toMatchObject({ lastCode: 368, lastSubcode: 1390008, lastFbtraceId: "AbCtrace368", liftedAt: null, failures: 1, probeStep: 0 });
    expect(row!.label).toContain(`Arvan Estate ${run}`);
    const pause = row!.nextProbeAt.getTime() - row!.since.getTime();
    expect(pause).toBe(3_600_000);
    // Журнал действий: код и подкод отдельными полями.
    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { entityType: "MetaSendBlock", entityId: row!.id, action: "meta.send_block.rejected" } }));
    expect(audit?.meta).toMatchObject({ code: 368, subcode: 1390008, fbtraceId: "AbCtrace368" });

    const second = await callGraph(IG_MESSAGES(), arvan.token, dm(PEER, "другой текст"), "POST", undefined, arvan.transport).catch((e) => e);
    expect(second).toBeInstanceOf(block.MetaSendBlockedError);
    const typing = await callGraph(IG_MESSAGES(), arvan.token, { recipient: { id: PEER }, sender_action: "typing_on" }, "POST", undefined, arvan.transport).catch((e) => e);
    expect(typing).toBeInstanceOf(block.MetaSendBlockedError);
    expect(callsFor(arvan.token)).toBe(1);

    // Другой аккаунт того же канала — как раньше.
    await expect(callGraph(IG_MESSAGES(), royal.token, dm(`royal-peer-${run}`), "POST", undefined, royal.transport)).resolves.toMatchObject({ message_id: expect.any(String) });
    expect(callsFor(royal.token)).toBe(1);
    expect(await blockRow(royal)).toBeNull();

    // Руководству — одна тревога о запрете аккаунта, а не «бот написал N раз».
    const alarms = await prisma.pendingDirectorAlert.findMany({ where: { tag: `meta-send-block:account:${arvan.id}:dm` } });
    expect(alarms).toHaveLength(1);
    expect(alarms[0].body).toContain(`Arvan Estate ${run}`);
    expect(alarms[0].body).toContain("368");
    expect(alarms[0].body).not.toMatch(/подряд/);
    // Человеку — один «клиент ждёт ответа» с настоящей причиной (агента нет — руководству).
    const waiting = await prisma.pendingDirectorAlert.findMany({ where: { tag: `client-waiting-${chat.id}` } });
    expect(waiting).toHaveLength(1);
    expect(waiting[0].body).toContain("Meta временно не пропускает ответы аккаунта");
    expect(waiting[0].body).toContain(`Arvan Estate ${run}`);
  });

  it("бот через sendMessage при метке не доходит ни до щита, ни до Meta", async () => {
    await callGraph(IG_MESSAGES(), arvan.token, dm(), "POST", undefined, arvan.transport).catch(() => undefined);
    fetchMock.mockClear();
    const err = await sendMessage("INSTAGRAM", PEER, "Салом", arvan.token, { transport: arvan.transport }).catch((e) => e);
    expect(block.isMetaSendBlockError(err)).toBe(true);
    expect(admitOutbound).not.toHaveBeenCalled();
    expect(callsFor(arvan.token)).toBe(0);
  });

  it("обычные отказы метку не ставят: окно 24 ч, плохой параметр, 5xx, обрыв сети", async () => {
    const replies: Array<() => Response | Promise<Response>> = [
      () => json({ error: { message: "This message is sent outside of allowed window.", type: "OAuthException", code: 10, error_subcode: 2534022 } }, 400),
      () => json({ error: { message: "Invalid parameter", type: "OAuthException", code: 100 } }, 400),
      () => json({ error: { message: "Service temporarily unavailable", code: 2 } }, 503),
      () => { throw new TypeError("fetch failed"); },
      () => json({ error: { message: "Application request limit reached", code: 4 } }, 400),
    ];
    // Каждому отказу — свой собеседник: после обрыва сети учёт физической отправки (верно) не даёт писать тому же.
    for (const [i, reply] of replies.entries()) {
      meta.set(royal.token, reply);
      await expect(callGraph(IG_MESSAGES(), royal.token, dm(`royal-peer-${run}-${i}`), "POST", undefined, royal.transport)).rejects.toThrow();
    }
    expect(await blockRow(royal)).toBeNull();
    // После всех отказов следующая отправка Royal Home идёт в Meta как обычно.
    meta.set(royal.token, ok);
    fetchMock.mockClear();
    await expect(callGraph(IG_MESSAGES(), royal.token, dm(`royal-peer-${run}-ok`), "POST", undefined, royal.transport)).resolves.toBeTruthy();
    expect(callsFor(royal.token)).toBe(1);
  });

  it("отказ вне списка сохраняет код и подкод полями ошибки — журналу больше нечего обрезать", async () => {
    meta.set(royal.token, () => json({ error: { message: "x".repeat(600), code: 100, error_subcode: 2534014, fbtrace_id: "T1" } }, 400));
    const err = await callGraph(IG_MESSAGES(), royal.token, dm(`royal-peer-${run}-codes`), "POST", undefined, royal.transport).catch((e) => e);
    expect(err).toBeInstanceOf(block.MetaGraphCallError);
    expect((err as InstanceType<typeof block.MetaGraphCallError>).graph).toMatchObject({ code: 100, subcode: 2534014, fbtraceId: "T1" });
    expect((err as Error).message).toMatch(/^Graph API HTTP 400: /);
  });
});

describe("проба после паузы", () => {
  async function blockedAndDue() {
    await callGraph(IG_MESSAGES(), arvan.token, dm(), "POST", undefined, arvan.transport).catch(() => undefined);
    await prisma.metaSendBlock.updateMany({ where: { accountKey: `account:${arvan.id}` }, data: { nextProbeAt: new Date(Date.now() - 1000) } });
    block.resetMetaSendBlockCache();
    fetchMock.mockClear();
  }

  it("удачная проба снимает метку, руководству «снова отправляет», дальше отправка как обычно", async () => {
    await blockedAndDue();
    meta.set(arvan.token, ok);
    await expect(callGraph(IG_MESSAGES(), arvan.token, dm(), "POST", undefined, arvan.transport)).resolves.toBeTruthy();
    const row = await blockRow(arvan);
    expect(row?.liftedAt).not.toBeNull();
    expect(await block.isAccountSendBlocked({ accountId: arvan.id, channel: "INSTAGRAM" })).toBe(false);
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `meta-send-unblock:account:${arvan.id}:dm` } })).toBe(1);
    await expect(callGraph(IG_MESSAGES(), arvan.token, dm(), "POST", undefined, arvan.transport)).resolves.toBeTruthy();
    expect(callsFor(arvan.token)).toBe(2);
  });

  it("неудачная проба продлевает паузу следующей ступенью (3 ч), вторая тревога не уходит", async () => {
    await blockedAndDue();
    const err = await callGraph(IG_MESSAGES(), arvan.token, dm(), "POST", undefined, arvan.transport).catch((e) => e);
    expect(err).toBeInstanceOf(block.MetaSendPolicyError);
    const row = await blockRow(arvan);
    expect(row).toMatchObject({ liftedAt: null, probeStep: 1, failures: 2, probeLeaseUntil: null });
    const pause = row!.nextProbeAt.getTime() - row!.lastFailureAt.getTime();
    expect(pause).toBe(3 * 3_600_000);
    expect(await prisma.pendingDirectorAlert.count({ where: { tag: `meta-send-block:account:${arvan.id}:dm` } })).toBe(1);
    expect(await block.isAccountSendBlocked({ accountId: arvan.id, channel: "INSTAGRAM" })).toBe(true);
  });

  it("пробует один: два одновременных хода — в Meta уходит одна отправка", async () => {
    await blockedAndDue();
    // Ответ Meta медленный: второй ход решает, пока проба первого ещё идёт.
    meta.set(arvan.token, () => new Promise<Response>((resolve) => setTimeout(() => resolve(ok()), 300)));
    const results = await Promise.allSettled([
      // Разные собеседники: иначе вторую отправку держит учёт физической отправки, а не замок пробы.
      callGraph(IG_MESSAGES(), arvan.token, dm(`${PEER}-a`), "POST", undefined, arvan.transport),
      callGraph(IG_MESSAGES(), arvan.token, dm(`${PEER}-b`), "POST", undefined, arvan.transport),
    ]);
    expect(callsFor(arvan.token)).toBe(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("фоновая отправка (напоминание) пробой не служит, даже когда пора", async () => {
    await blockedAndDue();
    meta.set(arvan.token, ok);
    const sent = await block.withoutMetaSendProbe(() => callGraph(IG_MESSAGES(), arvan.token, dm(), "POST", undefined, arvan.transport)).catch((e) => e);
    expect(sent).toBeInstanceOf(block.MetaSendBlockedError);
    expect(callsFor(arvan.token)).toBe(0);
    expect((await blockRow(arvan))?.liftedAt).toBeNull();
  });

  it("ручная отправка сотрудника идёт и во время паузы и сама служит пробой", async () => {
    await callGraph(IG_MESSAGES(), arvan.token, dm(), "POST", undefined, arvan.transport).catch(() => undefined);
    fetchMock.mockClear();
    meta.set(arvan.token, ok);
    await runAsActor(staffId, () => withAuthenticatedManualCustomerReply(staffId, () =>
      callGraph(IG_MESSAGES(), arvan.token, dm(PEER, "Ответ сотрудника"), "POST", undefined, arvan.transport)));
    expect(callsFor(arvan.token)).toBe(1);
    expect((await blockRow(arvan))?.liftedAt).not.toBeNull();
  });

  it("сотрудник получает понятную причину, если Meta отказала и ему", async () => {
    await callGraph(IG_MESSAGES(), arvan.token, dm(), "POST", undefined, arvan.transport).catch(() => undefined);
    const err = await runAsActor(staffId, () => withAuthenticatedManualCustomerReply(staffId, () =>
      callGraph(IG_MESSAGES(), arvan.token, dm(PEER, "Ответ сотрудника"), "POST", undefined, arvan.transport))).catch((e) => e);
    expect(block.isMetaSendBlockError(err)).toBe(true);
    const text = block.metaSendBlockStaffText(err);
    expect(text).toContain(`Arvan Estate ${run}`);
    expect(text).toContain("приложения Instagram");
    expect(text).toContain("368");
  });
});

describe("предупреждение 613/2018338 — не запрет, пока не повторилось за час", () => {
  const warningAlarms = () => prisma.pendingDirectorAlert.count({ where: { tag: `meta-send-warning:account:${arvan.id}:dm` } });
  const blockAlarms = () => prisma.pendingDirectorAlert.count({ where: { tag: `meta-send-block:account:${arvan.id}:dm` } });

  it("одно предупреждение: метки нет, другие переписки аккаунта идут, тревога-предупреждение одна, этот ход не повторяется", async () => {
    const chat = await waitingChat();
    meta.set(arvan.token, warning613);
    const err = await callGraph(IG_MESSAGES(), arvan.token, dm(), "POST", undefined, arvan.transport).catch((e) => e);
    expect(err).toBeInstanceOf(block.MetaSendWarningError);
    expect(block.isMetaSendBlockError(err)).toBe(true);
    expect(block.metaSendBlockStaffText(err)).toContain("предупредила");
    const row = await blockRow(arvan);
    expect(row).toMatchObject({ failures: 0, lastCode: 613, lastSubcode: 2018338 });
    expect(row?.liftedAt).not.toBeNull();
    expect(row?.warningAt).not.toBeNull();
    expect(await block.isAccountSendBlocked({ accountId: arvan.id, channel: "INSTAGRAM" })).toBe(false);
    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { entityType: "MetaSendBlock", entityId: row!.id, action: "meta.send_block.warned" } }));
    expect(audit?.meta).toMatchObject({ code: 613, subcode: 2018338, fbtraceId: "Warn613" });
    expect(await warningAlarms()).toBe(1);
    expect(await blockAlarms()).toBe(0);
    const waiting = await prisma.pendingDirectorAlert.findMany({ where: { tag: `client-waiting-${chat.id}` } });
    expect(waiting).toHaveLength(1);
    expect(waiting[0].body).toContain("предупредила о навязчивой отправке");

    // Другая переписка того же аккаунта — в Meta, как обычно.
    meta.set(arvan.token, ok);
    fetchMock.mockClear();
    await expect(callGraph(IG_MESSAGES(), arvan.token, dm(`${PEER}-other`), "POST", undefined, arvan.transport)).resolves.toBeTruthy();
    expect(callsFor(arvan.token)).toBe(1);

    // Повтор зависших этот ход тому же клиенту не досылает.
    fetchMock.mockClear();
    processMessengerTurn.mockResolvedValue({ reply: "Новый текст", shouldReply: true, ready: false, accepted: false });
    const stored = await prisma.botConversation.findUniqueOrThrow({ where: { id: chat.id } });
    await expect(retryStuckConversation({ id: chat.id, channel: "INSTAGRAM", subscriberId: PEER, name: stored.name, accountId: stored.accountId,
      lastText: `Нарх чанд? ${run}`, lastMid: null, lastMessageAt: stored.lastMessageAt! }, "ai_retry")).resolves.toBe("no-reply");
    expect(processMessengerTurn).not.toHaveBeenCalled();
    expect(callsFor(arvan.token)).toBe(0);
  });

  it("второе предупреждение в течение часа — метка, как у остальных кодов (пауза 1 ч)", async () => {
    meta.set(arvan.token, warning613);
    await callGraph(IG_MESSAGES(), arvan.token, dm(`${PEER}-w1`), "POST", undefined, arvan.transport).catch(() => undefined);
    const second = await callGraph(IG_MESSAGES(), arvan.token, dm(`${PEER}-w2`), "POST", undefined, arvan.transport).catch((e) => e);
    expect(second).toBeInstanceOf(block.MetaSendPolicyError);
    const row = await blockRow(arvan);
    expect(row).toMatchObject({ liftedAt: null, failures: 1, probeStep: 0, lastCode: 613, warningAt: null });
    expect(row!.nextProbeAt.getTime() - row!.since.getTime()).toBe(3_600_000);
    expect(await block.isAccountSendBlocked({ accountId: arvan.id, channel: "INSTAGRAM" })).toBe(true);
    expect(await blockAlarms()).toBe(1);
    expect(await warningAlarms()).toBe(1);
  });

  it("два предупреждения с разрывом больше часа — метки нет", async () => {
    meta.set(arvan.token, warning613);
    await callGraph(IG_MESSAGES(), arvan.token, dm(`${PEER}-g1`), "POST", undefined, arvan.transport).catch(() => undefined);
    await prisma.metaSendBlock.updateMany({ where: { accountKey: `account:${arvan.id}` },
      data: { warningAt: new Date(Date.now() - block.META_SEND_WARNING_WINDOW_MS - 60_000) } });
    const second = await callGraph(IG_MESSAGES(), arvan.token, dm(`${PEER}-g2`), "POST", undefined, arvan.transport).catch((e) => e);
    expect(second).toBeInstanceOf(block.MetaSendWarningError);
    const row = await blockRow(arvan);
    expect(row?.failures).toBe(0);
    expect(row?.liftedAt).not.toBeNull();
    expect(await block.isAccountSendBlocked({ accountId: arvan.id, channel: "INSTAGRAM" })).toBe(false);
    expect(await blockAlarms()).toBe(0);
  });
});

describe("повтор зависших при метке", () => {
  it("не зовёт модель и не отправляет; после снятия метки старую реплику не досылает, новую — отвечает", async () => {
    const chat = await waitingChat();
    await callGraph(IG_MESSAGES(), arvan.token, dm(), "POST", undefined, arvan.transport).catch(() => undefined);
    fetchMock.mockClear();
    processMessengerTurn.mockResolvedValue({ reply: "Новый текст", shouldReply: true, ready: false, accepted: false });
    const stored = await prisma.botConversation.findUniqueOrThrow({ where: { id: chat.id } });
    const row = {
      id: chat.id, channel: "INSTAGRAM", subscriberId: PEER, name: stored.name, accountId: stored.accountId,
      lastText: `Нарх чанд? ${run}`, lastMid: null, lastMessageAt: stored.lastMessageAt!,
    };
    await expect(retryStuckConversation(row, "ai_retry")).resolves.toBe("no-reply");
    expect(processMessengerTurn).not.toHaveBeenCalled();
    expect(callsFor(arvan.token)).toBe(0);

    // Метку сняли — реплика ждала во время запрета: решение за человеком, автоматика не досылает.
    await prisma.metaSendBlock.updateMany({ where: { accountKey: `account:${arvan.id}` }, data: { liftedAt: new Date() } });
    block.resetMetaSendBlockCache();
    await expect(retryStuckConversation(row, "ai_retry")).resolves.toBe("no-reply");
    expect(processMessengerTurn).not.toHaveBeenCalled();

    // Новая реплика клиента после снятия — обычный повтор.
    const later = new Date(Date.now() + 1000);
    await prisma.botConversation.update({ where: { id: chat.id }, data: { lastMessageAt: later,
      messages: [{ role: "user", content: `Нарх чанд? ${run}`, at: later.toISOString() }] } });
    meta.set(arvan.token, ok);
    await expect(retryStuckConversation({ ...row, lastMessageAt: later }, "ai_retry")).resolves.toBe("sent");
    expect(processMessengerTurn).toHaveBeenCalledTimes(1);
    expect(callsFor(arvan.token)).toBe(1);
  });
});

/**
 * СТОРОЖ ОДНОЙ ДВЕРИ: отправка в Meta (личное, комментарий, ответ) уходит только через
 * callGraph — иначе метка «Meta не пропускает» её не увидит. Файл, где есть POST и адрес
 * отправки Graph, обязан быть в списке ниже с причиной.
 */
describe("сторож: отправка в Meta только через callGraph", () => {
  const SRC = path.resolve(__dirname, "..", "src");
  const ALLOWED: Record<string, string> = {
    "messengers/meta.ts": "сама дверь: callGraph",
    "lib/metaEternalTokens.ts": "строит адрес /{page}/messages для callGraph; сам POST-ит только subscribed_apps",
  };
  const SEND_PATH = /\/(messages|comments|replies|private_replies)[`"'?]/;
  const RAW_POST = /method:\s*["'`]POST["'`]/;
  const GRAPH_HOST = /graph\.facebook\.com|graph\.instagram\.com|instagramApiUrl|GRAPH_INSTAGRAM_ORIGIN|GRAPH_VERSION/;

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === "generated" ? [] : files(full);
      return name.endsWith(".ts") ? [full] : [];
    });
  }

  it("ни один файл не шлёт POST на адрес отправки Graph мимо callGraph", () => {
    const offenders = files(SRC)
      .map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join("/"), text: readFileSync(f, "utf8") }))
      .filter(({ text }) => RAW_POST.test(text) && SEND_PATH.test(text) && GRAPH_HOST.test(text))
      .map(({ rel }) => rel)
      .filter((rel) => !ALLOWED[rel]);
    expect(offenders).toEqual([]);
  });
});
