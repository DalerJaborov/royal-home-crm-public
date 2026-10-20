import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { waitFor } from "./helpers/waitFor.js";

/**
 * МОБИЛЬНОЕ ПЛЕЧО АГЕНТОВ НА СТАНЦИИ (04.09.2026) — см. заголовок
 * lib/telephony/agentMobileFallback.ts. Разбор живого случая: DEVICE/dial у
 * большинства сотрудников был голым SIP/<номер> без единого зарегистрированного
 * аппарата, и общая очередь звонила в пустоту. CRM теперь сама держит в
 * DEVICE/dial мобильный запасным плечом — без замены существующих (десктоп/
 * браузер), только для role=AGENT (директор/админ купили себе отдельный
 * обычный телефон и в это плечо попадать не должны).
 */

let deviceDial: Record<string, string> = {};
let stationDown = false;
const amiSent: { action: string; fields: Record<string, string | number> }[] = [];

// agentMobileFallback.ts зовёт amiDbGet/amiDbPut напрямую (не сырой amiAction) —
// подделываются они сами, а не через него: моки чужих модулей заменяют экспорт
// целиком, и обёртки настоящего amiClient.js внутри себя дёргали бы настоящий
// amiAction, а не подставленный здесь.
vi.mock("../src/lib/telephony/amiClient.js", () => ({
  loadAmiCredentials: async () => ({ host: "127.0.0.1", port: 5038, username: "crm", password: "x" }),
  amiDbGet: async (_creds: unknown, family: string, key: string) => {
    amiSent.push({ action: "DBGet", fields: { Family: family, Key: key } });
    if (stationDown) return { ok: false, error: "станция не ответила за 5 с" };
    const val = deviceDial[key];
    return { ok: true, value: val ?? null };
  },
  amiDbPut: async (_creds: unknown, family: string, key: string, value: string) => {
    amiSent.push({ action: "DBPut", fields: { Family: family, Key: key, Val: value } });
    deviceDial[key] = value;
    return { ok: true, packets: [{ response: "Success" }] };
  },
}));

const { prisma } = await import("../src/db.js");
const { buildDialWithMobileFallback, mobileFallbackTarget, syncAgentMobileFallback, reconcileAgentMobileFallback } =
  await import("../src/lib/telephony/agentMobileFallback.js");

/**
 * ХВОСТ ТЕСТОВЫХ НОМЕРОВ — СЛУЧАЙНЫЙ, А НЕ ОТ ВРЕМЕНИ (20.09.2026).
 *
 * Было `Date.now()`, и номера строились как префикс + `String(runId).slice(-6)`.
 * Последние шесть цифр миллисекунд повторяются каждые 10^6 мс = 16,7 минуты, а
 * полный прогон CI идёт 21-25 минут — окна перекрываются постоянно. Стоило
 * прогону оборваться до `afterAll` (упал, отменён, шёл параллельно), и
 * брошенный агент красил следующий прогон на ровном месте:
 * `Unique constraint failed on the constraint: Agent_phone_key`, причём в
 * тесте, которого правка даже не касалась. Именно так покраснели #544 и #545.
 *
 * Шесть случайных цифр от времени не зависят вовсе, поэтому брошенный агент
 * больше никого не задевает.
 */
const runId = Math.floor(Math.random() * 900000) + 100000;
const agentIds: string[] = [];

/** Приём входящих ведёт прямо на аппарат — или обратно на очередь операторов.
 *  Настройка одна на всю базу, поэтому каждый тест возвращает её как было. */
/**
 * СЛЕДЫ ПРЕЖНЕЙ ТРЕВОГИ ПРО ЭТОТ АППАРАТ — СНЯТЬ ДО ДЕЙСТВИЯ, А НЕ ТОЛЬКО ПОСЛЕ
 * (20.09.2026).
 *
 * У обеих тревог есть защита от повтора, и обе читают следы ИЗ БАЗЫ:
 * `logSystemError` склеивает одинаковые записи за 10 минут, `shouldAlert` не
 * пускает уведомление с тем же признаком сутки. Уборка стояла только в конце
 * теста — то есть при падении проверки не выполнялась вовсе, и повторная попытка
 * CI (`retry: 1`) шла уже с чужим следом: тревога не повторялась, проверка
 * падала снова. Повтор не мог спасти ни один из этих двух тестов, каким бы
 * мгновенным ни был сбой.
 *
 * Признак тревоги — `9`/`8` плюс три последние цифры метки времени, то есть
 * всего тысяча значений, а срок годности у него сутки: следы прошлых прогонов на
 * одной и той же базе пересекаются и без всяких падений.
 */
