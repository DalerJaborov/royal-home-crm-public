import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { uploadsDir } from "../src/upload.js";
import { resetAccountsCache } from "../src/messengers/accounts.js";
import { handleOutgoingEcho } from "../src/routes/webhooks.js";
import { rememberOutgoingMid } from "../src/messengers/outgoingMids.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { cleanupLegacyPhysicalFixture } from "./helpers/cleanupLegacyPhysicalFixture.js";

// Record only IDs returned by REAL committed ledger admission in this fixture.
// All SQL/UNKNOWN protections run unchanged; cleanup never selects foreign rows.
const physicalAttempts = vi.hoisted(() => [] as string[]);
vi.mock("../src/lib/customerLegacyPhysical.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/lib/customerLegacyPhysical.js")>();
  return { ...original, admitLegacyPhysicalPost: async (target: Parameters<typeof original.admitLegacyPhysicalPost>[0]) => {
    const id = await original.admitLegacyPhysicalPost(target); physicalAttempts.push(id); return id;
  } };
});
import {
  invalidateLeadMagnetCache,
  isFunnelKeyword,
  isHostileComment,
  rehearseCampaign,
  tryLeadMagnetComment,
  tryLeadMagnetMessage,
  type ActiveCampaign,
} from "../src/lib/leadMagnet.js";

/**
 * Воронка целиком: комментарий → приглашение → проверка подписки → файл.
 *
 * Проверяется на подменённой Meta, потому что каждая ошибка здесь стоит живых
 * денег: человек приходит с оплаченной рекламы и либо получает файл, либо нет.
 * Отдельно проверяются два места, где такие воронки ломаются молча:
 *
 *  - ПОВТОР. Человек пишет ключевое слово трижды, Meta доставляет событие дважды,
 *    крон берёт запись на второй заход после сбоя — личное сообщение обязано уйти
 *    одно. Держится это на ограничении базы, а не на проверке в коде.
 *  - ПРОВЕРКА ПОДПИСКИ НЕ УДАЛАСЬ. Пустой ответ Graph API — это не «не подписан».
 *    Отказать человеку из-за нашего сбоя хуже, чем отдать файл лишнему.
 */

const runId = Date.now().toString(36);
const password = "testpass123";

let directorToken = "";
let agentToken = "";
let directorId = "";
let agentId = "";
let campaignId = "";

const IG_USER = `igsid-${runId}`;
let instagram: CustomerMessengerFixture;
const savedPublicUrl = process.env.CRM_PUBLIC_URL;

/** Что ушло в Graph API. По этим записям видно, что человек получил на самом деле. */
let sent: { url: string; body: Record<string, unknown> }[] = [];
/** Что подменённый Graph API отвечает про подписку: true/false — ответ, undefined —
 *  поле отсутствует (так выглядит отказ или нехватка разрешения у маркера). */
let following: boolean | undefined = true;
/** Отвечает ли подменённая Meta отказом на ОТПРАВКУ (сеть, 500, истёкший маркер). */
let sendFails = false;

function stubMeta() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { method?: string; body?: unknown }) => {
      const address = String(url);
      // Профиль запрашивается обычным GET; всё остальное здесь — отправка сообщений.
      if (!init?.method || init.method === "GET") {
        const body = JSON.stringify({
          username: `client_${runId}`,
          ...(following === undefined ? {} : { is_user_follow_business: following }),
        });
        return new Response(body, { status: 200 });
      }
      sent.push({ url: address, body: JSON.parse(String(init?.body ?? "{}")) });
      if (sendFails) {
        return Response.json({ error: { message: "Invalid OAuth access token", code: 190 } }, { status: 400 });
      }
      const ok = JSON.stringify({ message_id: `mid-${sent.length}` });
      return new Response(ok, { status: 200 });
    })
  );
}

/** Сообщения, ушедшие человеку, — в порядке отправки и в удобном для проверки виде.
 *  Понимает и quick reply, и карточку generic template (с 16.08.2026 кнопки шлются
 *  карточкой — quick reply веб-версия Instagram не рисует вовсе). */
function outgoing() {
  return sent.map((s) => {
    const message = (s.body as { message?: Record<string, unknown> }).message ?? {};
    const attachment = message.attachment as
      | { type?: string; payload?: { template_type?: string; elements?: { title?: string; subtitle?: string; buttons?: { title: string }[] }[] } }
      | undefined;
    const card = attachment?.payload?.elements?.[0];
    const cardText = card ? [card.title, card.subtitle].filter(Boolean).join("") : undefined;
    return {
      text: (message.text as string | undefined) ?? cardText,
      buttons: [
        ...((message.quick_replies as { title: string }[] | undefined) ?? []).map((b) => b.title),
        ...(card?.buttons ?? []).map((b) => b.title),
      ],
      attachment: attachment?.type,
      /** Личное по комментарию адресуется идентификатором КОММЕНТАРИЯ, а не человека. */
      byComment: Boolean((s.body as { recipient?: { comment_id?: string } }).recipient?.comment_id),
    };
  });
}

/**
 * Текст карточки = заголовок владельца + подсказка «не видно кнопку — ответьте +».
 *
 * Подсказка приезжает ОТДЕЛЬНОЙ строкой (подзаголовок карточки), а `outgoing()`
 * склеивает заголовок с подзаголовком — поэтому сверяем не равенство, а начало и
 * наличие подсказки. Сама подсказка обязана быть: 17.08.2026 выяснилось, что её
 * дописывали только на запасных путях отправки, а уходило всё карточкой — то есть
 * не получил её ни один человек, и те, у кого кнопка не нарисовалась, видели
 * пустое место.
 */
function expectCardText(actual: string | undefined, ownText: string) {
  expect(actual).toBeDefined();
  expect(actual!.startsWith(ownText)).toBe(true);
  expect(actual).toContain('дар ҷавоб "+" нависед');
}

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

const CAMPAIGN = {
  name: `Тест-воронка ${runId}`,
  enabled: true,
  keywords: ["ЧЕКЛИСТ"],
  publicReplies: ["Отправил в директ"],
  inviteText: "Чек-лист готов — нажмите кнопку",
  inviteButton: "Хочу чек-лист",
  requireFollow: true,
  followText: "Подпишитесь и нажмите кнопку",
  followButton: "Я подписался",
  notFollowingText: "Подписки пока не вижу",
  maxFollowChecks: 2,
  deliverIfUnsure: true,
  deliveredText: "Готово, вот чек-лист",
  link: "https://royalhome.tj/checklist",
  handoffToBot: true,
};

