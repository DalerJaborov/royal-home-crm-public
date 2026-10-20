/**
 * БОТ ДЕРЖИТ ТЕМУ РАЗГОВОРА (решение владельца 11.08.2026).
 *
 * «После того как ИИ агент начал вести переговоры с клиентом и вдруг клиент начал
 * говорить не по теме — пусть ИИ агент потихоньку возвращает его к последнему диалогу».
 *
 * ПОЧЕМУ ЭТО НЕ СТРОЧКА В ПРОМТЕ. Просьба «мягко возвращай к теме» проверяется только
 * глазами и живёт ровно до того хода, на котором модель отвлеклась, — а отвлекается она
 * именно там, где клиент сменил разговор, то есть ровно в нужный момент. За 01.08 пять
 * правил из промта молча перестали срабатывать на живом клиенте; 11.08 так же повисла
 * просьба о номере, и это стоило заявки. Поэтому удержание темы собрано из трёх частей,
 * ни одна из которых не полагается на добрую волю модели:
 *
 *  1. СОСТОЯНИЕ. Тема и незакрытый вопрос лежат в BotConversation, а не в голове модели
 *     и не в оперативной памяти процесса (как turnHint, который живёт один ход). Диалог
 *     переживает перезапуск контейнера, а разговор о квартире тянется сутками.
 *  2. ПОЛЯ СХЕМЫ. topic / openQuestion / clientAnsweredOpenQuestion модель обязана
 *     заполнить — «почти заполнить» их нельзя, как и showPropertyNumber (ai/photoOffer.ts).
 *  3. ПОСТФИЛЬТР. Если вопрос всё-таки потерялся, его дописывает КОД
 *     (ensureOpenQuestionKept в ai/replyGuards.ts). Это и превращает удержание темы из
 *     пожелания в гарантию.
 *
 * Модуль намеренно не знает ни про базу, ни про транспорт: здесь только текст для
 * модели, разбор её ответа и правила перехода состояния. Всё это проверяется тестом,
 * ничего не поднимая (tests/bot-topic-lock.test.ts).
 */

import { prisma } from "../db.js";
import { repeatsQuestion } from "./replyGuards.js";

/**
 * Закрытый список тем. Именно закрытый, а не свободная строка: по нему код отличает
 * «клиент сменил тему» от «модель переформулировала ту же самую». Свободный текст
 * («бюджет» / «цена» / «сколько стоит») давал бы смену темы на каждом ходе, счётчик
 * ухода обнулялся бы вечно, и удержание не срабатывало бы никогда.
 */
export const TOPIC_CODES = [
  "price",
  "district",
  "rooms",
  "area",
  "photos",
  "showing",
  "documents",
  "payment",
  "sell_intake",
  "job",
  "other",
] as const;

export type TopicCode = (typeof TOPIC_CODES)[number];

/**
 * Запасная подпись темы — на случай, когда модель код темы вернула, а формулировку нет.
 * По-русски: это служебная строка промта и инбокса, а не текст клиенту. Живую
 * формулировку на языке клиента даёт модель (topicLabel), и она всегда приоритетнее.
 */
const TOPIC_LABELS_RU: Record<TopicCode, string> = {
  price: "цена и бюджет",
  district: "район",
  rooms: "количество комнат",
  area: "площадь",
  photos: "фотографии объекта",
  showing: "показ объекта",
  documents: "документы",
  payment: "оплата и рассрочка",
  sell_intake: "приём объекта на продажу",
  job: "работа в агентстве",
  other: "прочее",
};

/** Состояние темы одного диалога — ровно то, что лежит в BotConversation. */
export interface TopicState {
  topic: TopicCode | null;
  topicLabel: string | null;
  /** Последний заданный ботом и НЕ закрытый вопрос. null — на боте ничего не висит. */
  openQuestion: string | null;
  /** Сколько ходов подряд вопрос висит без ответа. Растёт только пока вопрос жив. */
  offTopicTurns: number;
}

