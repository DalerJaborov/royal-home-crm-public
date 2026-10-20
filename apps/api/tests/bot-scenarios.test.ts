import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import {
  DEFAULT_SCENARIO_ID,
  SALES_SCENARIOS,
  ensureConversationScenario,
  pickScenarioId,
  scenarioPromptBlock,
} from "../src/ai/salesScenarios.js";
import {
  MIN_CONVERSATIONS_PER_SCENARIO,
  buildScenarioComparison,
  decideVerdict,
  requiredPerScenario,
  wilsonInterval,
  type ScenarioStats,
} from "../src/lib/salesScenarioStats.js";
import { processMessengerTurn as actualProcessMessengerTurn } from "../src/messengers/conversation.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * Сравнение манер продажи бота.
 *
 * Три вещи, поломка любой из которых обесценивает всю затею целиком.
 *
 * 1. МАНЕРА ЗАКРЕПЛЕНА ЗА ДИАЛОГОМ НАВСЕГДА. Если она перевыбирается на каждом
 *    сообщении, бот меняет характер посреди разговора, а исход становится не к чему
 *    отнести: заявку принесли три разные манеры поровну. Это худший вид поломки —
 *    всё работает, числа копятся, и все они мусор.
 * 2. ВЫКЛЮЧЕННОЕ СРАВНЕНИЕ ЗНАЧИТ ВЫКЛЮЧЕННОЕ. Рубильник существует ровно затем,
 *    чтобы одним движением вернуть бота к проверенному поведению.
 * 3. СЧИТАЕМ ТО, ЧТО ОБЕЩАЛИ. Диалоги, заявки, ушедшие — и «мало данных» там, где
 *    данных мало. Красивый процент на сорока диалогах дороже пустого экрана.
 *
 * Модель подменена: тест не платит за токены и не зависит от доступности API.
 * Заодно это единственный способ проверить, что блок манеры уехал именно в
 * КЭШИРУЕМУЮ часть промта, — видно только по параметрам вызова.
 */

const { aiCall } = vi.hoisted(() => ({ aiCall: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: aiCall,
}));

/** Уникальный хвост: база общая, пересечься диалогами с соседними наборами нельзя. */
const runId = `sc-${Date.now().toString(36)}`;
/** Манера с непустым текстом — на ней проверяем попадание в промт. */
const NAMED_SCENARIO = SALES_SCENARIOS.find((s) => s.prompt.trim().length > 0)!;

const conversationIds: string[] = [];
const lostIds: string[] = [];
const SETTINGS_SELECT = {
  salesScenarioTestEnabled: true,
  botEnabled: true,
  botInstagramEnabled: true,
  botReplyDelaySec: true,
  botReplyMaxWaitSec: true,
} as const;
/** Настройки — singleton, общий на всю базу: что тронули, то и вернём. */
let savedSettings: Record<keyof typeof SETTINGS_SELECT, boolean | number>;
let fixture: CustomerMessengerFixture | undefined;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...fixture!.turnInput(input.subscriberId) });
}

async function setTest(enabled: boolean): Promise<void> {
  await prisma.settings.update({ where: { id: "singleton" }, data: { salesScenarioTestEnabled: enabled } });
}

