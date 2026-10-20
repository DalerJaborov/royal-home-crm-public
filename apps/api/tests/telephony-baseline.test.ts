import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../src/db.js";
import { checkSettingsBaseline, checkOperatorsBaseline, describeDrift } from "../src/lib/telephony/telephonyBaseline.js";

/**
 * СТОРОЖ РАБОЧЕЙ НАСТРОЙКИ ТЕЛЕФОНИИ (просьба владельца 21.09.2026: «если всё
 * работает — сделай так, чтобы никто больше не трогал эти настройки»).
 *
 * Проверяем не «сторож существует», а то, ради чего он написан: что он замечает
 * ИМЕННО ТЕ значения, при которых звонки терялись по-настоящему. Каждый случай
 * ниже — след реального простоя, а не выдуманная комбинация:
 *
 *  — приём на прямой аппарат: тридцать дней тишины 21.08-19.09.2026;
 *  — пустое действие при неответе: станция не знает, что делать со звонком
 *    (`none` с 03.10.2026 — осознанное «звонить без предела», тревогой не считается);
 *  — звонок агенту на настольную трубку: их нет ни у кого с 18.08.2026;
 *  — ноль операторов приёма: очередь станции пустеет за пятнадцать минут, и
 *    незнакомый клиент не дозванивается никому;
 *  — режим маршрутизации «kpi_queue»/«dedicated_operator»: незнакомый номер
 *    уходит агенту мимо оператора, против решения владельца 20.09.2026
 *    (ночная проверка 24.09.2026, К2-З1).
 *
 * Значения настроек в конце теста возвращаются на место — иначе следующий тест
 * в этом же файле базы получил бы чужую поломку и искал бы её у себя.
 */

const KEYS = {
  incomingPrimaryTarget: true,
  incomingRouteToAssignedAgent: true,
  asteriskAgentDialMode: true,
  incomingNoAnswerAction: true,
  incomingNoAnswerSeconds: true,
  incomingRoutingMode: true,
} as const;

type Snapshot = Awaited<ReturnType<typeof snapshot>>;
async function snapshot() {
  return prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: KEYS });
}

/** Привести настройки к эталону — исходная точка каждого случая. */
async function setGood(): Promise<void> {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      incomingPrimaryTarget: "queue",
      incomingRouteToAssignedAgent: true,
      asteriskAgentDialMode: "mobile",
      incomingNoAnswerAction: "voicemail",
      incomingNoAnswerSeconds: 40,
      incomingRoutingMode: "assigned_then_forward",
    },
  });
}

let before: Snapshot;

beforeAll(async () => {
  before = await snapshot();
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: before });
});

