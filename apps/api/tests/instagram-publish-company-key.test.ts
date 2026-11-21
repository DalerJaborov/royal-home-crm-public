import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

/**
 * Публикация в Instagram ключом компании (22.11.2026). Живой случай: 11–12.11 владелец
 * сменил пароль, личный ключ IGAA ответил 401 «session invalidated», и @royal.home.tj
 * перестал публиковать: ролики, истории и карусели брали только личный ключ. Здесь:
 * выбор ключа одной дверью (lib/instagramPublisher.ts), что ролик ключом компании идёт
 * на graph.facebook.com с id аккаунта Instagram, тревога руководству при 401 личного ключа
 * ровно один раз, и что «Проверить права» не отдаёт сам маркер.
 */
const { prisma } = await import("../src/db.js");
const { encryptSecret } = await import("../src/crypto.js");
const eternal = await import("../src/lib/metaEternalTokens.js");
const { resolveInstagramPublisher } = await import("../src/lib/instagramPublisher.js");
const { publishInstagramReel } = await import("../src/lib/socialPublish.js");
const { GRAPH_VERSION } = await import("../src/messengers/meta.js");
const { CHANNEL_KEY_ALERT_TAG_PREFIX, MANAGEMENT_ALARM_ROLES } = await import("../src/lib/channelKeyAlarm.js");

const run = randomUUID().slice(0, 8);
const stamp = Date.now().toString().slice(-9);
const PAGE_ID = `8${stamp}3`;
const IG_ID = `178417${stamp}`;
const IG_LOGIN = `IGAA-stand-publish-${run}`;
const SYSTEM = `EAA-stand-system-${run}`;
const PAGE_TOKEN = `EAA-stand-page-${run}`;
const CONTAINER = `container-${run}`;
const MEDIA = `media-${run}`;
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const PUBLISH_SCOPES = ["instagram_basic", "instagram_content_publish", "pages_read_engagement", "instagram_manage_messages", "pages_manage_metadata"];

let accountId = "";
let before: Record<string, unknown> | null = null;
const tagsToClean: string[] = [];

/** Что «отвечает Meta» — меняется по ходу теста. */
const meta = {
  systemScopes: PUBLISH_SCOPES,
  linkedIg: IG_ID,
  personalMe: (): Response => json({ id: `msg-${IG_ID}`, user_id: IG_ID, username: `publish_${run}` }),
};
const fetchMock = vi.fn();
const authOf = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.Authorization;
const isPersonalMe = (url: string) => url.includes("/me?fields=id,user_id,username");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function settings(patch: Record<string, unknown>) {
  await prisma.settings.update({ where: { id: "singleton" }, data: patch });
  eternal.resetMetaEternalCache();
}

beforeAll(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
  before = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaIgManageToken: true, instagramCompanyKeyEnabled: true },
  });
  const row = await prisma.messengerAccount.create({
    data: { channel: "INSTAGRAM", externalId: IG_ID, title: `Публикация ${run}`, token: encryptSecret(IG_LOGIN), username: `publish_${run}`, pageId: PAGE_ID },
  });
  accountId = row.id;
});

afterAll(async () => {
  await prisma.messengerAccount.deleteMany({ where: { id: accountId } });
  if (before) await prisma.settings.update({ where: { id: "singleton" }, data: before });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag: { in: tagsToClean } } });
  eternal.resetMetaEternalCache();
});

