import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ОЧЕРЕДЬ ВХОДЯЩИХ — ТОЛЬКО ОПЕРАТОРЫ (20.09.2026, решение владельца: «незнакомый
 * номер попадает только в очередь на оператора, агент отвечает только своим
 * клиентам»). Прежний критерий «в очередь идут все role=AGENT» отменён, и здесь
 * проверяется обе половины нового: оператора дописываем, не-оператора убираем,
 * чужого участника не трогаем никогда.
 *
 * Исходная задача (19.09.2026) — см. заголовок
 * lib/telephony/agentIncomingReadiness.ts. Жалоба владельца: у новых агентов
 * Сурайё и Комрона не работали входящие, потому что CRM выдавала номер и
 * мобильное плечо, но в очередь на станции номер не попадал никогда, и об этом
 * нигде не говорилось. Плюс просьба: «чтобы всегда, даже когда новых добавляем,
 * тоже всё сработало в будущем».
 *
 * Проверяем то, из-за чего это может тихо сломаться: в какую очередь дописывать
 * (на станции их может быть несколько), в каком виде записывать участника
 * (форма живёт в чужой конфигурации), и что мы добавляем ровно недостающих — не
 * трогая тех, кого в очередь записали руками.
 */

const queueAdds: { queue: string; iface: string; memberName?: string }[] = [];
const queueRemoves: { queue: string; iface: string }[] = [];
let stationMembers: { event: string; queue: string; location: string }[] = [];
let stationOk = true;

vi.mock("../src/lib/telephony/amiClient.js", () => ({
  loadAmiCredentials: async () => ({ host: "127.0.0.1", port: 5038, username: "crm", password: "x" }),
  amiQueueStatus: async () =>
    stationOk
      ? { ok: true, packets: stationMembers }
      : { ok: false, error: "станция не ответила за 5 с" },
  amiQueueAdd: async (
    _creds: unknown,
    queue: string,
    iface: string,
    options: { memberName?: string } = {}
  ) => {
    queueAdds.push({ queue, iface, memberName: options.memberName });
    return { ok: true, packets: [] };
  },
  amiQueueRemove: async (_creds: unknown, queue: string, iface: string) => {
    queueRemoves.push({ queue, iface });
    return { ok: true, packets: [] };
  },
  amiQueuePause: async () => ({ ok: true, packets: [] }),
  amiAction: async () => ({ ok: true, packets: [] }),
}));

const { prisma } = await import("../src/db.js");
const {
  pickTargetQueue,
  memberInterfaceFor,
  checkIncomingReadiness,
  ensureAgentsInIncomingQueue,
  describeNewAgentQueueOutcome,
} = await import("../src/lib/telephony/agentIncomingReadiness.js");

const runId = Date.now();
const agentIds: string[] = [];

/** Пакет QueueMember от станции: `Local/<номер>@from-queue/n` — ровно так
 *  участники записаны на живой станции. */
function member(queue: string, extension: string) {
  return { event: "QueueMember", queue, location: `Local/${extension}@from-queue/n` };
}

/** Тот же участник, уже разобранный (то, что отдаёт readQueueMembers). */
function row(queue: string, extension: string, iface?: string) {
  return { queue, extension, iface: iface ?? `Local/${extension}@from-queue/n` };
}

