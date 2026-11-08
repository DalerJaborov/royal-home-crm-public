import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { customerBotHistory } from "../src/lib/customerRecentBotMessage.js";
import { logSystemError } from "../src/lib/systemError.js";

vi.mock("../src/lib/systemError.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: vi.fn(async () => {}) }));

// Review 08.11.2026 (findings 7, 7b, 7c, 9): the greeting and the long repeat memory come from the dialogue's own message
// history (old bot and core), not only the core memory, which keeps three exchanges and forgets older ones after a revision change.
const created: string[] = [];
async function conversation(messages: unknown) {
  const row = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: `recent-bot-${randomUUID()}`, messages: messages as never }, select: { id: true } });
  created.push(row.id); return row.id;
}
afterAll(async () => { await prisma.botConversation.deleteMany({ where: { id: { in: created } } }); });
const now = new Date("2026-11-08T12:00:00.000Z");
const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

it("a bot message within 12 hours counts, an older one or a customer message does not", async () => {
  expect((await customerBotHistory(await conversation([{ role: "assistant", content: "Ассалому алайкум!", at: ago(1) }]), now))?.recentBotMessage).toBe(true);
  expect((await customerBotHistory(await conversation([{ role: "assistant", content: "Здравствуйте!", at: ago(13) }]), now))?.recentBotMessage).toBe(false);
  expect((await customerBotHistory(await conversation([{ role: "user", content: "салом", at: ago(1) }]), now))?.recentBotMessage).toBe(false);
  expect((await customerBotHistory(await conversation([]), now))?.recentBotMessage).toBe(false);
});
it("returns the bot's texts of the last 7 days, oldest first, beyond the three-exchange memory", async () => {
  const id = await conversation([
    { role: "assistant", content: "старое", at: ago(24 * 8) },
    ...Array.from({ length: 6 }, (_, i) => [{ role: "user", content: `где? ${i}`, at: ago(10 - i) }, { role: "assistant", content: `ответ ${i}`, at: ago(10 - i) }]).flat(),
  ]);
  expect((await customerBotHistory(id, now))?.botMessages).toEqual(["ответ 0", "ответ 1", "ответ 2", "ответ 3", "ответ 4", "ответ 5"]);
});
it("a malformed stamp is skipped, an unknown dialogue gives no answer", async () => {
  const id = await conversation([{ role: "assistant", content: "x", at: "вчера" }, { role: "assistant", content: "y" }]);
  expect(await customerBotHistory(id, now)).toEqual({ recentBotMessage: false, botMessages: [] });
  expect(await customerBotHistory(randomUUID(), now)).toBeUndefined();
});
it("a read failure is logged, not swallowed, and gives no answer", async () => {
  const spy = vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("db down"));
  expect(await customerBotHistory(randomUUID(), now)).toBeUndefined();
  expect(logSystemError).toHaveBeenCalledWith("ai", expect.stringContaining("История сообщений бота не прочитана"), expect.objectContaining({ dedupKey: "customer-bot-history" }));
  spy.mockRestore();
});
