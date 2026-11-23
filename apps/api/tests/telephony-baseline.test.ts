import { describe, expect, it } from "vitest";

import { prisma } from "../src/db.js";
import { TELEPHONY_OPTIONS, telephonyOptionTitle } from "@royal-home/shared";
import {
  checkOperatorsBaseline,
  describeDrift,
  evaluateSettingsBaseline,
  operatorsMatter,
  type BaselineContext,
  type BaselineSettings,
} from "../src/lib/telephony/telephonyBaseline.js";
import {
  BASELINE_CHECK_NAME,
  LEGACY_BASELINE_CHECK_NAMES,
  dropLegacyHealthSnapshots,
  queueNotUsedCheck,
} from "../src/lib/telephony/stationHealth.js";

/**
 * СТОРОЖ РАБОЧЕЙ НАСТРОЙКИ ТЕЛЕФОНИИ (просьба владельца 21.09.2026: «если всё
 * работает — сделай так, чтобы никто больше не трогал эти настройки»).
 *
 * Проверяем не «сторож существует», а то, ради чего он написан: что он замечает
 * ИМЕННО ТЕ значения, при которых звонки терялись по-настоящему. Каждый случай
 * ниже — след реального простоя, а не выдуманная комбинация:
 *
 *  — приём не на тот аппарат или без переадресации директору: урок 1003,
 *    тридцать дней тишины 21.08-19.09.2026 (схема владельца с 18.11/23.11.2026:
 *    10 секунд аппарат 2020, не ответили — сразу директору);
 *  — ложная тревога 23.11.2026: сторож требовал очередь, 40 с и оператора на
 *    рабочей схеме — первый случай ниже держит, чтобы это не повторилось;
 *  — пустое действие при неответе: станция не знает, что делать со звонком
 *    (`none` с 03.10.2026 — осознанное «звонить без предела», тревогой не считается);
 *  — звонок агенту на настольную трубку: их нет ни у кого с 18.08.2026;
 *  — ноль операторов приёма, когда приём идёт через очередь: очередь станции
 *    пустеет за пятнадцать минут, и незнакомый клиент не дозванивается никому;
 *  — режим маршрутизации «kpi_queue»/«dedicated_operator»: незнакомый номер
 *    уходит агенту мимо оператора, против решения владельца 20.09.2026
 *    (ночная проверка 24.09.2026, К2-З1).
 *
 * Сверка настроек — чистая функция (evaluateSettingsBaseline): база для неё не нужна.
 */

/** Номер директора в тесте — заглушка, не настоящий. */
const DIRECTOR_PHONE = "+992900000001";

/**
 * Рабочая схема владельца (18.11.2026 + 23.11.2026): 10 секунд звонит аппарат 2020,
 * не ответили — сразу директору (а дальше автоответчик). Ровно эти значения стояли
 * на проде 23.11.2026, когда сторож показывал «сломан».
 */
function good(): BaselineSettings {
  return {
    incomingPrimaryTarget: "extension",
    incomingPrimaryExtension: "2020",
    incomingRouteToAssignedAgent: true,
    asteriskAgentDialMode: "mobile",
    incomingNoAnswerAction: "both",
    incomingNoAnswerSeconds: 10,
    incomingRoutingMode: "assigned_then_forward",
    incomingForwardPhone: DIRECTOR_PHONE,
  };
}
const ctx = (over: Partial<BaselineContext> = {}): BaselineContext => ({
  directorPhones: [DIRECTOR_PHONE],
  consultantStationMode: "",
  ...over,
});
const driftOf = (s: BaselineSettings, c: BaselineContext = ctx()) =>
  evaluateSettingsBaseline(s, c).filter((r) => !r.ok);
const names = (s: BaselineSettings, c?: BaselineContext) => driftOf(s, c).map((d) => d.name);