beforeAll(async () => {
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  process.env.CRM_PUBLIC_URL = "https://crm.test";
  const passwordHash = await bcrypt.hash(password, 10);

  const director = await prisma.agent.create({
    data: { fullName: "Тест Директор воронка", phone: `+992961${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
  const agent = await prisma.agent.create({
    data: { fullName: "Тест Агент воронка", phone: `+992962${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  directorToken = await login(director.phone);
  agentToken = await login(agent.phone);
});

afterAll(async () => {
  await prisma.leadMagnetCampaign.deleteMany({ where: { name: { startsWith: CAMPAIGN.name } } });
  await instagram.dispose();
  await prisma.auditLog.deleteMany({ where: { agentId: { in: [directorId, agentId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [directorId, agentId] } } });
  if (savedPublicUrl === undefined) delete process.env.CRM_PUBLIC_URL;
  else process.env.CRM_PUBLIC_URL = savedPublicUrl;
});

beforeEach(async () => {
  sent = [];
  following = true;
  sendFails = false;
  stubMeta();
  /**
   * ЩИТ ИСХОДЯЩИХ (feat/outbound-shield, 17.09.2026) ПОМНИТ ПОЛУЧАТЕЛЯ В БАЗЕ,
   * А НЕ В ПАМЯТИ ТЕСТА. `IG_USER` — один и тот же `igsid` на ВЕСЬ файл (не
   * генерируется заново на каждый тест), а тексты кампании (`CAMPAIGN.deliveredText`
   * и т.п.) буквально совпадают тест от теста. Без сброса щит корректно видит
   * дословный повтор одного и того же сообщения одному и тому же получателю —
   * то есть именно то, для чего он и написан, — и после первого успешного теста
   * блокирует ЛЮБУЮ следующую отправку той же фразы этому igsid как «инициативу
   * без права на повтор» (`OutboundBlockedError: reason "repeat"`). Тот же приём,
   * что в tests/outbound-shield.test.ts (там щит — предмет проверки и чистится
   * явно; здесь он посторонний и должен молчать).
   */
  await prisma.outboundShieldState.deleteMany({ where: { endpointScopeId: instagram.transport.endpointScopeId, subscriberId: IG_USER } });
  const campaign = await prisma.leadMagnetCampaign.create({ data: CAMPAIGN });
  campaignId = campaign.id;
  invalidateLeadMagnetCache();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await cleanupLegacyPhysicalFixture({ ids: physicalAttempts.splice(0) });
  await prisma.leadMagnetDelivery.deleteMany({ where: { campaignId } });
  await prisma.leadMagnetCampaign.deleteMany({ where: { id: campaignId } });
  await instagram.cleanupConversations();
  /**
   * ЩИТ ИСХОДЯЩИХ (17.09.2026, lib/outboundShield.ts) ПОМНИТ ТЕКСТЫ МЕЖДУ ТЕСТАМИ.
   *
   * `IG_USER` один на весь файл, а щит хранит отпечатки исходящих текстов по паре
   * «канал + получатель» в отдельной таблице, которую этот файл раньше не чистил
   * вовсе (её не было, когда писались эти тесты). deliveredText шлётся через
   * `sendMessage` (единственная функция, которую щит проверяет, — sendButtonCard/
   * sendQuickReplies/sendPrivateReply/sendFile мимо него), и без сброса второй же
   * тест, доставляющий тот же текст тому же IG_USER, читался щитом как «бот
   * повторяет инициативу» и блокировался с постановкой диалога на паузу — то есть
   * тест проверял не воронку, а то, помнит ли щит предыдущие тесты. В проде щит
   * различает эту доставку как ОТВЕТ живому человеку (см. `noteRealInbound` в
   * routes/webhooks.ts, вызывается до развилки на воронку), но тесты зовут
   * `tryLeadMagnetMessage`/`tryLeadMagnetComment` напрямую, минуя вебхук, — и это
   * состояние обязано начинаться с чистого листа на каждый тест, как и остальные.
   */
  await prisma.outboundShieldState.deleteMany({ where: { endpointScopeId: instagram.transport.endpointScopeId, channel: "INSTAGRAM", subscriberId: IG_USER } });
  /**
   * ОБЩАЯ ПАУЗА ЩИТА («всплеск исходящих по всей системе») — ТОЖЕ СЛЕД ЧУЖИХ
   * ТЕСТОВ (24.09.2026, полный прогон в общей базе). Полный прогон шлёт тысячи
   * исходящих за десять минут, щит честно ставит бота на общую паузу на 30
   * минут (`outboundShieldGlobal`, id 1), и следующие полчаса этот файл красный
   * на 11 тестов с `lastError` «бот на общей паузе» — при том, что в проде
   * выдача воронки идёт ОТВЕТОМ живому человеку (вебхук зовёт `noteRealInbound`
   * до развилки) и под общую паузу не попадает вовсе (см. `isReply` в
   * outboundShield.ts). Снимаем её так же, как это делает tests/outbound-shield.test.ts —
   * вместе с поминутными счётчиками пульса: с переполненным окном щит поднимает
   * общую паузу заново первой же отправкой.
   */
  await prisma.outboundShieldGlobal.deleteMany({});
  await prisma.outboundShieldPulse.deleteMany({});
  invalidateLeadMagnetCache();
});

function comment(text: string, suffix = "1") {
  return {
    accountExternalId: instagram.turnInput(IG_USER).accountExternalId,
    commentId: `lm-${runId}-${suffix}`,
    mediaId: `media-${runId}`,
    parentId: null,
    authorId: IG_USER,
    authorName: `client_${runId}`,
    text,
    createdAt: new Date(),
  };
}

describe("кто управляет кампаниями", () => {
  it("рядовой агент кампании не видит", async () => {
    const res = await request(app).get("/api/v1/lead-magnets").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it("агент не может завести кампанию", async () => {
    const res = await request(app)
      .post("/api/v1/lead-magnets")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ ...CAMPAIGN, name: `Тест-воронка чужая ${runId}` });
    expect(res.status).toBe(403);
  });

  it("кампания без ключевых слов и без «любого комментария» не сохраняется", async () => {
    // Иначе владелец включает её, запускает рекламу и ждёт лидов, которых не будет.
    const res = await request(app)
      .post("/api/v1/lead-magnets")
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ ...CAMPAIGN, name: `Тест-воронка пустая ${runId}`, keywords: [], anyComment: false });
    expect(res.status).toBe(400);
  });

  it("«любой комментарий» без публикации не сохраняется", async () => {
    // Это означало бы личное сообщение каждому, кто написал что угодно под любым
    // нашим постом. Так теряют аккаунт.
    const res = await request(app)
      .post("/api/v1/lead-magnets")
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ ...CAMPAIGN, name: `Тест-воронка везде ${runId}`, anyComment: true, postUrl: "" });
    expect(res.status).toBe(400);
  });
});

/**
 * ДУБЛИРОВАНИЕ (владелец 17.08.2026: «чтобы не делать одно и то же дважды»).
 *
 * Кампании под разные ролики отличаются публикацией и ключевым словом, остальное
 * общее. Проверяем ровно то, что ломается молча: копия не должна прийти включённой
 * (иначе двойник затенил бы оригинал — pickCampaign берёт первое совпадение), и её
 * PDF обязан быть ОТДЕЛЬНЫМ файлом, иначе удаление любой из двух кампаний уносит
 * файл у обеих, а вторая начинает отдавать битую ссылку недели спустя.
 */
describe("дублирование кампании", () => {
  const copies: string[] = [];

  afterEach(async () => {
    await prisma.leadMagnetCampaign.deleteMany({ where: { id: { in: copies } } });
    copies.length = 0;
  });

  it("копия повторяет тексты, но приходит выключенной и с чистыми счётчиками", async () => {
    const res = await request(app)
      .post(`/api/v1/lead-magnets/${campaignId}/duplicate`)
      .set("Authorization", `Bearer ${directorToken}`);

    expect(res.status).toBe(201);
    copies.push(res.body.id);

    expect(res.body.id).not.toBe(campaignId);
    expect(res.body.name).toBe(`${CAMPAIGN.name} (копия)`);
    // Оригинал в фикстуре ВКЛЮЧЁН — копия обязана прийти выключенной.
    expect(CAMPAIGN.enabled).toBe(true);
    expect(res.body.enabled).toBe(false);

    expect(res.body.keywords).toEqual(CAMPAIGN.keywords);
    expect(res.body.inviteText).toBe(CAMPAIGN.inviteText);
    expect(res.body.inviteButton).toBe(CAMPAIGN.inviteButton);
    expect(res.body.followText).toBe(CAMPAIGN.followText);
    expect(res.body.deliveredText).toBe(CAMPAIGN.deliveredText);
    expect(res.body.link).toBe(CAMPAIGN.link);
    expect(res.body.requireFollow).toBe(CAMPAIGN.requireFollow);
    expect(res.body.maxFollowChecks).toBe(CAMPAIGN.maxFollowChecks);
    // Журнал выдач принадлежит оригиналу: у копии он свой и пустой.
    expect(res.body.stats.invited).toBe(0);
    expect(res.body.stats.delivered).toBe(0);
  });

  it("PDF копируется отдельным файлом — удаление оригинала не ломает копию", async () => {
    const upload = await request(app)
      .post(`/api/v1/lead-magnets/${campaignId}/file`)
      .set("Authorization", `Bearer ${directorToken}`)
      .attach("file", Buffer.from("%PDF-1.4 тестовый чек-лист"), {
        filename: "checklist.pdf",
        contentType: "application/pdf",
      });
    expect(upload.status).toBe(200);
    const originalPath = upload.body.filePath as string;
    expect(originalPath).toBeTruthy();

    const res = await request(app)
      .post(`/api/v1/lead-magnets/${campaignId}/duplicate`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(201);
    copies.push(res.body.id);

    // Имя файла для человека то же, а путь на диске — свой.
    expect(res.body.fileName).toBe("checklist.pdf");
    expect(res.body.filePath).toBeTruthy();
    expect(res.body.filePath).not.toBe(originalPath);

    // Удаляем ОРИГИНАЛ вместе с его файлом — копия обязана уцелеть.
    const del = await request(app)
      .delete(`/api/v1/lead-magnets/${campaignId}`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(del.status).toBe(200);

    const copyOnDisk = path.join(uploadsDir, String(res.body.filePath).replace("/uploads/", ""));
    expect(fs.existsSync(copyOnDisk)).toBe(true);
    expect(fs.readFileSync(copyOnDisk).toString()).toContain("тестовый чек-лист");
    fs.rmSync(copyOnDisk, { force: true });
  });

  it("агент дублировать не может — это правка настроек", async () => {
    const res = await request(app)
      .post(`/api/v1/lead-magnets/${campaignId}/duplicate`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it("несуществующая кампания — 404, а не пустая копия", async () => {
    const res = await request(app)
      .post("/api/v1/lead-magnets/00000000-0000-4000-8000-000000000000/duplicate")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(404);
  });
});

/**
 * ДВА АККАУНТА И СОАВТОРСКИЙ ПОСТ (живой случай владельца 17.08.2026).
 *
 * Одно видео выложили на royal.home.tj и royalhome.info соавторами друг друга.
 * Meta доставляет комментарий под таким постом в вебхуки ОБОИХ аккаунтов, а замок
 * выдачи стоит по паре «кампания + человек» — две кампании (по одной на зеркало)
 * им не считались повтором, и человек получал два приглашения в директ, причём
 * второе — от аккаунта, которому он не писал.
 *
 * Лечится привязкой кампании к аккаунту: комментарий, пришедший в вебхук одного
 * аккаунта, видят только его кампании.
 */
describe("два аккаунта: кампания ловит только свои комментарии", () => {
  let OTHER_IG = "";
  let OWN_IG = "";
  let own: CustomerMessengerFixture;
  let other: CustomerMessengerFixture;
  let ownAccountId = "";
  const boundCampaigns: string[] = [];

  beforeEach(async () => {
    own = await createCustomerMessengerFixture("INSTAGRAM");
    other = await createCustomerMessengerFixture("INSTAGRAM");
    OWN_IG = own.turnInput(IG_USER).accountExternalId;
    OTHER_IG = other.turnInput(IG_USER).accountExternalId;
    ownAccountId = own.id;
    resetAccountsCache();
    invalidateLeadMagnetCache();
  });

  afterEach(async () => {
    await prisma.leadMagnetCampaign.deleteMany({ where: { id: { in: boundCampaigns } } });
    boundCampaigns.length = 0;
    // `bindFixtureTo` привязывает ОБЩУЮ фикстуру `campaignId` (не копию) к одному
    // из временных аккаунтов этого describe — без сброса accountId остаётся
    // висеть на уже удалённом MessengerAccount, и все описания ПОСЛЕ этого в
    // файле получают кампанию, которую resolveIncomingAccount больше ни с чем не
    // сопоставляет: tryLeadMagnetComment/tryLeadMagnetMessage перестают видеть
    // её вовсе, а не только в тестах этого блока.
    await prisma.leadMagnetCampaign.update({ where: { id: campaignId }, data: { accountId: null } }).catch(() => {});
    await own.dispose();
    await other.dispose();
    resetAccountsCache();
    invalidateLeadMagnetCache();
  });

  /** Кампания фикстуры, привязанная к одному из аккаунтов. */
  async function bindFixtureTo(accountId: string) {
    await prisma.leadMagnetCampaign.update({ where: { id: campaignId }, data: { accountId } });
    invalidateLeadMagnetCache();
  }

  it("комментарий чужого аккаунта кампанию НЕ будит", async () => {
    await bindFixtureTo(ownAccountId);

    const res = await tryLeadMagnetComment(
      { ...comment("ЧЕКЛИСТ", "cross"), accountExternalId: OTHER_IG },
      undefined
    );

    expect(res).toBeNull();
    expect(outgoing()).toHaveLength(0);
  });

  it("комментарий своего аккаунта работает как раньше", async () => {
    await bindFixtureTo(ownAccountId);

    const res = await tryLeadMagnetComment(
      { ...comment("ЧЕКЛИСТ", "own"), accountExternalId: OWN_IG },
      undefined
    );

    expect(res?.dmSent).toBe(true);
    expect(outgoing()).toHaveLength(1);
  });

  it("в приглашении есть подсказка «не видно кнопку — ответьте +»", async () => {
    /**
     * ГЛАВНЫЙ ПУТЬ, а не запасной. 17.08.2026 на проде все 18 отправок ушли
     * карточкой (пометка lead_magnet, ни одного отката), а подсказку дописывали
     * только на запасных путях — значит её не увидел ни один человек. Кто не
     * увидел кнопку, видел пустое место и не знал, что можно просто ответить.
     */
    await bindFixtureTo(ownAccountId);

    const res = await tryLeadMagnetComment(
      { ...comment("ЧЕКЛИСТ", "hint"), accountExternalId: OWN_IG },
      undefined
    );
    expect(res?.dmSent).toBe(true);

    const invite = outgoing()[0];
    expectCardText(invite.text, CAMPAIGN.inviteText);
    // Кнопка при этом никуда не делась — подсказка её дополняет, а не заменяет.
    expect(invite.buttons).toContain(CAMPAIGN.inviteButton);
  });

  it("mid приглашения от Meta сохраняется в выдаче", async () => {
    /**
     * Ради разбора жалоб «пришло пустое сообщение» (17.08.2026). Раньше при
     * успешной отправке не оставалось НИЧЕГО: ни лога, ни ответа Meta, и
     * доказывать отправку приходилось косвенно. Проверяем именно запись в базу,
     * а не сам факт вызова: смысл поля в том, что его можно предъявить потом.
     */
    await bindFixtureTo(ownAccountId);

    const res = await tryLeadMagnetComment(
      { ...comment("ЧЕКЛИСТ", "mid"), accountExternalId: OWN_IG },
      undefined
    );
    expect(res?.dmSent).toBe(true);

    const delivery = await prisma.leadMagnetDelivery.findFirst({
      where: { campaignId, igUserId: IG_USER },
      select: { inviteMid: true },
    });
    // Подменённая Meta отвечает `{ message_id: "mid-N" }` — см. stubMeta.
    expect(delivery?.inviteMid).toMatch(/^mid-/);
  });

  it("кампания без привязки ловит оба аккаунта — прежнее поведение не сломано", async () => {
    // Все кампании, заведённые до 17.08.2026, имеют accountId = null: они обязаны
    // продолжать работать без правки руками.
    const res = await tryLeadMagnetComment(
      { ...comment("ЧЕКЛИСТ", "any"), accountExternalId: OTHER_IG },
      undefined
    );

    expect(res?.dmSent).toBe(true);
  });
});

describe("комментарий с ключевым словом", () => {
  it("уходит одно личное по комментарию, с кнопкой, и публичный ответ", async () => {
    const result = await tryLeadMagnetComment(comment("Хочу чек-лист!"));
    expect(result?.publicReply).toBe("Отправил в директ");
    expect(result?.dmSent).toBe(true);

    const messages = outgoing();
    expect(messages).toHaveLength(1);
    expect(messages[0].byComment).toBe(true);
    expect(messages[0].text).toContain(CAMPAIGN.inviteText);
    expect(messages[0].buttons).toEqual(["Хочу чек-лист"]);
  });

  it("посторонний комментарий воронку не трогает", async () => {
    expect(await tryLeadMagnetComment(comment("красивая квартира"))).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("повторный комментарий того же человека второго письма не шлёт", async () => {
    await tryLeadMagnetComment(comment("чеклист", "a"));
    sent = [];
    const again = await tryLeadMagnetComment(comment("ЧЕКЛИСТ ещё раз", "b"));
    expect(again?.note).toBe("lm_repeat");
    expect(sent).toHaveLength(0);
  });

  it("ответ внутри ветки не считается заявкой", async () => {
    // Личное по такому комментарию Meta всё равно не примет: нужен корневой.
    const inThread = { ...comment("чеклист", "c"), parentId: "parent-1" };
    expect(await tryLeadMagnetComment(inThread)).toBeNull();
  });

  it("комментарий старше семи суток в директ не уходит", async () => {
    const old = { ...comment("чеклист", "d"), createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) };
    const result = await tryLeadMagnetComment(old);
    expect(result?.note).toBe("lm_window");
    expect(sent).toHaveLength(0);
  });

  /**
   * НАХОДКА НОЧНОЙ ПРОВЕРКИ 24.09.2026 (тот же класс, что Б8 в
   * messengers/comments.ts): раньше досье комментатора заводилось только когда
   * приглашение УДАВАЛОСЬ отправить (recordInConversation звалась внутри
   * `if (dmSent) …`). Окно старше 7 суток — личное вообще не пытались слать
   * (dmSent остаётся false), и карточка не заводилась совсем.
   */
  it("окно истекло — личное не уходит, но досье комментатора всё равно заводится", async () => {
    const old = { ...comment("чеклист", "d-card"), createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) };
    const result = await tryLeadMagnetComment(old);
    expect(result?.note).toBe("lm_window");
    expect(sent).toHaveLength(0);

    const conversation = await prisma.botConversation.findFirst({ where: { channel: "INSTAGRAM", subscriberId: IG_USER } });
    expect(conversation).toBeTruthy();
    expect(conversation?.contactProfileId).toBeTruthy();
  });
});

describe("ответ в директ и проверка подписки", () => {
  it("подписан — получает текст и файл", async () => {
    await tryLeadMagnetComment(comment("чеклист"));
    sent = [];

    const handled = await tryLeadMagnetMessage({
      channel: "INSTAGRAM",
      accountExternalId: instagram.externalId,
      senderId: IG_USER,
      text: "Хочу чек-лист",
      payload: `lm:${campaignId}:want`,
    });
    expect(handled).toBe(true);

    const messages = outgoing();
    expect(messages[0].text).toBe(CAMPAIGN.deliveredText);
    // Файла у кампании нет — уходит запасная ссылка, а не тишина.
    expect(messages[1].text).toBe(CAMPAIGN.link);

    const delivery = await prisma.leadMagnetDelivery.findFirst({ where: { campaignId, igUserId: IG_USER } });
    expect(delivery?.state).toBe("DELIVERED");
    expect(delivery?.wasFollowing).toBe(true);
  });

  it("не подписан — просим подписаться, потом отдаём", async () => {
    await tryLeadMagnetComment(comment("чеклист"));
    sent = [];
    following = false;

    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "хочу", payload: `lm:${campaignId}:want` });
    expectCardText(outgoing()[0].text, CAMPAIGN.followText);
    expect(outgoing()[0].buttons).toEqual(["Я подписался"]);
    expect((await prisma.leadMagnetDelivery.findFirst({ where: { campaignId } }))?.state).toBe("AWAITING_FOLLOW");

    // Нажал «я подписался», а подписки всё ещё не видно — второй текст, не первый.
    sent = [];
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "готово", payload: `lm:${campaignId}:followed` });
    expectCardText(outgoing()[0].text, CAMPAIGN.notFollowingText);

    // Подписался по-настоящему — файл уходит.
    sent = [];
    following = true;
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "теперь да", payload: `lm:${campaignId}:followed` });
    expect(outgoing()[0].text).toBe(CAMPAIGN.deliveredText);
    expect((await prisma.leadMagnetDelivery.findFirst({ where: { campaignId } }))?.state).toBe("DELIVERED");
  });

  it("после предела проверок воронка замолкает и отдаёт ход боту", async () => {
    // Человек, которого спрашивают четвёртый раз, уходит и жалуется на спам.
    await tryLeadMagnetComment(comment("чеклист"));
    following = false;
    for (let i = 0; i < CAMPAIGN.maxFollowChecks; i++) {
      await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "готово", payload: `lm:${campaignId}:followed` });
    }
    sent = [];
    const handled = await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "ну где" });
    expect(handled).toBe(false);
    expect(sent).toHaveLength(0);
    expect((await prisma.leadMagnetDelivery.findFirst({ where: { campaignId } }))?.state).toBe("FAILED");
  });

  it("проверить подписку не удалось — файл всё равно уходит", async () => {
    // Пустое поле у Graph API значит «не знаем», а не «не подписан». Человек
    // пришёл с оплаченной рекламы: наш сбой не повод оставлять его ни с чем.
    await tryLeadMagnetComment(comment("чеклист"));
    sent = [];
    following = undefined;

    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "хочу", payload: `lm:${campaignId}:want` });
    const delivery = await prisma.leadMagnetDelivery.findFirst({ where: { campaignId } });
    expect(delivery?.state).toBe("DELIVERED");
    expect(delivery?.wasFollowing).toBeNull();
  });

  it("человек не из воронки идёт обычным путём", async () => {
    const handled = await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: `stranger-${runId}`, text: "здравствуйте" });
    expect(handled).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("после выдачи разговор возвращается боту", async () => {
    await tryLeadMagnetComment(comment("чеклист"));
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "хочу", payload: `lm:${campaignId}:want` });
    sent = [];
    // Следующее сообщение воронка не перехватывает — иначе человек, спросивший про
    // квартиру, разговаривал бы со стеной.
    expect(await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "а квартиры есть?" })).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("вся переписка воронки видна в CRM", async () => {
    // Иначе в разделе «Сообщения» человек ни с того ни с сего пишет «спасибо» в
    // пустой диалог, а куда делось всё до этого — неизвестно.
    await tryLeadMagnetComment(comment("чеклист"));
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "Хочу чек-лист", payload: `lm:${campaignId}:want` });

    const conversation = await prisma.botConversation.findUnique({
      where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId: IG_USER } },
    });
    const messages = (conversation?.messages ?? []) as { role: string; content: string }[];
    expect(messages.map((m) => m.content)).toContain(CAMPAIGN.inviteText);
    expect(messages.map((m) => m.content)).toContain(CAMPAIGN.deliveredText);
    expect(messages.some((m) => m.role === "user" && m.content === "Хочу чек-лист")).toBe(true);
  });

  it("эхо собственных сообщений воронки не дублирует их и не ставит бота на паузу", async () => {
    /**
     * 17.08.2026, жалоба владельца: «воронка отправляет каждое сообщение дважды
     * после нажатия кнопки». На самом деле Meta отправляла его один раз, но эхо
     * этого же исходящего возвращалось вебхуком (is_echo) и попадало в
     * handleOutgoingEcho — тот не находил свой mid в истории (recordInConversation
     * его не сохранял) и записывал письмо ВТОРОЙ раз, как будто ответил сотрудник
     * из телефона мимо CRM, вдобавок ставя бота на паузу.
     */
    await tryLeadMagnetComment(comment("чеклист"));
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "Хочу чек-лист", payload: `lm:${campaignId}:want` });

    const before = await prisma.botConversation.findUnique({
      where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId: IG_USER } },
    });
    const beforeMessages = (before?.messages ?? []) as { role: string; content: string; mid?: string }[];
    const invite = beforeMessages.find((m) => m.content === CAMPAIGN.inviteText);
    const delivered = beforeMessages.find((m) => m.content === CAMPAIGN.deliveredText);
    // Каждое исходящее сообщение воронки обязано нести mid — без него эхо не отличить от чужого.
    expect(invite?.mid).toBeTruthy();
    expect(delivered?.mid).toBeTruthy();

    await handleOutgoingEcho({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: CAMPAIGN.inviteText, messageId: invite!.mid });
    await handleOutgoingEcho({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: CAMPAIGN.deliveredText, messageId: delivered!.mid });

    const after = await prisma.botConversation.findUnique({
      where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId: IG_USER } },
    });
    const afterMessages = (after?.messages ?? []) as { role: string; content: string }[];
    expect(afterMessages).toHaveLength(beforeMessages.length);
    expect(afterMessages.filter((m) => m.content === CAMPAIGN.deliveredText)).toHaveLength(1);
    // Главное: бот не должен думать, что сотрудник перехватил разговор вручную.
    expect(after?.pausedUntil).toBeNull();
  });

  it("эхо, обогнавшее запись переписки, тоже узнаётся своим", async () => {
    /**
     * 18.08.2026, живой диалог @farruhruz_. Предыдущий тест закрывал случай, когда
     * mid УЖЕ лежит в переписке. Но воронка шлёт пачкой — сперва текст, потом PDF —
     * а историю с mid'ами пишет одним махом в самом конце. Эхо первого сообщения
     * приходит в эту щель: текст ушёл в 09:11:17, эхо вернулось в ту же секунду, а
     * mid'ы легли в переписку только в 09:11:20. Три секунды, за которые CRM
     * приняла собственное сообщение воронки за ручной ответ сотрудника: вторая
     * копия в переписке (владелец: «отправляется два сообщения») и пауза бота на
     * 10 минут на живом лиде.
     *
     * Здесь эта щель воспроизведена буквально: разговор есть, mid'а в нём ещё нет,
     * но отметка об отправке уже стоит (messengers/outgoingMids.ts).
     */
    const RACE_MID = `mid-race-${Date.now()}`;
    await tryLeadMagnetComment(comment("чеклист"));
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "Хочу чек-лист", payload: `lm:${campaignId}:want` });

    const before = await prisma.botConversation.findUnique({
      where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId: IG_USER } },
    });
    const beforeMessages = (before?.messages ?? []) as { role: string; content: string }[];

    // Отправка состоялась — транспорт отметил mid; переписку с ним ещё не записали.
    await rememberOutgoingMid(RACE_MID);
    await handleOutgoingEcho({
      channel: "INSTAGRAM",
      accountExternalId: instagram.externalId,
      senderId: IG_USER,
      text: CAMPAIGN.deliveredText,
      messageId: RACE_MID,
    });

    const after = await prisma.botConversation.findUnique({
      where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId: IG_USER } },
    });
    const afterMessages = (after?.messages ?? []) as { role: string; content: string }[];
    expect(afterMessages).toHaveLength(beforeMessages.length);
    expect(after?.pausedUntil).toBeNull();
  });

  it("настоящий ручной ответ сотрудника по-прежнему глушит бота", async () => {
    // Обратная сторона: отметки об отправке НЕТ — значит писал человек из
    // приложения мимо CRM, и бот обязан замолчать. Иначе защита выше превратилась
    // бы в «эхо игнорируем всегда» и сломала бы перехват разговора сотрудником.
    await tryLeadMagnetComment(comment("чеклист"));
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "Хочу чек-лист", payload: `lm:${campaignId}:want` });

    await handleOutgoingEcho({
      channel: "INSTAGRAM",
      accountExternalId: instagram.externalId,
      senderId: IG_USER,
      text: "Здравствуйте, это Нурмухаммад, отвечаю лично",
      messageId: `mid-manual-${Date.now()}`,
    });

    const after = await prisma.botConversation.findUnique({
      where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId: IG_USER } },
    });
    const afterMessages = (after?.messages ?? []) as { role: string; content: string }[];
    expect(afterMessages.some((m) => m.content === "Здравствуйте, это Нурмухаммад, отвечаю лично")).toBe(true);
    expect(after?.pausedUntil).not.toBeNull();
  });
});

