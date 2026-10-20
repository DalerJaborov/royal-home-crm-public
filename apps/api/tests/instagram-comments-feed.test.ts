import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * Лента комментариев Instagram в CRM: что видно владельцу и что можно сделать руками.
 *
 * Проверяем то, что стоит дорого при ошибке: чужие глаза на переписке бота (право),
 * выгрузка всей таблицы одним ответом (предел выборки), и главное — ручное скрытие:
 * оно видно постороннему человеку в Instagram, поэтому не должно ни срабатывать
 * молча мимо Meta, ни менять запись, когда Meta отказала.
 *
 * Graph API подменён: тест не ходит в Meta и не зависит от её доступности.
 */

const runId = Date.now().toString(36);
const password = "testpass123";

let directorToken = "";
let agentToken = "";
let managerToken = "";
let directorId = "";
let agentId = "";
let managerId = "";
let districtId = "";
let propertyId = "";
let propertyShortId = 0;

/** Что ушло в Graph API — по этим записям видно, скрыли комментарий на самом деле
 *  или только в нашей базе. */
let graphCalls: { url: string; body: Record<string, unknown> }[] = [];
/** Отвечает ли подменённая Meta успехом. */
let graphOk = true;
let graphBody: unknown = { success: true };

const savedIgToken = process.env.META_IG_TOKEN;
const savedPageToken = process.env.META_PAGE_TOKEN;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Комментарий с уникальным для прогона идентификатором: база общая, и совпадение
 *  с чужой записью уронило бы соседний тест, а не этот. */
async function makeComment(suffix: string, data: Record<string, unknown> = {}) {
  return prisma.instagramComment.create({
    data: {
      commentId: `feed-${runId}-${suffix}`,
      mediaId: `media-${runId}`,
      authorId: `author-${runId}`,
      authorName: `tester_${runId}`,
      text: `Комментарий ${suffix}`,
      replyDueAt: new Date(),
      ...data,
    },
  });
}

beforeAll(async () => {
  process.env.META_IG_TOKEN = "test-ig-token";
  // Маркер страницы Facebook: комментарии со страницы приходят в ту же ленту с
  // 16.08.2026, и скрытие для них уходит в graph.facebook.com этим маркером.
  process.env.META_PAGE_TOKEN = "test-page-token";
  const passwordHash = await bcrypt.hash(password, 10);

  const director = await prisma.agent.create({
    data: { fullName: "Тест Директор комменты", phone: `+992971${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const agent = await prisma.agent.create({
    data: { fullName: "Тест Агент комменты", phone: `+992972${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  // Руководитель: переписку бота видит, но публично действовать от имени компании
  // не должен — на нём и проверяется отдельное право на скрытие.
  const manager = await prisma.agent.create({
    data: { fullName: "Тест Руководитель комменты", phone: `+992973${runId}`, role: "MANAGER", passwordHash },
  });
  managerId = manager.id;

  const district = await prisma.district.create({ data: { name: `Тест-район-лента-${runId}` } });
  districtId = district.id;
  const property = await prisma.property.create({
    data: {
      title: `Тест-объект-лента-${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "USD",
      districtId,
      address: "Тестовая, 3",
      condition: "GOOD",
      instagramUrl: `https://www.instagram.com/p/FEED${runId}/`,
    },
  });
  propertyId = property.id;
  propertyShortId = property.shortId;

  directorToken = await login(director.phone);
  agentToken = await login(agent.phone);
  managerToken = await login(manager.phone);
});

afterAll(async () => {
  await prisma.instagramComment.deleteMany({ where: { commentId: { startsWith: `feed-${runId}` } } });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: [directorId, agentId, managerId] } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId, managerId] } } });
  if (savedIgToken === undefined) delete process.env.META_IG_TOKEN;
  else process.env.META_IG_TOKEN = savedIgToken;
  if (savedPageToken === undefined) delete process.env.META_PAGE_TOKEN;
  else process.env.META_PAGE_TOKEN = savedPageToken;
});

beforeEach(() => {
  graphCalls = [];
  graphOk = true;
  graphBody = { success: true };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      graphCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      const text = graphOk ? JSON.stringify(graphBody) : "Invalid OAuth access token";
      return {
        ok: graphOk,
        status: graphOk ? 200 : 400,
        text: async () => text,
        json: async () => JSON.parse(text),
      } as unknown as Response;
    })
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await prisma.instagramComment.deleteMany({ where: { commentId: { startsWith: `feed-${runId}` } } });
});