describe("сторож рабочей настройки телефонии", () => {
  it("схема владельца 23.11.2026 (2020 на 10 с → директору) — тревоги нет; до 23.11 тут было «сломан»", () => {
    expect(driftOf(good())).toEqual([]);
    // Ложная тревога 23.11.2026: на этих значениях сторож требовал очередь, 40 с и оператора.
    expect(operatorsMatter(evaluateSettingsBaseline(good(), ctx()))).toBe(false);
  });

  it("«только переадресация» без автоответчика после директора — тоже схема владельца", () => {
    expect(driftOf({ ...good(), incomingNoAnswerAction: "forward" })).toEqual([]);
  });

  it("замечает приём, возвращённый в очередь, — и тогда снова нужны операторы", () => {
    const rules = evaluateSettingsBaseline({ ...good(), incomingPrimaryTarget: "queue" }, ctx());
    expect(rules.filter((r) => !r.ok).map((r) => r.name)).toContain("Куда идёт входящий");
    expect(operatorsMatter(rules)).toBe(true);
  });

  it("замечает другой аппарат приёма и пустое/мусорное поле аппарата", () => {
    expect(names({ ...good(), incomingPrimaryExtension: "1003" })).toContain("Аппарат приёма");
    const empty = driftOf({ ...good(), incomingPrimaryExtension: "" }).find((d) => d.name === "Аппарат приёма");
    expect(empty?.actual).toBe("не задан");
    // Мусор станция отбрасывает целиком (internalExtensionDigits) — для сторожа это тоже «не задан».
    expect(driftOf({ ...good(), incomingPrimaryExtension: "2020;Hangup" }).find((d) => d.name === "Аппарат приёма")?.actual).toBe("не задан");
    // «20 20» — та же 2020, человек набрал с пробелом: не тревога.
    expect(names({ ...good(), incomingPrimaryExtension: "20 20" })).not.toContain("Аппарат приёма");
  });

  it("замечает возврат ожидания к прежним 40 секундам", () => {
    const d = driftOf({ ...good(), incomingNoAnswerSeconds: 40 }).find((r) => r.name === "Сколько звонит аппарат приёма");
    expect(d).toBeDefined();
    expect(describeDrift([d!])).toContain("сейчас «40 с», нужно «10 с»");
  });

  describe("не ответили на аппарате — директору", () => {
    const rule = (s: BaselineSettings, c?: BaselineContext) =>
      evaluateSettingsBaseline(s, c ?? ctx()).find((r) => r.name === "Не ответили на аппарате — директору")!;

    it("автоответчик сразу после аппарата — тревога: директору никто не звонит", () => {
      expect(rule({ ...good(), incomingNoAnswerAction: "voicemail" }).ok).toBe(false);
      expect(rule({ ...good(), incomingNoAnswerAction: "none" }).actual).toBe("не переадресуется (выбрано другое действие)");
    });

    it("номер переадресации пустой — тревога (станция молча получила бы «ничего»)", () => {
      expect(rule({ ...good(), incomingForwardPhone: "" }).actual).toBe("номер для переадресации не задан");
      expect(rule({ ...good(), incomingForwardPhone: null }).ok).toBe(false);
    });

    it("номер не директора — тревога; тот же номер в другой записи (без +992, с пробелами) — не тревога", () => {
      expect(rule({ ...good(), incomingForwardPhone: "+992900000002" }).actual).toBe("номер для переадресации не директора");
      expect(rule({ ...good(), incomingForwardPhone: "90 000 00 01" }).ok).toBe(true);
      expect(rule(good(), ctx({ directorPhones: [] })).ok).toBe(false);
    });

    it("робот на входящих перехватывает звонок вместо директора — тревога", () => {
      expect(rule(good(), ctx({ consultantStationMode: "no_answer" })).actual).toBe("трубку берёт робот, а не директор");
    });
  });

  it("«none» и «переадресация» при неответе — заданный выбор, правило «Что делать» молчит; пусто — тревога", () => {
    expect(names({ ...good(), incomingNoAnswerAction: "none" })).not.toContain("Что делать, если не ответили");
    const empty = driftOf({ ...good(), incomingNoAnswerAction: "" }).find((d) => d.name === "Что делать, если не ответили");
    expect(empty?.actual).toBe("не задано");
  });

  it("замечает выключенный перевод известного клиента своему агенту", () => {
    expect(names({ ...good(), incomingRouteToAssignedAgent: false })).toContain("Известный клиент — своему агенту");
  });

  it("замечает звонок агенту на настольную трубку, которой ни у кого нет", () => {
    expect(names({ ...good(), asteriskAgentDialMode: "extension" })).toContain("Чем звонить агенту");
  });

  // Ночная проверка 24.09.2026 (К2-З1): режимы «kpi_queue» и «dedicated_operator»
  // уводят незнакомый номер агенту мимо решения владельца 20.09.2026.
  for (const mode of ["kpi_queue", "dedicated_operator"] as const) {
    it(`замечает режим «${mode}» — незнакомый звонок уходит агенту`, () => {
      const found = driftOf({ ...good(), incomingRoutingMode: mode }).find((d) => d.name === "Незнакомый звонок — оператору");
      expect(found?.actual).toBe(mode);
      expect(found?.expected).toBe("assigned_then_forward");
      expect(describeDrift([found!])).toContain("Незнакомые звонки должны идти оператору (решение 20.09");
    });
  }

  it("пустой режим маршрутизации читается как умолчание — тревоги нет", () => {
    expect(names({ ...good(), incomingRoutingMode: "" })).not.toContain("Незнакомый звонок — оператору");
  });
});

