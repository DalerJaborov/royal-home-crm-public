import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * МЁРТВЫЙ КЛЮЧ INSTAGRAM — ОДНА ДВЕРЬ (прод 24.11.2026 03:18 → 25.11). Arvan Estate после смены пароля отвечал
 * HTTP 401 / код 190 «The session has been invalidated because the user changed their password», а дверь
 * lib/instagramAccountAccess.ts метила только «войдите в Instagram и пройдите проверку». За ~28 часов: «Сообщение в
 * INSTAGRAM не отправлено» ×67, «Повтор зависшего диалога … не удался» ×100+ (одни и те же переписки раз в 30 минут),
 * «Публикация … не получена» ×20, «Профиль … не получен» ×19, «Сообщение из INSTAGRAM не обработано» ×18.
 *
 * Здесь класс целиком: любой путь, получивший 401/190, ставит отметку один раз (одна запись, одна тревога); пока она
 * стоит, отправка, профиль и повтор зависших в Meta не ходят и журнал не пишут; проба раз в полчаса снимает отметку,
 * если ключ ожил; «Заменить маркер» снимает её сразу, и зависшая переписка отвечается. Живой ключ (Royal Home) — как
 * раньше, временные отказы (не про ключ) отметку не ставят.
 */
vi.setConfig({ testTimeout: 60_000 });

const { processMessengerTurn, logSpy } = vi.hoisted(() => ({ processMessengerTurn: vi.fn(), logSpy: vi.fn() }));
vi.mock("../src/messengers/conversation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/conversation.js")>()),
  processMessengerTurn,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/systemError.js")>();
  return {
    ...real,
    logSystemError: async (...args: Parameters<typeof real.logSystemError>) => {
      logSpy(...args);
      return real.logSystemError(...args);
    },
  };
});

const { prisma } = await import("../src/db.js");
const access = await import("../src/lib/instagramAccountAccess.js");
const eternal = await import("../src/lib/metaEternalTokens.js");
const meta = await import("../src/messengers/meta.js");
const { retryStuckConversation } = await import("../src/lib/stuckConversations.js");
const { saveAccount, resetAccountsCache } = await import("../src/messengers/accounts.js");
const { privateReplyFailure } = await import("../src/messengers/comments.js");
const { MetaGraphCallError } = await import("../src/lib/metaSendBlock.js");
const { checkInstagramAccountsHealth } = await import("../src/lib/integrationHealth.js");

const run = randomUUID().slice(0, 8);
const DEAD_TEXT = "Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons.";
let dead: CustomerMessengerFixture;
let alive: CustomerMessengerFixture;
/** Ключ, которым Meta снова отвечает (после «Заменить маркер» или ожившая сессия). */
const revived = new Set<string>();
const NEW_TOKEN = `stand-ig-new-token-${run}`;

const fetchMock = vi.fn();
const carries = (url: string, init: RequestInit | undefined, token: string) =>
  (init?.headers as Record<string, string> | undefined)?.Authorization === `Bearer ${token}` || url.includes(`access_token=${encodeURIComponent(token)}`);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const callsWith = (token: string) => fetchMock.mock.calls.filter(([u, i]) => carries(String(u), i as RequestInit, token)).length;
const logged = (prefix: string) => logSpy.mock.calls.filter(([, message]) => String(message).startsWith(prefix)).length;

async function lostAt(id: string) {
  return (await prisma.messengerAccount.findUnique({ where: { id }, select: { accessLostAt: true } }))?.accessLostAt ?? null;
}
const alertsFor = (id: string) => prisma.pendingDirectorAlert.count({ where: { tag: { startsWith: `ig-account-locked:${id}:` } } });

beforeAll(async () => {
  dead = await createCustomerMessengerFixture("INSTAGRAM");
  alive = await createCustomerMessengerFixture("INSTAGRAM");
});

afterAll(async () => {
  for (const f of [dead, alive]) {
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: `ig-account-locked:${f.id}` } } });
    await prisma.errorLog.deleteMany({ where: { dedupKey: { startsWith: `ig-account-locked:${f.id}` } } });
    await prisma.errorLog.deleteMany({ where: { dedupKey: { startsWith: `ig-access-held:${f.id}` } } });
    await f.dispose();
  }
  eternal.resetMetaEternalCache();
});

