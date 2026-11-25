import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * ШАБНАМ: ЛЁГКОЕ ПОДКЛЮЧЕНИЕ СОТРУДНИКА И ЗАЩИТА ОТ ПРИВЯЗКИ «НЕ В ТОТ АККАУНТ» (25.11.2026).
 *
 * Живой случай: «Ноза РОП» не смогла привязать Telegram (блок в профиле был только у агента),
 * а у той же сотрудницы две учётки и два Telegram. Проверяем:
 *  1) директор/админ выдаёт ссылку сотруднику (POST /agents/:id/telegram-link), код не попадает
 *     в журнал; чужая роль — 403; без подтверждения личности — 428; учётку директора админ не трогает;
 *  2) «Отключить Шабнам» снимает чат, Telegram-аккаунт и код;
 *  3) список сотрудников отдаёт признак telegramLinked, но не номер чата;
 *  4) просроченный код не привязывает;
 *  5) чат уже у ДРУГОЙ действующей учётки — бот спрашивает, код не съедается; «Да» перепривязывает,
 *     «Нет» и чужое нажатие ничего не меняют;
 *  6) «это тот же человек» — сохраняется, сам себе нельзя, права не меняются;
 *  7) акционер (режим просмотра) может привязать СВОЙ Telegram.
 */

const { sendMessageWithButtons, editMessageText, answerCallbackQuery, sendMessage, removeKeyboard } = vi.hoisted(() => ({
  sendMessageWithButtons: vi.fn(async (..._a: unknown[]) => ({ message_id: 1 })),
  editMessageText: vi.fn(async (..._a: unknown[]) => {}),
  answerCallbackQuery: vi.fn(async (..._a: unknown[]) => ({})),
  sendMessage: vi.fn(async (..._a: unknown[]) => ({})),
  removeKeyboard: vi.fn(async (..._a: unknown[]) => ({})),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessageWithButtons,
  editMessageText,
  answerCallbackQuery,
  sendMessage,
  removeKeyboard,
  getBotUsername: async () => "rh_test_bot",
}));

const { prisma } = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { grantElevation, revokeElevation } = await import("../src/lib/stepUp.js");
const { linkAgentByCode, handleTelegramRelinkCallback, createTelegramLinkCode, isExpiredLinkCode } = await import(
  "../src/lib/telegramAgentLink.js"
);
const { invalidateAgentAccess } = await import("../src/auth/middleware.js");

const runId = String(Date.now()).slice(-7);
const ids: string[] = [];
let seq = 0;
async function mk(fullName: string, role: string, extra: Record<string, unknown> = {}) {
  const phone = `+9929${seq++}${runId}`;
  await prisma.agent.deleteMany({ where: { phone } });
  const a = await prisma.agent.create({ data: { fullName: `${fullName} ${runId}`, phone, role: role as never, ...extra } });
  ids.push(a.id);
  return a;
}
const tokenOf = (a: { id: string; role: string }) => signAccessToken({ sub: a.id, role: a.role as never });
const tgId = (n: number) => `7${runId}${n}`;

let director: { id: string; role: string };
let admin: { id: string; role: string };
let agent: { id: string; role: string };
let rop: { id: string; role: string; fullName: string };

beforeAll(async () => {
  director = await mk("Директор Шабнам", "DIRECTOR");
  admin = await mk("Админ Шабнам", "ADMIN");
  agent = await mk("Ноза агент", "AGENT");
  rop = await mk("Ноза РОП", "HEAD_OF_SALES");
  for (const a of [director, admin, agent, rop]) grantElevation(a.id);
});

beforeEach(() => {
  sendMessageWithButtons.mockClear();
  editMessageText.mockClear();
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { agentId: { in: ids } }] } });
  await prisma.agent.updateMany({ where: { id: { in: ids } }, data: { samePersonAgentId: null } });
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
});

