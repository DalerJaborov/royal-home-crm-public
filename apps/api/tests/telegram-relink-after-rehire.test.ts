import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * Повторная привязка Telegram после увольнения и нового найма (G16, 02.10.2026).
 *
 * Так было: чат уволенного оставался привязан к старой учётке, а
 * Agent.telegramChatId уникален — `/start <код>` новой учётки того же человека
 * падал исключением, бот молчал, в CRM «Telegram не привязан». И код привязки
 * отключённой учётки по-прежнему срабатывал.
 */

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn(async () => {}) }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
}));

const { prisma } = await import("../src/db.js");
const { tryLinkAgentByCode } = await import("../src/lib/telegramAgentLink.js");

const runId = String(Date.now()).slice(-7);
const CHAT = `5${runId}3`;
const ids: string[] = [];

async function mk(label: string, isActive: boolean, extra: Record<string, unknown>) {
  const phone = `+99299${ids.length}${runId}`;
  await prisma.agent.deleteMany({ where: { phone } });
  const a = await prisma.agent.create({
    data: { fullName: label, phone, role: "EDITOR", isActive, passwordHash: await bcrypt.hash("x", 4), ...extra },
  });
  ids.push(a.id);
  return a;
}

beforeAll(async () => {
  await prisma.agent.updateMany({ where: { telegramChatId: CHAT }, data: { telegramChatId: null } });
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("tryLinkAgentByCode", () => {
  it("чат уволенной учётки переходит к новой учётке того же человека", async () => {
    const old = await mk("Монтажёр прежний", false, { telegramChatId: CHAT });
    const fresh = await mk("Монтажёр новый", true, { telegramLinkCode: `code-new-${runId}` });

    const ok = await tryLinkAgentByCode(CHAT, `code-new-${runId}`);
    expect(ok).toBe(true);
    expect((await prisma.agent.findUnique({ where: { id: fresh.id } }))!.telegramChatId).toBe(CHAT);
    expect((await prisma.agent.findUnique({ where: { id: old.id } }))!.telegramChatId).toBeNull();
  });

  it("код отключённой учётки не срабатывает", async () => {
    const off = await mk("Отключённый с кодом", false, { telegramLinkCode: `code-off-${runId}` });
    const ok = await tryLinkAgentByCode(`4${runId}9`, `code-off-${runId}`);
    expect(ok).toBe(false);
    expect((await prisma.agent.findUnique({ where: { id: off.id } }))!.telegramChatId).toBeNull();
  });
});
