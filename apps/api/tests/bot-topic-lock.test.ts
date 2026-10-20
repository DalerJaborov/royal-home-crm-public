import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";
import { prisma } from "../src/db.js";
import { ensureOpenQuestionKept, repeatsQuestion } from "../src/ai/replyGuards.js";
import {
  EMPTY_TOPIC_STATE,
  mustRepeatOpenQuestion,
  nextTopicState,
  parseTopicAnswer,
  shouldPressOpenQuestion,
  topicDirective,
  topicStateBlock,
  topicStateOf,
  topicStateUpdate,
  type TopicState,
} from "../src/ai/topicLock.js";
import { processMessengerTurn as actualProcessMessengerTurn } from "../src/messengers/conversation.js";
let fixture: CustomerMessengerFixture | undefined;
function processMessengerTurn(input: Parameters<typeof actualProcessMessengerTurn>[0]) {
  return actualProcessMessengerTurn({ ...input, ...fixture!.turnInput(input.subscriberId) });
}

/**
 * БОТ ДЕРЖИТ ТЕМУ РАЗГОВОРА (решение владельца 11.08.2026).
 *
 * Проверяется не «есть ли в промте нужная фраза» — такую проверку этот проект уже
 * покупал пять раз за один день и каждый раз оставался с ботом, который правило
 * прочитал и не выполнил. Проверяется то, что нельзя выполнить наполовину:
 *
 *  1. УХОД С ТЕМЫ ВКЛЮЧАЕТ ПРЕДПИСАНИЕ. В промт уходит не «мягко верни к теме», а
 *     дословный вопрос, которым модель обязана закончить сообщение.
 *  2. ЗАБЫТЫЙ ВОПРОС ДОПИСЫВАЕТ КОД. Модель промолчала про вопрос — он всё равно
 *     уходит клиенту. Это и есть разница между пожеланием и гарантией.
 *  3. ОТВЕТ КЛИЕНТА ЗАКРЫВАЕТ ВОПРОС. Иначе бот превращается в автомат, долбящий
 *     одним и тем же вопросом по человеку, который на него уже ответил.
 *  4. ВЫКЛЮЧЕННЫЙ РУБИЛЬНИК ЗНАЧИТ ВЫКЛЮЧЕННЫЙ — ни строки в промте, ни поля в схеме,
 *     ни правки реплики. Регресс-щит: одним движением вернуть прежнее поведение.
 *  5. СОСТОЯНИЕ ЛЕЖИТ В БАЗЕ. Разговор о квартире тянется сутками и переживает
 *     перезапуск контейнера; вопрос обязан пережить его вместе с разговором.
 *
 * Модель подменена: тест не платит за токены и не зависит от доступности API. Заодно
 * это единственный способ увидеть, что именно уехало в промт и в схему инструмента.
 */

const { aiCall } = vi.hoisted(() => ({ aiCall: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: aiCall,
}));

/** Уникальный хвост: база общая с соседними наборами, пересечься диалогами нельзя. */
const runId = `tl-${Date.now().toString(36)}`;
const conversationIds: string[] = [];

const SETTINGS_SELECT = {
  botTopicLockEnabled: true,
  botTopicDriftTurns: true,
  botEnabled: true,
  botInstagramEnabled: true,
  botReplyDelaySec: true,
  botReplyMaxWaitSec: true,
} as const;
let savedSettings: Record<keyof typeof SETTINGS_SELECT, boolean | number>;

const BUDGET_QUESTION = "Буҷетатон то чанд ҳазор доллар аст?";

/** Ответ модели на ход квалификации — с полями темы, как их вернула бы живая модель. */
function modelReply(reply: string[], topic: Record<string, unknown> = {}) {
  return { reply, ready: false, confident: true, lead: {}, ...topic };
}

/** Параметры последнего вызова квалификатора: промт и схема инструмента. */
function lastQualifyCall(): { system: string; systemStable?: string; schema?: any } {
  const calls = aiCall.mock.calls.filter(([params]) => params?.endpoint === "lead-qualify");
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

async function setTopicLock(enabled: boolean, driftTurns = 1): Promise<void> {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botTopicLockEnabled: enabled, botTopicDriftTurns: driftTurns },
  });
}

async function readConversation(subscriberId: string) {
  const row = await prisma.botConversation.findUnique({
    where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId } },
  });
  if (row && !conversationIds.includes(row.id)) conversationIds.push(row.id);
  return row;
}