export const EMPTY_TOPIC_STATE: TopicState = {
  topic: null,
  topicLabel: null,
  openQuestion: null,
  offTopicTurns: 0,
};

/** Настройки → Бот → «Бот держит тему». */
export interface TopicLockSettings {
  enabled: boolean;
  /** После скольких ходов ухода бот возвращает свой вопрос дословно. 1 = сразу. */
  driftTurns: number;
}

/**
 * Выключено — то, как бот работал до 11.08.2026.
 *
 * Отказ базы трактуем именно так, а не «включено»: удержание темы дописывает клиенту
 * текст, и делать это на догадке о настройках нельзя. Молчаливо не сработавшая
 * возможность стоит одного менее настойчивого ответа; молчаливо сработавшая на
 * выключенном рубильнике — доверия к рубильнику.
 */
const TOPIC_LOCK_OFF: TopicLockSettings = { enabled: false, driftTurns: 1 };

export async function loadTopicLockSettings(): Promise<TopicLockSettings> {
  try {
    const s = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { botTopicLockEnabled: true, botTopicDriftTurns: true },
    });
    if (!s) return TOPIC_LOCK_OFF;
    return { enabled: s.botTopicLockEnabled, driftTurns: s.botTopicDriftTurns };
  } catch {
    return TOPIC_LOCK_OFF;
  }
}

/**
 * Поля инструмента submit_reply. При выключенном рубильнике полей НЕТ ВОВСЕ — схема
 * обязана быть побайтово прежней, иначе «выключено» означало бы «работает чуть иначе».
 *
 * ПРО openQuestion И null. Схема уходит двум поставщикам сразу (Claude и Gemini), а
 * Gemini принимает не JSON Schema, а её OpenAPI-подмножество: `type: ["string","null"]`
 * там означает 400 на каждый вызов, то есть молчащего бота. Поэтому поле объявлено
 * обычной строкой, а «вопроса нет» передаётся пустой строкой — и превращается в null
 * уже здесь, в parseTopicAnswer. Граница между «модель сказала» и «мы поняли» одна.
 */
export function topicSchemaFields(enabled: boolean): Record<string, unknown> {
  if (!enabled) return {};
  return {
    topic: {
      type: "string",
      enum: [...TOPIC_CODES],
      description:
        "О ЧЁМ идёт разговор ПРЯМО СЕЙЧАС: price — цена, бюджет, торг; district — район, ориентир, где " +
        "находится; rooms — количество комнат; area — площадь, этаж, метраж; photos — просит фотографии или " +
        "ссылку; showing — когда посмотреть, встреча; documents — документы, оформление; payment — рассрочка, " +
        "ипотека, способ оплаты; sell_intake — клиент сдаёт нам свой объект на продажу; job — устройство на " +
        "работу; other — всё остальное, включая разговор не про недвижимость. Заполняй КАЖДЫЙ ход.",
    },
    topicLabel: {
      type: "string",
      description:
        "Та же тема одной короткой фразой НА ЯЗЫКЕ КЛИЕНТА («буҷет», «кадом тараф», «расмҳо», «район»). " +
        "Это служебная подпись для нас, клиенту она не отправляется.",
    },
    openQuestion: {
      type: "string",
      description:
        "Вопрос, который ты задаёшь клиенту в ЭТОМ сообщении и ждёшь на него ответа — дословно, как он " +
        "написан в reply, и обязательно на языке ПОСЛЕДНЕГО сообщения клиента (он мог перейти с русского на " +
        "таджикский, и тогда старая формулировка сюда не годится). Если в этом ходе ты вопроса не задаёшь, а " +
        "прошлый ещё висит без ответа — повтори здесь ТОТ ЖЕ прошлый вопрос слово в слово. Вопроса нет вовсе — " +
        "пустая строка. Если клиент на прошлый вопрос ответил или заговорил о другом, СТАРЫЙ вопрос сюда не " +
        "переписывай: он закрыт, и повторять его клиенту нельзя.",
    },
    clientAnsweredOpenQuestion: {
      type: "boolean",
      description:
        "Ответил ли клиент в этом сообщении на ТВОЙ прошлый незакрытый вопрос (он показан выше в блоке " +
        "«НЕЗАКРЫТЫЙ ВОПРОС»). Ответ по существу, пусть коротко и не теми словами — true. Написал про другое, " +
        "переспросил, поздоровался, промолчал по сути — false. Незакрытого вопроса не было — false.",
    },
  };
}