describe("POST /agents/:id/telegram-link — ссылка от руководителя", () => {
  it("директор получает ссылку для РОП; код в ответе, в журнале — только факт выдачи", async () => {
    const res = await request(app).post(`/api/v1/agents/${rop.id}/telegram-link`).set("Authorization", `Bearer ${tokenOf(director)}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body.deepLink).toBe(`https://t.me/rh_test_bot?start=${res.body.code}`);
    expect(res.body.expiresInHours).toBe(24);
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: rop.id } });
    expect(row.telegramLinkCode).toBe(res.body.code);
    expect(row.telegramLinkCodeExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    const { waitFor } = await import("./helpers/waitFor.js");
    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { action: "TELEGRAM_LINK_CODE_ISSUED", entityId: rop.id } }));
    expect(audit?.agentId).toBe(director.id);
    expect(JSON.stringify(audit?.meta ?? {})).not.toContain(res.body.code);
  });

  it("агент без права — 403, код не заводится", async () => {
    await prisma.agent.update({ where: { id: rop.id }, data: { telegramLinkCode: null } });
    const res = await request(app).post(`/api/v1/agents/${rop.id}/telegram-link`).set("Authorization", `Bearer ${tokenOf(agent)}`);
    expect(res.status).toBe(403);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: rop.id } })).telegramLinkCode).toBeNull();
  });

  it("админ не выдаёт ссылку на учётку директора", async () => {
    const res = await request(app).post(`/api/v1/agents/${director.id}/telegram-link`).set("Authorization", `Bearer ${tokenOf(admin)}`);
    expect(res.status).toBe(403);
  });

  it("без свежего подтверждения личности — 428", async () => {
    revokeElevation(admin.id);
    const res = await request(app).post(`/api/v1/agents/${rop.id}/telegram-link`).set("Authorization", `Bearer ${tokenOf(admin)}`);
    expect(res.status).toBe(428);
    grantElevation(admin.id);
  });

  it("отключённому сотруднику ссылку не выдаём", async () => {
    const off = await mk("Уволенный Шабнам", "AGENT", { isActive: false });
    const res = await request(app).post(`/api/v1/agents/${off.id}/telegram-link`).set("Authorization", `Bearer ${tokenOf(director)}`);
    expect(res.status).toBe(409);
  });
});

describe("список сотрудников и «Отключить Шабнам»", () => {
  it("GET /agents отдаёт telegramLinked, но не номер чата", async () => {
    await prisma.agent.update({ where: { id: agent.id }, data: { telegramChatId: tgId(1) } });
    const res = await request(app).get("/api/v1/agents").set("Authorization", `Bearer ${tokenOf(director)}`);
    expect(res.status).toBe(200);
    const row = res.body.find((a: { id: string }) => a.id === agent.id);
    expect(row.telegramLinked).toBe(true);
    expect(row.telegramChatId).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(tgId(1));
  });

  it("POST /agents/:id/telegram-unlink снимает чат, аккаунт и код", async () => {
    await prisma.agent.update({ where: { id: agent.id }, data: { telegramChatId: tgId(1), telegramUserId: tgId(1), telegramLinkCode: `left-${runId}` } });
    const res = await request(app).post(`/api/v1/agents/${agent.id}/telegram-unlink`).set("Authorization", `Bearer ${tokenOf(admin)}`);
    expect(res.status).toBe(200);
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect([row.telegramChatId, row.telegramUserId, row.telegramLinkCode]).toEqual([null, null, null]);
  });
});