beforeAll(async () => {
  fixture = await createCustomerMessengerFixture("INSTAGRAM");
  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: SETTINGS_SELECT,
  });
  // Дебаунс на ноль: ход бота по умолчанию ждёт тишины 25 секунд, и тест бы просто не
  // уложился в таймаут. Рубильники канала включаем явно — соседний набор мог оставить
  // их выключенными, и до квалификатора ход бы вовсе не дошёл.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botReplyDelaySec: 0, botReplyMaxWaitSec: 5, botEnabled: true, botInstagramEnabled: true },
  });
});

afterAll(async () => {
  await fixture?.dispose();
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
});

beforeEach(() => {
  aiCall.mockReset();
});

describe("разбор ответа модели про тему", () => {
  it("берёт только код из закрытого списка", () => {
    expect(parseTopicAnswer({ topic: "price" }).topic).toBe("price");
    // Выдуманный код доехал бы до колонки в базе и до сравнения «сменилась ли тема».
    expect(parseTopicAnswer({ topic: "budget" }).topic).toBeNull();
    expect(parseTopicAnswer({ topic: 7 }).topic).toBeNull();
    expect(parseTopicAnswer({}).topic).toBeNull();
  });

  it("пустой вопрос — это «вопроса нет», а не пустой пузырь клиенту", () => {
    expect(parseTopicAnswer({ openQuestion: "" }).openQuestion).toBeNull();
    expect(parseTopicAnswer({ openQuestion: "   " }).openQuestion).toBeNull();
    expect(parseTopicAnswer({ openQuestion: "да" }).openQuestion).toBeNull();
    expect(parseTopicAnswer({ openQuestion: `  ${BUDGET_QUESTION} ` }).openQuestion).toBe(BUDGET_QUESTION);
  });

  it("ответ на вопрос засчитывается только по явному true", () => {
    expect(parseTopicAnswer({ clientAnsweredOpenQuestion: true }).clientAnsweredOpenQuestion).toBe(true);
    // Модель охотно возвращает строку «true» и «yes» — это НЕ ответ клиента, и принять
    // такое значит молча закрыть живой вопрос.
    expect(parseTopicAnswer({ clientAnsweredOpenQuestion: "true" }).clientAnsweredOpenQuestion).toBe(false);
    expect(parseTopicAnswer({}).clientAnsweredOpenQuestion).toBe(false);
  });
});

describe("счётчик ухода от темы", () => {
  const asked: TopicState = {
    topic: "price",
    topicLabel: "буҷет",
    openQuestion: BUDGET_QUESTION,
    offTopicTurns: 0,
  };

  it("новый вопрос начинает отсчёт с нуля", () => {
    const state = nextTopicState(EMPTY_TOPIC_STATE, {
      topic: "price",
      topicLabel: "буҷет",
      openQuestion: BUDGET_QUESTION,
      clientAnsweredOpenQuestion: false,
    });
    expect(state.openQuestion).toBe(BUDGET_QUESTION);
    expect(state.offTopicTurns).toBe(0);
  });

  it("модель «забыла» вопрос — код его не теряет и считает уход", () => {
    // Ровно та поломка, ради которой всё написано: модель отвечает на последнюю
    // реплику и роняет висящую задачу. Пустое поле не закрывает вопрос.
    const state = nextTopicState(asked, {
      topic: "price",
      topicLabel: null,
      openQuestion: null,
      clientAnsweredOpenQuestion: false,
    });
    expect(state.openQuestion).toBe(BUDGET_QUESTION);
    expect(state.offTopicTurns).toBe(1);
    // Второй уход подряд — предел исчерпан, вопрос снимается совсем (см. модуль).
    expect(nextTopicState(state, parseTopicAnswer({ topic: "price" })).openQuestion).toBeNull();
  });

  it("ответ клиента закрывает вопрос и обнуляет счётчик", () => {
    const drifted = { ...asked, offTopicTurns: 3 };
    const state = nextTopicState(drifted, {
      topic: "price",
      topicLabel: "буҷет",
      openQuestion: null,
      clientAnsweredOpenQuestion: true,
    });
    expect(state.openQuestion).toBeNull();
    expect(state.offTopicTurns).toBe(0);
  });

  it("клиент сам сменил тему — старый вопрос снимается вместе с ней", () => {
    const state = nextTopicState({ ...asked, offTopicTurns: 2 }, parseTopicAnswer({ topic: "showing" }));
    expect(state.topic).toBe("showing");
    expect(state.openQuestion).toBeNull();
    expect(state.offTopicTurns).toBe(0);
  });

  it("бот задал другой вопрос — отсчёт начинается заново", () => {
    const state = nextTopicState(asked, parseTopicAnswer({ topic: "price", openQuestion: "Кадом тараф?" }));
    expect(state.openQuestion).toBe("Кадом тараф?");
    expect(state.offTopicTurns).toBe(0);
  });

  it("отметка о смене темы ставится только при настоящей смене", () => {
    const same = topicStateUpdate(asked, { ...asked, offTopicTurns: 1 });
    expect(same.topicSetAt).toBeUndefined();
    const changed = topicStateUpdate(asked, { ...asked, topic: "showing" });
    expect(changed.topicSetAt).toBeInstanceOf(Date);
  });
});