describe("чем выдаём — решает владелец", () => {
  it("без файла и без ссылки выдача идёт текстом и считается успешной", async () => {
    // Лид-магнит — это обещание, а не обязательно PDF: промокод, адрес, ответ на
    // вопрос. Раньше такая кампания попадала в «не дошло», хотя человек всё получил.
    await prisma.leadMagnetCampaign.update({ where: { id: campaignId }, data: { link: null } });
    invalidateLeadMagnetCache();

    await tryLeadMagnetComment(comment("чеклист"));
    sent = [];
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "хочу", payload: `lm:${campaignId}:want` });

    const messages = outgoing();
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe(CAMPAIGN.deliveredText);
    const delivery = await prisma.leadMagnetDelivery.findFirst({ where: { campaignId } });
    expect(delivery?.state).toBe("DELIVERED");
    expect(delivery?.deliveredAsFile).toBe(false);
  });

  it("без требования подписки выдаём сразу и подписку не спрашиваем", async () => {
    await prisma.leadMagnetCampaign.update({ where: { id: campaignId }, data: { requireFollow: false } });
    invalidateLeadMagnetCache();
    following = false;

    await tryLeadMagnetComment(comment("чеклист"));
    sent = [];
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "хочу", payload: `lm:${campaignId}:want` });

    expect(outgoing()[0].text).toBe(CAMPAIGN.deliveredText);
    expect((await prisma.leadMagnetDelivery.findFirst({ where: { campaignId } }))?.state).toBe("DELIVERED");
  });

  it("строгий вариант: не смогли подтвердить подписку — не выдаём", async () => {
    // Тумблер «выдавать, если Instagram не ответил» выключен. Тогда пустой ответ
    // Graph API приравнивается к «подписки нет»: просим подписаться, но не отдаём.
    await prisma.leadMagnetCampaign.update({ where: { id: campaignId }, data: { deliverIfUnsure: false } });
    invalidateLeadMagnetCache();

    await tryLeadMagnetComment(comment("чеклист"));
    sent = [];
    following = undefined;
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "хочу", payload: `lm:${campaignId}:want` });

    expectCardText(outgoing()[0].text, CAMPAIGN.followText);
    expect((await prisma.leadMagnetDelivery.findFirst({ where: { campaignId } }))?.state).toBe("AWAITING_FOLLOW");
  });

  it("не подписан — файл не уходит ни при каких повторах", async () => {
    // Главное требование владельца: без подписки не выдавать. Проверяем не одну
    // ступень, а всю ветку до конца — включая момент, когда воронка сдаётся.
    await tryLeadMagnetComment(comment("чеклист"));
    following = false;
    sent = [];
    for (let i = 0; i <= CAMPAIGN.maxFollowChecks + 1; i++) {
      await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "дай", payload: `lm:${campaignId}:followed` });
    }
    // Ни одного сообщения с выдачей: только просьбы подписаться.
    expect(outgoing().every((m) => m.text !== CAMPAIGN.deliveredText)).toBe(true);
    expect((await prisma.leadMagnetDelivery.findFirst({ where: { campaignId } }))?.state).toBe("FAILED");
  });
});

