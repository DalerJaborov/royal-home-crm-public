import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { claimUnreadablePhoneAsk } from "../src/messengers/phoneRetryClaim.js";

/**
 * ПЕРЕСПРОС НЕЧИТАЕМОГО НОМЕРА: СЧЁТ НЕ ТЕРЯЕТСЯ И НЕ ТЕРЯЕТ ЧУЖОГО.
 *
 * Жалоба владельца 20.09.2026 «он опять спрашивает по 35 раз». Предел считался
 * по черновику, прочитанному в начале хода, а писался перезаписью ВСЕГО
 * черновика — см. докстринг src/messengers/phoneRetryClaim.ts.
 *
 * Человек часто пишет очередью, и ходы одного разговора идут внахлёст: именно
 * поэтому здесь есть проверка ПАРАЛЛЕЛЬНЫМИ вызовами. Прежний код её не проходил
 * дважды — и разрешал лишние переспросы, и возвращал черновик к устаревшему
 * состоянию, стирая собранное соседним ходом.
 */
const runId = `${process.pid}`;
const created: string[] = [];

async function seed(draft: Record<string, unknown>): Promise<string> {
  const subscriberId = `retry-claim-${runId}-${created.length}`;
  const conv = await prisma.botConversation.create({
    data: { channel: "INSTAGRAM", subscriberId, leadDraft: draft as never },
  });
  created.push(conv.id);
  return conv.id;
}

async function draftOf(id: string): Promise<Record<string, unknown>> {
  const row = await prisma.botConversation.findUnique({ where: { id }, select: { leadDraft: true } });
  return (row?.leadDraft ?? {}) as Record<string, unknown>;
}

afterAll(async () => {
  await prisma.botConversation.deleteMany({ where: { id: { in: created } } });
});

describe("Право переспросить нечитаемый номер", () => {
  it("первые попытки в пределах нормы проходят, следующие — нет", async () => {
    const id = await seed({ stage: "chatting" });
    expect(await claimUnreadablePhoneAsk(id, 2)).toBe(true);
    expect(await claimUnreadablePhoneAsk(id, 2)).toBe(true);
    expect(await claimUnreadablePhoneAsk(id, 2)).toBe(false);
    expect((await draftOf(id)).phoneRetryCount).toBe(2);
  });

  it("параллельные ходы не выдают переспросов больше предела", async () => {
    // Ровно та гонка, которую прежний код не видел: пять ходов читают одну цифру,
    // и все пятеро считают, что предел не достигнут.
    const id = await seed({ stage: "chatting" });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => claimUnreadablePhoneAsk(id, 2)));
    expect(results.filter(Boolean)).toHaveLength(2);
    expect((await draftOf(id)).phoneRetryCount).toBe(2);
  });

  it("собранное соседним ходом не стирается", async () => {
    // Перезапись всего черновика возвращала его к состоянию начала хода: район и
    // бюджет, дописанные соседним ходом, исчезали, и бот спрашивал их заново.
    const id = await seed({ stage: "chatting", districtName: "Фирдавсӣ", budgetMax: 50000, rooms: 2 });
    expect(await claimUnreadablePhoneAsk(id, 2)).toBe(true);
    const draft = await draftOf(id);
    expect(draft.districtName).toBe("Фирдавсӣ");
    expect(draft.budgetMax).toBe(50000);
    expect(draft.rooms).toBe(2);
    expect(draft.stage).toBe("chatting");
    expect(draft.phoneRetryCount).toBe(1);
  });

  it("черновика нет вовсе — счёт начинается с нуля, а не падает", async () => {
    const id = await seed({});
    await prisma.botConversation.update({ where: { id }, data: { leadDraft: null as never } });
    expect(await claimUnreadablePhoneAsk(id, 1)).toBe(true);
    expect((await draftOf(id)).phoneRetryCount).toBe(1);
    expect(await claimUnreadablePhoneAsk(id, 1)).toBe(false);
  });
});