describe("предписание на ход", () => {
  const on = { enabled: true, driftTurns: 1 };
  const hanging: TopicState = { topic: "price", topicLabel: "буҷет", openQuestion: BUDGET_QUESTION, offTopicTurns: 0 };

  it("при driftTurns=1 включается с ПЕРВОЙ же реплики мимо темы", () => {
    // Подпись настройки обещает «со следующей же реплики». Счётчик в базе на этот
    // момент ещё нулевой — клиент только что написал, и его реплика и есть первый уход.
    expect(shouldPressOpenQuestion(hanging, on)).toBe(true);
    expect(topicDirective(hanging, on)).toContain(BUDGET_QUESTION);
    expect(topicDirective(hanging, on)).toContain("заверши сообщение ровно этим вопросом");
  });

  it("более мягкая настройка откладывает возврат", () => {
    const soft = { enabled: true, driftTurns: 3 };
    expect(shouldPressOpenQuestion(hanging, soft)).toBe(false);
    expect(shouldPressOpenQuestion({ ...hanging, offTopicTurns: 1 }, soft)).toBe(false);
    // Предел попыток (2) наступает раньше, чем мягкая настройка успевает сработать
    // на третьем ходу: вопрос к этому моменту уже снят.
    expect(shouldPressOpenQuestion({ ...hanging, offTopicTurns: 2 }, soft)).toBe(false);
  });

  it("без незакрытого вопроса возвращать не к чему", () => {
    expect(shouldPressOpenQuestion(EMPTY_TOPIC_STATE, on)).toBe(false);
    expect(topicDirective(EMPTY_TOPIC_STATE, on)).toBe("");
  });

  it("выключенный рубильник не добавляет к промту ни строчки", () => {
    const off = { enabled: false, driftTurns: 1 };
    expect(topicDirective(hanging, off)).toBe("");
    expect(topicStateBlock(hanging, off)).toBe("");
  });

  it("состояние в промте называет и тему, и вопрос, и сколько ходов его обходят", () => {
    const block = topicStateBlock({ ...hanging, offTopicTurns: 2 }, on);
    expect(block).toContain("ТЕМА: буҷет.");
    expect(block).toContain(`НЕЗАКРЫТЫЙ ВОПРОС: "${BUDGET_QUESTION}".`);
    expect(block).toContain("Клиент не ответил 2 ходов.");
  });

  it("клиент ответил — постфильтр молчит, даже когда предписание в промте было", () => {
    // Догонять человека вопросом, на который он только что ответил, хуже, чем не
    // догонять вовсе: именно так разговор превращается в неисправный автомат.
    const answered = parseTopicAnswer({ topic: "price", clientAnsweredOpenQuestion: true });
    expect(mustRepeatOpenQuestion(hanging, answered, on)).toBe(false);
    const drifted = parseTopicAnswer({ topic: "price" });
    expect(mustRepeatOpenQuestion(hanging, drifted, on)).toBe(true);
    expect(mustRepeatOpenQuestion(hanging, parseTopicAnswer({ topic: "job" }), on)).toBe(false);
  });
});