beforeEach(async () => {
  await prisma.messengerAccount.updateMany({ where: { id: { in: [dead.id, alive.id] } }, data: { accessLostAt: null, accessLostReason: null } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: `ig-account-locked:${dead.id}` } } });
  resetAccountsCache();
  eternal.resetMetaEternalCache();
  access.resetInstagramAccessProbes();
  meta.resetInstagramProfileCache();
  revived.clear();
  logSpy.mockClear();
  processMessengerTurn.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    for (const t of revived) if (carries(url, init, t)) return json({ recipient_id: "r", message_id: `mid-${randomUUID()}`, username: "ok" });
    if (carries(url, init, dead.token)) return json({ error: { message: DEAD_TEXT, type: "OAuthException", code: 190, error_subcode: 460 } }, 401);
    if (carries(url, init, alive.token)) return json({ recipient_id: "r", message_id: `mid-${randomUUID()}`, username: "royal" });
    return json({ data: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const staffSend = (token: string, peer = `peer-${run}`) =>
  meta.sendMessage("INSTAGRAM", peer, "Тест двери", token, { origin: "staff" });

describe("отправка: 401/190 «сессия сброшена» — отметка один раз, дальше в Meta не ходим", () => {
  it("первый отказ ставит отметку и одну тревогу; следующие отправки — без запроса и без строки журнала", async () => {
    await expect(staffSend(dead.token)).rejects.toThrow(/401/);
    await waitFor(() => lostAt(dead.id), { label: "отметка «доступ потерян»" });
    // Тревога ставится за записью журнала (в отрыве от отправки) — ждём её появления, а не «осело».
    await waitFor(async () => (await alertsFor(dead.id)) >= 1, { label: "тревога руководству", timeoutMs: 5000 });
    expect(await waitForSettled(() => alertsFor(dead.id))).toBe(1);
    const firstLines = logged("Сообщение в INSTAGRAM не отправлено");
    expect(firstLines).toBe(1);

    const before = callsWith(dead.token);
    for (let i = 0; i < 3; i++) {
      const err = await staffSend(dead.token).catch((e: unknown) => e);
      expect(access.isInstagramAccessLostError(err)).toBe(true);
    }
    expect(callsWith(dead.token)).toBe(before);
    expect(logged("Сообщение в INSTAGRAM не отправлено")).toBe(firstLines);
    expect(await waitForSettled(() => alertsFor(dead.id))).toBe(1);
    // Отказ без запроса — «не ушло точно»: счёт щита «бот написал N подряд» его не берёт.
    expect(meta.isDefinitiveSendRejection(new access.InstagramAccessLostError(dead.id, null))).toBe(true);
  });

  it("проба раз в полчаса: ключ всё ещё мёртв — отметка стоит, строки нет; ожил — отметка снимается", async () => {
    await access.noteInstagramAccountLocked(dead.id, `HTTP 401: ${DEAD_TEXT}`);
    expect(await lostAt(dead.id)).not.toBeNull();

    access.resetInstagramAccessProbes(); // прошло PROBE_EVERY_MS
    const before = callsWith(dead.token);
    const err = await staffSend(dead.token).catch((e: unknown) => e);
    expect(callsWith(dead.token)).toBe(before + 1);
    expect(access.isInstagramAccessLostError(err)).toBe(true);
    expect(logged("Сообщение в INSTAGRAM не отправлено")).toBe(0);
    expect(await lostAt(dead.id)).not.toBeNull();

    revived.add(dead.token);
    access.resetInstagramAccessProbes();
    await expect(staffSend(dead.token)).resolves.toMatch(/^mid-/);
    expect(await lostAt(dead.id)).toBeNull();
  });

  it("живой ключ (как у Royal Home) — без изменений; отказ «про клиента» отметку не ставит", async () => {
    await expect(staffSend(alive.token)).resolves.toMatch(/^mid-/);
    fetchMock.mockImplementation(async () => json({ error: { message: "No matching user found", code: 100, error_subcode: 2018001 } }, 400));
    await expect(staffSend(alive.token)).rejects.toThrow(/400/);
    await new Promise((r) => setTimeout(r, 200));
    expect(await lostAt(alive.id)).toBeNull();
    expect(access.isInstagramKeyRefusal(500, "Internal error")).toBe(false);
    expect(access.isInstagramKeyRefusal(429, JSON.stringify({ error: { code: 4, message: "Application request limit reached" } }))).toBe(false);
    expect(access.isInstagramKeyRefusal(401, DEAD_TEXT)).toBe(true);
  });
});

describe("профиль собеседника: отказ ключа — через дверь, без строки на каждого", () => {
  it("мёртвый ключ: отметка, без «Профиль Instagram … не получен»; дальше в Meta не ходим", async () => {
    expect(await meta.fetchInstagramProfile(`p1-${run}`, dead.token)).toEqual({});
    await waitFor(() => lostAt(dead.id), { label: "отметка от профиля" });
    expect(logged("Профиль Instagram")).toBe(0);
    const before = callsWith(dead.token);
    expect(await meta.fetchInstagramProfile(`p2-${run}`, dead.token)).toEqual({});
    expect(callsWith(dead.token)).toBe(before);
  });
});

describe("повтор зависшего диалога: пока отметка стоит — ни ИИ, ни Meta; после «Заменить маркер» — отвечает", () => {
  it("channel-paused без хода ИИ и запроса; новый ключ снимает отметку и остановки, повтор уходит", async () => {
    const peer = `stuck-${run}`;
    const native = await dead.ensureConversation(peer);
    const at = new Date(Date.now() - 6 * 60_000);
    await prisma.botConversation.update({ where: { id: native.id }, data: {
      messages: [{ role: "user", content: "Нарх чанд?", at: at.toISOString() }] as never, lastMessageAt: at } });
    const row = { id: native.id, channel: "INSTAGRAM", subscriberId: peer, name: null, accountId: dead.id,
      lastText: "Нарх чанд?", lastMessageAt: at, lastMid: null };

    await access.noteInstagramAccountLocked(dead.id, `HTTP 401: ${DEAD_TEXT}`);
    const before = fetchMock.mock.calls.length;
    for (let i = 0; i < 3; i++) expect(await retryStuckConversation(row, "ai_retry")).toBe("channel-paused");
    expect(processMessengerTurn).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(logged("Повтор зависшего диалога")).toBe(0);
    // Одна строка «ждёт» на аккаунт в сутки, а не на каждый повтор.
    expect(await waitForSettled(() => prisma.errorLog.count({ where: { dedupKey: { startsWith: `ig-access-held:${dead.id}:` } } }))).toBe(1);

    // Остановка «ключ мёртв» от первых отказов (до отметки) — «Заменить маркер» её снимает.
    await prisma.processedMessage.create({ data: { channel: "ai-retry-no-reply", messageId: `${native.id}:m:stop-key:abc`, completedAt: new Date() } });
    revived.add(NEW_TOKEN);
    await saveAccount({ id: dead.id, channel: "INSTAGRAM", externalId: dead.externalId, title: `Fixture ${dead.id}`, token: NEW_TOKEN });
    expect(await lostAt(dead.id)).toBeNull();
    expect(await prisma.processedMessage.count({ where: { channel: "ai-retry-no-reply", messageId: { startsWith: `${native.id}:` } } })).toBe(0);

    processMessengerTurn.mockResolvedValue({ shouldReply: true, reply: "Салом! Нарх 500 000." });
    expect(await retryStuckConversation(row, "ai_retry")).toBe("sent");
    expect(processMessengerTurn).toHaveBeenCalledOnce();
    expect(callsWith(NEW_TOKEN)).toBeGreaterThan(0);

    // Вернуть фикстуре её ключ — dispose и соседние тесты ждут исходный.
    const { encryptSecret } = await import("../src/crypto.js");
    await prisma.messengerAccount.update({ where: { id: dead.id }, data: { token: encryptSecret(dead.token) } });
    resetAccountsCache();
  });
});

describe("суточная проверка ключей: смена пароля — та же дверь", () => {
  it("401/190 — отметка и понятная строка, без «Ключ не работает» второй тревогой", async () => {
    const [check] = await checkInstagramAccountsHealth([dead.id]);
    expect(check.ok).toBeNull();
    expect(check.detail).toMatch(/не принимает ключ/);
    expect(await lostAt(dead.id)).not.toBeNull();
    expect(logged("Ключ не работает")).toBe(0);
  });
});

describe("ревью #432: ворота — только вызов Instagram, не ключ", () => {
  const SHARED = `stand-shared-page-token-${run}`;
  let igShared = "";
  let fbShared = "";
  const fbUrl = () => `https://graph.facebook.com/${meta.GRAPH_VERSION}/page-${run}/messages`;
  const igUrl = () => meta.instagramApiUrl(`/${meta.GRAPH_VERSION}/me/messages`);
  const dm = { recipient: { id: `peer-shared-${run}` }, message: { text: "Тест общего ключа" } };

  beforeAll(async () => {
    const { encryptSecret } = await import("../src/crypto.js");
    // Instagram, подключённый через Страницу, и Facebook этой Страницы — один ключ (lib/metaPageConnect.ts).
    igShared = (await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: `ig-shared-${run}`, title: `IG общий ${run}`, token: encryptSecret(SHARED) } })).id;
    fbShared = (await prisma.messengerAccount.create({ data: { channel: "FACEBOOK", externalId: `page-${run}`, title: `FB общий ${run}`, token: encryptSecret(SHARED) } })).id;
  });
  afterAll(async () => {
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { startsWith: `ig-account-locked:${igShared}` } } });
    await prisma.errorLog.deleteMany({ where: { dedupKey: { startsWith: `ig-account-locked:${igShared}` } } });
    await prisma.messengerAccount.deleteMany({ where: { id: { in: [igShared, fbShared] } } });
    resetAccountsCache();
  });
  beforeEach(async () => {
    await prisma.messengerAccount.updateMany({ where: { id: igShared }, data: { accessLostAt: null, accessLostReason: null } });
  });

  it("отметка Instagram не глушит Messenger с тем же ключом, а успех Messenger её не снимает", async () => {
    await access.noteInstagramAccountLocked(igShared, `HTTP 401: ${DEAD_TEXT}`);
    expect(await lostAt(igShared)).not.toBeNull();
    const before = callsWith(SHARED);
    fetchMock.mockImplementation(async () => json({ recipient_id: "r", message_id: `mid-${randomUUID()}` }));
    await expect(meta.callGraph(fbUrl(), SHARED, dm)).resolves.toBeTruthy();
    expect(callsWith(SHARED)).toBe(before + 1);
    expect(await lostAt(igShared)).not.toBeNull();
    // Сам Instagram этим ключом закрыт (проба только что взята отметкой).
    const err = await meta.callGraph(igUrl(), SHARED, dm).catch((e: unknown) => e);
    expect(access.isInstagramAccessLostError(err)).toBe(true);
    expect(callsWith(SHARED)).toBe(before + 1);
  });

  it("401/190 на вызове Facebook с общим ключом не метит Instagram", async () => {
    fetchMock.mockImplementation(async () => json({ error: { message: DEAD_TEXT, type: "OAuthException", code: 190 } }, 401));
    await expect(meta.callGraph(fbUrl(), SHARED, dm)).rejects.toThrow(/401/);
    await new Promise((r) => setTimeout(r, 400));
    expect(await lostAt(igShared)).toBeNull();
  });

  it("голый 401 без слов про ключ/сессию (например, прокси) не метит аккаунт", async () => {
    expect(access.isInstagramKeyRefusal(401, "Unauthorized")).toBe(false);
    expect(access.isInstagramKeyRefusal(401, JSON.stringify({ error: { message: "Unauthorized", code: 1 } }))).toBe(false);
    expect(access.isInstagramKeyRefusal(401, JSON.stringify({ error: { message: "x", code: 190 } }))).toBe(true);
    fetchMock.mockImplementation(async () => new Response("Unauthorized", { status: 401 }));
    await expect(meta.callGraph(igUrl(), alive.token, dm)).rejects.toThrow(/401/);
    await new Promise((r) => setTimeout(r, 400));
    expect(await lostAt(alive.id)).toBeNull();
  });

  it("успешная отправка через ядро (durable) этим ключом снимает отметку", async () => {
    const { withCustomerDeliveryTransport } = await import("../src/lib/customerDeliveryTransport.js");
    await access.noteInstagramAccountLocked(dead.id, `HTTP 401: ${DEAD_TEXT}`);
    expect(await lostAt(dead.id)).not.toBeNull();
    revived.add(dead.token);
    const hooks = { beforePost: async () => {}, accepted: async () => {}, rejected: async () => {}, networkFailure: async () => {} };
    await expect(withCustomerDeliveryTransport(hooks, () => meta.callGraph(igUrl(), dead.token, dm))).resolves.toBeTruthy();
    expect(await lostAt(dead.id)).toBeNull();
  });

  it("карточка объекта, не ушедшая из-за потери доступа, — «не ушло», а не «неизвестно»", async () => {
    const { isProviderDefinitiveRejection } = await import("../src/lib/metaProviderRejection.js");
    expect(isProviderDefinitiveRejection(new access.InstagramAccessLostError(dead.id, null))).toBe(true);
    expect(isProviderDefinitiveRejection(new Error("Graph API HTTP 400: x"))).toBe(true);
    expect(isProviderDefinitiveRejection(new Error("Graph API HTTP 500: x"))).toBe(false);
  });
});