beforeEach(async () => {
  Object.assign(meta, {
    systemScopes: PUBLISH_SCOPES,
    linkedIg: IG_ID,
    personalMe: () => json({ id: `msg-${IG_ID}`, user_id: IG_ID, username: `publish_${run}` }),
  });
  await settings({ metaIgManageToken: encryptSecret(SYSTEM), instagramCompanyKeyEnabled: true });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = authOf(init);
    if (url === `${GRAPH}/me/permissions`) {
      if (auth !== `Bearer ${SYSTEM}`) return json({ error: { code: 190, message: "bad token" } }, 400);
      return json({ data: meta.systemScopes.map((permission) => ({ permission, status: "granted" })) });
    }
    if (url.startsWith(`${GRAPH}/${PAGE_ID}?fields=access_token`)) {
      if (auth !== `Bearer ${SYSTEM}`) return json({ error: { code: 190, message: "bad token" } }, 400);
      return json({ id: PAGE_ID, access_token: PAGE_TOKEN, name: "Royal Home Page", instagram_business_account: { id: meta.linkedIg } });
    }
    if (isPersonalMe(url)) return meta.personalMe();
    if (url === `${GRAPH}/me?fields=id,name`) return json({ id: "sys", name: "royalhome-crm" });
    if (url === `${GRAPH}/app?fields=id`) return json({ id: "1684679092586215" });
    if (url === `${GRAPH}/${PAGE_ID}/subscribed_apps`) return json({ data: [] });
    if (url === `${GRAPH}/${IG_ID}/media` && init?.method === "POST") return json({ id: CONTAINER });
    if (url.startsWith(`${GRAPH}/${CONTAINER}?fields=status_code`)) return json({ status_code: "FINISHED" });
    if (url === `${GRAPH}/${IG_ID}/media_publish` && init?.method === "POST") return json({ id: MEDIA });
    // Без адреса в тексте: в адресе через прокси мог бы оказаться маркер.
    return json({ error: { message: "unexpected" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (before) await prisma.settings.update({ where: { id: "singleton" }, data: before });
  eternal.resetMetaEternalCache();
});

describe("одна дверь «чем публиковать в Instagram»", () => {
  it("ключ компании готов — публикует он, в аккаунт этого Instagram; личный ключ Meta даже не спрашивали", async () => {
    const publisher = await resolveInstagramPublisher(IG_LOGIN);
    expect(publisher).toMatchObject({ ok: true, route: "company", igUserId: IG_ID, token: SYSTEM, username: `publish_${run}` });
    expect(fetchMock.mock.calls.filter(([u]) => isPersonalMe(String(u)))).toHaveLength(0);
  });

  it("рубильник «Instagram через постоянный ключ Meta» выключен — личный ключ, как раньше", async () => {
    await settings({ instagramCompanyKeyEnabled: false });
    const publisher = await resolveInstagramPublisher(IG_LOGIN);
    expect(publisher).toMatchObject({ ok: true, route: "personal", igUserId: IG_ID, token: IG_LOGIN });
  });

  it("у ключа компании нет instagram_content_publish — личный ключ", async () => {
    meta.systemScopes = PUBLISH_SCOPES.filter((s) => s !== "instagram_content_publish");
    expect(await resolveInstagramPublisher(IG_LOGIN)).toMatchObject({ ok: true, route: "personal", token: IG_LOGIN });
  });

  it("к Странице привязан ЧУЖОЙ Instagram — личный ключ (иначе ролик ушёл бы в другой аккаунт)", async () => {
    meta.linkedIg = "17841400000000000";
    expect(await resolveInstagramPublisher(IG_LOGIN)).toMatchObject({ ok: true, route: "personal", token: IG_LOGIN });
  });

  it("ключ компании не маркер Facebook Login (не EAA) — личный ключ, адрес graph.facebook.com не подставится", async () => {
    await settings({ metaIgManageToken: encryptSecret(`stand-system-${run}`) });
    expect(await resolveInstagramPublisher(IG_LOGIN)).toMatchObject({ ok: true, route: "personal", token: IG_LOGIN });
  });

  it("ключа нет вовсе — «Instagram не подключён», Meta не спрашиваем", async () => {
    expect(await resolveInstagramPublisher(undefined)).toEqual({ ok: false, error: "Instagram не подключён" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ролик ключом компании", () => {
  it("идёт на graph.facebook.com/{ig-id}/media → статус контейнера → media_publish, всё маркером компании", async () => {
    const publisher = await resolveInstagramPublisher(IG_LOGIN);
    expect(publisher.ok).toBe(true);
    if (!publisher.ok) return;
    fetchMock.mockClear();
    const result = await publishInstagramReel(
      `prop-${run}`,
      publisher.igUserId,
      publisher.token,
      "https://crm-test.royalhome.tj/uploads/handoff/x.mp4",
      "Подпись",
      null,
      [],
      { persistPendingContainer: false }
    );
    expect(result).toMatchObject({ channel: "INSTAGRAM", ok: true, postId: MEDIA });
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls[0]).toBe(`${GRAPH}/${IG_ID}/media`);
    expect(urls).toContain(`${GRAPH}/${IG_ID}/media_publish`);
    expect(urls.some((u) => u.startsWith(`${GRAPH}/${CONTAINER}?fields=status_code`))).toBe(true);
    // Ни одного запроса на graph.instagram.com или через прокси — только graph.facebook.com.
    expect(urls.every((u) => u.startsWith("https://graph.facebook.com/"))).toBe(true);
    for (const [, init] of fetchMock.mock.calls) expect(authOf(init as RequestInit)).toBe(`Bearer ${SYSTEM}`);
    const createBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(createBody).toMatchObject({ media_type: "REELS", video_url: "https://crm-test.royalhome.tj/uploads/handoff/x.mp4", caption: "Подпись" });
  });
});

describe("тревога, когда ключ Instagram перестал работать", () => {
  it("личный ключ ответил 401 — одна тревога руководству на сутки, второй отказ её не повторяет", async () => {
    await settings({ instagramCompanyKeyEnabled: false });
    meta.personalMe = () =>
      json({ error: { code: 190, error_subcode: 460, message: "Error validating access token: The session has been invalidated because the user changed their password." } }, 401);
    const tag = `${CHANNEL_KEY_ALERT_TAG_PREFIX}account:${accountId}`;
    tagsToClean.push(tag);
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag } });

    const first = await resolveInstagramPublisher(IG_LOGIN);
    expect(first.ok).toBe(false);
    const alert = await waitFor(() => prisma.pendingDirectorAlert.findFirst({ where: { tag } }));
    expect(alert?.body).toContain("Настройках → Каналы");
    expect([...(alert?.recipientRoles ?? [])].sort()).toEqual([...MANAGEMENT_ALARM_ROLES].sort());

    const second = await resolveInstagramPublisher(IG_LOGIN);
    expect(second.ok).toBe(false);
    expect(await waitForSettled(() => prisma.pendingDirectorAlert.count({ where: { tag } }))).toBe(1);
  });
});

describe("«Проверить права» ключа компании", () => {
  it("список прав и нужные для публикации; сам маркер в ответе не встречается", async () => {
    meta.systemScopes = PUBLISH_SCOPES.filter((s) => s !== "pages_read_engagement");
    const status = await eternal.metaEternalStatus();
    expect(status.systemUser.ok).toBe(true);
    expect(status.systemUser.grantedScopes).toEqual([...meta.systemScopes].sort());
    const checks = new Map((status.systemUser.scopeChecks ?? []).map((c) => [c.scope, c.granted]));
    expect(checks.get("instagram_content_publish")).toBe(true);
    expect(checks.get("pages_read_engagement")).toBe(false);
    expect(checks.get("pages_show_list")).toBe(false);
    // Без pages_read_engagement публикация остаётся на личном ключе — экран так и говорит.
    expect(status.rows.find((r) => r.accountId === accountId)?.publishRoute).toBe("personal");
    const text = JSON.stringify(status);
    for (const secret of [SYSTEM, PAGE_TOKEN, IG_LOGIN]) expect(text).not.toContain(secret);
  });

  it("всё выдано — строка аккаунта говорит «публикует постоянным ключом компании»", async () => {
    const status = await eternal.metaEternalStatus();
    expect(status.rows.find((r) => r.accountId === accountId)?.publishRoute).toBe("company");
    expect(JSON.stringify(status)).not.toContain(SYSTEM);
  });
});