describe("постфильтр дописывает забытый вопрос", () => {
  it("вопроса в репликах нет — он уходит отдельным сообщением", () => {
    const out = ensureOpenQuestionKept(["Мо дар маркази шаҳр ҳастем"], BUDGET_QUESTION, true);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(BUDGET_QUESTION);
  });

  it("места под второй пузырь нет — вопрос дописывается в конец последнего", () => {
    // Предел в два сообщения держит вся отправка: третье молча выбрасывается, а
    // вместе с ним выбросился бы и вопрос.
    const out = ensureOpenQuestionKept(["Ҳа", "Мо дар маркази шаҳр ҳастем"], BUDGET_QUESTION, true);
    expect(out).toHaveLength(2);
    expect(out[1].endsWith(BUDGET_QUESTION)).toBe(true);
  });

  it("модель спросила сама, пусть другими словами — второй раз не дописываем", () => {
    const out = ensureOpenQuestionKept(["Мо дар марказ. Буҷетатон чанд ҳазор доллар?"], BUDGET_QUESTION, true);
    expect(out).toHaveLength(1);
  });

  it("без предписания не трогает реплики вовсе", () => {
    const bubbles = ["Мо дар маркази шаҳр ҳастем"];
    expect(ensureOpenQuestionKept(bubbles, BUDGET_QUESTION, false)).toEqual(bubbles);
    expect(ensureOpenQuestionKept(bubbles, null, true)).toEqual(bubbles);
  });

  it("узнаёт вопрос по корням слов, а не по точному совпадению", () => {
    // Таджикский лепит окончания к корню: «буҷет» → «буҷетатон». Требование буквы
    // означало бы второй такой же вопрос следом за первым.
    expect(repeatsQuestion("Буҷети шумо чанд ҳазор?", BUDGET_QUESTION)).toBe(true);
    expect(repeatsQuestion("Мо дар маркази шаҳр ҳастем", BUDGET_QUESTION)).toBe(false);
  });
});

describe("живой диалог: состояние темы копится в базе", () => {
  const subscriberId = `${runId}-live`;

  it("вопрос бота запоминается, уход с темы возвращает его клиенту, ответ закрывает", async () => {
    await setTopicLock(true, 1);

    // ХОД 1: бот спрашивает про бюджет.
    aiCall.mockResolvedValue(
      modelReply([BUDGET_QUESTION], {
        topic: "price",
        topicLabel: "буҷет",
        openQuestion: BUDGET_QUESTION,
        clientAnsweredOpenQuestion: false,
      })
    );
    await processMessengerTurn({ channel: "INSTAGRAM", subscriberId, text: "Салом, хона мекобам" });

    const afterAsk = await readConversation(subscriberId);
    expect(afterAsk?.topic).toBe("price");
    expect(afterAsk?.topicLabel).toBe("буҷет");
    expect(afterAsk?.openQuestion).toBe(BUDGET_QUESTION);
    expect(afterAsk?.offTopicTurns).toBe(0);
    expect(afterAsk?.topicSetAt).toBeInstanceOf(Date);

    // ХОД 2: клиент спрашивает совсем о другом, а модель про свой вопрос забывает —
    // возвращает пустой openQuestion и отвечает только на реплику клиента.
    aiCall.mockResolvedValue(
      modelReply(["Мо дар маркази шаҳр ҳастем"], {
        topic: "price",
        openQuestion: "",
        clientAnsweredOpenQuestion: false,
      })
    );
    const drifted = await processMessengerTurn({
      channel: "INSTAGRAM",
      subscriberId,
      text: "Шумо кучо ҷойгиред?",
    });

    // Промт этого хода: и состояние, и дословное предписание.
    const call = lastQualifyCall();
    expect(call.system).toContain(`НЕЗАКРЫТЫЙ ВОПРОС: "${BUDGET_QUESTION}"`);
    expect(call.system).toContain("ЗАДАНИЕ НА ЭТОТ ХОД");
    // Переменная часть промта — да, кэшируемый префикс — никогда: состояние меняется
    // каждый ход и внутри кэш-блока стоило бы дороже, чем экономило.
    expect(call.systemStable ?? "").not.toContain("НЕЗАКРЫТЫЙ ВОПРОС");

    // Модель предписание не выполнила — вопрос дописал код. Именно это и есть гарантия.
    const said = [drifted.reply, drifted.reply2].filter(Boolean).join("\n");
    expect(said).toContain("Буҷетатон");

    const afterDrift = await readConversation(subscriberId);
    // Вопрос НЕ потерян: закрыть его может только ответ клиента или смена темы.
    expect(afterDrift?.openQuestion).toBe(BUDGET_QUESTION);
    expect(afterDrift?.offTopicTurns).toBe(1);

    // ХОД 3: клиент наконец отвечает. Проверяем заодно, что прошлый ход честно
    // рассказал модели, сколько раз вопрос обошли стороной.
    aiCall.mockResolvedValue(
      modelReply(["Кадом тарафро дидан мехоҳед?"], {
        topic: "price",
        topicLabel: "буҷет",
        openQuestion: "Кадом тарафро дидан мехоҳед?",
        clientAnsweredOpenQuestion: true,
      })
    );
    const answered = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId, text: "То 50 ҳазор доллар" });
    expect(lastQualifyCall().system).toContain("Клиент не ответил 1 ходов.");

    // Вопрос про бюджет больше не догоняет человека, который на него ответил.
    expect([answered.reply, answered.reply2].filter(Boolean).join("\n")).not.toContain("Буҷетатон");

    const afterAnswer = await readConversation(subscriberId);
    expect(afterAnswer?.offTopicTurns).toBe(0);
    expect(afterAnswer?.openQuestion).toBe("Кадом тарафро дидан мехоҳед?");
  }, 30_000);

  it("состояние переживает перезапуск: оно целиком в записи диалога", async () => {
    // В памяти процесса живут только подсказки одного хода (turnHint). Тема обязана
    // лежать в базе: разговор о квартире тянется сутками, а контейнер перезапускается.
    const row = await readConversation(subscriberId);
    const reread = await prisma.botConversation.findUnique({
      where: { id: row!.id },
      select: { topic: true, topicLabel: true, openQuestion: true, offTopicTurns: true, topicSetAt: true },
    });
    expect(reread).toEqual({
      topic: "price",
      topicLabel: "буҷет",
      openQuestion: "Кадом тарафро дидан мехоҳед?",
      offTopicTurns: 0,
      topicSetAt: expect.any(Date),
    });
    // И то же самое, прочитанное так, как его читает ход диалога.
    expect(topicStateOf(reread!).openQuestion).toBe("Кадом тарафро дидан мехоҳед?");
  });
});

