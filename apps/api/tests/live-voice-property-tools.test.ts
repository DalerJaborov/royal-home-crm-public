import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * КВАРТИРЫ В ЗВОНКЕ КОНСУЛЬТАНТА (24.09.2026, робозвонок, правка 3).
 *
 * Проверяется по базе: что консультант находит, что он может сказать вслух про
 * открытый и про закрытый объект, и что уходит звонящему по СМС. Отправка СМС
 * подменена: здесь важно, КАКОЙ текст и КОМУ, а не ответ провайдера.
 */

const { sendSms } = vi.hoisted(() => ({ sendSms: vi.fn() }));
vi.mock("../src/lib/sms/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/sms/index.js")>()),
  sendSms,
}));

const { formatPropertyCode } = await import("@royal-home/shared");
const { prisma } = await import("../src/db.js");
const { handlePropertyTool, newPropertyCallMemory, propertiesSmsText } = await import(
  "../src/lib/telephony/liveVoicePropertyTools.js"
);
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now().toString(36);
// Street fixture must not accidentally include the digits searched for by the
// house-number privacy assertion below; encode the run suffix as letters.
const safeStreetToken = runId.replace(/\d/g, (digit) => String.fromCharCode(97 + Number(digit)));
const agentIds: string[] = [];
const propertyIds: string[] = [];
let open = { id: "", shortId: 0 };
let closed = { id: "", shortId: 0 };
let pricey = { id: "", shortId: 0 };

// Девять цифр после 992 — свой номер на прогон.
const CALLER = `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`;

