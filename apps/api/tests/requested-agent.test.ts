import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * «МНЕ НУЖЕН УМЕД» — КЛИЕНТ САМ НАЗЫВАЕТ СОТРУДНИКА (решение владельца 18.08.2026).
 *
 * ЧТО СТЕРЕГУТ ЭТИ ТЕСТЫ. Не качество распознавания вообще (совпадение имён —
 * задача без идеального ответа), а ровно те решения, цена ошибки в которых
 * несимметрична:
 *
 *  1. названного и доступного агента находим и отдаём клиента ему, мимо очереди;
 *  2. ТЁЗКИ — не угадываем: в базе два Баходура (директор 1003 и агент 1012),
 *     и молчаливый выбор одного из них — худший исход из возможных;
 *  3. названный сотрудник отключён — не проглатываем: лид уходит обычным
 *     порядком, но факт просьбы остаётся в карточке;
 *  4. имени у нас нет вовсе — обычный путь, ничего не выдумываем;
 *  5. кнопка «Принять» у такого лида ОСТАЁТСЯ: с этим агентом клиент ещё не
 *     говорил (в отличие от того, кто сам снял трубку на входящем звонке).
 *
 * Пуши замоканы: тест про раздачу лидов не должен зависеть от веб-пуша.
 */

vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 1),
  sendPushToAgents: vi.fn(async () => 1),
}));
vi.mock("../src/lib/pushLeadActions.js", () => ({ sendLeadPush: vi.fn(async () => 1) }));

const { prisma } = await import("../src/db.js");
import type { KnownAgent } from "../src/lib/requestedAgent.js";

const { matchRequestedAgent, resetKnownAgentsCache, requestedAgentNote, requestedAgentNotice } = await import(
  "../src/lib/requestedAgent.js"
);
const { createLeadFromChannel } = await import("../src/leads.js");

const runId = Date.now();
const tail = String(runId).slice(-7);

/** Список сотрудников для чистых проверок — тот же набор граблей, что и в проде:
 *  лишние пробелы в имени и два Баходура. */
function agent(over: Partial<KnownAgent> & { id: string; fullName: string }): KnownAgent {
  return {
    role: "AGENT",
    isActive: true,
    frozenAt: null,
    leadsPausedUntil: null,
    sipExtension: null,
    ...over,
  };
}

const STAFF: KnownAgent[] = [
  agent({ id: "umed", fullName: "Умед Сафаров", sipExtension: "1005" }),
  agent({ id: "noza", fullName: "Ноза Ҳакимова", sipExtension: "1007" }),
  agent({ id: "bah-director", fullName: "Баходур Назаров ", role: "DIRECTOR", sipExtension: "1003" }),
  agent({ id: "bah-agent", fullName: "Баходур Рахимов", sipExtension: "1012" }),
  agent({ id: "abu", fullName: "Абубакр ", sipExtension: "1009" }),
  agent({ id: "fired", fullName: "Сухроб Ниёзов", isActive: false }),
  agent({ id: "paused", fullName: "Далер Юсупов", leadsPausedUntil: new Date(Date.now() + 3_600_000) }),
];

describe("распознавание названного сотрудника", () => {
  it("узнаёт имя в косвенном падеже и с опечаткой", () => {
    for (const text of ["мне нужен Умед", "передайте Умеду, пожалуйста", "я работаю с Умедом"]) {
      const m = matchRequestedAgent(text, STAFF);
      expect(m.status, text).toBe("matched");
      if (m.status === "matched") expect(m.agentId).toBe("umed");
    }
    // Творительный падеж + женское имя, и лишние пробелы в базе не мешают.
    const noza = matchRequestedAgent("я работаю с Нозой", STAFF);
    expect(noza.status === "matched" && noza.agentId).toBe("noza");
    const abu = matchRequestedAgent("мне нужен Абубакр", STAFF);
    expect(abu.status === "matched" && abu.agentId).toBe("abu");
    // Опечатка в длинном имени — всё ещё тот же человек.
    const typo = matchRequestedAgent("мне посоветовали Абубакра", STAFF);
    expect(typo.status === "matched" && typo.agentId).toBe("abu");
  });

  it("без просьбы о человеке имя не ищет — «меня зовут Ноза» это клиентка, а не агент", () => {
    expect(matchRequestedAgent("Здравствуйте, меня зовут Ноза", STAFF).status).toBe("none");
    expect(matchRequestedAgent("Ищу квартиру в Сино, 3 комнаты", STAFF).status).toBe("none");
  });

  it("ТЁЗКИ: два Баходура — не угадываем, а переспрашиваем", () => {
    const m = matchRequestedAgent("мне нужен Баходур", STAFF);
    expect(m.status).toBe("ambiguous");
    if (m.status !== "ambiguous") return;
    expect(m.candidates).toHaveLength(2);
    // Вопрос клиенту составляет код, а не модель: имена в нём — из базы.
    const ask = requestedAgentNotice(m, "ru");
    expect(ask).toContain("Баходур Назаров");
    expect(ask).toContain("Баходур Рахимов");
    // И пометка в карточку — чтобы агент по очереди знал, что имя звучало.
    expect(requestedAgentNote(m)).toContain("однозначно определить не вышло");
  });

  it("ТЁЗКИ разводятся фамилией и внутренним номером", () => {
    const bySurname = matchRequestedAgent("мне нужен Баходур Рахимов", STAFF);
    expect(bySurname.status === "matched" && bySurname.agentId).toBe("bah-agent");
    const byExtension = matchRequestedAgent("соедините с Баходуром, добавочный 1003", STAFF);
    expect(byExtension.status === "unavailable" && byExtension.agentId).toBe("bah-director");
  });

  it("названный сотрудник отключён — не проглатываем молча", () => {
    const fired = matchRequestedAgent("мне нужен Сухроб", STAFF);
    expect(fired.status === "unavailable" && fired.reason).toBe("fired");
    const paused = matchRequestedAgent("мне нужен Далер", STAFF);
    expect(paused.status === "unavailable" && paused.reason).toBe("paused");
    // Клиенту про это говорят честно и обещают свободного.
    expect(requestedAgentNotice(fired, "ru")).toContain("свободному");
  });

  it("имени нет у нас вовсе — обычный клиент, ничего не выдумываем", () => {
    expect(matchRequestedAgent("мне нужен Джамшед из вашего агентства", STAFF).status).toBe("none");
    expect(matchRequestedAgent("мне нужен Ахмед", STAFF).status).toBe("none");
  });
});