describe("сбой не должен терять оплаченный лид", () => {
  it("приглашение не ушло — следующий комментарий пробует ещё раз", async () => {
    // Один отказ Meta оставлял запись в FAILED, и человек для воронки переставал
    // существовать: следующая ступень ищет только незакрытые, а замок от повтора
    // не давал написать снова. Лид с оплаченной рекламы терялся молча.
    sendFails = true;
    const failed = await tryLeadMagnetComment(comment("чеклист", "x"));
    expect(failed?.note).toBe("lm_dm_failed");
    expect((await prisma.leadMagnetDelivery.findFirst({ where: { campaignId } }))?.state).toBe("FAILED");
    // Приглашение не ушло (dmSent=false) — досье комментатора всё равно должно
    // быть заведено, находка 24.09.2026, тот же класс, что Б8 в comments.ts.
    const conversationAfterFailure = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: IG_USER },
    });
    expect(conversationAfterFailure).toBeTruthy();
    expect(conversationAfterFailure?.contactProfileId).toBeTruthy();

    sendFails = false;
    sent = [];
    const retry = await tryLeadMagnetComment(comment("ЧЕКЛИСТ", "y"));
    expect(retry?.dmSent).toBe(true);
    expect(outgoing()[0].text).toContain(CAMPAIGN.inviteText);
    expect((await prisma.leadMagnetDelivery.findFirst({ where: { campaignId } }))?.state).toBe("INVITED");
  });

  it("подписался позже и написал сам — файл всё-таки уходит, но просьб больше нет", async () => {
    await tryLeadMagnetComment(comment("чеклист"));
    following = false;
    for (let i = 0; i <= CAMPAIGN.maxFollowChecks; i++) {
      await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "готово", payload: `lm:${campaignId}:followed` });
    }
    expect((await prisma.leadMagnetDelivery.findFirst({ where: { campaignId } }))?.state).toBe("FAILED");

    // Пока подписки нет — молчим и не начинаем второй круг просьб.
    sent = [];
    expect(await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "ну как?" })).toBe(false);
    expect(sent).toHaveLength(0);

    // Подписался и написал — условие выполнено, файл он получить обязан.
    following = true;
    expect(await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "подписался" })).toBe(true);
    expect(outgoing()[0].text).toBe(CAMPAIGN.deliveredText);
    const delivery = await prisma.leadMagnetDelivery.findFirst({ where: { campaignId } });
    expect(delivery?.state).toBe("DELIVERED");
    expect(delivery?.lastError).toBeNull();
  });
});