describe("сторож рабочей настройки телефонии", () => {
  it("на эталонных значениях молчит", async () => {
    await setGood();
    const drift = (await checkSettingsBaseline()).filter((r) => !r.ok);
    expect(drift).toEqual([]);
  });

  it("замечает приём, переведённый на прямой аппарат", async () => {
    await setGood();
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingPrimaryTarget: "extension" } });
    const drift = (await checkSettingsBaseline()).filter((r) => !r.ok);
    expect(drift.map((d) => d.name)).toContain("Куда идёт входящий");
  });

  it("«none» при неответе — осознанный выбор владельца (звонить без предела), тревогой НЕ считается", async () => {
    // С 03.10.2026 none в диалплане = «звонить, пока не снимут» (RH_DWAIT пуст), а не обрыв.
    await setGood();
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingNoAnswerAction: "none" } });
    const drift = (await checkSettingsBaseline()).filter((r) => !r.ok);
    expect(drift.map((d) => d.name)).not.toContain("Что делать, если не ответили");
  });

  it("пустое значение при неответе — тревога: станция не знает, что делать со звонком", async () => {
    await setGood();
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingNoAnswerAction: "" } });
    const drift = (await checkSettingsBaseline()).filter((r) => !r.ok);
    const rule = drift.find((d) => d.name === "Что делать, если не ответили");
    expect(rule).toBeDefined();
    expect(rule?.actual).toBe("не задано");
  });

  it("переадресация дежурному вместо автоответчика тревогой НЕ считается", async () => {
    // Правило намеренно «задано хоть что-то», а не «равно voicemail»: годится любой
    // запасной путь. Иначе сторож мешал бы владельцу выбрать переадресацию.
    await setGood();
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingNoAnswerAction: "forward" } });
    const drift = (await checkSettingsBaseline()).filter((r) => !r.ok);
    expect(drift.map((d) => d.name)).not.toContain("Что делать, если не ответили");
  });

  it("замечает выключенный перевод известного клиента своему агенту", async () => {
    await setGood();
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingRouteToAssignedAgent: false } });
    const drift = (await checkSettingsBaseline()).filter((r) => !r.ok);
    expect(drift.map((d) => d.name)).toContain("Известный клиент — своему агенту");
  });

  it("замечает звонок агенту на настольную трубку, которой ни у кого нет", async () => {
    await setGood();
    await prisma.settings.update({ where: { id: "singleton" }, data: { asteriskAgentDialMode: "extension" } });
    const drift = (await checkSettingsBaseline()).filter((r) => !r.ok);
    expect(drift.map((d) => d.name)).toContain("Чем звонить агенту");
  });

  it("замечает возврат ожидания к прежним 45 секундам", async () => {
    await setGood();
    await prisma.settings.update({ where: { id: "singleton" }, data: { incomingNoAnswerSeconds: 45 } });
    const drift = (await checkSettingsBaseline()).filter((r) => !r.ok);
    expect(drift.map((d) => d.name)).toContain("Сколько ждёт незнакомый");
  });

  // Ночная проверка 24.09.2026 (К2-З1): режимы «kpi_queue» и «dedicated_operator»
  // включаются одной кнопкой в Настройках → Каналы связи и уводят незнакомый
  // номер агенту мимо очереди оператора — против решения владельца 20.09.2026
  // («незнакомый входящий — только оператору»). Сторож обязан это заметить.
  for (const mode of ["kpi_queue", "dedicated_operator"] as const) {
    it(`замечает режим «${mode}» — незнакомый звонок уходит агенту мимо оператора`, async () => {
      await setGood();
      await prisma.settings.update({ where: { id: "singleton" }, data: { incomingRoutingMode: mode } });
      const drift = (await checkSettingsBaseline()).filter((r) => !r.ok);
      const found = drift.find((d) => d.name === "Незнакомый звонок — оператору");
      expect(found).toBeDefined();
      expect(found?.actual).toBe(mode);
      expect(found?.expected).toBe("assigned_then_forward");
      // Текст для журнала должен назвать и решение, и дату — чтобы читающий понял без нас.
      expect(describeDrift([found!])).toContain("Незнакомые звонки должны идти оператору (решение 20.09");
    });
  }

  it("режим «assigned_then_forward» — тревоги нет", async () => {
    await setGood();
    const drift = (await checkSettingsBaseline()).filter((r) => !r.ok);
    expect(drift.map((d) => d.name)).not.toContain("Незнакомый звонок — оператору");
  });
});

describe("операторы приёма", () => {
  it("ноль операторов — тревога", async () => {
    const restore = await prisma.agent.findMany({
      where: { takesUnknownCalls: true },
      select: { id: true },
    });
    await prisma.agent.updateMany({ where: { takesUnknownCalls: true }, data: { takesUnknownCalls: false } });
    try {
      const rule = await checkOperatorsBaseline();
      expect(rule.ok).toBe(false);
      expect(rule.actual).toBe("0");
    } finally {
      await prisma.agent.updateMany({
        where: { id: { in: restore.map((a) => a.id) } },
        data: { takesUnknownCalls: true },
      });
    }
  });
});

describe("текст для журнала", () => {
  it("называет поле, оба значения и причину — чтобы читающий понял без нас", () => {
    const text = describeDrift([
      {
        name: "Куда идёт входящий",
        why: "приём на прямой аппарат стоил тридцати дней тишины",
        expected: "queue",
        actual: "extension",
        ok: false,
      },
    ]);
    expect(text).toContain("Куда идёт входящий");
    expect(text).toContain("extension");
    expect(text).toContain("queue");
    expect(text).toContain("тридцати дней тишины");
    // Читающему нужно знать не только «разошлось», но и что делать дальше — без
    // пути к файлу в тексте для человека (ночная проверка 24.09.2026, №9а).
    expect(text).toContain("разработчика");
    expect(text).not.toMatch(/\.[jt]sx?\b/);
  });
});