describe("очередь приёма при приёме на аппарат", () => {
  it("не судится: «ни один участник не на связи» — норма, когда звонки идут на 2020 (ложная тревога до 23.11.2026)", () => {
    const check = queueNotUsedCheck("2020");
    expect(check.name).toBe("Очередь приёма: доступность");
    expect(check.ok).toBeNull();
    expect(check.detail).toContain("2020");
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
        field: "incomingPrimaryTarget",
      },
    ]);
    expect(text).toContain("Куда идёт входящий");
    // Значения — словами, а не именами режимов станции (владелец 20.11.2026: «простыми словами»).
    expect(text).toContain("Прямо на один аппарат");
    expect(text).toContain("Операторам в очередь");
    expect(text).not.toMatch(/(?<![a-z_])(extension|queue|kpi_queue|dedicated_operator|PJSIP|RH_CRM_VERDICT)(?![a-z_])/i);
    // «» у кириллицы молчит (JS считает границей слова только латиницу): слово «эталон» ищем через lookaround
    expect(text).not.toMatch(/(?<![а-яё])эталон/i);
    expect(text).toContain("тридцати дней тишины");
    // Читающему нужно знать не только «разошлось», но и что делать дальше — без
    // пути к файлу в тексте для человека (ночная проверка 24.09.2026, №9а).
    expect(text).toContain("разработчику");
    expect(text).not.toMatch(/\.[jt]sx?\b/);
  });
});

describe("текст для журнала: подписи вариантов из общего словаря", () => {
  it("каждое значение каждого поля подписано словом из общего словаря, а не именем режима", () => {
    for (const field of Object.keys(TELEPHONY_OPTIONS) as Array<keyof typeof TELEPHONY_OPTIONS>) {
      const values = TELEPHONY_OPTIONS[field].map((o) => o.value as string);
      for (const value of values) {
        const text = describeDrift([{ name: "Поле", why: "причина", expected: values[0], actual: value, ok: false, field }]);
        expect(text, field + "/" + value).toContain(telephonyOptionTitle(field, value));
        expect(text, field + "/" + value).not.toMatch(/(mobile|extension|queue|none|auto|ivr_menu|kpi_queue|dedicated_operator)/);
      }
    }
  });

  it("«mobile» — звонок на мобильный сотрудника, «dedicated_operator» — дежурный по календарю, секунды — с единицей", () => {
    const text = describeDrift([
      { name: "Чем звонить агенту", why: "п", expected: "mobile", actual: "extension", ok: false, field: "asteriskAgentDialMode" },
      { name: "Незнакомый звонок — оператору", why: "п", expected: "assigned_then_forward", actual: "dedicated_operator", ok: false, field: "incomingRoutingMode" },
      { name: "Сколько ждёт незнакомый", why: "п", expected: "40", actual: "20", ok: false, unit: "с" },
    ]);
    expect(text).toContain("сейчас «На внутренний номер (софтфон)», нужно «На мобильный сотрудника»");
    expect(text).toContain("сейчас «Дежурный по календарю»");
    expect(text).toContain("сейчас «20 с», нужно «40 с»");
  });
});

describe("имя проверки телефонии: ключ без слова «эталон», старая строка снимка удаляется", () => {
  it("старый снимок здоровья удаляется, снимок под новым именем остаётся", async () => {
    const legacy = LEGACY_BASELINE_CHECK_NAMES.map((n) => `Телефония: ${n}`);
    const fresh = `Телефония: ${BASELINE_CHECK_NAME}`;
    for (const name of [...legacy, fresh]) {
      await prisma.integrationHealthSnapshot.upsert({ where: { name }, create: { name, ok: false, detail: "тест" }, update: { ok: false, detail: "тест" } });
    }
    expect(await dropLegacyHealthSnapshots()).toBeGreaterThanOrEqual(legacy.length);
    expect(await prisma.integrationHealthSnapshot.count({ where: { name: { in: legacy } } })).toBe(0);
    expect(await prisma.integrationHealthSnapshot.count({ where: { name: fresh } })).toBe(1);
    await prisma.integrationHealthSnapshot.delete({ where: { name: fresh } });
  });

  it("новое имя без слова «эталон»", () => {
    expect(BASELINE_CHECK_NAME).not.toMatch(/эталон/i);
  });
});