describe("«любой комментарий» — не буквально любой", () => {
  it("грубость и обвинение не получают бодрую заготовку", () => {
    // «Мошенники!» в ответ на «чек-лист готов, жмите кнопку» читается как
    // издевательство, а скрыть комментарий модель уже не может — воронка
    // перехватила его раньше модерации.
    expect(isHostileComment("мошенники!!")).toBe(true);
    expect(isHostileComment("это развод и обман")).toBe(true);
    expect(isHostileComment("қаллобон")).toBe(true);
    expect(isHostileComment("🖕")).toBe(true);
  });

  it("обычное возражение остаётся в воронке", () => {
    // «Дорого» под рекламой чек-листа о ценах пишет ровно тот, кому чек-лист нужен.
    expect(isHostileComment("дорого")).toBe(false);
    expect(isHostileComment("а сколько стоит?")).toBe(false);
    expect(isHostileComment("хочу чек-лист")).toBe(false);
    // Настоящий продавец: «развод» в падежной форме — это про жизнь, а не про нас.
    expect(isHostileComment("после развода продаём квартиру")).toBe(false);
  });

  it("враждебный комментарий под кампанией «на всё» идёт обычным путём", async () => {
    await prisma.leadMagnetCampaign.update({
      where: { id: campaignId },
      data: { anyComment: true, postUrl: "https://www.instagram.com/reel/ANY1/", mediaId: `media-${runId}` },
    });
    invalidateLeadMagnetCache();
    expect(await tryLeadMagnetComment(comment("это обман, не ведитесь"))).toBeNull();
    expect(sent).toHaveLength(0);
    // Комментарий не признан заявкой воронки (isHostileComment) — карточку не заводим.
    const conversation = await prisma.botConversation.findFirst({ where: { channel: "INSTAGRAM", subscriberId: IG_USER } });
    expect(conversation).toBeNull();
  });

  it("ключевое слово главнее: человек попросил файл — файл будет, что бы ни было вокруг", async () => {
    const result = await tryLeadMagnetComment(comment("чеклист, хотя выглядит как развод 🙂"));
    expect(result?.dmSent).toBe(true);
  });
});