/**
 * НИЧЕЙНЫЙ АППАРАТ — НОМЕР, КОТОРЫЙ НЕ МОЖЕТ СОВПАСТЬ С АППАРАТОМ СОТРУДНИКА
 * ЭТОГО ЖЕ ФАЙЛА (живое падение в CI 20.09.2026).
 *
 * Аппараты сотрудников здесь строятся как префикс + ДВЕ последние цифры runId
 * (`89` + `07` = `8907`), а «ничейный» строился как одна цифра + ТРИ последние
 * (`8` + `907` = `8907`). Когда runId кончается на 9, эти два выражения дают
 * ОДИН И ТОТ ЖЕ номер — и у «ничейного» аппарата внезапно оказывался живой
 * владелец с наборным мобильным, из-за чего проверка честно молчала: ни записи в
 * журнале, ни уведомления директору. Совпадали обе пары сразу (`99`/`9` и
 * `89`/`8`), поэтому падали ровно два теста.
 *
 * Пять цифр вместо четырёх убирают совпадение по длине, а не по удаче.
 */
function orphanExtension(prefix: string): string {
  return `${prefix}0${String(runId).slice(-3)}`;
}

/** Ничейный — значит проверено, что он ничей. Иначе тест позеленел бы молча,
 *  проверяя не то: у аппарата с владельцем плечо есть и тревоги быть не должно. */
async function expectNobodyOwns(extension: string): Promise<void> {
  expect(await prisma.agent.count({ where: { sipExtension: extension } })).toBe(0);
}

async function forgetPreviousAlerts(extension: string): Promise<void> {
  const tag = `incoming-primary-unreachable-${extension}`;
  await prisma.notification.deleteMany({ where: { tag } });
  await prisma.pendingDirectorAlert.deleteMany({ where: { tag } });
  await prisma.errorLog.deleteMany({
    where: { source: "telephony", message: { contains: `приём входящих заведён на аппарат ${extension}` } },
  });
}

async function setIncomingPrimary(extension: string | null): Promise<void> {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      incomingPrimaryTarget: extension ? "extension" : "queue",
      incomingPrimaryExtension: extension,
    },
  });
}

afterEach(() => {
  amiSent.length = 0;
  deviceDial = {};
});