describe("рубильник выключен — всё как раньше", () => {
  const subscriberId = `${runId}-off`;

  it("ни строки в промте, ни поля в схеме, ни правки реплики, ни записи в базу", async () => {
    await setTopicLock(false, 1);
    // Положительный ответ соблюдает схему выключенного рубильника: поля темы
    // модель не возвращает. Запрещённые поля проверяются отдельным reject-тестом.
    aiCall.mockResolvedValue(modelReply(["Мо дар маркази шаҳр ҳастем"]));

    const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId, text: "Шумо кучо ҷойгиред?" });

    const call = lastQualifyCall();
    expect(call.system).not.toContain("ТЕМА:");
    expect(call.system).not.toContain("НЕЗАКРЫТЫЙ ВОПРОС");
    expect(call.system).not.toContain("ЗАДАНИЕ НА ЭТОТ ХОД");
    // Схема инструмента — тоже прежняя: лишнее обязательное поле стоит токенов на
    // каждом ходе и меняет поведение модели даже там, где мы его не читаем.
    expect(Object.keys(call.schema.properties)).not.toContain("topic");
    expect(Object.keys(call.schema.properties)).not.toContain("openQuestion");
    // `confident` — не «лишнее поле»: его читают на КАЖДОМ ходе и в каждом канале
    // (ai/leadKind.ts решает по нему тип карточки). Добавлено 30.08.2026 по разбору
    // прода: без признака уверенности «модель не поняла» молча превращалось в
    // «покупатель», и мусорный лид уходил живому агенту. Рубильник темы к нему
    // отношения не имеет — в отличие от topic/openQuestion ниже по списку.
    expect(call.schema.required).toEqual(["reply", "ready", "confident"]);

    // Реплика уходит ровно такой, какой её вернула модель.
    expect(result.reply).toBe("Мо дар маркази шаҳр ҳастем");
    expect(result.reply2).toBeUndefined();

    const row = await readConversation(subscriberId);
    expect(row?.topic).toBeNull();
    expect(row?.openQuestion).toBeNull();
    expect(row?.offTopicTurns).toBe(0);
  }, 30_000);
});