describe("репетиция — тот же путь, что у живого человека", () => {
  const campaign = (over: Partial<ActiveCampaign> = {}): ActiveCampaign => ({
    id: "c1",
    name: "Тест",
    enabled: true,
    postUrl: null,
    mediaId: null,
    keywords: ["ЧЕКЛИСТ"],
    anyComment: false,
    publicReplies: ["Отправил в директ"],
    inviteText: "Жмите кнопку",
    inviteButton: "Хочу чек-лист",
    requireFollow: true,
    followText: "Подпишитесь сначала",
    followButton: "Я подписался",
    notFollowingText: "Пока не вижу подписку",
    maxFollowChecks: 3,
    deliverIfUnsure: true,
    deliveredText: "Держите",
    filePath: "/uploads/lead-magnets/x.pdf",
    fileName: "checklist.pdf",
    link: null,
    handoffToBot: true,
    ...over,
  });

  it("живая фраза с ключевым словом проходит весь путь до файла", () => {
    const steps = rehearseCampaign(campaign(), { comment: "хочу чек-лист пожалуйста", following: "yes" });
    const texts = steps.map((s) => s.text).join("\n");
    expect(texts).toContain("Отправил в директ");
    expect(texts).toContain("Жмите кнопку");
    expect(steps.some((s) => s.file === "checklist.pdf")).toBe(true);
  });

  it("фраза без слова честно говорит «воронка промолчит»", () => {
    const steps = rehearseCampaign(campaign(), { comment: "красивая квартира", following: "yes" });
    expect(steps.some((s) => s.who === "note" && s.text.includes("промолчит"))).toBe(true);
    expect(steps.some((s) => s.file)).toBe(false);
  });

  it("не подписан — показывает просьбу, выдачу после подписки и предел проверок", () => {
    const steps = rehearseCampaign(campaign(), { comment: "чеклист", following: "no" });
    const texts = steps.map((s) => s.text).join("\n");
    expect(texts).toContain("Подпишитесь сначала");
    expect(texts).toContain("Держите");
    expect(texts).toContain("не больше 3 раз");
  });

  it("строгий режим при молчании Instagram показывает просьбу, а не выдачу", () => {
    const steps = rehearseCampaign(campaign({ deliverIfUnsure: false }), { comment: "чеклист", following: "unknown" });
    const texts = steps.map((s) => s.text).join("\n");
    expect(texts).toContain("Подпишитесь сначала");
    expect(steps.some((s) => s.file)).toBe(false);
  });

  it("кампания без файла и без ссылки предупреждает про выдачу текстом", () => {
    const steps = rehearseCampaign(campaign({ filePath: null, fileName: null }), {
      comment: "чеклист",
      following: "yes",
    });
    expect(steps.some((s) => s.who === "note" && s.text.includes("только текстом"))).toBe(true);
  });
});

