import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { loadMorningNumbers } from "../src/lib/morningNumbers.js";
import { buildProblemMetrics } from "../src/lib/problemReport.js";
import { dushanbeStartOfToday } from "../src/lib/dushanbeTime.js";

/**
 * АУДИТ CODEX 04.10.2026, CHANNEL-NEW-13: «НЕРАЗОБРАННЫЕ ЗВОНКИ» В УТРЕННИХ ЦИФРАХ И В РАЗБОРЕ
 * ПРОБЛЕМ ДОЛЖНЫ СЧИТАТЬСЯ ТЕМ ЖЕ УСЛОВИЕМ, ЧТО И ЖУРНАЛ (AWAITING_REVIEW_WHERE).
 *
 * Оба места держали устаревшее `answered && clientId != null && qualifiedAt == null` и не
 * видели сообщение автоответчика без карточки (voicemailFile есть, clientId нет): живое
 * необработанное обращение директор видел нулём.
 */
const runId = Date.now();
const createdIds: string[] = [];

afterAll(async () => {
  await prisma.incomingCall.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.$disconnect();
});

async function addVoicemailWithoutCard() {
  const row = await prisma.incomingCall.create({
    data: {
      channelId: `c1-voicemail-${runId}`,
      phone: `+992900${String(runId).slice(-6)}`,
      // Вчера, в пределах и недельного окна отчёта, и месячного окна утренних цифр.
      startedAt: new Date(dushanbeStartOfToday().getTime() - 2 * 60 * 60 * 1000),
      answered: false,
      voicemailFile: `c1-${runId}.wav`,
      clientId: null,
      qualifiedAt: null,
    },
  });
  createdIds.push(row.id);
}

describe("неразобранные звонки: сообщение автоответчика без карточки считается", () => {
  it("утренние цифры: unqualifiedNow растёт на 1", async () => {
    const before = (await loadMorningNumbers()).unqualifiedNow;
    await addVoicemailWithoutCard();
    const after = (await loadMorningNumbers()).unqualifiedNow;
    expect(after - before).toBe(1);
  });

  it("разбор проблем: метрика «не разобраны оператором» за неделю растёт на 1", async () => {
    const value = async () => {
      const m = await buildProblemMetrics("week");
      return m.sections.find((s) => s.key === "calls")!.metrics.find((x) => x.key === "unqualified")!.value;
    };
    // Звонок предыдущего теста убираем: замеряем базу, потом заводим заново.
    await prisma.incomingCall.deleteMany({ where: { id: { in: createdIds } } });
    createdIds.length = 0;
    const base = await value();
    await addVoicemailWithoutCard();
    expect((await value()) - base).toBe(1);
  });
});
