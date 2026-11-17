import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * КОММЕНТАРИЙ ПОД ПОСТОМ СТРАНИЦЫ FACEBOOK, ПОДКЛЮЧЁННОЙ ЧЕРЕЗ НАСТРОЙКИ
 * (прод, ErrorLog 15.10–07.11.2026: «Досье комментатора … не заведено»,
 * «Интерес клиента к объекту №192 не записан», «Личное по комментарию … не
 * записано в переписку» — всё `Customer endpoint denied: account_unknown`).
 *
 * У такой страницы нет строки MessengerAccount: resolveIncomingAccount отдаёт
 * id = null. Путь комментария передавал дальше только этот null, без страницы,
 * которой Meta адресовала комментарий, — и scope отказывал. Ответ при этом
 * уходил (отправка находит страницу из Настроек сама), поэтому снаружи поломку
 * не было видно. Личное входящее (routes/webhooks.ts) передаёт обе половины
 * и работало. Тест держит одну дверь — commentAuthorScope — и все вызовы
 * записи по комментарию через неё.
 *
 * Настройки — общий singleton базы, его не трогаем (тесты идут в два процесса):
 * «страница из Настроек» подставлена через readInstalledCustomerTransport,
 * остальной путь scope — настоящий, по базе.
 */
const PAGE = vi.hoisted(() => `fb-settings-page-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

vi.mock("../src/lib/customerInstalledTransport.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/customerInstalledTransport.js")>();
  return {
    ...original,
    readInstalledCustomerTransport: vi.fn(async (db: Parameters<typeof original.readInstalledCustomerTransport>[0],
      channel: string, requestedExternalId?: string) => {
      if (channel === "FACEBOOK" && requestedExternalId === PAGE) {
        return { channel: "FACEBOOK" as const, externalId: PAGE, transportKey: `settings:FACEBOOK:${PAGE}`,
          signingSecret: null, endpointScopeId: null, scopeRevision: null, policyRevision: null };
      }
      return original.readInstalledCustomerTransport(db, channel, requestedExternalId);
    }),
  };
});

import { prisma } from "../src/db.js";
import { commentAuthorScope } from "../src/messengers/comments.js";
import { ensureConversationId } from "../src/messengers/conversationStore.js";
import { recordClientInterest } from "../src/messengers/sharedMedia.js";
import { CustomerScopeDenied } from "../src/lib/customerConversationScope.js";

const run = randomUUID().slice(0, 8);
const authors: string[] = [];
let ownerId = "";
let propertyId = "";
let shortId = 0;

beforeAll(async () => {
  ownerId = (await prisma.agent.create({ data: { fullName: `FB comment owner ${run}`,
    phone: `+9929${randomInt(10_000_000, 99_999_999)}`, passwordHash: "fixture", role: "AGENT" } })).id;
  const property = await prisma.property.create({ data: { title: `FB comment property ${run}`, type: "APARTMENT",
    address: "Synthetic district", areaSqm: 60, price: 200_000, currency: "TJS", condition: "GOOD", status: "AVAILABLE",
    intakeAgentId: ownerId } });
  propertyId = property.id;
  shortId = property.shortId;
});

afterAll(async () => {
  const convs = await prisma.botConversation.findMany({ where: { channel: "FACEBOOK", subscriberId: { in: authors } },
    select: { id: true, contactProfileId: true } });
  await prisma.propertyExposure.deleteMany({ where: { channel: "FACEBOOK", recipientId: { in: authors } } });
  await prisma.conversationProperty.deleteMany({ where: { conversationId: { in: convs.map((c) => c.id) } } });
  await prisma.customerInquiry.deleteMany({ where: { conversationId: { in: convs.map((c) => c.id) } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: convs.map((c) => c.id) } } });
  const profiles = convs.map((c) => c.contactProfileId).filter((id): id is string => Boolean(id));
  if (profiles.length) await prisma.contactProfile.deleteMany({ where: { id: { in: profiles } } });
  await prisma.customerEndpointScope.deleteMany({ where: { channel: "FACEBOOK", transportKey: `settings:FACEBOOK:${PAGE}` } });
  if (propertyId) await prisma.property.delete({ where: { id: propertyId } });
  if (ownerId) await prisma.agent.delete({ where: { id: ownerId } });
});

const author = () => {
  const id = `fb-author-${run}-${authors.length}`;
  authors.push(id);
  return id;
};
const property = () => ({ id: propertyId, shortId, status: "AVAILABLE", intakeAgentId: ownerId,
  assignedAgentId: null, createdById: null });

describe("комментарий страницы Facebook из Настроек (account.id = null)", () => {
  it("досье: диалог заводится в namespace страницы, без строки аккаунта", async () => {
    const authorId = author();
    const row = { channel: "FACEBOOK", authorId, accountExternalId: PAGE };
    const scope = await commentAuthorScope(row, null);
    expect(scope.accountId).toBeNull();
    expect(scope.transport?.transportKey).toBe(`settings:FACEBOOK:${PAGE}`);

    const conversationId = await ensureConversationId("FACEBOOK", authorId, "Синтетический автор", scope.accountId, false, scope.transport);
    const conv = await prisma.botConversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conv.accountId).toBeNull();
    expect(conv.endpointScopeId).toBe(scope.transport?.endpointScopeId);

    // Повторный комментарий того же автора — тот же диалог, не второй.
    const again = await commentAuthorScope(row, null);
    expect(await ensureConversationId("FACEBOOK", authorId, undefined, again.accountId, false, again.transport)).toBe(conversationId);
  });

  it("интерес к объекту пишется тем же namespace", async () => {
    const authorId = author();
    const scope = await commentAuthorScope({ channel: "FACEBOOK", authorId, accountExternalId: PAGE }, null);
    await recordClientInterest(property(), "FACEBOOK", authorId, undefined, scope.transport ?? null);
    const exposure = await prisma.propertyExposure.findFirst({ where: { channel: "FACEBOOK", recipientId: authorId, propertyId } });
    expect(exposure?.kind).toBe("CLIENT_SHARED");
    expect(exposure?.endpointScopeId).toBe(scope.transport?.endpointScopeId);
  });

  it("механизм поломки: один голый null без страницы — отказ account_unknown, запись не появляется", async () => {
    const authorId = author();
    await expect(ensureConversationId("FACEBOOK", authorId, undefined, null, false)).rejects.toThrow("account_unknown");
    await recordClientInterest(property(), "FACEBOOK", authorId, undefined, null);
    expect(await prisma.propertyExposure.count({ where: { channel: "FACEBOOK", recipientId: authorId } })).toBe(0);
  });

  it("чужая страница (не из Настроек и без строки аккаунта) по-прежнему получает отказ", async () => {
    const authorId = author();
    await expect(commentAuthorScope({ channel: "FACEBOOK", authorId, accountExternalId: `${PAGE}-foreign` }, null))
      .rejects.toBeInstanceOf(CustomerScopeDenied);
  });

  it("строка аккаунта есть — прежний путь без изменений, страница не подмешивается", async () => {
    const scope = await commentAuthorScope({ channel: "INSTAGRAM", authorId: "x", accountExternalId: "17841400000000000" }, "acc-1");
    expect(scope).toEqual({ accountId: "acc-1" });
    const yt = await commentAuthorScope({ channel: "YOUTUBE", authorId: "x", accountExternalId: "UCxxxx" }, null);
    expect(yt).toEqual({ accountId: null });
  });
});

/**
 * СТОРОЖ КЛАССА: каждая запись в CRM по комментарию (досье, переписка, интерес
 * к объекту) берёт namespace из commentAuthorScope, а не голый account.id.
 * Новый вызов ensureConversationId в comments.ts без scope.transport — красный.
 */
describe("сторож: comments.ts пишет только через commentAuthorScope", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, "../src/messengers/comments.ts"), "utf8").replace(/\r\n/g, "\n");

  it("каждый ensureConversationId( получает scope.transport", () => {
    const calls = [...source.matchAll(/await ensureConversationId\(([\s\S]*?)\);/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const args of calls) expect(args).toMatch(/scope\.transport\s*$/);
  });

  it("recordClientInterest из комментария получает namespace автора, а не голый account.id", () => {
    const calls = [...source.matchAll(/recordClientInterest\(([\s\S]*?)\n\s*\);/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const args of calls) expect(args).toMatch(/authorTransport \?\? account\.id\s*$/);
  });
});