describe("выключенная кампания", () => {
  it("новых людей в воронку не пускает", async () => {
    await prisma.leadMagnetCampaign.update({ where: { id: campaignId }, data: { enabled: false } });
    invalidateLeadMagnetCache();
    expect(await tryLeadMagnetComment(comment("чеклист"))).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("но уже приглашённым файл всё равно отдаёт", async () => {
    // Реклама кончилась, владелец убрал галочку — а люди продолжают нажимать
    // кнопку ещё сутками. Обещание им дала CRM, и снятая галочка его не отменяет.
    await tryLeadMagnetComment(comment("чеклист"));
    await prisma.leadMagnetCampaign.update({ where: { id: campaignId }, data: { enabled: false } });
    invalidateLeadMagnetCache();
    sent = [];

    expect(await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "нажал" })).toBe(true);
    expect(outgoing()[0].text).toBe(CAMPAIGN.deliveredText);
  });
});

/**
 * ОДНОВРЕМЕННАЯ ДОСТАВКА — то, чего не видно в последовательных проверках выше.
 *
 * Повтор от Meta приходит именно тогда, когда мы не успели ответить 200, то есть
 * ВТОРЫМ HTTP-запросом ПАРАЛЛЕЛЬНО первому. Обработчики в вебхуке идут каждый в
 * своём запросе: последовательная проверка «а не выдали ли уже» их не разводит —
 * оба читают одно и то же состояние и оба идут отправлять.
 *
 * Под рекламой это не теория: чем больше входящих, тем чаще мы не укладываемся в
 * срок ответа Meta и тем чаще она повторяет доставку.
 */