describe("лид из переписки уходит названному агенту", () => {
  let namedId = "";
  let otherId = "";
  const clientIds: string[] = [];

  beforeAll(async () => {
    const named = await prisma.agent.create({
      data: { fullName: `Умеджон Тест${tail}`, phone: `+99291${tail}`, role: "AGENT", passwordHash: "x" },
    });
    const other = await prisma.agent.create({
      data: { fullName: `Прочий Тест${tail}`, phone: `+99292${tail}`, role: "AGENT", passwordHash: "x" },
    });
    namedId = named.id;
    otherId = other.id;
    resetKnownAgentsCache();
  });

  afterEach(async () => {
    await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    clientIds.length = 0;
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { id: { in: [namedId, otherId] } } });
    resetKnownAgentsCache();
  });

  it("закрепляется за названным мимо очереди, но кнопка «Принять» остаётся", async () => {
    const { clientId } = await createLeadFromChannel({
      fullName: "Клиент по имени",
      phone: `+99293${tail}`,
      source: "WHATSAPP",
      requestedAgentId: namedId,
      requestedAgentNote: "Клиент сам назвал сотрудника",
    });
    clientIds.push(clientId);
    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(client.assignedAgentId).toBe(namedId);
    expect(client.assignReason).toBe("requested_by_client");
    // ГЛАВНОЕ: разговора с этим агентом ещё не было — он вправе решать сам.
    expect(client.acceptedAt).toBeNull();
    // «Лид на 1%» это не он: агент ничего не приносил, его просто попросили.
    expect(client.ownPropertyLead).toBe(false);
  });

  it("рекомендация после сделки без типа — покупатель у агента сделки, а не «Прочее»", async () => {
    // 23.09.2026, проверка раздачи, пункт 14: «Прочее» у агента не видят ни
    // круг «не принял», ни правило первого звонка, ни эскалация.
    const { clientId } = await createLeadFromChannel({
      fullName: "Рекомендация от клиента",
      phone: `+99295${tail}`,
      source: "REFERRAL",
      requestedAgentId: namedId,
      requestedAgentNote: "Рекомендован клиентом после сделки",
    });
    clientIds.push(clientId);
    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(client.assignedAgentId).toBe(namedId);
    expect(client.kind).toBe("BUYER");
    expect(client.acceptedAt).toBeNull();
  });

  it("названного отключили, пока клиент писал, — обычная раздача плюс пометка", async () => {
    await prisma.agent.update({ where: { id: namedId }, data: { isActive: false } });
    try {
      const { clientId } = await createLeadFromChannel({
        fullName: "Клиент по имени 2",
        phone: `+99294${tail}`,
        source: "WHATSAPP",
        requestedAgentId: namedId,
        requestedAgentNote: "Клиент просил Умеджона, но тот больше у нас не работает",
      });
      clientIds.push(clientId);
      const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(client.assignedAgentId).not.toBe(namedId);
      expect(client.assignReason).not.toBe("requested_by_client");
      if (client.assignedAgentId) {
        const notes = await prisma.interaction.findMany({ where: { clientId }, select: { notes: true } });
        expect(notes.some((n) => n.notes?.includes("больше у нас не работает"))).toBe(true);
      }
    } finally {
      await prisma.agent.update({ where: { id: namedId }, data: { isActive: true } });
    }
  });
});
