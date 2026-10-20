import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ОДИН НОМЕР, ДВЕ ЗАЯВКИ ОДНОВРЕМЕННО — НИ ОДНА НЕ ТЕРЯЕТСЯ.
 *
 * Найдено проверкой кода 12.08.2026. createLeadFromChannel искала клиента по
 * телефону и следом создавала карточку. Человек отправляет форму на сайте и тут же
 * пишет боту (или Meta доставляет вебхук дважды) — обе половины проходят проверку,
 * вторая упирается в уникальный индекс. Раньше это выглядело так: бот отвечал
 * заглушкой «позвоните нам», хотя лид был создан, а /website-lead отдавал сайту 500
 * и заявка терялась на его стороне.
 *
 * Теперь проигравший гонку продолжает как с уже существующим клиентом: карточка
 * одна, исключения нет, created:true ровно у одного вызова.
 */

const sendPushToAgent = vi.fn(async () => 1);
const sendPushToAgents = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents,
}));

const { prisma } = await import("../src/db.js");
const { createLeadFromChannel } = await import("../src/leads.js");

const runId = Date.now();
const PHONE = `+992919${String(runId).slice(-6)}`;
let agentId: string;

beforeAll(async () => {
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент гонки", phone: `+992887${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
});

afterAll(async () => {
  const client = await prisma.client.findUnique({ where: { phone: PHONE }, select: { id: true } });
  if (client) {
    await prisma.interaction.deleteMany({ where: { clientId: client.id } });
    await prisma.client.deleteMany({ where: { id: client.id } });
  }
  await prisma.interaction.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("Заявка с сайта и от бота приходят с одним номером", () => {
  it("обе завершаются успехом, карточка одна, ошибки нет", async () => {
    const [site, bot] = await Promise.all([
      createLeadFromChannel({ fullName: "Гонка по телефону", phone: PHONE, source: "WEBSITE" }),
      createLeadFromChannel({ fullName: "Гонка по телефону", phone: PHONE, source: "INSTAGRAM" }),
    ]);

    // Ни один вызов не бросил исключение — сайт получил бы 200, бот ответил бы
    // человеку, а не заглушкой «позвоните нам».
    expect(site.clientId).toBe(bot.clientId);
    // Заведена ровно одна карточка: created:true у победителя, false у второго.
    expect([site.created, bot.created].filter(Boolean)).toHaveLength(1);

    const clients = await prisma.client.findMany({ where: { phone: PHONE }, select: { id: true } });
    expect(clients).toHaveLength(1);
  });
});