/** Диалог напрямую в базе — без вебхуков и ИИ, когда проверяем только подсчёт. */
async function makeConversation(
  tag: string,
  options: { scenario?: string | null; withClient?: string | null; lost?: boolean; scoped?: boolean } = {}
): Promise<string> {
  const data = {
    channel: "INSTAGRAM",
    subscriberId: `${runId}-${tag}`,
    messages: [] as never,
    leadDraft: { stage: "chatting" } as never,
    salesScenario: options.scenario ?? null,
    clientId: options.withClient ?? null,
    lastMessageAt: new Date(),
  };
  // Analytics-only cases deliberately keep historical raw rows. A prompt test
  // is an actual authorized transport turn, so its preloaded native is scoped.
  const conv = options.scoped ? await prisma.botConversation.update({
    where: { id: (await fixture!.ensureConversation(`${runId}-${tag}`)).id }, data,
  }) : await prisma.botConversation.create({ data });
  conversationIds.push(conv.id);
  if (options.lost) {
    const lost = await prisma.lostConversation.create({
      data: {
        conversationId: conv.id,
        channel: "INSTAGRAM",
        reason: "silent",
        stage: "other",
        lastMessageAt: new Date(),
        clientMessages: 2,
        followUpsSent: 0,
        finding: `тест ${runId}`,
        suggestion: "",
        botMessage: "бот",
        clientMessage: "клиент",
      },
    });
    lostIds.push(lost.id);
  }
  return conv.id;
}

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: SETTINGS_SELECT,
  });
  // Дебаунс на ноль: ход бота по умолчанию ждёт 25 секунд тишины, и тест бы просто
  // не уложился в таймаут. Рубильники бота включаем явно: соседний набор мог
  // оставить их выключенными, и тогда ход не дошёл бы до квалификатора вовсе.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botReplyDelaySec: 0, botReplyMaxWaitSec: 5, botEnabled: true, botInstagramEnabled: true },
  });
});

afterAll(async () => {
  await prisma.lostConversation.deleteMany({ where: { id: { in: lostIds } } });
  const inquiries = await prisma.customerInquiry.findMany({ where: { conversationId: { in: conversationIds } }, select: { id: true } });
  await fixture?.dispose();
  await prisma.botConversation.deleteMany({ where: { id: { in: conversationIds } } });
  await prisma.customerInquiry.deleteMany({ where: { id: { in: inquiries.map(row => row.id) } } });
  await prisma.botConversation.deleteMany({ where: { subscriberId: { startsWith: runId } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
});

beforeEach(() => {
  aiCall.mockReset();
  aiCall.mockResolvedValue({ reply: ["Салом! Дар кадом ноҳия?"], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false, lead: {} });
});

describe("жребий манеры", () => {
  it("при выключенном сравнении всегда даёт манеру по умолчанию", () => {
    for (let i = 0; i < 50; i++) expect(pickScenarioId(false)).toBe(DEFAULT_SCENARIO_ID);
  });

  it("при включённом раздаёт все манеры реестра, а не одну", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(pickScenarioId(true));
    expect(seen.size).toBe(SALES_SCENARIOS.length);
    for (const scenario of SALES_SCENARIOS) expect(seen.has(scenario.id)).toBe(true);
  });
});

describe("манера закрепляется за диалогом и не меняется", () => {
  it("назначается один раз, повторный вызов возвращает ту же и ничего не переписывает", async () => {
    await setTest(true);
    const id = await makeConversation("pin", { scenario: null });

    const first = await ensureConversationScenario({ id, salesScenario: null });
    expect(SALES_SCENARIOS.map((s) => s.id)).toContain(first);

    // Тот же диалог, но нам «подсовывают» пустое поле — как если бы вызывающий
    // работал по устаревшему снимку записи. Из базы всё равно должна прийти
    // та же манера: перевыбор здесь — ровно та поломка, ради которой тест и есть.
    const again = await ensureConversationScenario({ id, salesScenario: null });
    expect(again).toBe(first);

    const stored = await prisma.botConversation.findUnique({ where: { id }, select: { salesScenario: true } });
    expect(stored?.salesScenario).toBe(first);
  });

  it("уже назначенную манеру не трогает даже после выключения сравнения", async () => {
    await setTest(true);
    const id = await makeConversation("keep", { scenario: NAMED_SCENARIO.id });

    await setTest(false);
    const kept = await ensureConversationScenario({ id, salesScenario: NAMED_SCENARIO.id });
    expect(kept).toBe(NAMED_SCENARIO.id);

    const stored = await prisma.botConversation.findUnique({ where: { id }, select: { salesScenario: true } });
    expect(stored?.salesScenario).toBe(NAMED_SCENARIO.id);
  });

  it("живой диалог получает манеру на первом же сообщении и держит её дальше", async () => {
    await setTest(true);
    const subscriberId = `${runId}-live`;

    await processMessengerTurn({ channel: "INSTAGRAM", subscriberId, text: "Салом, хона мекобам" });
    const after1 = await prisma.botConversation.findUnique({
      where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId } },
      select: { id: true, salesScenario: true },
    });
    conversationIds.push(after1!.id);
    expect(after1?.salesScenario).toBeTruthy();

    // Сравнение выключили посреди разговора — диалог обязан доживать на своей манере.
    await setTest(false);
    await processMessengerTurn({ channel: "INSTAGRAM", subscriberId, text: "Дар Сино" });
    const after2 = await prisma.botConversation.findUnique({
      where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId } },
      select: { salesScenario: true },
    });
    expect(after2?.salesScenario).toBe(after1?.salesScenario);
  });

  it("при выключенном сравнении новый диалог идёт на манере по умолчанию", async () => {
    await setTest(false);
    const subscriberId = `${runId}-off`;

    await processMessengerTurn({ channel: "INSTAGRAM", subscriberId, text: "Салом" });
    const conv = await prisma.botConversation.findUnique({
      where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId } },
      select: { id: true, salesScenario: true },
    });
    conversationIds.push(conv!.id);
    expect(conv?.salesScenario).toBe(DEFAULT_SCENARIO_ID);
  });
});