afterAll(async () => {
  await setIncomingPrimary(null);
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

beforeAll(async () => {
  // Приём очередью — исходное состояние для всех тестов, кроме тех, где аппарат
  // приёма выставляется намеренно.
  await setIncomingPrimary(null);
});

describe("buildDialWithMobileFallback (чистая функция)", () => {
  it("голому DEVICE/dial добавляет мобильное плечо, не трогая формат", () => {
    expect(buildDialWithMobileFallback("SIP/1005", "1005", "+992777070100")).toBe(
      "SIP/1005&Local/777070100@from-internal/n"
    );
  });

  it("не трогает существующие плечи (десктоп/браузер) — только добавляет своё", () => {
    expect(buildDialWithMobileFallback("SIP/1001&PJSIP/rh-web-1001", "1001", "+992930001001")).toBe(
      "SIP/1001&PJSIP/rh-web-1001&Local/930001001@from-internal/n"
    );
  });

  it("уже стоит верное мобильное плечо — писать нечего", () => {
    expect(buildDialWithMobileFallback("SIP/1005&Local/777070100@from-internal/n", "1005", "+992777070100")).toBeNull();
  });

  it("сменился телефон агента — старое мобильное плечо заменяется, не копится", () => {
    expect(buildDialWithMobileFallback("SIP/1005&Local/777070100@from-internal/n", "1005", "+992900111222")).toBe(
      "SIP/1005&Local/900111222@from-internal/n"
    );
  });

  it("пустой DEVICE/dial — базой берётся голый SIP/<номер>", () => {
    expect(buildDialWithMobileFallback(null, "1010", "+992000001017")).toBe(
      "SIP/1010&Local/000001017@from-internal/n"
    );
  });

  it("международный номер (не +992) — писать нечего, транк его не наберёт", () => {
    expect(mobileFallbackTarget("+79261234567")).toBeNull();
    expect(buildDialWithMobileFallback("SIP/1005", "1005", "+79261234567")).toBeNull();
  });

  it("CHANNEL-NEW-18: сменили номер на ненаборный — старое мобильное плечо снимается, а не остаётся звонить прежнему", () => {
    expect(buildDialWithMobileFallback("SIP/1234&Local/930001001@from-internal/n", "1234", "+79991234567")).toBe("SIP/1234");
    // Плечи десктопа и браузера остаются.
    expect(buildDialWithMobileFallback("SIP/1234&PJSIP/rh-web-1234&Local/930001001@from-internal/n", "1234", "+79991234567")).toBe(
      "SIP/1234&PJSIP/rh-web-1234"
    );
    // Своего плеча не было — писать нечего.
    expect(buildDialWithMobileFallback("SIP/1234&PJSIP/rh-web-1234", "1234", "+79991234567")).toBeNull();
  });
});

describe("syncAgentMobileFallback (со станцией)", () => {
  it("агенту (role=AGENT) со свежим SIP/<ext> дописывает мобильное плечо", async () => {
    const agent = await prisma.agent.create({
      data: {
        fullName: `Агент плеча ${runId}`,
        phone: `+992777${String(runId).slice(-6)}`,
        role: "AGENT",
        sipExtension: `19${String(runId).slice(-2)}`,
        passwordHash: "x",
      },
    });
    agentIds.push(agent.id);
    deviceDial[`${agent.sipExtension}/dial`] = `SIP/${agent.sipExtension}`;

    await syncAgentMobileFallback(agent.id);

    const puts = amiSent.filter((c) => c.action === "DBPut");
    expect(puts).toHaveLength(1);
    expect(puts[0].fields.Family).toBe("DEVICE");
    expect(puts[0].fields.Key).toBe(`${agent.sipExtension}/dial`);
    expect(puts[0].fields.Val).toBe(`SIP/${agent.sipExtension}&Local/777${String(runId).slice(-6)}@from-internal/n`);
  });

  it("директору/админу — не трогает станцию вовсе (у них свой обычный телефон)", async () => {
    for (const role of ["DIRECTOR", "ADMIN"] as const) {
      const agent = await prisma.agent.create({
        data: {
          fullName: `${role} плеча ${runId}`,
          phone: `+992778${String(runId).slice(-6)}${role === "ADMIN" ? "1" : "2"}`,
          role,
          sipExtension: `29${String(runId).slice(-2)}${role === "ADMIN" ? "1" : "2"}`,
          passwordHash: "x",
        },
      });
      agentIds.push(agent.id);
      deviceDial[`${agent.sipExtension}/dial`] = `SIP/${agent.sipExtension}`;

      await syncAgentMobileFallback(agent.id);

      expect(amiSent.filter((c) => c.action === "DBPut")).toHaveLength(0);
    }
  });

  it("плечо уже верное — повторный обход ничего не пишет (идемпотентность)", async () => {
    const agent = await prisma.agent.create({
      data: {
        fullName: `Идемпотентный ${runId}`,
        phone: `+992779${String(runId).slice(-6)}`,
        role: "AGENT",
        sipExtension: `39${String(runId).slice(-2)}`,
        passwordHash: "x",
      },
    });
    agentIds.push(agent.id);
    const localMobile = `779${String(runId).slice(-6)}`;
    deviceDial[`${agent.sipExtension}/dial`] = `SIP/${agent.sipExtension}&Local/${localMobile}@from-internal/n`;

    await syncAgentMobileFallback(agent.id);

    expect(amiSent.filter((c) => c.action === "DBPut")).toHaveLength(0);
  });

  it("reconcileAgentMobileFallback чинит сразу нескольких активных агентов", async () => {
    const a = await prisma.agent.create({
      data: {
        fullName: `Обход А ${runId}`,
        phone: `+992471${String(runId).slice(-6)}`,
        role: "AGENT",
        sipExtension: `49${String(runId).slice(-2)}`,
        passwordHash: "x",
        isActive: true,
      },
    });
    const b = await prisma.agent.create({
      data: {
        fullName: `Обход Б ${runId}`,
        phone: `+992472${String(runId).slice(-6)}`,
        role: "AGENT",
        sipExtension: `59${String(runId).slice(-2)}`,
        passwordHash: "x",
        isActive: true,
      },
    });
    agentIds.push(a.id, b.id);
    deviceDial[`${a.sipExtension}/dial`] = `SIP/${a.sipExtension}`;
    deviceDial[`${b.sipExtension}/dial`] = `SIP/${b.sipExtension}`;

    await reconcileAgentMobileFallback();

    expect(deviceDial[`${a.sipExtension}/dial`]).toContain("Local/471");
    expect(deviceDial[`${b.sipExtension}/dial`]).toContain("Local/472");
  });
});

describe("станция не отвечает", () => {
  // «Здоровье системы» 02.10.2026: на каждое падение туннеля семь строк
  // «Мобильное плечо 10xx: станция не ответила» — по одной на аппарат.
  it("обход останавливается на первом отказе, а не ждёт таймаут у каждого аппарата", async () => {
    const a = await prisma.agent.create({
      data: {
        fullName: `Станция лежит ${runId}`,
        phone: `+992473${String(runId).slice(-6)}`,
        role: "AGENT",
        // «08»/«09» — свободные полосы этого файла (19…99 уже заняты соседними тестами).
        sipExtension: `09${String(runId).slice(-2)}`,
        passwordHash: "x",
        isActive: true,
      },
    });
    const b = await prisma.agent.create({
      data: {
        fullName: `Станция лежит Б ${runId}`,
        phone: `+992474${String(runId).slice(-6)}`,
        role: "AGENT",
        sipExtension: `08${String(runId).slice(-2)}`,
        passwordHash: "x",
        isActive: true,
      },
    });
    agentIds.push(a.id, b.id);
    amiSent.length = 0;
    stationDown = true;
    try {
      await reconcileAgentMobileFallback();
    } finally {
      stationDown = false;
    }
    expect(amiSent.filter((c) => c.action === "DBGet")).toHaveLength(1);
    expect(amiSent.filter((c) => c.action === "DBPut")).toHaveLength(0);
  });
});

/**
 * АППАРАТ, НА КОТОРЫЙ ЗАВЕДЁН ВЕСЬ ПРИЁМ ВХОДЯЩИХ (разбор 19.09.2026).
 *
 * Живой случай: приём стоял на 1003 (директор — роль вне списка «кому ставим
 * мобильное плечо»), а DEVICE/1003/dial содержал только два мёртвых PJSIP-плеча
 * заброшенного эксперимента с браузерными звонками. Dial мгновенно отдавал
 * CHANUNAVAIL, incomingNoAnswerAction=none клал трубку — звонок клиента умирал
 * за ~50 мс. Ломалось с 21.08.2026 и месяц не оставляло ни одного следа.
 */
describe("аппарат приёма входящих обязан быть достижим", () => {
  it("директор, чей аппарат выбран приёмом, ПОЛУЧАЕТ мобильное плечо", async () => {
    const ext = `69${String(runId).slice(-2)}`;
    const director = await prisma.agent.create({
      data: {
        fullName: `Директор приёма ${runId}`,
        phone: `+992934${String(runId).slice(-6)}`,
        role: "DIRECTOR",
        sipExtension: ext,
        passwordHash: "x",
      },
    });
    agentIds.push(director.id);
    // Ровно та строка, что была на проде: два мёртвых плеча и ни одного живого.
    deviceDial[`${ext}/dial`] = `PJSIP/rh-mobile-${ext}&PJSIP/rh-web-${ext}`;
    await setIncomingPrimary(ext);

    await syncAgentMobileFallback(director.id);

    const puts = amiSent.filter((c) => c.action === "DBPut");
    expect(puts).toHaveLength(1);
    expect(puts[0].fields.Val).toBe(
      `PJSIP/rh-mobile-${ext}&PJSIP/rh-web-${ext}&Local/934${String(runId).slice(-6)}@from-internal/n`
    );

    await setIncomingPrimary(null);
  });

  it("оператор первой линии получает плечо при любой роли — очередь звонит на его номер", async () => {
    /**
     * 20.09.2026: владелец назначил первой линией себя, пуш о входящем пришёл, а
     * телефон не зазвонил. CRM сама ставит оператора в очередь станции, очередь
     * звонит на внутренний номер, а номер без мобильного плеча — это тишина.
     * Настольных аппаратов в агентстве нет вовсе.
     */
    const ext = `99${String(runId).slice(-2)}`;
    const operator = await prisma.agent.create({
      data: {
        fullName: `Оператор-админ ${runId}`,
        phone: `+992938${String(runId).slice(-6)}`,
        role: "ADMIN",
        sipExtension: ext,
        passwordHash: "x",
        takesUnknownCalls: true,
      },
    });
    agentIds.push(operator.id);
    deviceDial[`${ext}/dial`] = `SIP/${ext}`;
    await setIncomingPrimary(null);

    await syncAgentMobileFallback(operator.id);

    const puts = amiSent.filter((c) => c.action === "DBPut");
    expect(puts).toHaveLength(1);
    expect(puts[0].fields.Val).toBe(`SIP/${ext}&Local/938${String(runId).slice(-6)}@from-internal/n`);
  });

  it("тот же директор при приёме очередью — станцию не трогаем (решение 04.09 в силе)", async () => {
    const ext = `79${String(runId).slice(-2)}`;
    const director = await prisma.agent.create({
      data: {
        fullName: `Директор вне приёма ${runId}`,
        phone: `+992935${String(runId).slice(-6)}`,
        role: "DIRECTOR",
        sipExtension: ext,
        passwordHash: "x",
      },
    });
    agentIds.push(director.id);
    deviceDial[`${ext}/dial`] = `SIP/${ext}`;
    await setIncomingPrimary(null);

    await syncAgentMobileFallback(director.id);

    expect(amiSent.filter((c) => c.action === "DBPut")).toHaveLength(0);
  });

  it("обход по расписанию захватывает аппарат приёма, а не только агентов", async () => {
    const ext = `89${String(runId).slice(-2)}`;
    const director = await prisma.agent.create({
      data: {
        fullName: `Директор обхода ${runId}`,
        phone: `+992936${String(runId).slice(-6)}`,
        role: "DIRECTOR",
        sipExtension: ext,
        passwordHash: "x",
        isActive: true,
      },
    });
    agentIds.push(director.id);
    deviceDial[`${ext}/dial`] = `PJSIP/rh-web-${ext}`;
    await setIncomingPrimary(ext);

    await reconcileAgentMobileFallback();

    expect(deviceDial[`${ext}/dial`]).toBe(
      `PJSIP/rh-web-${ext}&Local/936${String(runId).slice(-6)}@from-internal/n`
    );

    await setIncomingPrimary(null);
  });

  it("аппарат приёма ни за кем не закреплён — молчать нельзя, пишем в журнал", async () => {
    const orphan = orphanExtension("9");
    await expectNobodyOwns(orphan);
    await forgetPreviousAlerts(orphan);
    await setIncomingPrimary(orphan);

    await reconcileAgentMobileFallback();

    /**
     * Опрос, а не голая проверка: запись в журнал уходит из `void logSystemError`
     * (см. warnIfIncomingPrimaryUnreachable) — горячий путь её не ждёт намеренно,
     * и тест шёл с ней наперегонки. См. tests/helpers/waitFor.ts.
     */
    const logged = await waitFor(
      () =>
        prisma.errorLog.findFirst({
          where: { source: "telephony", message: { contains: `приём входящих заведён на аппарат ${orphan}` } },
        }),
      { label: `запись журнала про аппарат ${orphan}` }
    );
    expect(logged).not.toBeNull();

    await prisma.errorLog.deleteMany({ where: { id: logged!.id } });
    await prisma.notification.deleteMany({ where: { tag: `incoming-primary-unreachable-${orphan}` } });
    await setIncomingPrimary(null);
  });

  it("та же находка доходит до директора уведомлением, а не только в журнал", async () => {
    // Журнал читают при разборе, а настройку человек меняет прямо сейчас.
    const orphan = orphanExtension("8");
    await expectNobodyOwns(orphan);
    const phone = `+99291${String(runId).slice(-6)}`;
    // Повторный прогон теста (в CI стоит `retry: 1`) идёт в ТОМ ЖЕ процессе, то есть
    // с тем же runId, а сотрудников файл убирает только в afterAll. Без этой строки
    // первая неудача превращала повтор в падение на `Agent_phone_key` — то есть
    // прятала настоящую причину за чужой ошибкой.
    await prisma.agent.deleteMany({ where: { phone } });
    const director = await prisma.agent.create({
      data: {
        fullName: `Директор уведомления-${runId}`,
        phone,
        role: "DIRECTOR",
        passwordHash: "x",
        isActive: true,
      },
    });
    agentIds.push(director.id);
    await forgetPreviousAlerts(orphan);
    await setIncomingPrimary(orphan);

    await reconcileAgentMobileFallback();

    const tag = `incoming-primary-unreachable-${orphan}`;
    const notified = await waitFor(() => prisma.notification.findFirst({ where: { tag, agentId: director.id } }), {
      label: `уведомление про аппарат ${orphan}`,
    });
    expect(notified).not.toBeNull();
    expect(notified!.body).toContain(orphan);

    await prisma.notification.deleteMany({ where: { tag } });
    await prisma.errorLog.deleteMany({
      where: { source: "telephony", message: { contains: `приём входящих заведён на аппарат ${orphan}` } },
    });
    await setIncomingPrimary(null);
  });
});
