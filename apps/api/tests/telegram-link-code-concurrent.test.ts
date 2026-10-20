import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * ОДНОРАЗОВЫЙ КОД ПРИВЯЗКИ TELEGRAM НЕЛЬЗЯ ПОТРАТИТЬ ДВАЖДЫ (аудит Codex 04.10.2026,
 * ACCESS-10).
 *
 * Так было: tryLinkAgentByCode искал агента по коду, а потом писал по id без
 * условия на сам код. Два чата с одним ещё действующим кодом проходили поиск оба,
 * оба получали true, второй молча перепривязывал учётку и снимал привязку
 * первого. Теперь код «съедается» условным апдейтом внутри транзакции — выигрывает
 * ровно один.
 */

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn(async () => {}) }));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage,
}));

const { prisma } = await import("../src/db.js");
const { tryLinkAgentByCode } = await import("../src/lib/telegramAgentLink.js");

const runId = String(Date.now()).slice(-7);
const ids: string[] = [];

async function mk(code: string | null) {
  const phone = `+99281${ids.length}${runId}`;
  await prisma.agent.deleteMany({ where: { phone } });
  const a = await prisma.agent.create({
    data: {
      fullName: `Привязка ${ids.length}`,
      phone,
      role: "EDITOR",
      passwordHash: await bcrypt.hash("x", 4),
      ...(code ? { telegramLinkCode: code } : {}),
    },
  });
  ids.push(a.id);
  return a;
}

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("tryLinkAgentByCode при двух одновременных /start с одним кодом", () => {
  it("ровно один чат привязывается, второй получает false и не затирает первого", async () => {
    const code = `race-${runId}`;
    const agent = await mk(code);
    const chatA = `7${runId}1`;
    const chatB = `7${runId}2`;

    // Управляемая задержка между чтением и записью: оба вызова обязаны пройти поиск
    // по коду ДО того, как любой из них начнёт писать.
    const realFindFirst = prisma.agent.findFirst.bind(prisma.agent);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = vi.spyOn(prisma.agent, "findFirst").mockImplementation(((...args: Parameters<typeof realFindFirst>) => {
      const result = realFindFirst(...args);
      return result.then(async (row: unknown) => {
        arrived += 1;
        if (arrived >= 2) release();
        await Promise.race([gate, new Promise((r) => setTimeout(r, 1500))]);
        return row;
      });
    }) as never);
    try {
      const [a, b] = await Promise.all([tryLinkAgentByCode(chatA, code), tryLinkAgentByCode(chatB, code)]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      const after = await prisma.agent.findUnique({ where: { id: agent.id }, select: { telegramChatId: true, telegramLinkCode: true } });
      expect(after!.telegramLinkCode).toBeNull();
      expect(after!.telegramChatId).toBe(a ? chatA : chatB);
    } finally {
      spy.mockRestore();
    }
  });

  it("код, сброшенный между поиском и записью, ничего не привязывает", async () => {
    const code = `revoked-${runId}`;
    const agent = await mk(code);
    const realFindFirst = prisma.agent.findFirst.bind(prisma.agent);
    const spy = vi.spyOn(prisma.agent, "findFirst").mockImplementation(((...args: Parameters<typeof realFindFirst>) =>
      realFindFirst(...args).then(async (row: unknown) => {
        await prisma.agent.update({ where: { id: agent.id }, data: { telegramLinkCode: `other-${runId}` } });
        return row;
      })) as never);
    try {
      const ok = await tryLinkAgentByCode(`6${runId}1`, code);
      expect(ok).toBe(false);
      const after = await prisma.agent.findUnique({ where: { id: agent.id }, select: { telegramChatId: true } });
      expect(after!.telegramChatId).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