describe("код привязки и «не в тот аккаунт»", () => {
  it("просроченный код не привязывает", async () => {
    const { code } = await createTelegramLinkCode(rop.id);
    await prisma.agent.update({ where: { id: rop.id }, data: { telegramLinkCodeExpiresAt: new Date(Date.now() - 1000) } });
    expect(await linkAgentByCode(tgId(2), code, tgId(2))).toBe("unknown");
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: rop.id } })).telegramChatId).toBeNull();
  });

  it("свой второй Telegram на вторую учётку — без вопроса (две учётки, два Telegram)", async () => {
    await prisma.agent.update({ where: { id: agent.id }, data: { telegramChatId: tgId(3), telegramUserId: tgId(3) } });
    const { code } = await createTelegramLinkCode(rop.id);
    expect(await linkAgentByCode(tgId(4), code, tgId(4))).toBe("linked");
    const [a, r] = await Promise.all([agent, rop].map((x) => prisma.agent.findUniqueOrThrow({ where: { id: x.id } })));
    expect(a!.telegramChatId).toBe(tgId(3));
    expect(r!.telegramChatId).toBe(tgId(4));
    expect(sendMessageWithButtons).not.toHaveBeenCalled();
    await prisma.agent.update({ where: { id: rop.id }, data: { telegramChatId: null, telegramUserId: null } });
  });

  it("тот же Telegram на другую ДЕЙСТВУЮЩУЮ учётку — вопрос, код живёт, первая учётка не тронута", async () => {
    await prisma.agent.update({ where: { id: agent.id }, data: { telegramChatId: tgId(5), telegramUserId: tgId(5) } });
    const { code } = await createTelegramLinkCode(rop.id);
    expect(await linkAgentByCode(tgId(5), code, tgId(5))).toBe("asked");
    expect(sendMessageWithButtons).toHaveBeenCalledTimes(1);
    const [chat, text, buttons] = sendMessageWithButtons.mock.calls[0] as [string, string, Array<Array<{ callback_data: string }>>];
    expect(chat).toBe(tgId(5));
    expect(text).toContain(`«${rop.fullName}»`);
    expect(buttons[0]!.map((b) => b.callback_data)).toEqual([`tl:y:${code}`, `tl:n:${code}`]);
    const r = await prisma.agent.findUniqueOrThrow({ where: { id: rop.id } });
    expect(r.telegramLinkCode).toBe(code);
    expect(r.telegramChatId).toBeNull();
    // Срок самого кода вопрос не режет: после «Нет» ссылка ещё нужна из другого Telegram (ревью 25.11).
    expect(r.telegramLinkCodeExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).telegramChatId).toBe(tgId(5));

    const press = (data: string, from: string, id: string) =>
      handleTelegramRelinkCallback({ id, data, from: { id: Number(from) }, message: { chat: { id: Number(tgId(5)) }, message_id: 9 } });

    // Чужое нажатие (другой from.id) — ничего не меняет.
    expect(await press(`tl:y:${code}`, tgId(6), `cb-other-${runId}`)).toBe(true);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: rop.id } })).telegramChatId).toBeNull();

    // «Нет» — ничего не меняет.
    expect(await press(`tl:n:${code}`, tgId(5), `cb-no-${runId}`)).toBe(true);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).telegramChatId).toBe(tgId(5));
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: rop.id } })).telegramChatId).toBeNull();

    // «Да» — перепривязка.
    expect(await press(`tl:y:${code}`, tgId(5), `cb-yes-${runId}`)).toBe(true);
    const [a2, r2] = await Promise.all([agent, rop].map((x) => prisma.agent.findUniqueOrThrow({ where: { id: x.id } })));
    expect(a2!.telegramChatId).toBeNull();
    expect(a2!.telegramUserId).toBeNull();
    expect(r2!.telegramChatId).toBe(tgId(5));
    expect(r2!.telegramLinkCode).toBeNull();

    // Повтор той же доставки «Да» — второй раз не исполняется (код уже съеден, кнопка гасится).
    expect(await press(`tl:y:${code}`, tgId(5), `cb-yes-${runId}`)).toBe(true);
    // Второе быстрое «Да» с ДРУГИМ id: привязка не слетает и «Перепривязано» не затирается словами «устарела».
    editMessageText.mockClear();
    expect(await press(`tl:y:${code}`, tgId(5), `cb-yes2-${runId}`)).toBe(true);
    expect(editMessageText).not.toHaveBeenCalled();
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: rop.id } })).telegramChatId).toBe(tgId(5));
    await prisma.agent.update({ where: { id: rop.id }, data: { telegramChatId: null, telegramUserId: null } });
  });

  it("устаревший вопрос: «Да» через 20 минут ничего не меняет, код цел и привязывает из другого Telegram", async () => {
    await prisma.agent.update({ where: { id: agent.id }, data: { telegramChatId: tgId(7), telegramUserId: tgId(7) } });
    const { code } = await createTelegramLinkCode(rop.id);
    expect(await linkAgentByCode(tgId(7), code, tgId(7))).toBe("asked");
    const oldDate = Math.floor((Date.now() - 20 * 60_000) / 1000);
    expect(
      await handleTelegramRelinkCallback({
        id: `cb-stale-${runId}`, data: `tl:y:${code}`, from: { id: Number(tgId(7)) },
        message: { chat: { id: Number(tgId(7)) }, message_id: 11, date: oldDate },
      })
    ).toBe(true);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } })).telegramChatId).toBe(tgId(7));
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: rop.id } })).telegramLinkCode).toBe(code);
    // Та же ссылка из второго Telegram (после «Нет» и паузы) работает.
    expect(await linkAgentByCode(tgId(8), code, tgId(8))).toBe("linked");
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: rop.id } })).telegramChatId).toBe(tgId(8));
    await prisma.agent.update({ where: { id: rop.id }, data: { telegramChatId: null, telegramUserId: null } });
    await prisma.agent.update({ where: { id: agent.id }, data: { telegramChatId: null, telegramUserId: null } });
  });

  it("isExpiredLinkCode: просроченный код — да, живой и несуществующий — нет", async () => {
    const { code } = await createTelegramLinkCode(rop.id);
    expect(await isExpiredLinkCode(code)).toBe(false);
    expect(await isExpiredLinkCode(`nope-${runId}`)).toBe(false);
    await prisma.agent.update({ where: { id: rop.id }, data: { telegramLinkCodeExpiresAt: new Date(Date.now() - 60_000) } });
    expect(await isExpiredLinkCode(code)).toBe(true);
    await prisma.agent.update({ where: { id: rop.id }, data: { telegramLinkCode: null, telegramLinkCodeExpiresAt: null } });
  });

  it("чужие кнопки (не tl:) не трогает", async () => {
    expect(await handleTelegramRelinkCallback({ id: `x-${runId}`, data: "as:ok:1", message: { chat: { id: 1 } } })).toBe(false);
  });
});