/** Какие из этих полей обязательны. Пусто при выключенном рубильнике — см. выше. */
export function topicRequiredFields(enabled: boolean): string[] {
  return enabled ? ["topic", "openQuestion", "clientAnsweredOpenQuestion"] : [];
}

/** Ответ модели про тему, приведённый к нашим типам. */
export interface TopicTurnAnswer {
  topic: TopicCode | null;
  topicLabel: string | null;
  openQuestion: string | null;
  clientAnsweredOpenQuestion: boolean;
}

/** Слишком короткое «да»/«?» вопросом не считаем: дописывать такое клиенту нельзя. */
const MIN_QUESTION_LENGTH = 5;
/** Вопрос уходит и в промт, и (постфильтром) клиенту — простыня там не нужна. */
const MAX_QUESTION_LENGTH = 200;

/**
 * Разбор ответа модели. Ответ модели — внешние данные: код темы вне списка, число
 * вместо строки, пустой вопрос и «нет» здесь одинаково означают «ничего не сказано».
 * Без этой границы выдуманный код темы доехал бы до колонки в базе, а пустой вопрос —
 * до постфильтра, который отправил бы клиенту пустой пузырь.
 */
export function parseTopicAnswer(raw: unknown): TopicTurnAnswer {
  const value = (raw ?? {}) as Record<string, unknown>;
  const topicRaw = typeof value.topic === "string" ? value.topic.trim() : "";
  const topic = (TOPIC_CODES as readonly string[]).includes(topicRaw) ? (topicRaw as TopicCode) : null;

  const labelRaw = typeof value.topicLabel === "string" ? value.topicLabel.trim() : "";
  const questionRaw = typeof value.openQuestion === "string" ? value.openQuestion.trim() : "";

  return {
    topic,
    topicLabel: labelRaw ? labelRaw.slice(0, 80) : null,
    openQuestion: questionRaw.length >= MIN_QUESTION_LENGTH ? questionRaw.slice(0, MAX_QUESTION_LENGTH) : null,
    clientAnsweredOpenQuestion: value.clientAnsweredOpenQuestion === true,
  };
}

/** Подпись темы для промта и инбокса: сначала слова клиента, потом наша запаска. */
export function topicTitle(state: TopicState): string | null {
  if (state.topicLabel) return state.topicLabel;
  return state.topic ? TOPIC_LABELS_RU[state.topic] : null;
}

/**
 * Состояние темы В ПРОМТ, каждый ход.
 *
 * Идёт рядом с «ТЕКУЩЕЕ СОСТОЯНИЕ ДИАЛОГА» и строго в ИЗМЕНЯЕМУЮ часть system: тема
 * меняется от хода к ходу, а внутри кэшируемого префикса любая переменная строка ломает
 * побайтовое совпадение и превращает экономию в наценку (см. ai/client.ts).
 *
 * Пустое состояние не печатаем вовсе: строка «ТЕМА: null» ничего не сообщает, а токены
 * стоит на каждом сообщении каждого диалога.
 */
export function topicStateBlock(state: TopicState, settings: TopicLockSettings): string {
  if (!settings.enabled) return "";
  const title = topicTitle(state);
  if (!title && !state.openQuestion) return "";
  const parts: string[] = [];
  if (title) parts.push(`ТЕМА: ${title}.`);
  if (state.openQuestion) {
    parts.push(`НЕЗАКРЫТЫЙ ВОПРОС: "${state.openQuestion}".`);
    parts.push(
      state.offTopicTurns > 0
        ? `Клиент не ответил ${state.offTopicTurns} ходов.`
        : "Клиент на него ещё не отвечал."
    );
  }
  return `\n\n${parts.join(" ")}`;
}