describe("повтор доставки приходит ПАРАЛЛЕЛЬНО, а не по очереди", () => {
  it("два одновременных нажатия кнопки тратят одно личное сообщение по комментарию", async () => {
    // Комментарий тоже может приехать дважды разом: приглашение Meta разрешает
    // ровно одно, и второе — это выброшенная в никуда единственная попытка.
    const [first, second] = await Promise.all([
      tryLeadMagnetComment(comment("чеклист", "par-a")),
      tryLeadMagnetComment(comment("чеклист", "par-b")),
    ]);
    const invites = outgoing().filter((m) => m.byComment);
    expect(invites).toHaveLength(1);
    expect([first?.note, second?.note].sort()).toEqual(["lead_magnet", "lm_repeat"]);
  });

  it("два одновременных нажатия «Хочу чек-лист» отдают файл ОДИН раз", async () => {
    await tryLeadMagnetComment(comment("чеклист"));
    sent = [];

    const press = () =>
      tryLeadMagnetMessage({
        channel: "INSTAGRAM",
        accountExternalId: instagram.externalId,
        senderId: IG_USER,
        text: "Хочу чек-лист",
        payload: `lm:${campaignId}:want`,
      });
    await Promise.all([press(), press()]);

    // Человек обещанное получил ровно один раз: две копии чек-листа подряд — это
    // не «повезло дважды», а видимая неисправность, с которой идут в поддержку.
    const delivered = outgoing().filter((m) => m.text === CAMPAIGN.deliveredText);
    expect(delivered).toHaveLength(1);

    const delivery = await prisma.leadMagnetDelivery.findFirst({ where: { campaignId, igUserId: IG_USER } });
    expect(delivery?.state).toBe("DELIVERED");
  });
});

/**
 * СЛОВО ВОРОНКИ ПРИНАДЛЕЖИТ ВОРОНКЕ (решение владельца 16.08.2026).
 *
 * Кампанию забыли включить, человек написал под роликом «Дастур», и ответил
 * обычный бот: «Салом! Ба директ нависед». Реклама оплачена, отклик потерян, а по
 * переписке видно вежливый ответ — то есть потерю не заметишь.
 */
describe("ключевое слово воронки не достаётся обычному боту", () => {
  it("узнаётся, даже когда кампания выключена", async () => {
    await prisma.leadMagnetCampaign.update({ where: { id: campaignId }, data: { enabled: false } });
    invalidateLeadMagnetCache();

    // Имя кампании не проверяем: в базе стенда живут и другие кампании с тем же
    // словом, и совпасть может любая. Важно ровно одно — слово опознано как
    // принадлежащее воронке, а значит обычный бот на него не ответит.
    const verdict = await isFunnelKeyword({ text: `хочу ${CAMPAIGN.keywords[0]}` });
    expect(verdict).not.toBeNull();
  });

  it("обычный вопрос про квартиру воронке не принадлежит", async () => {
    expect(await isFunnelKeyword({ text: "Ин хона чанд пул?" })).toBeNull();
  });
});

describe("второе «я подписался» открывает выдачу — переключатель кампании", () => {
  /**
   * Разбор прода 30.08.2026. Живой диалог: человек нажал «Гирифтани PDF»,
   * подписался, нажал «Ман обуна шудам ✅» — и получил «Обунаро ҳанӯз намебинам».
   * Нажал ещё раз — то же самое слово в слово, и так до предела проверок. Восемь
   * человек застряли здесь, последняя выдача файла была 27.08 при том, что
   * приглашения шли до 29.08. Из 46 успешных выдач у ВСЕХ подписка подтвердилась —
   * значит на неподтверждённых воронка не отдавала ни разу.
   *
   * Instagram отвечает твёрдое «не подписан», а не молчит, поэтому настройка
   * «отдавать при сомнении» сюда не дотягивается — нужен свой переключатель.
   * Он ВЫКЛЮЧЕН по умолчанию: у владельца есть прямое требование «без подписки не
   * выдавать», и молча его переопределять нельзя (тест «не подписан — файл не
   * уходит ни при каких повторах» ниже проверяет, что оно в силе).
   */
  beforeEach(async () => {
    await prisma.leadMagnetDelivery.deleteMany({ where: { campaignId } });
    await prisma.leadMagnetCampaign.update({ where: { id: campaignId }, data: { deliverOnSecondClaim: false } });
    invalidateLeadMagnetCache();
  });

  it("выключен по умолчанию — второе нажатие ничего не меняет", async () => {
    await tryLeadMagnetComment(comment("чеклист"));
    following = false;
    sent = [];
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "хочу", payload: `lm:${campaignId}:want` });
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "готово", payload: `lm:${campaignId}:followed` });
    sent = [];
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "готово", payload: `lm:${campaignId}:followed` });

    expect(outgoing().every((m) => m.text !== CAMPAIGN.deliveredText)).toBe(true);
  });

  it("включён — на второе нажатие файл уходит, в журнале честно «подписка не подтверждена»", async () => {
    await prisma.leadMagnetCampaign.update({ where: { id: campaignId }, data: { deliverOnSecondClaim: true } });
    invalidateLeadMagnetCache();

    await tryLeadMagnetComment(comment("чеклист"));
    following = false;
    sent = [];

    // Первое нажатие — по-прежнему просьба подписаться: человек мог нажать, не
    // подписавшись, и эта просьба работает.
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "хочу", payload: `lm:${campaignId}:want` });
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "готово", payload: `lm:${campaignId}:followed` });
    expect(outgoing().every((m) => m.text !== CAMPAIGN.deliveredText)).toBe(true);

    // Второе — это уже осознанное «я сделал»: между нажатиями он сходил и проверил.
    sent = [];
    await tryLeadMagnetMessage({ channel: "INSTAGRAM", accountExternalId: instagram.externalId, senderId: IG_USER, text: "точно подписался", payload: `lm:${campaignId}:followed` });
    expect(outgoing()[0].text).toBe(CAMPAIGN.deliveredText);

    const delivery = await prisma.leadMagnetDelivery.findFirst({ where: { campaignId } });
    expect(delivery?.state).toBe("DELIVERED");
    // Честная запись: файл отдан по слову человека, а не по подтверждённой подписке.
    expect(delivery?.wasFollowing).toBe(false);

    await prisma.leadMagnetCampaign.update({ where: { id: campaignId }, data: { deliverOnSecondClaim: false } });
    invalidateLeadMagnetCache();
  });
});