describe("«Это тот же человек»", () => {
  it("сохраняется у учётки, права и роль не меняются; сам себе — 400", async () => {
    const self = await request(app)
      .patch(`/api/v1/agents/${rop.id}`)
      .set("Authorization", `Bearer ${tokenOf(director)}`)
      .send({ samePersonAgentId: rop.id });
    expect(self.status).toBe(400);
    const res = await request(app)
      .patch(`/api/v1/agents/${rop.id}`)
      .set("Authorization", `Bearer ${tokenOf(director)}`)
      .send({ samePersonAgentId: agent.id });
    expect(res.status).toBe(200);
    expect(res.body.samePersonAgentId).toBe(agent.id);
    const r = await prisma.agent.findUniqueOrThrow({ where: { id: rop.id } });
    expect(r.role).toBe("HEAD_OF_SALES");
    expect(r.permissions).toBeNull();
    const list = await request(app).get("/api/v1/agents").set("Authorization", `Bearer ${tokenOf(director)}`);
    expect(list.body.find((a: { id: string }) => a.id === rop.id).samePersonAgentId).toBe(agent.id);
    const cleared = await request(app)
      .patch(`/api/v1/agents/${rop.id}`)
      .set("Authorization", `Bearer ${tokenOf(director)}`)
      .send({ samePersonAgentId: null });
    expect(cleared.body.samePersonAgentId).toBeNull();
  });
});

describe("акционер привязывает свой Telegram", () => {
  it("POST /me/telegram-link и /me/telegram-unlink не закрыты режимом просмотра", async () => {
    const holder = await mk("Акционер Шабнам", "SHAREHOLDER");
    invalidateAgentAccess(holder.id);
    grantElevation(holder.id);
    const res = await request(app).post("/api/v1/me/telegram-link").set("Authorization", `Bearer ${tokenOf(holder)}`);
    expect(res.status).toBe(200);
    const off = await request(app).post("/api/v1/me/telegram-unlink").set("Authorization", `Bearer ${tokenOf(holder)}`);
    expect(off.status).toBe(200);
  });
});