/**
 * Пора ли давить на незакрытый вопрос В ЭТОМ ходе.
 *
 * Считаем ДО обращения к модели, поэтому берём счётчик «с запасом на этот ход»: клиент
 * уже написал, и пока модель не ответила, мы обязаны считать его реплику очередным
 * уходом. Иначе при driftTurns=1 («со следующей же реплики») предписание появлялось бы
 * только со второго ухода — на ход позже, чем обещает подпись настройки.
 *
 * Если окажется, что клиент всё-таки ответил, вреда нет: предписание начинается с
 * прямой оговорки про этот случай, а постфильтр в таком ходе не срабатывает вовсе
 * (см. mustRepeatOpenQuestion).
 */
export function pendingOffTopicTurns(state: TopicState): number {
  return state.openQuestion ? state.offTopicTurns + 1 : 0;
}

/**
 * СКОЛЬКО РАЗ ПОДРЯД МОЖНО ВЕРНУТЬ ОДИН И ТОТ ЖЕ ВОПРОС.
 *
 * Предела не было вовсе, и 13.08.2026 это вышло боком на живом клиенте (Жасмин,
 * WhatsApp): человек не отвечал на стартовую анкету «Кадом тарафда хона кофта
 * истодед ё фурӯхтаниед?» — он присылал фото конкретной квартиры, спрашивал,
 * продана ли она, и просил позвонить. Для удержания темы это «уход», счётчик рос,
 * и код дописывал анкету ВОСЕМЬ раз подряд, в том числе к «ташаккур» и «тезтарак».
 * Со стороны клиента это неисправный автомат, и владелец увидел это первым.
 *
 * Три — не выдуманное число: ровно это уже записано в промте бота («НЕ переспрашивай
 * по третьему разу одно и то же... Если человек уже дважды ответил не про жильё,
 * тема закрыта»). Правило было просьбой к модели и не держалось — теперь это предел
 * в коде, как и остальные дорогие запреты этого проекта.
 *
 * Что происходит после предела: вопрос снимается совсем (см. nextTopicState).
 * Не «замолкаем и ждём» — незакрытый вопрос перестаёт существовать, и бот дальше
 * ведёт разговор по тому, что клиенту действительно нужно.
 */
/**
 * СНИЖЕНО С ТРЁХ ДО ДВУХ (владелец 16.08.2026, вечер: «бот вечно переспрашивает»).
 *
 * Три попытки выглядели умеренно на бумаге, но в живом диалоге к ним добавляется
 * ещё и вопрос, который модель задаёт сама: клиент получил «То чанд ҳазор доллар
 * дар назар доред?» ЧЕТЫРЕ раза подряд, успев между ними попросить просто
 * показать варианты. Две попытки — это «переспросил и отстал», и ровно так ведёт
 * себя живой человек.
 */
const MAX_OPEN_QUESTION_PRESSES = 2;

export function shouldPressOpenQuestion(state: TopicState, settings: TopicLockSettings): boolean {
  if (!settings.enabled || !state.openQuestion) return false;
  if (state.offTopicTurns >= MAX_OPEN_QUESTION_PRESSES) return false;
  return pendingOffTopicTurns(state) >= Math.max(1, settings.driftTurns);
}

/**
 * ПРЕДПИСАНИЕ НА ЭТОТ ХОД, а не общая инструкция.
 *
 * Разница принципиальная и выстрадана этим проектом: «мягко возвращай к теме» модель
 * исполняет как хочет и чаще всего не исполняет вовсе, а «заверши сообщение ровно этим
 * вопросом» либо выполнено, либо нет — и второе видно коду, который вопрос допишет сам.
 *
 * Приклеивается в САМЫЙ конец system: это распоряжение про текущий ход, и оно должно
 * читаться последним, после всех общих правил, а не тонуть среди них.
 */