describe("манера доезжает до промта, и именно в кэшируемую часть", () => {
  it("текст манеры лежит в systemStable, а не в переменной части", async () => {
    await setTest(true);
    // Манеру ставим руками: жребий не должен решать, что именно проверяет тест.
    await makeConversation("prompt", { scenario: NAMED_SCENARIO.id, scoped: true });

    await processMessengerTurn({
      channel: "INSTAGRAM",
      subscriberId: `${runId}-prompt`,
      text: "Салом, хона мекобам",
    });

    const call = aiCall.mock.calls.find(([params]) => params?.endpoint === "lead-qualify");
    expect(call).toBeTruthy();
    const params = call![0] as { system: string; systemStable?: string };
    // Кэшируемый блок — тот, за который платят один раз, а не на каждом сообщении.
    expect(params.systemStable).toContain(NAMED_SCENARIO.prompt.trim());
    // Переменная часть промта манеры знать не должна: попав туда, она стоила бы
    // денег на каждом ходе и рвала бы совпадение префикса кэша.
    expect(params.system).not.toContain(NAMED_SCENARIO.prompt.trim());
  });

  it("контрольная манера ничего к промту не приклеивает", () => {
    expect(scenarioPromptBlock(DEFAULT_SCENARIO_ID)).toBe("");
    expect(scenarioPromptBlock(null)).toBe("");
    // Код, которого в реестре нет (манеру удалили после её диалогов) — бот работает
    // как обычно, а не падает и не подставляет чужой текст.
    expect(scenarioPromptBlock("удалённая-манера")).toBe("");
  });
});

describe("подсчёт результата", () => {
  it("считает диалоги, заявки и ушедших по каждой манере", async () => {
    await setTest(true);
    const other = SALES_SCENARIOS.find((s) => s.id !== NAMED_SCENARIO.id)!;

    // Замер «до»: база общая, и соседние наборы тестов тоже оставляют диалоги.
    // Проверяем прирост, а не абсолютные числа, — иначе тест ломался бы от порядка файлов.
    const before = await buildScenarioComparison();
    const beforeOf = (id: string) => before.scenarios.find((s) => s.id === id)!;

    const client = await prisma.client.create({
      data: { fullName: `Сценарии ${runId}`, phone: `+99291${runId.slice(-7).padStart(7, "0")}`, source: "INSTAGRAM" },
    });

    await makeConversation("stat-lead", { scenario: NAMED_SCENARIO.id, withClient: client.id });
    await makeConversation("stat-lost", { scenario: NAMED_SCENARIO.id, lost: true });
    await makeConversation("stat-open", { scenario: NAMED_SCENARIO.id });
    await makeConversation("stat-other", { scenario: other.id });
    // Диалог без манеры (начался до сравнения) в счёт не идёт вовсе.
    await makeConversation("stat-none", { scenario: null });

    const after = await buildScenarioComparison();
    const afterOf = (id: string) => after.scenarios.find((s) => s.id === id)!;

    const named = { before: beforeOf(NAMED_SCENARIO.id), after: afterOf(NAMED_SCENARIO.id) };
    expect(named.after.conversations - named.before.conversations).toBe(3);
    expect(named.after.leads - named.before.leads).toBe(1);
    expect(named.after.lost - named.before.lost).toBe(1);
    expect(named.after.undecided - named.before.undecided).toBe(1);

    expect(afterOf(other.id).conversations - beforeOf(other.id).conversations).toBe(1);
    expect(after.totalConversations - before.totalConversations).toBe(4);

    // Диалоги, заявки и потери — это разложение одного и того же числа.
    for (const s of after.scenarios) {
      expect(s.leads + s.lost + s.undecided).toBe(s.conversations);
    }

    await prisma.botConversation.updateMany({ where: { clientId: client.id }, data: { clientId: null } });
    await prisma.client.delete({ where: { id: client.id } });
  });

  it("рубильник виден в ответе — экран не должен гадать, идёт сравнение или нет", async () => {
    await setTest(false);
    expect((await buildScenarioComparison()).testEnabled).toBe(false);
    await setTest(true);
    expect((await buildScenarioComparison()).testEnabled).toBe(true);
  });
});