async function makeProperty(data: Record<string, unknown>) {
  const p = await prisma.property.create({
    data: {
      title: `Голос-${runId}`,
      type: "COMMERCIAL",
      // Девять комнат у коммерческого — таких чужих карточек в общей базе нет, и
      // поиск «от 9 комнат в Сино» находит только наши.
      rooms: 9,
      areaSqm: 120,
      price: 900_000,
      currency: "TJS",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
      ...data,
    } as never,
    select: { id: true, shortId: true },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const agentId = await createTestAgent("Шахло Голосова");
  agentIds.push(agentId);
  // Официальный район — консультант ищет только по четырём настоящим. Строку не
  // удаляем: район общий (seed.ts заводит все четыре).
  const sino = await prisma.district.upsert({ where: { name: "Сино" }, create: { name: "Сино" }, update: {} });
  open = await makeProperty({ districtId: sino.id, address: `Профсоюз, ${runId}`, intakeAgentId: agentId, floor: 3, totalFloors: 9 });
  closed = await makeProperty({ districtId: sino.id, publishedOnSite: false, offSite: true, intakeAgentId: agentId, title: `Закрытый-${runId}` });
  pricey = await makeProperty({ districtId: sino.id, price: 95_000, currency: "USD", address: `Дорогая, ${runId}` });
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await deleteAgentsWithTraces(agentIds);
});

beforeEach(() => {
  sendSms.mockReset();
  sendSms.mockResolvedValue({ ok: true, id: "sms-1", parts: 2 });
});

const call = (name: string, args: Record<string, unknown>) => ({ id: "c", name, args });

describe("search_properties", () => {
  it("без района и без типа не ищет — просит сначала понять запрос", async () => {
    const memory = newPropertyCallMemory({ callerPhone: CALLER, clientId: null });
    const reply = await handlePropertyTool(memory, call("search_properties", { rooms: 2 }));
    expect(reply?.response).toMatchObject({ ok: false });
    expect(memory.discussedShortIds).toEqual([]);
  });

  it("находит опубликованное под запрос, закрытое не показывает; найденное запоминается", async () => {
    const memory = newPropertyCallMemory({ callerPhone: CALLER, clientId: null });
    const reply = await handlePropertyTool(memory, call("search_properties", { district: "Сино", type: "COMMERCIAL", rooms: 9 }));
    const numbers = (reply?.response.options as { number: number }[]).map((o) => o.number);
    expect(numbers).toContain(open.shortId);
    expect(numbers).not.toContain(closed.shortId);
    expect(reply?.scheduling).toBe("WHEN_IDLE");
    expect(memory.discussedShortIds).toEqual(numbers);
    const first = (reply?.response.options as { number: number; price: string; where: string }[]).find((o) => o.number === open.shortId)!;
    expect(first.price).toBe("девятьсот тысяч сомони");
    expect(first.where).toContain("Профсоюз");
  });

  it("бюджет в долларах пересчитывается по курсу: 90 тысяч долларов — это больше 900 тысяч сомони", async () => {
    const memory = newPropertyCallMemory({ callerPhone: CALLER, clientId: null });
    const inUsd = await handlePropertyTool(
      memory,
      call("search_properties", { district: "Сино", type: "COMMERCIAL", rooms: 9, budget_max: 90_000, currency: "USD" })
    );
    const usdNumbers = (inUsd?.response.options as { number: number }[]).map((o) => o.number);
    expect(usdNumbers).toContain(open.shortId);
    // $95 000 при бюджете $90 000 — в допуске подбора (+10 %, lib/matchPolicy.ts, как у
    // агентов CRM — аудит поиска P1-2, 10.10.2026): предлагается, но с честной пометкой.
    const options = inUsd?.response.options as { number: number; fit: string | null }[];
    expect(options.find((o) => o.number === pricey.shortId)?.fit).toContain("дороже названного бюджета");
    // Дальше допуска — отсекается: $85 000 × 1,1 < $95 000.
    const tighter = await handlePropertyTool(
      newPropertyCallMemory({ callerPhone: CALLER, clientId: null }),
      call("search_properties", { district: "Сино", type: "COMMERCIAL", rooms: 9, budget_max: 85_000, currency: "USD" })
    );
    expect(((tighter?.response.options ?? []) as { number: number }[]).map((o) => o.number)).not.toContain(pricey.shortId);

    const inTjs = await handlePropertyTool(
      newPropertyCallMemory({ callerPhone: CALLER, clientId: null }),
      call("search_properties", { district: "Сино", type: "COMMERCIAL", rooms: 9, budget_max: 90_000, currency: "TJS" })
    );
    const tjsNumbers = ((inTjs?.response.options ?? []) as { number: number }[]).map((o) => o.number);
    expect(tjsNumbers).not.toContain(open.shortId);
  });
});

/**
 * ВАЛЮТА БЮДЖЕТА НЕ НАЗВАНА — НЕ СЧИТАЕМ СОМОНИ МОЛЧА (аудит звонков робота 02.10.2026, №10).
 * «До шестидесяти тысяч» без слова «долларов» считалось 60 000 сомони (~$5,5 тыс.), и
 * робот отвечал «ничего нет» человеку, имевшему в виду доллары.
 */
describe("search_properties: валюта бюджета не названа", () => {
  it("90 тысяч без валюты, а в сомони ничего нет, в долларах есть — просит переспросить, досье не пишет", async () => {
    const memory = newPropertyCallMemory({ callerPhone: CALLER, clientId: null });
    const reply = await handlePropertyTool(
      memory,
      call("search_properties", { district: "Сино", type: "COMMERCIAL", rooms: 9, budget_max: 90_000 })
    );
    expect(reply?.response).toMatchObject({ ok: false, needs_currency: true });
    expect(String(reply?.response.error)).toContain("в долларах или в сомони");
    // Ничего не предложено и не «запомнено как обсуждённое».
    expect(reply?.response).not.toHaveProperty("options");
    expect(memory.discussedShortIds).toEqual([]);
  });

  it("сумма меньше порога покупки в сомони (правило текстового бота) — тоже переспрос, без поиска", async () => {
    const memory = newPropertyCallMemory({ callerPhone: CALLER, clientId: null });
    const reply = await handlePropertyTool(
      memory,
      call("search_properties", { district: "Сино", type: "COMMERCIAL", rooms: 9, budget_max: 45_000 })
    );
    expect(reply?.response).toMatchObject({ ok: false, needs_currency: true });
  });

  it("сумма без валюты, которая в сомони находит объект, — ищет как раньше, не переспрашивает", async () => {
    const memory = newPropertyCallMemory({ callerPhone: CALLER, clientId: null });
    const reply = await handlePropertyTool(
      memory,
      call("search_properties", { district: "Сино", type: "COMMERCIAL", rooms: 9, budget_max: 1_000_000 })
    );
    expect(reply?.response).not.toHaveProperty("needs_currency");
    const numbers = (reply?.response.options as { number: number }[]).map((o) => o.number);
    expect(numbers).toContain(open.shortId);
  });

  it("валюта названа явно — никаких переспросов, как и было", async () => {
    const reply = await handlePropertyTool(
      newPropertyCallMemory({ callerPhone: CALLER, clientId: null }),
      call("search_properties", { district: "Сино", type: "COMMERCIAL", rooms: 9, budget_max: 90_000, currency: "USD" })
    );
    expect(reply?.response).not.toHaveProperty("needs_currency");
    expect(reply?.response).toMatchObject({ ok: true });
  });
});

describe("get_property", () => {
  it("открытый объект по номеру — цена, этаж и агент по имени; номер запоминается", async () => {
    const memory = newPropertyCallMemory({ callerPhone: CALLER, clientId: null });
    const reply = await handlePropertyTool(memory, call("get_property", { query: String(open.shortId) }));
    expect(reply?.response).toMatchObject({
      found: true,
      number: open.shortId,
      price: "девятьсот тысяч сомони",
      floor: "третий этаж из девяти",
      agent: "Шахло",
      status: "в продаже",
    });
    expect(memory.discussedShortIds).toEqual([open.shortId]);
    // Узнанный объект помнится отдельно: после звонка лид уходит его агенту.
    expect(memory.identifiedPropertyId).toBe(open.id);
  });

  it("площадь словами, а по-таджикски — только если звонящему можно (tajikAllowed)", async () => {
    const ru = await handlePropertyTool(
      newPropertyCallMemory({ callerPhone: CALLER, clientId: null }),
      call("get_property", { query: String(open.shortId) })
    );
    expect(String(ru?.response.area)).toMatch(/квадрат/);
    expect(String(ru?.response.area)).not.toMatch(/\d/);
    expect(ru?.response).not.toHaveProperty("price_tg");

    const tg = await handlePropertyTool(
      newPropertyCallMemory({ callerPhone: CALLER, clientId: null, tajikAllowed: true }),
      call("get_property", { query: String(open.shortId) })
    );
    expect(tg?.response).toMatchObject({ price_tg: "нӯҳсад ҳазор сомонӣ" });
    expect(String(tg?.response.area_tg)).toMatch(/метр$/);
    expect(tg?.response.floor_tg).toBe("қабати сеюм аз нӯҳ");
  });

  it("закрытый объект — ни цены, ни адреса по телефону, только агент", async () => {
    const reply = await handlePropertyTool(
      newPropertyCallMemory({ callerPhone: CALLER, clientId: null }),
      call("get_property", { query: String(closed.shortId) })
    );
    expect(reply?.response).toMatchObject({ found: true, closed: true, agent: "Шахло" });
    expect(reply?.response).not.toHaveProperty("price");
    expect(reply?.response).not.toHaveProperty("where");
  });

  it("не нашли — честное «не нашли», а не выдуманный объект", async () => {
    const reply = await handlePropertyTool(
      newPropertyCallMemory({ callerPhone: CALLER, clientId: null }),
      call("get_property", { query: `несуществующий-${runId}` })
    );
    expect(reply?.response).toMatchObject({ found: false });
  });
});

/**
 * Объект по приметам объявления (24.09.2026): консультант узнаёт объект той же
 * функцией, что разбор звонка оператору (identifyProperty, lib/propertyMatch.ts).
 * Слова-ориентиры — из цифр прогона, чтобы не совпасть с соседями по базе.
 */
describe("get_property по приметам", () => {
  const tag = String(Date.now())
    .slice(-8)
    .split("")
    .map((d) => "бвгдзклмнр"[Number(d)])
    .join("");
  const PLACE = `Зарнигор${tag}`;
  let low = { id: "", shortId: 0 };
  let high = { id: "", shortId: 0 };
  let sold = { id: "", shortId: 0 };

  beforeAll(async () => {
    const twin = { type: "APARTMENT", rooms: 2, areaSqm: 64, price: 700_000, landmark: `у фабрики ${PLACE}`, totalFloors: 9 };
    low = await makeProperty({ ...twin, floor: 2 });
    high = await makeProperty({ ...twin, floor: 7 });
    sold = await makeProperty({ type: "APARTMENT", rooms: 3, areaSqm: 90, price: 800_000, landmark: `Шукуфа${tag}`, status: "SOLD", soldAt: new Date() });
  });

  it("два похожих — не угадывает, отдаёт кандидатов на переспрос без номеров; этаж решает", async () => {
    const memory = newPropertyCallMemory({ callerPhone: CALLER, clientId: null });
    const clues = { landmark: `возле ${PLACE}`, price: 700_000, currency: "TJS", rooms: 2 };
    const vague = await handlePropertyTool(memory, call("get_property", clues));
    expect(vague?.response).toMatchObject({ ok: true, found: false });
    const candidates = vague?.response.candidates as Record<string, unknown>[];
    // Утверждаем про СВОИ две квартиры, а не про длину всего списка: identifyProperty
    // не требует, чтобы примета совпала, — он отсеивает по типу, комнатам и цене с
    // допуском PRICE_VETO = 0.2 (lib/propertyMatch.ts), а примета лишь добавляет
    // очков. Поэтому в кандидаты законно попадает любая двухкомнатная с ценой в
    // пределах 20%: в засеянной базе это «2-комн · Исмоили Сомони» из prisma/seed.ts
    // за 605 000 (13,6% от 700 000 — мимо PRICE_MATCH, но внутри вето). С проверкой
    // по длине тест был красным там, где базу засевали, и зелёным там, где нет
    // (поймано 24.09.2026 на main). Свои узнаём по той самой примете из цифр
    // прогона, ради которой она и уникальна.
    const mine = candidates.filter((c) => String(c.where ?? "").includes(PLACE));
    expect(mine).toHaveLength(2);
    expect(mine.map((c) => c.floor).sort()).toEqual(["второй этаж из девяти", "седьмой этаж из девяти"]);
    // «Без номеров» — ни поля с номером, ни номера в тексте кандидата. Подстрокой
    // по всему JSON проверять нельзя: на пустой базе номер однозначный, и «7»
    // находится в «7 из 9» и «700 000 сомони» (поймано 25.09.2026 на --clean-db).
    for (const c of mine) {
      expect(Object.keys(c)).not.toEqual(expect.arrayContaining(["number"]));
      expect(Object.keys(c)).not.toEqual(expect.arrayContaining(["shortId"]));
      for (const [key, value] of Object.entries(c)) {
        if (key === "floor" || key === "area" || key === "price" || key === "rooms") continue;
        for (const id of [low.shortId, high.shortId]) {
          expect(String(value)).not.toMatch(new RegExp(`(?<!\\d)${id}(?!\\d)`));
        }
      }
    }
    // И номер в человеческом виде («ОБ-000006») — его подстрокой искать можно,
    // префикс делает совпадение однозначным при любой длине номера.
    expect(JSON.stringify(candidates)).not.toContain(formatPropertyCode(high.shortId));
    expect(memory.discussedShortIds).toEqual([]);

    const exact = await handlePropertyTool(memory, call("get_property", { ...clues, floor: 7 }));
    expect(exact?.response).toMatchObject({ found: true, number: high.shortId, floor: "седьмой этаж из девяти" });
    expect(memory.discussedShortIds).toEqual([high.shortId]);
  });

  it("цена в долларах пересчитывается в сомони по курсу", async () => {
    const { usdToTjs } = await (await import("../src/lib/money.js")).loadMoneyContext();
    const reply = await handlePropertyTool(
      newPropertyCallMemory({ callerPhone: CALLER, clientId: null }),
      call("get_property", { landmark: PLACE, price: Math.round(700_000 / usdToTjs), currency: "USD", rooms: 2, floor: 2 })
    );
    expect(reply?.response).toMatchObject({ found: true, number: low.shortId });
  });

  it("проданный недавно — честно «продан», без цены", async () => {
    const memory = newPropertyCallMemory({ callerPhone: CALLER, clientId: null });
    const reply = await handlePropertyTool(memory, call("get_property", { landmark: `Шукуфа${tag}`, price: 800_000, rooms: 3 }));
    expect(reply?.response).toMatchObject({ found: true, sold: true });
    // Проданный к агенту не ведёт — лид по нему уйдёт обычным путём.
    expect(memory.identifiedPropertyId).toBeNull();
    expect(reply?.response).not.toHaveProperty("price");
    expect(sold.shortId).toBeGreaterThan(0);
  });

  it("без единой приметы — просит спросить, а не ищет по всей базе", async () => {
    const reply = await handlePropertyTool(newPropertyCallMemory({ callerPhone: CALLER, clientId: null }), call("get_property", {}));
    expect(reply?.response).toMatchObject({ ok: false });
  });
});

describe("send_property_sms", () => {
  it("шлёт на номер звонка ссылки только на обсуждённое и опубликованное, второй раз — нет", async () => {
    const memory = newPropertyCallMemory({ callerPhone: CALLER, clientId: null });
    await handlePropertyTool(memory, call("get_property", { query: String(open.shortId) }));
    await handlePropertyTool(memory, call("get_property", { query: String(closed.shortId) }));

    // Просит прислать и обсуждённые, и выдуманный номер, и открытый дважды: уходит одна ссылка.
    // Выдуманный — заведомо несуществующий: на чистой базе номер 1 — это наш же open.
    const reply = await handlePropertyTool(memory, call("send_property_sms", { numbers: `${open.shortId}, ${closed.shortId}, ${open.shortId}, 999999999` }));
    expect(reply?.response).toEqual({ ok: true, sent: 1 });
    expect(sendSms).toHaveBeenCalledTimes(1);
    const sms = sendSms.mock.calls[0][0] as { phone: string; text: string; purpose: string };
    expect(sms.phone).toBe(CALLER);
    expect(sms.purpose).toBe("CALL_PROPERTIES");
    expect(sms.text).toContain(`https://royalhome.tj/listing/by-crm/${open.id}`);
    expect(sms.text).not.toContain(closed.id);

    const again = await handlePropertyTool(memory, call("send_property_sms", {}));
    expect(again?.response).toMatchObject({ ok: false });
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("два параллельных вызова в одном звонке (LIVE01): СМС уходит один раз", async () => {
    const memory = newPropertyCallMemory({ callerPhone: CALLER, clientId: null });
    await handlePropertyTool(memory, call("get_property", { query: String(open.shortId) }));
    // Оба вызова с разными id проходят проверку smsSent до первого await.
    const [a, b] = await Promise.all([
      handlePropertyTool(memory, { id: "c1", name: "send_property_sms", args: {} }),
      handlePropertyTool(memory, { id: "c2", name: "send_property_sms", args: {} }),
    ]);
    expect(sendSms).toHaveBeenCalledTimes(1);
    const oks = [a, b].filter((r) => (r?.response as { ok?: boolean }).ok === true);
    expect(oks).toHaveLength(1);
  });

  it("номер, продиктованный человеком, важнее номера звонка", async () => {
    const memory = newPropertyCallMemory({ callerPhone: CALLER, clientId: null });
    // Свой номер на прогон: с 02.10.2026 продиктованный номер, записанный в CRM за
    // другим человеком, не принимается — постоянный номер мог бы совпасть с чужой
    // карточкой в общей базе.
    const dictated = `+992 ${Math.floor(Math.random() * 900_000_000) + 100_000_000}`;
    memory.otherPhone = dictated;
    await handlePropertyTool(memory, call("get_property", { query: String(open.shortId) }));
    await handlePropertyTool(memory, call("send_property_sms", {}));
    expect((sendSms.mock.calls[0][0] as { phone: string }).phone).toBe(dictated);
  });

  it("номер скрыт — СМС не отправить, модель слышит, что ссылки пришлёт агент", async () => {
    const memory = newPropertyCallMemory({ callerPhone: null, clientId: null });
    await handlePropertyTool(memory, call("get_property", { query: String(open.shortId) }));
    const reply = await handlePropertyTool(memory, call("send_property_sms", {}));
    expect(reply?.response).toMatchObject({ ok: false });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("ничего не обсуждали — отправлять нечего", async () => {
    const reply = await handlePropertyTool(newPropertyCallMemory({ callerPhone: CALLER, clientId: null }), call("send_property_sms", {}));
    expect(reply?.response).toMatchObject({ ok: false });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("текст СМС: коротко, район, площадь, цена и ссылка на объект", () => {
    const text = propertiesSmsText([
      { id: "abc", publishedOnSite: true, rooms: 2, areaSqm: 64.5, price: 58000, currency: "USD", district: { name: "Сино" } },
    ]);
    expect(text).toBe("Royal Home, по вашему звонку:\n2-комн., Сино, 65 м², $58 000: https://royalhome.tj/listing/by-crm/abc");
  });
});

describe("чужие функции", () => {
  it("не про квартиры — null, их ведёт мост", async () => {
    expect(await handlePropertyTool(newPropertyCallMemory({ callerPhone: CALLER, clientId: null }), call("end_call", {}))).toBeNull();
  });
});

/**
 * АУДИТ 09.10.2026 (робот перед первым клиентом): P1-9 — адрес без номера дома, описание
 * без телефонов и сумм; P1-6 — доллары в сомони кодом; P0-1 — сырые числа объекта для
 * сторожа скрытым полем, которого модель не видит.
 */
const { LIVE_VOICE_GUARD_FACTS } = await import("../src/lib/telephony/liveVoiceGuards.js");
const { streetWithoutHouse, descriptionForVoice } = await import("../src/lib/telephony/liveVoicePropertyTools.js");
const { spokenPrice, convertToTjs } = await import("@royal-home/shared");

describe("аудит 09.10: что из карточки уходит модели", () => {
  let house = { id: "", shortId: 0 };

  beforeAll(async () => {
    house = await makeProperty({
      address: `Айни${safeStreetToken}, д. 45, кв. 12`,
      description: "Звоните собственнику 93 555 12 34. Хозяин отдаст за 700 тысяч. Ремонт свежий, двор тихий.",
      floor: 4,
      totalFloors: 9,
    });
  });

  it("streetWithoutHouse: улица остаётся, дом и квартира — нет; «82 мкр» и «Дружбы народов» не режутся", () => {
    expect(streetWithoutHouse("Айни, д. 45, кв. 12")).toBe("Айни");
    expect(streetWithoutHouse("Рудаки 137а")).toBe("Рудаки");
    expect(streetWithoutHouse("Сомони 45/2, кв 7")).toBe("Сомони");
    expect(streetWithoutHouse("Сино, 82 мкр")).toBe("Сино, 82 мкр");
    expect(streetWithoutHouse("проспект Дружбы народов")).toBe("проспект Дружбы народов");
  });

  it("описание: телефон закрыт, предложение с суммой вырезано, остальное на месте", () => {
    const text = descriptionForVoice("Звоните собственнику 93 555 12 34. Хозяин отдаст за 700 тысяч. Ремонт свежий.")!;
    expect(text).not.toMatch(/93\s?555/);
    expect(text).not.toContain("700");
    expect(text).toContain("Ремонт свежий");
  });

  it("get_property: в ответе нет номера дома, квартиры, телефона и «другой цены»; сырые числа — скрытым полем", async () => {
    const reply = await handlePropertyTool(newPropertyCallMemory({ callerPhone: CALLER, clientId: null }), call("get_property", { query: String(house.shortId) }));
    const r = reply!.response as Record<string, unknown>;
    expect(String(r.where)).toContain(`Айни${safeStreetToken}`);
    expect(String(r.where)).not.toMatch(/45|кв/);
    expect(String(r.description)).not.toMatch(/93\s?555|700/);
    const json = JSON.stringify(r);
    // Модель цифр не видит: ни цены, ни площади цифрами в отправляемом тексте.
    expect(json).not.toContain("900000");
    expect({ ...r }).not.toHaveProperty("facts_raw");
    const facts = (r as { [LIVE_VOICE_GUARD_FACTS]?: unknown })[LIVE_VOICE_GUARD_FACTS];
    expect(facts).toEqual([{ price: 900_000, currency: "TJS", areaSqm: 120, floor: 4, totalFloors: 9 }]);
  });

  it("search_properties: адрес варианта без номера дома, сырые числа приложены, note запрещает номер дома", async () => {
    const reply = await handlePropertyTool(
      newPropertyCallMemory({ callerPhone: CALLER, clientId: null }),
      call("search_properties", { district: "Сино", type: "COMMERCIAL", rooms: 9 })
    );
    const r = reply!.response as { options: { number: number; where: string }[]; note: string };
    const mine = r.options.find((o) => o.number === house.shortId);
    if (mine) expect(mine.where).not.toMatch(/45|кв/);
    expect(r.note).toContain("номер дома и квартиры — нет");
    const facts = (r as unknown as { [LIVE_VOICE_GUARD_FACTS]?: unknown[] })[LIVE_VOICE_GUARD_FACTS];
    expect(facts?.length).toBeGreaterThanOrEqual(r.options.length);
  });

  it("долларовый объект: цена в сомони готовым полем price_tjs по курсу CRM, модели велено не пересчитывать", async () => {
    const { usdToTjs } = await (await import("../src/lib/money.js")).loadMoneyContext();
    const reply = await handlePropertyTool(newPropertyCallMemory({ callerPhone: CALLER, clientId: null }), call("get_property", { query: String(pricey.shortId) }));
    const r = reply!.response as Record<string, unknown>;
    expect(r.price).toBe("девяносто пять тысяч долларов");
    expect(r.price_tjs).toBe(spokenPrice(Math.round(convertToTjs(95_000, "USD", usdToTjs)), "TJS", "ru"));
    expect(String(r.note)).toContain("price_tjs");
    // Сомонийный объект поля не получает.
    const tjs = await handlePropertyTool(newPropertyCallMemory({ callerPhone: CALLER, clientId: null }), call("get_property", { query: String(open.shortId) }));
    expect(tjs?.response).not.toHaveProperty("price_tjs");
  });
});