export function topicDirective(state: TopicState, settings: TopicLockSettings): string {
  if (!shouldPressOpenQuestion(state, settings) || !state.openQuestion) return "";
  return (
    "\n\nЗАДАНИЕ НА ЭТОТ ХОД. На тебе висит незаданный заново вопрос: " +
    `"${state.openQuestion}".\n` +
    "Если клиент в этом сообщении на него ответил — поставь clientAnsweredOpenQuestion=true и вопрос НЕ " +
    "повторяй, продолжай разговор дальше.\n" +
    "Если не ответил — ответь на его реплику ОДНИМ коротким предложением, без нового вопроса, и заверши " +
    `сообщение ровно этим вопросом: "${state.openQuestion}". ` +
    "Не упрекай («вы не ответили»), не объясняй, почему спрашиваешь снова, и не задавай вместо него другой " +
    "вопрос: человек просто отвлёкся, и вернуть его надо спокойно, одной фразой."
  );
}

/**
 * Нужно ли КОДУ дописать вопрос в реплики этого хода.
 *
 * Считается уже ПОСЛЕ ответа модели — здесь известно главное: ответил клиент или нет.
 * Ответил или сменил тему сам — не дописываем ничего: догонять человека вопросом, на
 * который он только что ответил, хуже, чем не догонять вовсе.
 */
export function mustRepeatOpenQuestion(
  state: TopicState,
  answer: TopicTurnAnswer | null,
  settings: TopicLockSettings
): boolean {
  if (!shouldPressOpenQuestion(state, settings)) return false;
  if (!answer) return false;
  if (answer.clientAnsweredOpenQuestion) return false;
  if (isTopicChanged(state, answer)) return false;
  return true;
}

/** Клиент сам увёл разговор на ДРУГУЮ тему — старый вопрос вместе с ней и снимается. */
function isTopicChanged(state: TopicState, answer: TopicTurnAnswer): boolean {
  return !!answer.topic && !!state.topic && answer.topic !== state.topic;
}

/**
 * Новое состояние темы после хода.
 *
 * Два правила, из которых всё остальное следует:
 *
 *  1. ВОПРОС СНИМАЕТСЯ ТОЛЬКО ДВУМЯ СОБЫТИЯМИ — клиент на него ответил либо сам сменил
 *     тему. Модель, которая просто «забыла» про вопрос и вернула пустое поле, вопрос НЕ
 *     закрывает: именно эта забывчивость и есть та поломка, ради которой всё написано.
 *  2. СЧЁТЧИК РАСТЁТ, ПОКА ВИСИТ ОДИН И ТОТ ЖЕ ВОПРОС. Новый вопрос — новый отсчёт,
 *     иначе бот, спокойно ведущий разговор с новым вопросом каждый ход, через пять
 *     сообщений начал бы давить на пустом месте.
 */