/**
 * ПРЕДЕЛ ПОПЫТОК ВЕРНУТЬ ВОПРОС.
 *
 * Разбор живой переписки 13.08.2026 (клиент Жасмин, WhatsApp): предела не было
 * вовсе. Человек не отвечал на стартовую анкету — он присылал фото квартиры,
 * спрашивал, продана ли она, и просил позвонить, — а код дописывал ему эту анкету
 * восемь раз подряд, включая ответы на «ташаккур» и «тезтарак». Владелец увидел
 * это первым и сказал прямо: бот злит клиента.
 *
 * Три попытки — не выдуманное число: ровно это уже стояло в промте бота («не
 * переспрашивай по третьему разу одно и то же»). Была просьба к модели, стал предел
 * в коде.
 */
describe("вопрос не возвращают бесконечно", () => {
  const ON = { enabled: true, driftTurns: 1 };
  const asked = { topic: "buy" as const, topicLabel: null, openQuestion: "Кадом тарафда хона кофта истодед?", offTopicTurns: 0 };

  it("первая попытка давит — удержание темы работает как задумано", () => {
    expect(shouldPressOpenQuestion(asked, ON)).toBe(true);
    expect(shouldPressOpenQuestion({ ...asked, offTopicTurns: 1 }, ON)).toBe(true);
  });

  it("после двух попыток давить перестаём (владелец 16.08.2026: «вечно переспрашивает»)", () => {
    expect(shouldPressOpenQuestion({ ...asked, offTopicTurns: 2 }, ON)).toBe(false);
    expect(shouldPressOpenQuestion({ ...asked, offTopicTurns: 3 }, ON)).toBe(false);
    expect(shouldPressOpenQuestion({ ...asked, offTopicTurns: 8 }, ON)).toBe(false);
  });

  it("на второй попытке вопрос снимается совсем, а не висит молча", () => {
    // Пока openQuestion заполнен, он уходит в промт и модель тянется его задать —
    // поэтому «перестали давить» недостаточно, вопрос должен исчезнуть.
    const after = nextTopicState(
      { ...asked, offTopicTurns: 2 },
      parseTopicAnswer({ topic: "buy", openQuestion: "Кадом тарафда хона кофта истодед?" })
    );
    expect(after.openQuestion).toBeNull();
    expect(after.offTopicTurns).toBe(0);
  });

  it("ответил клиент — счётчик обнуляется, предел ни при чём", () => {
    const after = nextTopicState(
      { ...asked, offTopicTurns: 2 },
      parseTopicAnswer({ topic: "buy", openQuestion: "Буҷетатон то чӣ қадар?", clientAnsweredOpenQuestion: true })
    );
    expect(after.openQuestion).toBe("Буҷетатон то чӣ қадар?");
    expect(after.offTopicTurns).toBe(0);
  });

  /**
   * ПЯТНАДЦАТЬ ПОВТОРОВ ПОДРЯД (переписка 14.08.2026, разбор владельца).
   *
   * «Вы ищете в районе Исмоили Сомони или рассмотреть и другие варианты?» уходило
   * клиенту после каждого его сообщения: про чемпионат мира, про год, про подарок
   * квартиры, про номер агента. Предел в три попытки при этом работал — он считает
   * ходы ПОДРЯД по одной теме, а клиент каждой репликой тему менял. Счётчик
   * обнулялся, тот же самый вопрос переезжал в новое состояние и оживал заново.
   */
  it("клиент сменил тему — прежний вопрос снимается, а не переезжает в новое состояние", () => {
    const after = nextTopicState(
      asked,
      parseTopicAnswer({ topic: "price", openQuestion: "Кадом тарафда хона кофта истодед?" })
    );
    expect(after.openQuestion).toBeNull();
  });

  it("клиент ответил, а модель по привычке вернула тот же вопрос — вопрос всё равно закрыт", () => {
    const after = nextTopicState(
      asked,
      parseTopicAnswer({
        topic: "buy",
        openQuestion: "Кадом тарафда хона кофта истодед?",
        clientAnsweredOpenQuestion: true,
      })
    );
    expect(after.openQuestion).toBeNull();
  });

  it("новый вопрос при смене темы живёт: закрывается прежний, а не любой", () => {
    const after = nextTopicState(asked, parseTopicAnswer({ topic: "price", openQuestion: "Буҷетатон то чӣ қадар?" }));
    expect(after.openQuestion).toBe("Буҷетатон то чӣ қадар?");
    expect(after.offTopicTurns).toBe(0);
  });
});