describe("кто видит ленту", () => {
  it("рядовой агент переписку бота не видит", async () => {
    const res = await request(app).get("/api/v1/instagram-comments").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it("без входа — отказ", async () => {
    const res = await request(app).get("/api/v1/instagram-comments");
    expect(res.status).toBe(401);
  });

  it("агент не может скрыть комментарий", async () => {
    const row = await makeComment("acl");
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/hide`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
    expect(graphCalls).toHaveLength(0);
  });

  /**
   * Главное разграничение этого раздела: читать ленту и действовать в ней публично —
   * разные права. Руководитель разбирает переписку бота, но скрытие видно
   * посторонним людям в Instagram, и оно ему по умолчанию не открыто.
   */
  it("руководитель ленту видит", async () => {
    const res = await request(app).get("/api/v1/instagram-comments").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
  });

  it("руководитель скрыть комментарий не может — и в Instagram ничего не уходит", async () => {
    const row = await makeComment("acl-manager", { status: "REPLIED", replyText: "Ответ бота" });
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/hide`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(403);
    expect(graphCalls).toHaveLength(0);
    const saved = await prisma.instagramComment.findUnique({ where: { id: row.id } });
    expect(saved!.status).toBe("REPLIED");
  });

  it("руководитель не может и вернуть скрытое: это тоже меняет то, что видят подписчики", async () => {
    const row = await makeComment("acl-manager-unhide", { status: "HIDDEN", hiddenAt: new Date() });
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/unhide`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(403);
    expect(graphCalls).toHaveLength(0);
  });
});

describe("лента", () => {
  it("отдаёт комментарий с ответом бота и ссылкой на публикацию", async () => {
    await makeComment("replied", {
      status: "REPLIED",
      replyText: "Написали вам в личные сообщения",
      repliedAt: new Date(),
      propertyId,
    });
    const res = await request(app)
      .get("/api/v1/instagram-comments")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);

    const item = res.body.items.find((i: { commentId: string }) => i.commentId === `feed-${runId}-replied`);
    expect(item).toBeTruthy();
    expect(item.replyText).toBe("Написали вам в личные сообщения");
    // Адреса публикации в самом комментарии нет — он приходит из карточки объекта.
    expect(item.post.instagramUrl).toContain(`FEED${runId}`);
    expect(item.post.propertyShortId).toBe(propertyShortId);
  });

  it("фильтр по статусу отдаёт только скрытое, а счётчики остаются по всей таблице", async () => {
    await makeComment("hidden-1", { status: "HIDDEN", note: "spam", hiddenAt: new Date() });
    await makeComment("replied-1", { status: "REPLIED", replyText: "Ответ" });

    const res = await request(app)
      .get("/api/v1/instagram-comments?status=HIDDEN")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items.every((i: { status: string }) => i.status === "HIDDEN")).toBe(true);
    // Счётчик другого статуса не обнуляется выбранным фильтром — иначе все
    // остальные вкладки показывали бы ноль, как только выбрана одна.
    expect(res.body.counts.REPLIED).toBeGreaterThan(0);
    expect(res.body.counts.HIDDEN).toBeGreaterThan(0);
  });

  it("предел выборки: pageSize больше сотни не принимается", async () => {
    const res = await request(app)
      .get("/api/v1/instagram-comments?pageSize=100000")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(400);
  });

  it("страница не длиннее запрошенной", async () => {
    await makeComment("p1");
    await makeComment("p2");
    const res = await request(app)
      .get("/api/v1/instagram-comments?pageSize=1")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.pageSize).toBe(1);
  });

  it("несуществующий статус отвергается, а не выдаёт всё подряд", async () => {
    const res = await request(app)
      .get("/api/v1/instagram-comments?status=WHATEVER")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(400);
  });
});

/**
 * Значок раздела в меню. Ради него всё и затевалось: случаи, где бот спасовал,
 * копились в ленте, а узнать о них можно было, только зайдя туда наугад.
 */
describe("счётчик «бот не знал ответа» в меню", () => {
  async function counters(token: string) {
    const res = await request(app).get("/api/v1/dashboard/counters").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body as { comments: number };
  }

  async function markSeen(token: string) {
    await request(app)
      .post("/api/v1/dashboard/counters/seen")
      .set("Authorization", `Bearer ${token}`)
      .send({ section: "comments" })
      .expect(200);
    // Отметка «видел» и следующая запись могут попасть в одну миллисекунду, а
    // сравнение строгое (gt) — без паузы тест падал бы через раз, а не по делу.
    await new Promise((r) => setTimeout(r, 5));
  }

  it("эскалированный комментарий поднимает значок, а открытие раздела его гасит", async () => {
    await markSeen(directorToken);
    await makeComment("counter-escalated", { status: "ESCALATED", note: "спрашивают про документы" });

    const before = (await counters(directorToken)).comments;
    expect(before).toBeGreaterThanOrEqual(1);

    // Открытие раздела = отметка «видел»: у комментария нет действия «разобрано»,
    // и без этой отметки значок горел бы вечно.
    await markSeen(directorToken);
    const after = (await counters(directorToken)).comments;
    expect(after).toBeLessThan(before);
  });

  it("отвеченный комментарий значок не поднимает — звать человека там незачем", async () => {
    await markSeen(directorToken);
    await makeComment("counter-replied", { status: "REPLIED", replyText: "Цена 41 000 $, Сино" });
    expect((await counters(directorToken)).comments).toBe(0);
  });

  it("у агента без права на переписку счётчик всегда нулевой", async () => {
    await makeComment("counter-agent", { status: "ESCALATED" });
    expect((await counters(agentToken)).comments).toBe(0);
  });
});

describe("скрыть и вернуть руками", () => {
  it("скрытие уходит в Instagram и записывается в CRM", async () => {
    const row = await makeComment("hide-me", { status: "REPLIED", replyText: "Ответ бота" });
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/hide`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);

    // Главное: комментарий скрыт НА САМОМ ДЕЛЕ, а не только в нашей таблице.
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0].url).toContain(encodeURIComponent(row.commentId));
    expect(graphCalls[0].body.hide).toBe(true);

    const saved = await prisma.instagramComment.findUnique({ where: { id: row.id } });
    expect(saved!.status).toBe("HIDDEN");
    expect(saved!.hiddenAt).not.toBeNull();
    // Ответ бота остаётся: скрытие прячет комментарий, а не историю.
    expect(saved!.replyText).toBe("Ответ бота");
  });

  /**
   * САМАЯ ДОРОГАЯ ИЗ НАХОДОК 23.09.2026: кнопка «Скрыть» в CRM ходила в
   * graph.instagram.com маркером Instagram ВСЕГДА, какой бы ни была площадка
   * строки. Комментарий со страницы Facebook (их приносит тот же вебхук с
   * 16.08.2026) она не скрывала — Meta отвечала отказом, потому что чужой маркер
   * чужого комментария не видит, — а сотрудник читал «Instagram не принял
   * скрытие» под комментарием, к Instagram отношения не имеющим.
   *
   * Проверяем ровно то, что отличает починку от прежнего кода: ДОМ Graph API.
   */
  it("комментарий со страницы Facebook скрывается через graph.facebook.com, а не через Instagram", async () => {
    const row = await makeComment("hide-facebook", { channel: "FACEBOOK", status: "REPLIED", replyText: "Ответ бота" });
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/hide`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);

    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0].url).toContain("graph.facebook.com");
    expect(graphCalls[0].url).not.toContain("graph.instagram.com");
    expect(graphCalls[0].url).toContain(encodeURIComponent(row.commentId));
    // У комментария страницы Facebook поле скрытия — `is_hidden` (24.09.2026), `hide` — это Instagram.
    expect(graphCalls[0].body).toEqual({ is_hidden: true });

    expect((await prisma.instagramComment.findUnique({ where: { id: row.id } }))!.status).toBe("HIDDEN");
  });

  it("отказ по комментарию Facebook называет Facebook, а не Instagram", async () => {
    const row = await makeComment("hide-facebook-fails", { channel: "FACEBOOK", status: "REPLIED" });
    graphOk = false;
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/hide`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("Facebook");
    expect(res.body.error).toContain("не подтвердил");
    expect(res.body.error).not.toContain("остался виден");
    // Запись не трогаем: отрицательный HTTP не подтверждает новую видимость.
    expect((await prisma.instagramComment.findUnique({ where: { id: row.id } }))!.status).toBe("REPLIED");
  });

  it.each([{ success: false }, {}])("ручной hide с неподтверждённым2xx %j не записывает успешное скрытие", async (body) => {
    graphBody = body;
    const row = await makeComment(`manual-hide-unconfirmed-${Object.keys(body).join("-")}`, { status: "REPLIED" });
    const res = await request(app).post(`/api/v1/instagram-comments/${row.id}/hide`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("не подтвердил");
    expect(res.body.error).not.toContain("остался виден");
    expect(graphCalls).toHaveLength(1);
    const saved = await prisma.instagramComment.findUniqueOrThrow({ where: { id: row.id } });
    expect(saved.status).toBe("REPLIED");
    expect(saved.hiddenAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: row.id, action: "IG_COMMENT_HIDE" } })).toBe(0);
  });

  it.each(["HIDDEN", "DELETED"])("YouTube %s не обещает возврат даже при прямом unhide", async (status) => {
    const row = await makeComment(`youtube-no-restore-${status}`, { channel: "YOUTUBE", status,
      hiddenAt: new Date(), note: status === "HIDDEN" ? "youtube_rejected; spam" : "competitor_ad" });
    const res = await request(app).post(`/api/v1/instagram-comments/${row.id}/unhide`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(409);
    expect(graphCalls).toHaveLength(0);
    const saved = await prisma.instagramComment.findUniqueOrThrow({ where: { id: row.id } });
    expect(saved.status).toBe(status);
    expect(saved.hiddenAt).toEqual(row.hiddenAt);
    expect(await prisma.auditLog.count({ where: { entityId: row.id, action: "IG_COMMENT_UNHIDE" } })).toBe(0);
    const reply = await request(app).post(`/api/v1/instagram-comments/${row.id}/reply`)
      .set("Authorization", `Bearer ${directorToken}`).send({ text: "Ответ" });
    expect(reply.status).toBe(409);
    expect(reply.body.error).not.toContain("сначала верните");
    expect(graphCalls).toHaveLength(0);
  });

  it("Meta unhide не восстанавливает legacy DELETED из statusBeforeHide", async () => {
    const row = await makeComment("legacy-deleted-before-hide", { status: "HIDDEN", statusBeforeHide: "DELETED" });
    const res = await request(app).post(`/api/v1/instagram-comments/${row.id}/unhide`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("SKIPPED");
  });

  it.each([{ channel: "WEBSITE", status: "HIDDEN" }, { channel: "INSTAGRAM", status: "UNKNOWN" }])(
    "неподдерживаемый канал/статус %j не получает idempotent success или публичные действия", async ({ channel, status }) => {
      const row = await makeComment(`unsupported-${channel}-${status}`, { channel, status });
      for (const operation of ["hide", "unhide", "reply"]) {
        const req = request(app).post(`/api/v1/instagram-comments/${row.id}/${operation}`)
          .set("Authorization", `Bearer ${directorToken}`);
        const res = await (operation === "reply" ? req.send({ text: "Ответ" }) : req);
        expect(res.status).toBe(409);
      }
      expect(graphCalls).toHaveLength(0);
      expect((await prisma.instagramComment.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(status);
    }
  );

  it("площадка видна в ленте — иначе Instagram, Facebook и YouTube в ней неотличимы", async () => {
    await makeComment("channel-visible", { channel: "FACEBOOK", status: "REPLIED" });
    const res = await request(app)
      .get("/api/v1/instagram-comments")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: { commentId: string }) => i.commentId === `feed-${runId}-channel-visible`);
    expect(item.channel).toBe("FACEBOOK");
  });

  it("возврат восстанавливает «бот ответил», если ответ был", async () => {
    const row = await makeComment("unhide-me", {
      status: "HIDDEN",
      hiddenAt: new Date(),
      replyText: "Ответ бота",
      repliedAt: new Date(),
    });
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/unhide`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(graphCalls[0].body.hide).toBe(false);

    const saved = await prisma.instagramComment.findUnique({ where: { id: row.id } });
    expect(saved!.status).toBe("REPLIED");
    expect(saved!.hiddenAt).toBeNull();
  });

  /**
   * Прежний статус переживает скрытие. Раньше он пересобирался догадкой, и
   * «Бот не знал ответа» — случай, который ЖДЁТ человека — после скрытия и
   * возврата превращался в «Бот промолчал», то есть в «всё в порядке».
   */
  it("возврат восстанавливает «бот не знал ответа», а не подменяет его молчанием", async () => {
    const row = await makeComment("unhide-escalated", {
      status: "ESCALATED",
      note: "спрашивают про рассрочку",
      replyText: "Сейчас уточним и вернёмся с ответом",
      repliedAt: new Date(),
    });

    await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/hide`)
      .set("Authorization", `Bearer ${directorToken}`)
      .expect(200);
    const hiddenRow = await prisma.instagramComment.findUnique({ where: { id: row.id } });
    expect(hiddenRow!.status).toBe("HIDDEN");
    expect(hiddenRow!.statusBeforeHide).toBe("ESCALATED");

    await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/unhide`)
      .set("Authorization", `Bearer ${directorToken}`)
      .expect(200);
    const back = await prisma.instagramComment.findUnique({ where: { id: row.id } });
    // Догадка по replyText дала бы здесь REPLIED, и случай потерялся бы.
    expect(back!.status).toBe("ESCALATED");
    // Память о скрытии стёрта: следующее скрытие запомнит новое состояние.
    expect(back!.statusBeforeHide).toBeNull();
  });

  it("запись без прежнего статуса (скрыта ботом или до появления поля) — прежняя догадка", async () => {
    const row = await makeComment("unhide-legacy", {
      status: "HIDDEN",
      hiddenAt: new Date(),
      note: "spam",
      replyText: "Ответ бота",
      repliedAt: new Date(),
    });
    await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/unhide`)
      .set("Authorization", `Bearer ${directorToken}`)
      .expect(200);
    const saved = await prisma.instagramComment.findUnique({ where: { id: row.id } });
    expect(saved!.status).toBe("REPLIED");
  });

  it("возврат без ответа бота даёт «промолчал», а не «ответил»", async () => {
    const row = await makeComment("unhide-silent", { status: "HIDDEN", hiddenAt: new Date(), note: "spam" });
    await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/unhide`)
      .set("Authorization", `Bearer ${directorToken}`)
      .expect(200);
    const saved = await prisma.instagramComment.findUnique({ where: { id: row.id } });
    expect(saved!.status).toBe("SKIPPED");
  });

  it("отказ Instagram не меняет запись: иначе в CRM «скрыт», а подписчики его видят", async () => {
    const row = await makeComment("hide-fails", { status: "REPLIED", replyText: "Ответ" });
    graphOk = false;
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/hide`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(502);

    const saved = await prisma.instagramComment.findUnique({ where: { id: row.id } });
    expect(saved!.status).toBe("REPLIED");
    expect(saved!.hiddenAt).toBeNull();
  });

  it("повторное скрытие в Instagram не идёт — двойной тап ничего не стоит", async () => {
    const row = await makeComment("hide-twice", { status: "HIDDEN", hiddenAt: new Date() });
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/hide`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(graphCalls).toHaveLength(0);
  });

  it("комментарий в работе у бота трогать нельзя: крон затрёт правку через секунду", async () => {
    const row = await makeComment("working", { status: "WORKING" });
    const res = await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/hide`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(409);
    expect(graphCalls).toHaveLength(0);
  });

  it("чужой идентификатор — 404, а не 500", async () => {
    const res = await request(app)
      .post("/api/v1/instagram-comments/11111111-1111-1111-1111-111111111111/hide")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(404);
  });

  it("скрытие вручную попадает в журнал действий — это действие от имени компании", async () => {
    const row = await makeComment("audit", { status: "REPLIED", replyText: "Ответ" });
    await request(app)
      .post(`/api/v1/instagram-comments/${row.id}/hide`)
      .set("Authorization", `Bearer ${directorToken}`)
      .expect(200);

    // logAudit пишет вне запроса (best-effort). Пауза в 400 мс — это ставка на
    // то, что запись успеет: на загруженной машине она проигрывается. Ждём
    // саму запись (tests/helpers/waitFor.ts), а не фиксированное время.
    const entry = await waitFor(
      () => prisma.auditLog.findFirst({ where: { action: "IG_COMMENT_HIDE", entityId: row.id } }),
      { label: "запись IG_COMMENT_HIDE в журнале действий" }
    );
    expect(entry).not.toBeNull();
    expect(entry!.agentId).toBe(directorId);
  });
});