export function nextTopicState(state: TopicState, answer: TopicTurnAnswer | null): TopicState {
  if (!answer) return state;

  const topicChanged = isTopicChanged(state, answer);
  const topic = answer.topic ?? state.topic;
  // Подпись берём из этого хода; при той же теме держим прежнюю, чтобы она не
  // прыгала от синонима к синониму, а при новой теме — запасную из кода.
  const topicLabel =
    answer.topicLabel ?? (topic === state.topic ? state.topicLabel : null) ?? (topic ? TOPIC_LABELS_RU[topic] : null);

  if (answer.clientAnsweredOpenQuestion || topicChanged) {
    /**
     * СТАРЫЙ ВОПРОС ЗДЕСЬ ЗАКРЫВАЕТСЯ СОВСЕМ, а не переезжает в новое состояние.
     *
     * Разбор переписки 14.08.2026 (WhatsApp, владелец): «Вы ищете в районе Исмоили
     * Сомони или рассмотреть и другие варианты?» ушло клиенту ПЯТНАДЦАТЬ раз подряд —
     * приклеенное к ответу про чемпионат мира, про год, про подарок квартиры и про
     * номер агента. Предел в три попытки при этом работал: он считает ходы ПОДРЯД
     * по ОДНОЙ теме, а клиент каждым сообщением тему менял. Счётчик обнулялся, а
     * `answer.openQuestion` возвращал тот же самый вопрос слово в слово (схема прямо
     * велит модели повторять незакрытый вопрос) — и он оживал бесконечно.
     *
     * Поэтому: клиент ответил или сам сменил тему — прежний вопрос снят. Пережить
     * этот момент может только ДРУГОЙ вопрос, заданный в этом же ходе; повтор
     * прежнего текста считаем той же забывчивостью модели и отбрасываем.
     */
    const carried = answer.openQuestion === state.openQuestion ? null : answer.openQuestion;
    return { topic, topicLabel, openQuestion: carried, offTopicTurns: 0 };
  }

  const openQuestion = answer.openQuestion ?? state.openQuestion;
  /**
   * ПО ОСНОВАМ СЛОВ, А НЕ БУКВАЛЬНО (26.08.2026). Схема лишь ПРОСИТ модель
   * повторять незакрытый вопрос слово в слово; переформулировка («Буҷетатон чӣ
   * қадар?» → «То чанд ҳазор дар назар доред?») при точном сравнении обнуляла
   * счётчик — и предел в 2 попытки не наступал никогда, вопрос жил бесконечно.
   * Асимметрия была двойной: фильтр повторов (dropRepeatedQuestions) узнаёт тот
   * же вопрос НЕЧЁТКО и пропускал переформулировку в чат. Считаем тем же
   * repeatsQuestion, которым пользуется фильтр, — одно правило на оба места.
   */
  const sameQuestion =
    !!state.openQuestion &&
    !!openQuestion &&
    (openQuestion === state.openQuestion || repeatsQuestion(openQuestion, state.openQuestion));
  const pressed = sameQuestion ? state.offTopicTurns + 1 : 0;
  /**
   * Попытки вернуть вопрос кончились — снимаем его совсем.
   *
   * Не «перестаём давить, но помним»: пока `openQuestion` заполнен, он попадает в
   * промт (topicSummary) и модель сама тянется его задать. Клиент трижды говорил о
   * своём и на вопрос не ответил — значит вопрос ему не подходит, и настаивать
   * больше нечем. Дальше разговор ведётся по тому, что нужно человеку.
   */
  if (sameQuestion && pressed >= MAX_OPEN_QUESTION_PRESSES) {
    return { topic, topicLabel, openQuestion: null, offTopicTurns: 0 };
  }
  return { topic, topicLabel, openQuestion, offTopicTurns: pressed };
}

/** Колонки BotConversation → состояние. Чужие/старые значения кода темы отбрасываем. */
export function topicStateOf(row: {
  topic?: string | null;
  topicLabel?: string | null;
  openQuestion?: string | null;
  offTopicTurns?: number | null;
}): TopicState {
  const topic = row.topic && (TOPIC_CODES as readonly string[]).includes(row.topic) ? (row.topic as TopicCode) : null;
  return {
    topic,
    topicLabel: row.topicLabel ?? null,
    openQuestion: row.openQuestion ?? null,
    offTopicTurns: row.offTopicTurns ?? 0,
  };
}

/**
 * Состояние → поля update для BotConversation.
 *
 * topicSetAt обновляется, ТОЛЬКО когда тема действительно сменилась: иначе отметка
 * означала бы «последний ход», а не «когда зашёл разговор», и по ней нельзя было бы
 * понять, сколько времени человек топчется на одном месте.
 */
export function topicStateUpdate(
  previous: TopicState,
  next: TopicState,
  now: Date = new Date()
): {
  topic: string | null;
  topicLabel: string | null;
  openQuestion: string | null;
  offTopicTurns: number;
  topicSetAt?: Date;
} {
  return {
    topic: next.topic,
    topicLabel: next.topicLabel,
    openQuestion: next.openQuestion,
    offTopicTurns: next.offTopicTurns,
    ...(next.topic && next.topic !== previous.topic ? { topicSetAt: now } : {}),
  };
}
