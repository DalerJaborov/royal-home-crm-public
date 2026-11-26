import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

/**
 * МЁРТВЫЙ КЛЮЧ INSTAGRAM — ПОСЛЕ СВОДА С #440 (26.11.2026). В main пришла ещё одна копия правила «Meta точно не
 * приняла» — conversationDelivery.ts::isDefiniteSendRejection для фото и видео сотрудника, — и она не знала
 * «доступ к аккаунту потерян, запроса не было». Отказ без запроса считался «исход неизвестен»: пауза бота не
 * откатывалась, «Повторить» не предлагалось. Теперь правило одно (lib/metaProviderRejection.ts).
 *
 * И экран: отметка видна в «Аккаунтах Instagram» рядом с «Заменить маркер» (listAccounts отдаёт accessLostAt).
 */
const { prisma } = await import("../src/db.js");
const { isDefiniteSendRejection } = await import("../src/lib/conversationDelivery.js");
const { InstagramAccessLostError, isProviderDefinitiveRejection } = await import("../src/lib/metaProviderRejection.js");
const { listAccounts, resetAccountsCache } = await import("../src/messengers/accounts.js");

const created: string[] = [];
afterAll(async () => {
  await prisma.messengerAccount.deleteMany({ where: { id: { in: created } } });
});

describe("«Meta точно не приняла» — одно правило и для файлов сотрудника", () => {
  it("доступ к аккаунту потерян (запроса не было) — заведомый отказ и для текста, и для фото/видео", () => {
    const err = new InstagramAccessLostError("acc-1", "HTTP 401: session invalidated");
    expect(isProviderDefinitiveRejection(err)).toBe(true);
    expect(isDefiniteSendRejection(err)).toBe(true);
  });

  it("5xx и обрыв — по-прежнему «исход неизвестен», 4xx — отказ", () => {
    expect(isDefiniteSendRejection(new Error("Graph API HTTP 502: bad gateway"))).toBe(false);
    expect(isDefiniteSendRejection(new Error("socket hang up"))).toBe(false);
    expect(isDefiniteSendRejection(new Error("Graph API HTTP 401: session invalidated"))).toBe(true);
  });
});

describe("экран «Аккаунты Instagram» видит отметку", () => {
  it("listAccounts отдаёт accessLostAt и причину; без отметки — null", async () => {
    const lostAt = new Date("2026-11-24T03:18:00.000Z");
    const dead = await prisma.messengerAccount.create({
      data: {
        channel: "INSTAGRAM", externalId: `ig-dead-${randomUUID().slice(0, 8)}`, title: "Мёртвый ключ", token: "",
        accessLostAt: lostAt, accessLostReason: "HTTP 401: The session has been invalidated",
      },
    });
    const live = await prisma.messengerAccount.create({
      data: { channel: "INSTAGRAM", externalId: `ig-live-${randomUUID().slice(0, 8)}`, title: "Живой", token: "" },
    });
    created.push(dead.id, live.id);
    resetAccountsCache();
    const items = await listAccounts("INSTAGRAM");
    const d = items.find((a) => a.id === dead.id);
    const l = items.find((a) => a.id === live.id);
    expect(d?.accessLostAt).toBe(lostAt.toISOString());
    expect(d?.accessLostReason).toContain("401");
    expect(l?.accessLostAt).toBeNull();
    expect(l?.accessLostReason).toBeNull();
  });
});