describe("ревью #432, второй круг: проба, ложные отметки, соседний аккаунт", () => {
  const igUrl = () => meta.instagramApiUrl(`/${meta.GRAPH_VERSION}/me/messages`);
  const dm = { recipient: { id: `peer-probe-${run}` }, message: { text: "Проба" } };

  it("проба получила 4xx «про получателя» (код 100) — ключ принят, отметка снята", async () => {
    await access.noteInstagramAccountLocked(dead.id, `HTTP 401: ${DEAD_TEXT}`);
    access.resetInstagramAccessProbes();
    fetchMock.mockImplementation(async () => json({ error: { message: "No matching user found", type: "OAuthException", code: 100, error_subcode: 2018001 } }, 400));
    await expect(meta.callGraph(igUrl(), dead.token, dm)).rejects.toThrow(/400/);
    expect(await lostAt(dead.id)).toBeNull();
  });

  it("проба с 429 (лимит) или 400 с кодом 190 — отметка остаётся", async () => {
    for (const [status, body] of [
      [429, { error: { message: "Application request limit reached", code: 4 } }],
      [400, { error: { message: "Unknown failure", type: "GraphMethodException", code: 190 } }],
    ] as const) {
      await access.noteInstagramAccountLocked(dead.id, `HTTP 401: ${DEAD_TEXT}`);
      access.resetInstagramAccessProbes();
      fetchMock.mockImplementation(async () => json(body, status));
      await meta.callGraph(igUrl(), dead.token, dm).catch(() => undefined);
      expect(await lostAt(dead.id), `статус ${status}`).not.toBeNull();
    }
    expect(access.isInstagramKeyAcceptedRefusal(400, "<html>Bad request</html>")).toBe(false);
    expect(access.isInstagramKeyAcceptedRefusal(403, JSON.stringify({ error: { message: "Permissions error", code: 10 } }))).toBe(true);
  });

  it("429, 5xx и 400 с кодом 190 без текста про ключ живой аккаунт НЕ метят", async () => {
    for (const [status, body] of [
      [429, { error: { message: "Application request limit reached", code: 4 } }],
      [500, { error: { message: "An unexpected error has occurred", code: 2 } }],
      [503, { error: { message: "Service temporarily unavailable", code: 2 } }],
      [400, { error: { message: "Unknown failure", type: "GraphMethodException", code: 190 } }],
    ] as const) {
      fetchMock.mockImplementation(async () => json(body, status));
      await meta.callGraph(igUrl(), alive.token, dm).catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 400));
    expect(await lostAt(alive.id)).toBeNull();
  });

  it("два аккаунта Instagram: отмечен один — отправка от второго идёт в Meta как обычно", async () => {
    await access.noteInstagramAccountLocked(dead.id, `HTTP 401: ${DEAD_TEXT}`);
    const before = callsWith(alive.token);
    await expect(staffSend(alive.token)).resolves.toMatch(/^mid-/);
    expect(callsWith(alive.token)).toBe(before + 1);
    expect(await lostAt(alive.id)).toBeNull();
    const deadErr = await staffSend(dead.token).catch((e: unknown) => e);
    expect(access.isInstagramAccessLostError(deadErr)).toBe(true);
  });

  it("проба без входящих: работа по расписанию сама делает GET /me раз в 30 минут; ключ ожил — отметка снята", async () => {
    const { stillLostAfterProbe } = await import("../src/lib/instagramAccessProbe.js");
    await access.noteInstagramAccountLocked(dead.id, `HTTP 401: ${DEAD_TEXT}`);
    // Сразу после отметки — проба ещё не положена: в Meta не ходим.
    let before = callsWith(dead.token);
    expect(await stillLostAfterProbe(dead.id)).toBe(true);
    expect(callsWith(dead.token)).toBe(before);
    // Прошло 30 минут, ключ всё ещё мёртв: одна проба, отметка стоит; повтор в те же полчаса — без запроса.
    access.resetInstagramAccessProbes();
    before = callsWith(dead.token);
    expect(await stillLostAfterProbe(dead.id)).toBe(true);
    expect(callsWith(dead.token)).toBe(before + 1);
    expect(await stillLostAfterProbe(dead.id)).toBe(true);
    expect(callsWith(dead.token)).toBe(before + 1);
    // Ключ ожил — следующая проба снимает отметку.
    revived.add(dead.token);
    access.resetInstagramAccessProbes();
    expect(await stillLostAfterProbe(dead.id)).toBe(false);
    expect(await lostAt(dead.id)).toBeNull();
    // Аккаунт без отметки — в Meta не ходим вовсе.
    before = callsWith(alive.token);
    expect(await stillLostAfterProbe(alive.id)).toBe(false);
    expect(callsWith(alive.token)).toBe(before);
  });
});