describe("честность вывода: мало данных значит мало данных", () => {
  /** Заготовка строки статистики — считаем интервал так же, как это делает экран. */
  const stat = (id: string, conversations: number, leads: number): ScenarioStats => {
    const { low, high } = wilsonInterval(leads, conversations);
    return {
      id,
      name: id,
      summary: "",
      known: true,
      conversations,
      leads,
      lost: 0,
      undecided: conversations - leads,
      rate: conversations > 0 ? leads / conversations : 0,
      rateLow: low,
      rateHigh: high,
      enough: conversations >= MIN_CONVERSATIONS_PER_SCENARIO,
    };
  };

  it("без диалогов вывода нет", () => {
    expect(decideVerdict([stat("a", 0, 0), stat("b", 0, 0)]).verdict).toBe("no_data");
  });

  it("десять диалогов ничего не доказывают, даже при разгромном счёте", () => {
    // 5 из 10 против 0 из 10 — на глаз «разгром», на деле пять человек.
    const result = decideVerdict([stat("a", 10, 5), stat("b", 10, 0)]);
    expect(result.verdict).toBe("too_little");
    expect(result.leaderId).toBeNull();
  });

  it("одна манера — это не сравнение", () => {
    expect(decideVerdict([stat("a", 500, 100), stat("b", 0, 0)]).verdict).toBe("too_little");
  });

  it("данных достаточно, но отрыв в пределах случайности — лидера не называем", () => {
    const result = decideVerdict([stat("a", 200, 32), stat("b", 200, 28)]);
    expect(result.verdict).toBe("no_difference");
    expect(result.leaderId).toBeNull();
  });

  it("уверенный отрыв на большом числе диалогов — называем лидера", () => {
    const result = decideVerdict([stat("a", 400, 120), stat("b", 400, 40)]);
    expect(result.verdict).toBe("leader");
    expect(result.leaderId).toBe("a");
  });

  it("интервал Уилсона не выходит за 0..1 и не схлопывается на малых числах", () => {
    const tiny = wilsonInterval(1, 12);
    expect(tiny.low).toBeGreaterThanOrEqual(0);
    expect(tiny.high).toBeLessThanOrEqual(1);
    // На двенадцати диалогах «8%» на деле означает «где-то до трети» — интервал
    // обязан это показывать, иначе экран врёт точностью.
    expect(tiny.high - tiny.low).toBeGreaterThan(0.2);

    const many = wilsonInterval(100, 1000);
    expect(many.high - many.low).toBeLessThan(0.06);
    expect(many.low).toBeLessThan(0.1);
    expect(many.high).toBeGreaterThan(0.1);
  });

  it("оценка «сколько ещё нужно» падает с ростом конверсии и не уходит в бесконечность", () => {
    expect(requiredPerScenario(0.2)).toBeLessThan(requiredPerScenario(0.1));
    expect(requiredPerScenario(0)).toBeGreaterThan(0);
    expect(requiredPerScenario(0.001)).toBeLessThanOrEqual(5000);
  });
});
