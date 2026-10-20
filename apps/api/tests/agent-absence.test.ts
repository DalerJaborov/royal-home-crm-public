import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { runAbsenceReturnTick } from "../src/lib/absenceReturn.js";
import { absenceKindOf } from "../src/lib/agentAvailability.js";

/**
 * ОТПУСК И БОЛЬНИЧНЫЙ (владелец 09.09.2026: «дать отпуск / больничный / уволить»).
 *
 * Признак `Agent.frozenAt` читали двенадцать мест — распределение лидов, KPI,
 * очередь АТС, Royal Score, маршрутизация вернувшегося клиента, — а записать его
 * не мог никто. Здесь проверяется вторая половина механизма: что отсутствие
 * действительно кончается и человек возвращается в строй сам.
 *
 * Главная проверяемая мысль — БОЛЬНИЧНЫЙ БЕЗ ДАТЫ НЕ СНИМАЕТСЯ АВТОМАТОМ. Вернуть
 * человека по догадке значит тут же пустить ему лиды и входящие звонки, пока он
 * лежит дома.
 */

const runId = Date.now();
const agentIds: string[] = [];

async function makeAgent(fields: {
  frozenAt?: Date | null;
  absenceKind?: "VACATION" | "SICK" | "OTHER" | null;
  absenceUntil?: Date | null;
  isActive?: boolean;
}) {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  const a = await prisma.agent.create({
    data: {
      fullName: `Отсутствующий ${runId}-${agentIds.length}`,
      phone: `+992958${runId}${agentIds.length}`,
      role: "AGENT",
      passwordHash,
      isActive: fields.isActive ?? true,
      frozenAt: fields.frozenAt ?? null,
      absenceKind: fields.absenceKind ?? null,
      absenceUntil: fields.absenceUntil ?? null,
    },
  });
  agentIds.push(a.id);
  return a;
}

const HOUR = 3600_000;

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("Вид отсутствия", () => {
  it("работающий сотрудник — отсутствия нет", async () => {
    const a = await makeAgent({});
    expect(await absenceKindOf(a.id)).toBeNull();
  });

  it("вид отсутствия читается как записан", async () => {
    const a = await makeAgent({ frozenAt: new Date(), absenceKind: "VACATION" });
    expect(await absenceKindOf(a.id)).toBe("VACATION");
  });

  /** Осторожная трактовка: неизвестный вид ведёт себя как больничный, а не как
   *  отпуск — клиента не заставляют ждать неизвестно чего. */
  it("заморожен без указанного вида — считается OTHER", async () => {
    const a = await makeAgent({ frozenAt: new Date(), absenceKind: null });
    expect(await absenceKindOf(a.id)).toBe("OTHER");
  });
});

describe("Возвращение из отсутствия", () => {
  it("срок вышел — сотрудник возвращается в строй", async () => {
    const a = await makeAgent({
      frozenAt: new Date(Date.now() - 240 * HOUR),
      absenceKind: "VACATION",
      absenceUntil: new Date(Date.now() - HOUR),
    });
    const { returned } = await runAbsenceReturnTick();
    expect(returned).toBeGreaterThanOrEqual(1);
    const after = await prisma.agent.findUnique({ where: { id: a.id } });
    expect(after!.frozenAt).toBeNull();
    expect(after!.absenceKind).toBeNull();
    expect(after!.absenceUntil).toBeNull();
    expect(await absenceKindOf(a.id)).toBeNull();
  });

  it("срок ещё не вышел — сотрудник остаётся в отпуске", async () => {
    const a = await makeAgent({
      frozenAt: new Date(),
      absenceKind: "VACATION",
      absenceUntil: new Date(Date.now() + 48 * HOUR),
    });
    await runAbsenceReturnTick();
    expect(await absenceKindOf(a.id)).toBe("VACATION");
  });

  /**
   * Самое важное правило этого тика. «До неизвестно когда» — законное состояние
   * больничного, и снимать его по догадке нельзя: человеку тут же пойдут лиды и
   * входящие звонки. Такое отсутствие снимает руководитель кнопкой «вернулся».
   */
  it("больничный без даты выхода автоматом не снимается никогда", async () => {
    const a = await makeAgent({
      frozenAt: new Date(Date.now() - 1000 * HOUR),
      absenceKind: "SICK",
      absenceUntil: null,
    });
    await runAbsenceReturnTick();
    expect(await absenceKindOf(a.id)).toBe("SICK");
  });

  /** Увольнение сильнее любой даты в календаре. */
  it("уволенного сотрудника тик не возвращает", async () => {
    const a = await makeAgent({
      isActive: false,
      frozenAt: new Date(Date.now() - 240 * HOUR),
      absenceKind: "VACATION",
      absenceUntil: new Date(Date.now() - HOUR),
    });
    await runAbsenceReturnTick();
    const after = await prisma.agent.findUnique({ where: { id: a.id } });
    expect(after!.frozenAt).not.toBeNull();
  });

  it("повторный прогон ничего не ломает и никого не возвращает дважды", async () => {
    await makeAgent({
      frozenAt: new Date(Date.now() - 240 * HOUR),
      absenceKind: "VACATION",
      absenceUntil: new Date(Date.now() - HOUR),
    });
    const first = await runAbsenceReturnTick();
    expect(first.returned).toBeGreaterThanOrEqual(1);
    const second = await runAbsenceReturnTick();
    expect(second.returned).toBe(0);
  });
});