describe("ревью #432: очередь комментариев не забивается отложенными брошенного аккаунта", () => {
  const prefix = `stand-park-${run}`;
  afterAll(async () => {
    await prisma.instagramComment.deleteMany({ where: { commentId: { startsWith: prefix } } });
  });

  it("520 отложенных у аккаунта с отметкой не мешают выбрать комментарий живого аккаунта; старше 3 суток — закрыты", async () => {
    const { selectDueComments } = await import("../src/messengers/comments.js");
    await access.noteInstagramAccountLocked(dead.id, `HTTP 401: ${DEAD_TEXT}`);
    const base = Date.UTC(1971, 0, 1);
    await prisma.instagramComment.createMany({ data: Array.from({ length: 520 }, (_, i) => ({
      commentId: `${prefix}-dead-${i}`, mediaId: "m", authorId: `a-${i}`, text: "нарх?", status: "PENDING",
      accountExternalId: dead.externalId, replyDueAt: new Date(base + i),
    })) as never });
    await prisma.instagramComment.create({ data: {
      commentId: `${prefix}-alive`, mediaId: "m", authorId: "a-alive", text: "нарх?", status: "PENDING",
      accountExternalId: alive.externalId, replyDueAt: new Date(base + 24 * 60 * 60 * 1000),
    } as never });

    const due = await selectDueComments(new Date());
    expect(due.some((c) => c.commentId === `${prefix}-alive`)).toBe(true);
    expect(due.some((c) => c.commentId.startsWith(`${prefix}-dead-`))).toBe(false);

    await prisma.instagramComment.updateMany({ where: { commentId: { in: [0, 1, 2, 3, 4].map((i) => `${prefix}-dead-${i}`) } },
      data: { createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000) } });
    await selectDueComments(new Date());
    expect(await prisma.instagramComment.count({ where: { commentId: { startsWith: `${prefix}-dead-` }, status: "SKIPPED", note: "access_lost" } })).toBe(5);
    expect(await prisma.instagramComment.count({ where: { commentId: { startsWith: `${prefix}-dead-` }, status: "PENDING" } })).toBe(515);
  });
});

describe("личное по комментарию: ожидаемые отказы Meta", () => {
  it("«This user cant reply» — отказ про получателя, а не поломка", () => {
    const err = new MetaGraphCallError("Graph API HTTP 400: This user cant reply to this comment",
      { status: 400, code: 10, subcode: null, message: "This user cant reply to this comment", type: null, fbtraceId: null } as never);
    expect(privateReplyFailure(err).kind).toBe("recipient");
  });
});