beforeAll(async () => {
  // 1004 — оператор первой линии, 1007 и 1008 — обычные агенты: именно тот
  // расклад, который описал владелец 20.09.2026.
  for (const [i, [name, ext, operator]] of (
    [
      ["Оператор приёма", "1004", true],
      ["Сурайё", "1007", false],
      ["Комрон", "1008", false],
    ] as [string, string, boolean][]
  ).entries()) {
    const a = await prisma.agent.create({
      data: {
        fullName: `${name} ${runId}`,
        phone: `+99290${runId}${i}`,
        role: "AGENT",
        passwordHash: "x",
        sipExtension: ext,
        isActive: true,
        takesUnknownCalls: operator,
      },
    });
    agentIds.push(a.id);
  }
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("Куда дописывать участника", () => {
  const known = new Set(["1004", "1007"]);

  it("очередь та, где уже сидят СВОИ агенты, а не любая на станции", () => {
    const target = pickTargetQueue([row("9999", "2001"), row("9999", "2002"), row("1000", "1004")], known);
    // В 9999 участников больше, но ни одного из CRM — это чужая очередь.
    expect(target?.queue).toBe("1000");
  });

  it("образец записи берётся у СВОЕГО агента, а не у случайного участника", () => {
    const target = pickTargetQueue([row("1000", "2222", "SIP/2222"), row("1000", "1004")], known);
    expect(target?.sample.iface).toBe("Local/1004@from-queue/n");
  });

  it("ничья между очередями — не выбираем вовсе, угадывать нельзя", () => {
    expect(pickTargetQueue([row("1000", "1004"), row("1001", "1007")], known)).toBeNull();
  });

  it("своих в очередях нет — вывести очередь не из чего", () => {
    expect(pickTargetQueue([row("9999", "2001")], known)).toBeNull();
  });
});

describe("Как записывать участника", () => {
  const sample = { queue: "1000", iface: "Local/1004@from-queue/n", extension: "1004" };

  it("подставляет номер в форму коллеги, а не собирает строку сам", () => {
    expect(memberInterfaceFor(sample, "1007")).toBe("Local/1007@from-queue/n");
  });

  it("номер не похож на внутренний — не догадываемся", () => {
    expect(memberInterfaceFor(sample, "+992900000000")).toBeNull();
  });
});

describe("Ответ директору при заведении сотрудника", () => {
  // 22.10.2026: заведение Бехруза (1016) пугало «станция не ответила», хотя
  // станция ответила, а в очередь обычный агент и не должен был попасть.
  const okFix = { added: [], removed: [], failed: [] };

  it("обычный агент не попал в очередь — это норма, не тревога", () => {
    expect(describeNewAgentQueueOutcome({ sipExtension: "1016", takesUnknownCalls: false }, okFix)).toBeUndefined();
  });

  it("обычный агент, сверка упала целиком — всё равно молчим: ему очередь не положена", () => {
    expect(describeNewAgentQueueOutcome({ sipExtension: "1016", takesUnknownCalls: false }, null)).toBeUndefined();
  });

  it("оператора добавили — сказать нечего", () => {
    const fix = { ...okFix, added: [{ fullName: "Оператор", extension: "1016", queue: "1000" }] };
    expect(describeNewAgentQueueOutcome({ sipExtension: "1016", takesUnknownCalls: true }, fix)).toBeUndefined();
  });

  it("оператор, станция не ответила — говорим ровно это", () => {
    const note = describeNewAgentQueueOutcome({ sipExtension: "1016", takesUnknownCalls: true }, null);
    expect(note).toContain("1016");
    expect(note).toContain("станция не ответила");
  });

  it("оператор, добавление отвергнуто — называем настоящую причину", () => {
    const fix = { ...okFix, failed: [{ fullName: "Оператор", extension: "1016", error: "Permission denied" }] };
    expect(describeNewAgentQueueOutcome({ sipExtension: "1016", takesUnknownCalls: true }, fix)).toContain(
      "Permission denied"
    );
  });

  it("оператор, очередь не опознана — передаём объяснение сверки", () => {
    const fix = { ...okFix, skipped: "Не удалось определить очередь входящих: …" };
    expect(describeNewAgentQueueOutcome({ sipExtension: "1016", takesUnknownCalls: true }, fix)).toContain(
      "Не удалось определить очередь"
    );
  });
});

describe("Сверка и починка", () => {
  it("оператора в очереди нет — дописываем ровно его", async () => {
    stationOk = true;
    // В очереди сидит чужой участник: по нему опознаётся очередь, но трогать его нельзя.
    stationMembers = [member("1000", "1007")];
    queueAdds.length = 0;
    queueRemoves.length = 0;

    const report = await checkIncomingReadiness();
    expect(report.problem).toBeUndefined();
    expect(report.gaps.map((g) => g.extension)).toEqual(["1004"]);

    const fix = await ensureAgentsInIncomingQueue();
    expect(fix.failed).toEqual([]);
    expect(fix.added.map((a) => a.extension)).toEqual(["1004"]);
    expect(queueAdds.map((a) => a.iface)).toEqual(["Local/1004@from-queue/n"]);
  });

  it("агент попал в очередь — убираем: незнакомые звонки ему не положены", async () => {
    stationOk = true;
    stationMembers = [member("1000", "1004"), member("1000", "1007"), member("1000", "1008")];
    queueAdds.length = 0;
    queueRemoves.length = 0;

    const report = await checkIncomingReadiness();
    expect(report.gaps).toEqual([]);
    expect(report.extra.map((g) => g.extension).sort()).toEqual(["1007", "1008"]);

    const fix = await ensureAgentsInIncomingQueue();
    expect(fix.failed).toEqual([]);
    expect(fix.removed.map((r) => r.extension).sort()).toEqual(["1007", "1008"]);
    expect(queueRemoves.map((r) => r.iface).sort()).toEqual([
      "Local/1007@from-queue/n",
      "Local/1008@from-queue/n",
    ]);
    // Оператора на месте не трогаем ни добавлением, ни удалением.
    expect(queueAdds).toEqual([]);
    expect(queueRemoves.some((r) => r.iface.includes("1004"))).toBe(false);
  });

  it("чужого участника не убираем никогда — его мог записать человек", async () => {
    stationOk = true;
    // 2222 в CRM не заведён вовсе: аппарат на ресепшене, внешний колл-центр, что угодно.
    stationMembers = [member("1000", "1004"), member("1000", "2222")];
    queueAdds.length = 0;
    queueRemoves.length = 0;

    const report = await checkIncomingReadiness();
    expect(report.extra).toEqual([]);

    const fix = await ensureAgentsInIncomingQueue();
    expect(fix.removed).toEqual([]);
    expect(queueRemoves).toEqual([]);
  });

  it("всё как надо — станцию не трогаем вовсе", async () => {
    stationOk = true;
    stationMembers = [member("1000", "1004")];
    queueAdds.length = 0;
    queueRemoves.length = 0;

    const fix = await ensureAgentsInIncomingQueue();
    expect(fix.added).toEqual([]);
    expect(fix.removed).toEqual([]);
    expect(queueAdds).toEqual([]);
    expect(queueRemoves).toEqual([]);
  });

  it("оператора не назначили ни одного — состав очереди не трогаем вовсе", async () => {
    stationOk = true;
    stationMembers = [member("1000", "1004"), member("1000", "1007"), member("1000", "1008")];
    queueAdds.length = 0;
    queueRemoves.length = 0;
    // Снимаем признак со всех: ровно то состояние, в котором правка приедет на прод.
    await prisma.agent.updateMany({ where: { id: { in: agentIds } }, data: { takesUnknownCalls: false } });
    try {
      const report = await checkIncomingReadiness();
      expect(report.noOperatorsAssigned).toBe(true);
      // Главное: НЕ считаем всех лишними. Иначе агентство осталось бы вовсе без
      // приёма незнакомых звонков — хуже, чем было до правила.
      expect(report.extra).toEqual([]);

      const fix = await ensureAgentsInIncomingQueue();
      expect(fix.noOperatorsAssigned).toBe(true);
      expect(fix.removed).toEqual([]);
      expect(queueRemoves).toEqual([]);
      expect(queueAdds).toEqual([]);
    } finally {
      await prisma.agent.updateMany({
        where: { id: agentIds[0] },
        data: { takesUnknownCalls: true },
      });
    }
  });

  it("станция не ответила — ничего не меняем и не выдаём это за «все на местах»", async () => {
    stationOk = false;
    queueAdds.length = 0;
    queueRemoves.length = 0;

    const report = await checkIncomingReadiness();
    expect(report.problem).toBeTruthy();
    expect(report.gaps).toEqual([]);
    expect(report.extra).toEqual([]);

    const fix = await ensureAgentsInIncomingQueue();
    expect(fix.skipped).toBeTruthy();
    expect(queueAdds).toEqual([]);
    expect(queueRemoves).toEqual([]);
  });
});
