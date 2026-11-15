import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { runPhoneLeadWatchdogTick } from "../src/lib/phoneLeadWatchdog.js";

/**
 * РЕШЕНИЕ ЧЕЛОВЕКА НЕ ОТМЕНЯЕТСЯ АВТОМАТИКОЙ (ревью 194-1, 15.11.2026).
 * Сотрудник удалил карточку навсегда — диалог отвязывается, а сторож «номер есть —
 * карточки нет» раньше заводил её снова через ≤15 минут по тому же номеру в старой
 * переписке. Теперь удаление ставит в черновик диалога отметку clientDeletedAt, и
 * сторож смотрит только реплики новее неё: старый номер — нет карточки; новый номер
 * после удаления — карточка есть.
 */
const runId = Date.now();
let adminId = "";
let token = "";
const convIds: string[] = [];

beforeAll(async () => {
  adminId = (await prisma.agent.create({ data: { fullName: `Админ удаления ${runId}`, phone: `+992926${String(runId).slice(-8)}`, role: "ADMIN", passwordHash: "x" } })).id;
  token = signAccessToken({ sub: adminId, role: "ADMIN" });
});
afterAll(async () => {
  const convs = await prisma.botConversation.findMany({ where: { id: { in: convIds } }, select: { clientId: true } });
  await prisma.botConversation.deleteMany({ where: { id: { in: convIds } } });
  const ids = convs.map((c) => c.clientId).filter((c): c is string => !!c);
  if (ids.length) { await prisma.interaction.deleteMany({ where: { clientId: { in: ids } } }); await prisma.client.deleteMany({ where: { id: { in: ids } } }); }
  await prisma.agent.deleteMany({ where: { id: adminId } });
});

describe("удаление карточки навсегда и сторож номера", () => {
  it("удалил → сторож не воскрешает → клиент прислал новый номер → карточка есть", async () => {
    const oldPhone = `9${String(runId).slice(-8)}`;
    const client = await prisma.client.create({ data: { fullName: `Мусорная ${runId}`, phone: `+992${oldPhone}`, source: "INSTAGRAM", deletedAt: new Date() } });
    const conv = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `perm-del-${runId}`, clientId: client.id,
      lastMessageAt: new Date(), leadDraft: { stage: "done", intent: "buy", confident: true },
      messages: [{ role: "user", content: `Хона даркор. Рақамам ${oldPhone}`, at: new Date(Date.now() - 10 * 60_000).toISOString() }] } });
    convIds.push(conv.id);

    const res = await request(app).delete(`/api/v1/clients/${client.id}/permanent`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
    const after = await prisma.botConversation.findUniqueOrThrow({ where: { id: conv.id }, select: { clientId: true, leadDraft: true } });
    expect(after.clientId).toBeNull();
    expect((after.leadDraft as { clientDeletedAt?: string; intent?: string }).clientDeletedAt).toBeTruthy();
    expect((after.leadDraft as { intent?: string }).intent).toBe("buy"); // остальной черновик не тронут

    await runPhoneLeadWatchdogTick();
    expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: conv.id }, select: { clientId: true } })).clientId).toBeNull();

    const newPhone = `9${String(runId + 7).slice(-8)}`;
    await prisma.botConversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date(Date.now() + 1000),
      messages: [{ role: "user", content: `Хона даркор. Рақамам ${oldPhone}`, at: new Date(Date.now() - 10 * 60_000).toISOString() },
        { role: "user", content: `Нав рақамам ${newPhone}`, at: new Date(Date.now() + 1000).toISOString() }] } });
    await runPhoneLeadWatchdogTick(new Date(Date.now() + 2000));
    expect((await prisma.botConversation.findUniqueOrThrow({ where: { id: conv.id }, select: { clientId: true } })).clientId).toBeTruthy();
  });
});
