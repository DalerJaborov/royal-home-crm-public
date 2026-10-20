import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  isOwnAccountSender,
  ownAccountPauseUntil,
  OWN_ACCOUNT_PAUSE_YEARS,
  resetOwnAccountCache,
} from "../src/lib/ownAccountGuard.js";

/**
 * Бот не отвечает сам себе.
 *
 * 16.08.2026 два наших Instagram-аккаунта вежливо прощались друг с другом
 * по кругу, пока владелец не поставил оба диалога на паузу руками. Защита —
 * узнать во входящем СВОЙ аккаунт: по нику (главный путь, потому что IGSID
 * отправителя никогда не совпадает с externalId аккаунта) или по
 * идентификатору напрямую (запасной путь, пока ник не сверен с Meta).
 * Если это узнавание сломается — боты снова переписываются между собой
 * и жгут деньги на каждом «Саломат бошед!».
 */

const runId = Date.now();

// Идентификаторы нарочно с меткой прогона: база общая, чужие строки
// MessengerAccount трогать нельзя, а свои должны быть уникальны.
const OWN_EXTERNAL_ID = `own-guard-ext-${runId}`;
const OWN_USERNAME = `royal.guard.${runId}`;
const BARE_EXTERNAL_ID = `own-guard-bare-${runId}`; // аккаунт, у которого ник ещё не сверён

const createdAccountIds: string[] = [];

beforeAll(async () => {
  const withUsername = await prisma.messengerAccount.create({
    data: {
      channel: "INSTAGRAM",
      externalId: OWN_EXTERNAL_ID,
      title: `Guard Test ${runId}`,
      token: "enc-guard-test",
      username: OWN_USERNAME,
    },
  });
  const withoutUsername = await prisma.messengerAccount.create({
    data: {
      channel: "WHATSAPP",
      externalId: BARE_EXTERNAL_ID,
      title: `Guard Test Bare ${runId}`,
      token: "enc-guard-test-bare",
      // username не заполнен: сверка с Meta ещё не проходила
    },
  });
  createdAccountIds.push(withUsername.id, withoutUsername.id);
  // Кэш живёт минуту — без сброса тест увидит состав аккаунтов ДО beforeAll.
  resetOwnAccountCache();
});

afterAll(async () => {
  await prisma.messengerAccount.deleteMany({ where: { id: { in: createdAccountIds } } });
  // Не оставлять другим тестам кэш с нашими тестовыми аккаунтами.
  resetOwnAccountCache();
});

describe("Узнавание своего аккаунта во входящем", () => {
  it("свой ник узнаётся, даже когда senderId — чужой IGSID (главный прод-случай)", async () => {
    // В вебхуке Instagram отправитель приходит как IGSID, который НИКОГДА
    // не равен externalId аккаунта — узнавание обязано сработать по нику.
    expect(
      await isOwnAccountSender({ senderId: `igsid-never-matches-${runId}`, senderName: OWN_USERNAME }),
    ).toBe(true);
  });

  it("ник узнаётся независимо от регистра, «@» и пробелов по краям", async () => {
    expect(
      await isOwnAccountSender({ senderId: "x", senderName: `  @${OWN_USERNAME.toUpperCase()}  ` }),
    ).toBe(true);
  });

  it("запасной путь: пока ник не сверён, аккаунт узнаётся по externalId", async () => {
    expect(await isOwnAccountSender({ senderId: BARE_EXTERNAL_ID })).toBe(true);
    expect(await isOwnAccountSender({ senderId: BARE_EXTERNAL_ID, senderName: null })).toBe(true);
  });

  it("обычный клиент — не «мы»: чужие id и ник не принимаются за свои", async () => {
    expect(
      await isOwnAccountSender({ senderId: `client-${runId}`, senderName: `some.client.${runId}` }),
    ).toBe(false);
  });

  it("клиент без ника не узнаётся ошибочно (senderName отсутствует/null)", async () => {
    expect(await isOwnAccountSender({ senderId: `client-noname-${runId}` })).toBe(false);
    expect(await isOwnAccountSender({ senderId: `client-noname-${runId}`, senderName: null })).toBe(false);
  });

  it("ник, ПОХОЖИЙ на наш, но другой — это клиент, а не мы", async () => {
    expect(
      await isOwnAccountSender({ senderId: "x", senderName: `${OWN_USERNAME}.fake` }),
    ).toBe(false);
  });

  it("незаполненный ник аккаунта не превращается в «пустой ник = все свои»", async () => {
    // У BARE-аккаунта username = null; клиент с пустым/пробельным ником
    // не должен совпасть с «пустотой» в множестве наших ников.
    expect(await isOwnAccountSender({ senderId: `client-${runId}-2`, senderName: "" })).toBe(false);
    expect(await isOwnAccountSender({ senderId: `client-${runId}-3`, senderName: "  @  " })).toBe(false);
  });

  it("смена состава аккаунтов видна после resetOwnAccountCache — удалённый аккаунт перестаёт быть «своим»", async () => {
    const temp = await prisma.messengerAccount.create({
      data: {
        channel: "FACEBOOK",
        externalId: `own-guard-temp-${runId}`,
        title: `Guard Temp ${runId}`,
        token: "enc-guard-temp",
        username: `royal.temp.${runId}`,
      },
    });
    resetOwnAccountCache();
    expect(await isOwnAccountSender({ senderId: "x", senderName: `royal.temp.${runId}` })).toBe(true);

    await prisma.messengerAccount.delete({ where: { id: temp.id } });
    // Пока кэш не сброшен, минуту аккаунт ещё считается своим — это осознанная
    // цена кэша; после сброса (правка в Настройках зовёт reset) — уже нет.
    resetOwnAccountCache();
    expect(await isOwnAccountSender({ senderId: "x", senderName: `royal.temp.${runId}` })).toBe(false);
  });
});

describe("Пауза диалога между своими аккаунтами", () => {
  it("пауза ставится на 10 лет вперёд — «навсегда», но обычным pausedUntil, который владелец может снять", () => {
    const now = new Date("2026-08-26T12:00:00.000Z");
    const until = ownAccountPauseUntil(now);
    expect(OWN_ACCOUNT_PAUSE_YEARS).toBe(10);
    expect(until.getFullYear()).toBe(now.getFullYear() + 10);
    // Остальные компоненты даты не трогаются.
    expect(until.getMonth()).toBe(now.getMonth());
    expect(until.getDate()).toBe(now.getDate());
    expect(until.getTime()).toBeGreaterThan(Date.now());
  });

  it("без аргумента пауза считается от текущего момента", () => {
    const before = new Date();
    const until = ownAccountPauseUntil();
    expect(until.getFullYear()).toBeGreaterThanOrEqual(before.getFullYear() + 10);
  });
});
