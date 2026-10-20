import {
  CARD_NOTE_TAGS,
  PROPERTY_TYPES,
  PROPERTY_TYPE_LABELS,
  type CardFillSuggestion,
  type PropertyType,
} from "@royal-home/shared";
import type { ConversationMessage } from "@royal-home/shared";
import { prisma } from "../db.js";
import { callAiText } from "./client.js";
import { loadMoneyContext } from "../lib/money.js";
import type { LeadDraft } from "./leadQualifier.js";
import { clientSelfStatedName, normalizeClientName } from "./replyGuards.js";
import { clipHeadTail } from "./untrustedContent.js";

/**
 * «ИИ заполняет карточку сам, агент подтверждает шагами» (пакет владельца 31.07, п. 5).
 *
 * Модуль отвечает ровно на один вопрос: что клиент рассказал о себе и как это ложится
 * в поля карточки. Ничего не сохраняет — решение остаётся за агентом в мастере.
 *
 * Два источника, именно в этом порядке:
 *  1. BotConversation.leadDraft / TelegramConversation.leadDraft — квалификатор уже
 *     копил бюджет, район, комнаты и тип по ходу всего диалога (см. leadQualifier.ts).
 *     Это готовые данные, разбирать переписку заново ради них незачем и дороже.
 *  2. Переписка — только за тем, чего в черновике нет: срочность туда не пишется
 *     вовсе, а тип и пожелания попадают не всегда.
 *
 * Отказ ИИ (нет ключа, таймаут) НЕ ломает мастер: возвращается предложение по одному
 * черновику с aiUnavailable=true, и агент дальше просто выбирает из готовых вариантов.
 */

/** Сколько последних сообщений уходит в модель. Диалог приёма заявки короткий, а
 *  полная лента росла бы вместе со стоимостью разбора. */
const MAX_MESSAGES = 40;
/** Потолок длины одного сообщения — пересланные простыни не должны раздувать запрос. */
const MAX_MESSAGE_CHARS = 500;
/** Сколько последних телефонных разговоров берём в разбор. Три — это примерно вся
 *  история общения с живым клиентом; более старые описывают уже другой запрос. */
const MAX_CALLS = 3;
/** Потолок одной расшифровки: получасовой разговор — это тысячи знаков. Голова и
 *  хвост входят оба (clipHeadTail, ai/untrustedContent.ts, 24.09.2026) — не только
 *  первые минуты («что ищет»), но и то, чем разговор кончился и о чём договорились,
 *  а это чаще лежит в последних репликах. */
const MAX_TRANSCRIPT_CHARS = 4000;

// Форма реплики переписки описана один раз в @royal-home/shared.
type StoredMessage = ConversationMessage;

/** Сообщения диалога лежат в Json-колонке — приводим к списку строк, не доверяя форме.
 *  export — переиспользуется в ai/propertyDraft.ts (тот же формат messages у
 *  BotConversation/TelegramConversation, разбирать заново незачем). */
export function readMessages(raw: unknown): StoredMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages: StoredMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (typeof content !== "string" || content.trim().length === 0) continue;
    if (role !== "user" && role !== "assistant") continue;
    messages.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
  }
  return messages.slice(-MAX_MESSAGES);
}

function readDraft(raw: unknown): LeadDraft | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as LeadDraft;
}

/**
 * Число из ответа модели.
 *
 * Строка принимается НАМЕРЕННО. Схема просит `type: "number"`, но и Gemini, и Claude
 * время от времени отдают сумму строкой — «700000», «700 000», «700000.00». Строгая
 * проверка `typeof value === "number"` такую сумму молча выбрасывала: в заметках
 * карточки стояло «квартира за 700 000 сомони», а поле «Бюджет» оставалось пустым,
 * и подбор объектов по бюджету клиенту не работал вовсе.
 *
 * export — тот же разбор чисел от модели нужен ai/propertyDraft.ts (площадь, этаж,
 * цена объекта — те же огрехи форматирования, что и у бюджета клиента).
 */
export function asPositiveNumber(value: unknown): number | null {
  const num =
    typeof value === "string"
      ? // Пробелы (в т.ч. неразрывный) — разделители разрядов, запятая — десятичная точка.
        Number(value.replace(/\s/g, "").replace(",", "."))
      : value;
  return typeof num === "number" && Number.isFinite(num) && num > 0 ? num : null;
}

/** Ориентир/адрес со слов клиента. Длину режем: это строка карточки, а не рассказ.
 *  export — тот же разбор нужен ai/propertyDraft.ts (адрес продавца/объекта). */
export function asAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 200) : null;
}

/** export — тот же справочник PROPERTY_TYPES нужен ai/propertyDraft.ts. */
export function asPropertyType(value: unknown): PropertyType | null {
  return typeof value === "string" && (PROPERTY_TYPES as readonly string[]).includes(value)
    ? (value as PropertyType)
    : null;
}

/** Ответ модели — внешние данные: ни одно поле не берём на веру, всё через проверки выше. */
interface ChatExtract {
  clientName?: unknown;
  budgetMin?: unknown;
  budgetMax?: unknown;
  districtName?: unknown;
  address?: unknown;
  rooms?: unknown;
  propertyType?: unknown;
  urgency?: unknown;
  notes?: unknown;
  tags?: unknown;
  evidence?: unknown;
}

function extractSchema(districtNames: string[]) {
  return {
    type: "object",
    properties: {
      clientName: {
        type: "string",
        description:
          "Собственное имя клиента, если он назвал его САМ — в любом месте разговора, а не только в ответ " +
          "на вопрос «как вас зовут»: «номам Гулру», «Ном Фозилшо», «Наргиз 900001014», «меня зовут…», «я Умед». " +
          "Пиши ТОЛЬКО САМО ИМЯ, без приставок («Ном», «номам») и без номера телефона рядом с ним. " +
          "Никнейм из профиля, название компании или обращение к клиенту от бота/агента сюда не идут — " +
          "только то, что клиент сказал о СЕБЕ. Не назвал — оставь пустым: целая фраза клиента " +
          "(«Чихели кунум», «Бахшиш дер чавоб додестам»), слово «Тел», город или адрес именем не являются.",
      },
      // Про одну названную сумму сказано и здесь, и в системном промте: описание поля
      // модель читает в момент заполнения, а промт — в начале рассуждения, и на
      // коротких разборах (Haiku/Flash) срабатывает именно ближнее напоминание.
      budgetMin: {
        type: "number",
        description:
          "Нижняя граница бюджета в сомони. Заполняй ТОЛЬКО если клиент назвал вилку («от 300 до 500 тысяч») " +
          "или прямо сказал «не меньше». Одну названную сумму сюда не пиши. Цена ЗА КВАДРАТНЫЙ МЕТР — не бюджет, " +
          "см. описание budgetMax.",
      },
      budgetMax: {
        type: "number",
        description:
          "Потолок ОБЩЕГО бюджета в сомони. Одна названная клиентом сумма («за 700 000», «то 700 ҳазор», " +
          "«50 тысяч долларов») — это ВСЕГДА budgetMax. ИСКЛЮЧЕНИЕ: цена ЗА КВАДРАТНЫЙ МЕТР («650 доллар за метр», " +
          "«цена за квадрат», расчёт для котлована/стадии строительства) — это цена ЕДИНИЦЫ площади, а не общая " +
          "сумма покупки; сюда её не пиши вовсе, оставь поле пустым.",
      },
      ...(districtNames.length > 0
        ? { districtName: { type: "string", enum: districtNames, description: "Район из списка" } }
        : {}),
      address: {
        type: "string",
        description:
          "Адрес или ориентир со слов клиента: улица и дом, ЖК, рынок, кинотеатр, школа " +
          "(«напротив кинотеатра Зебунисо», «ДОК»). Район сюда не дублируй — он идёт в districtName.",
      },
      rooms: { type: "number", description: "Сколько комнат нужно клиенту" },
      propertyType: { type: "string", enum: [...PROPERTY_TYPES] },
      // Срочности здесь БОЛЬШЕ НЕТ (решение владельца 01.08.2026). Поле было в схеме,
      // модель его исправно заполняла, и в заметках карточки появлялось «Срочность:
      // Срочно, на этой неделе» — строка, которой владелец не просил и которая
      // занимала первое место в блоке требований.
      notes: { type: "string", description: "Суть запроса одной короткой фразой, до 200 знаков" },
      tags: {
        type: "array",
        items: { type: "string", enum: [...CARD_NOTE_TAGS] },
        description: "Готовые пожелания, которые клиент назвал прямо",
      },
      evidence: {
        type: "array",
        items: { type: "string" },
        maxItems: 3,
        description: "До 3 коротких цитат клиента, подтверждающих заполненные поля",
      },
    },
  };
}

/**
 * @param usdToTjs курс из Настроек (lib/money.ts). Раньше в промте стояло «11,3»
 * литералом — при живом курсе в Настройках, ночном обновлении с alif.tj и прямом
 * отказе siteSync публиковать объект без курса («не публикуем по случайному»).
 * Итог: бюджет, записанный ботом в карточку, расходился с бюджетом, по которому
 * потом ищутся объекты (priceRangeBranches считает по настоящему курсу). При 11,9
 * клиент с $50 000 получал 565 000 вместо 595 000 и не видел подходящие варианты.
 */
function buildSystemPrompt(districtNames: string[], usdToTjs: number): string {
  return (
    "Ты разбираешь общение клиента с агентством недвижимости Royal Home (Душанбе) и заполняешь карточку клиента. " +
    "Источники двух видов: переписка в мессенджере и расшифровки телефонных разговоров. " +
    "КРИТИЧЕСКИ ВАЖНО: бери ТОЛЬКО то, что клиент сказал сам. Ничего не додумывай и не выводи по косвенным " +
    "признакам: не сказал про срочность, район, бюджет или комнаты, значит поле не заполняется вовсе. " +
    "Слова бота (assistant) и агента источником не считаются, только слова самого клиента. " +
    "ИМЯ. Ищи его ПО ВСЕЙ переписке и по всем разговорам, а не только там, где клиента спросили, как его зовут: " +
    "люди называют себя мимоходом — «номам Гулру», «Ном Фозилшо», «Наргиз 900001014», «меня зовут Дилноза», «я Умед». " +
    "В clientName пиши только само имя, без приставок и без прилипшего телефона. " +
    "Ни в коем случае не путай с тем, как к нему обращался бот или агент, и не бери из подписи/никнейма профиля. " +
    "Не представлялся — оставь пустым, переспрашивать не нужно; целая фраза клиента, слово «Тел», " +
    "название города или адрес именем не являются. " +
    "Клиент может писать и говорить на таджикском (кириллицей или латиницей), русском или смеси — это нормально. " +
    // Поля карточки русские, а половина клиентов агентства говорит по-таджикски.
    // Без этой строки модель складывала в карточку таджикские слова, и один и тот же
    // район приезжал то как «Сино», то как «Сино ноҳия» — фильтры по нему не работали.
    "ЯЗЫК ОТВЕТА: всегда русский, независимо от языка клиента. Названия районов приводи " +
    "к тому виду, в котором они перечислены ниже, даже если клиент назвал район по-таджикски " +
    "или разговорным именем. " +
    // Расшифровка живой речи — не переписка: там оговорки, «эээ», перебивания и
    // неточные слова. Модель должна понимать суть, а не цепляться за форму.
    "В расшифровках телефонных разговоров встречаются оговорки, повторы, обрывки фраз и ошибки " +
    "распознавания — понимай смысл сказанного, а не буквальные слова. Если клиент назвал сумму или район " +
    "неуверенно («ну тысяч пятьдесят где-то»), поле всё равно заполняй, но в notes отметь приблизительность. " +
    `Суммы в долларах переводи в сомони по курсу ${usdToTjs} и упоминай исходную сумму в notes. ` +
    // Разбор, из-за которого правило появилось: в заметках карточки стояло «квартира
    // за 700 000 сомони», а поля бюджета и адреса остались пустыми — и клиент не
    // получил ни одного подходящего объекта, потому что подбор идёт по бюджету и
    // району. Модель всё расслышала, но «одна сумма» не подошла ни под «нижнюю
    // границу», ни под «верхнюю», а запрет додумывать довершил дело.
    "БЮДЖЕТ. Клиент почти всегда называет ОДНУ сумму, а не вилку: «за 700 000», «то 700 ҳазор», " +
    "«тысяч пятьдесят долларов». Такая сумма — это ПОТОЛОК: пиши её в budgetMax, а budgetMin оставляй пустым. " +
    "Обе границы заполняй, только если клиент прямо назвал вилку («от 300 до 500»). " +
    "Записать названную сумму потолком — не догадка, а прямая передача сказанного; пустое поле бюджета " +
    "означает, что клиент о деньгах не говорил вовсе. " +
    // Живой случай 15.09.2026 (карточка №298): клиент на звонке назвал «650 доллар»
    // для стадии котлована, имея в виду цену за квадратный метр, а не общий бюджет.
    // Модель применила общее правило «одна сумма — это budgetMax», перевела в сомони
    // и записала цену ЗА МЕТР как потолок ВСЕЙ покупки — карточка получила бюджет
    // «от 463 500 до 6 027», задом наперёд и из разных единиц измерения.
    "ЦЕНА ЗА КВАДРАТНЫЙ МЕТР — НЕ БЮДЖЕТ. «650 доллар за метр», «по 700 за квадрат», расчёт для котлована или " +
    "стадии строительства — это цена ЕДИНИЦЫ площади, а не сумма всей покупки. Такую цифру в budgetMin/budgetMax " +
    "не пиши вовсе, даже если она единственная названная сумма в разговоре — упомяни её в notes словами клиента. " +
    // Адрес в Душанбе — это почти всегда ориентир, а не улица с номером дома.
    // Раньше поля address в разборе не было вовсе, и «напротив кинотеатра Зебунисо»
    // доживало только до свободных заметок, откуда его не читает ни один фильтр.
    "АДРЕС И ОРИЕНТИР. В Душанбе место называют ориентиром: «ДОК», «напротив кинотеатра Зебунисо», " +
    "«за рынком Саховат», «ЖК Пойтахт». Это и есть address — записывай его отдельным полем словами клиента. " +
    "Район при этом всё равно указывай в districtName. " +
    (districtNames.length > 0 ? `Районы агентства: ${districtNames.join(", ")}. Другие названия в districtName не пиши. ` : "") +
    `Типы недвижимости: ${PROPERTY_TYPES.map((t) => `${t} = ${PROPERTY_TYPE_LABELS[t]}`).join("; ")}. ` +
    "notes пиши по-русски, коротко и по делу, без вводных слов и без тире. " +
    "Ответ передавай через инструмент submit_reply."
  );
}

/**
 * Предложение по карточке + адрес клиента.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ТИП, А НЕ ПОЛЕ В CardFillSuggestion: адрес разбирается на сервере
 * и пишется автозаполнением напрямую (lib/clientAutopilot.ts), а мастер на вебе его
 * пока не показывает и подтверждать не предлагает. Как только адрес появится в форме
 * мастера, поле переедет в общий тип @royal-home/shared вместе с ней. Добавление
 * ключа безопасно: все, кто читает предложение, берут поля поимённо.
 */
export type CardFillResult = CardFillSuggestion & {
  /** Ориентир или адрес со слов клиента («напротив кинотеатра Зебунисо»). */
  address: string | null;
  /** Имя клиента, если он сам представился в переписке/на звонке (19.08.2026).
   *  Тот же приём, что у address: разбирается на сервере и пишется автозаполнением
   *  напрямую (lib/clientAutopilot.ts) — только если карточка сейчас на запасном
   *  «Покупатель №…»/«Продавец №…», настоящее имя никогда не перезаписывается. */
  clientName: string | null;
};

/**
 * Собирает предложение по заполнению карточки. Клиент должен существовать —
 * проверка доступа и наличия остаётся на маршруте.
 */
export async function buildCardFillSuggestion(clientId: string): Promise<CardFillResult> {
  const [botConversation, telegramConversation, districts] = await Promise.all([
    // findFirst, не findUnique (19.08.2026) — у клиента теперь может быть несколько
    // диалогов бот-платформы (Instagram + WhatsApp и т.п.), берём самый свежий:
    // разбор карточки строится на последнем разговоре, а не на всей истории сразу.
    prisma.botConversation.findFirst({
      where: { clientId },
      orderBy: { lastMessageAt: "desc" },
      select: { leadDraft: true, messages: true },
    }),
    prisma.telegramConversation.findUnique({
      where: { clientId },
      select: { leadDraft: true, messages: true },
    }),
    prisma.district.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  // Клиент пишет в один канал, но карточку могли слить из дубликатов — берём тот
  // диалог, где вообще есть история.
  const conversation = botConversation ?? telegramConversation;
  const draft = readDraft(conversation?.leadDraft);
  const messages = readMessages(conversation?.messages);
  const clientLines = messages.filter((m) => m.role === "user");

  const districtByName = new Map(districts.map((d) => [d.name.trim().toLowerCase(), d]));
  const resolveDistrict = (name: unknown) =>
    typeof name === "string" ? districtByName.get(name.trim().toLowerCase()) ?? null : null;

  const suggestion: CardFillResult = {
    source: draft ? "draft" : "none",
    budgetMin: asPositiveNumber(draft?.budgetMin),
    budgetMax: asPositiveNumber(draft?.budgetMax),
    districtId: null,
    districtName: null,
    // Черновик квалификатора адрес не собирает вовсе — он всегда достаётся из разбора.
    address: null,
    /**
     * ИМЯ ИЩЕТ И КОД, И МОДЕЛЬ (30.08.2026, жалоба владельца «клиент назвал имя, а
     * ИИ его не вставил»). В 24 разобранных карточках имя прозвучало СВОБОДНО, а не в
     * ответ на прямой вопрос: «номам Гулру», «Ном Фозилшо» (сказано дважды), «Наргиз
     * 900001014». Промт просит модель это заметить, но промт — просьба, а не гарантия
     * (см. ai/replyGuards.ts), поэтому то же представление ищется по репликам клиента
     * шаблоном. Модель, если найдёт своё, перезапишет это ниже.
     *
     * Здесь же, а не после вызова модели: отказ ИИ (нет ключа, таймаут) не должен
     * стоить карточке имени, которое видно в переписке простым поиском.
     */
    clientName: clientSelfStatedName(messages),
    rooms: asPositiveNumber(draft?.rooms),
    type: asPropertyType(draft?.type),
    // Срочность квалификатор не собирает вовсе — она всегда достаётся из переписки.
    urgency: null,
    notes: typeof draft?.notes === "string" && draft.notes.trim() ? draft.notes.trim() : null,
    tags: [],
    evidence: [],
    aiUnavailable: false,
  };

  const draftDistrict = resolveDistrict(draft?.districtName);
  if (draftDistrict) {
    suggestion.districtId = draftDistrict.id;
    suggestion.districtName = draftDistrict.name;
  }

  // РАЗГОВОРЫ ПО ТЕЛЕФОНУ — третий источник (07.08.2026, после запуска телефонии).
  // Самый ценный из трёх: по телефону клиент рассказывает то, что в переписку никогда
  // не пишет, — и именно эти карточки раньше оставались пустыми, потому что «звонок
  // был, а записать некогда». Расшифровки берутся только у этого клиента и только
  // свежие: старый разговор описывает уже неактуальный запрос.
  const callTranscripts = await prisma.interaction.findMany({
    where: { clientId, type: "CALL", transcript: { not: null } },
    orderBy: { createdAt: "desc" },
    take: MAX_CALLS,
    select: { transcript: true, createdAt: true },
  });

  // Разбирать нечего: клиент не писал и не звонил (заявку завели руками) — платный
  // вызов пропускаем.
  if (clientLines.length === 0 && callTranscripts.length === 0) return suggestion;

  const districtNames = districts.map((d) => d.name);
  // Курс тот же, по которому потом считаются диапазоны подбора (lib/money.ts).
  const { usdToTjs } = await loadMoneyContext();
  const chatPart = messages.map((m) => `${m.role === "user" ? "КЛИЕНТ" : "Бот"}: ${m.content}`).join("\n");
  // Разговоры идут в хронологическом порядке и подписаны датой: модель должна понимать,
  // что «вчера просил двушку, сегодня трёшку» — это изменение запроса, а не противоречие.
  const callsPart = [...callTranscripts]
    .reverse()
    .map((c) => {
      // Дата — по Душанбе: ночной звонок (00:30 местного) в UTC-контейнере
      // подписывался вчерашним днём, и хронология запроса клиента строилась
      // задом наперёд — модель принимала старый запрос за актуальный (аудит №4).
      const day = c.createdAt.toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        timeZone: "Asia/Dushanbe",
      });
      return `[Телефонный разговор ${day}]\n${clipHeadTail(c.transcript ?? "", MAX_TRANSCRIPT_CHARS)}`;
    })
    .join("\n\n");
  const transcript = [chatPart, callsPart].filter(Boolean).join("\n\n");

  const extract = await callAiText<ChatExtract>({
    endpoint: "card-fill",
    // Только id — для журнала блокировки промта Google (аудит 10.10.2026, P1-8).
    clientId,
    // Разбор переписки в поля карточки — простая задача: у Claude это Haiku.
    simple: true,
    system: buildSystemPrompt(districtNames, usdToTjs),
    user:
      `Уже известно из карточки (не переспрашивай и не противоречь): ${JSON.stringify({
        budgetMin: suggestion.budgetMin,
        budgetMax: suggestion.budgetMax,
        districtName: suggestion.districtName,
        rooms: suggestion.rooms,
        type: suggestion.type,
      })}\n\nЧто клиент говорил и писал:\n${transcript}`,
    maxTokens: 600,
    schema: extractSchema(districtNames),
  });

  if (!extract) {
    // Модель молчит — мастер всё равно открывается, просто без подсказок по переписке.
    suggestion.aiUnavailable = true;
    return suggestion;
  }

  const fromCall = callTranscripts.length > 0;
  // Разговор надёжнее переписки как источник: по телефону клиент рассказывает
  // подробнее. Агенту показываем именно его, чтобы он понимал, что проверять.
  suggestion.source = fromCall ? "call" : "chat";

  /**
   * Кто побеждает при расхождении.
   *
   * Без звонка — черновик бота: он копился по всему диалогу и уже пережил уточнения
   * клиента, а разбор переписки это один взгляд со стороны. ИИ только закрывает дыры.
   *
   * Со звонком — наоборот, разбор. Типичный случай агентства: клиент написал в
   * Instagram «до 40 тысяч», агент перезвонил уточнить, и выяснилось, что бюджет
   * 60 и нужна не двушка, а трёшка. Черновик бота при этом остаётся прежним — он
   * собран из переписки и о разговоре не знает. Пока приоритет был у черновика,
   * свежие слова клиента проигрывали позавчерашней переписке, и предложение выглядело
   * так, будто ИИ вообще не слушал разговор.
   *
   * Модель при этом видит и переписку, и разговоры сразу (обе части идут в один
   * запрос), поэтому её ответ — не «мнение звонка против мнения чата», а итог по
   * всему общению с клиентом.
   */
  const prefer = <T>(fromAi: T | null, fromDraft: T | null): T | null =>
    fromCall ? (fromAi ?? fromDraft) : (fromDraft ?? fromAi);

  suggestion.budgetMin = prefer(asPositiveNumber(extract.budgetMin), suggestion.budgetMin);
  suggestion.budgetMax = prefer(asPositiveNumber(extract.budgetMax), suggestion.budgetMax);
  suggestion.rooms = prefer(asPositiveNumber(extract.rooms), suggestion.rooms);
  suggestion.type = prefer(asPropertyType(extract.propertyType), suggestion.type);
  // Срочность не собираем (решение владельца 01.08.2026) — поле остаётся в типе
  // предложения ради старых карточек, но всегда пустое.
  suggestion.urgency = null;

  const aiDistrict = resolveDistrict(extract.districtName);
  if (aiDistrict && (fromCall || !suggestion.districtId)) {
    suggestion.districtId = aiDistrict.id;
    suggestion.districtName = aiDistrict.name;
  }

  // Адрес приходит только из разбора (в черновике его нет), поэтому и спорить не с чем.
  suggestion.address = asAddress(extract.address);
  // Тот же фильтр, которым бот отсекает никнеймы/мусор при обращении к клиенту
  // (ai/replyGuards.ts) — одно правило «похоже на настоящее имя» на оба случая.
  /**
   * ИМЯ — ЧЕРЕЗ ФИЛЬТР НА ЗАПИСЬ (30.08.2026). Раньше здесь стоял `looksLikeRealName`
   * — проверка «можно ли этим словом обратиться вслух», и она пропускала целые фразы:
   * в поле «Имя» на проде лежат «Чихели кунум» («а как мне это сделать?») и «Бахшиш
   * дер чавоб додестам ман кордаям». `normalizeClientName` заодно чистит имя от того,
   * что к нему прилипло («Наргиз 900001014» → «Наргиз», «Ном Фозилшо» → «Фозилшо»).
   */
  // Имя от модели побеждает найденное шаблоном: её ответ учитывает контекст разговора,
  // шаблон — нет. Промолчала — остаётся то, что нашёл код перед вызовом.
  const aiName = typeof extract.clientName === "string" ? normalizeClientName(extract.clientName) : null;
  if (aiName) suggestion.clientName = aiName;

  const aiNotes = typeof extract.notes === "string" && extract.notes.trim() ? extract.notes.trim().slice(0, 500) : null;
  if (aiNotes && (fromCall || !suggestion.notes)) {
    suggestion.notes = aiNotes;
  }
  if (Array.isArray(extract.tags)) {
    suggestion.tags = extract.tags.filter(
      (t): t is string => typeof t === "string" && (CARD_NOTE_TAGS as readonly string[]).includes(t)
    );
  }
  if (Array.isArray(extract.evidence)) {
    suggestion.evidence = extract.evidence
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .map((q) => q.trim().slice(0, 200))
      .slice(0, 3);
  }

  // Бюджет задом наперёд ломает и подбор, и Zod-проверку при сохранении.
  if (suggestion.budgetMin !== null && suggestion.budgetMax !== null && suggestion.budgetMin > suggestion.budgetMax) {
    [suggestion.budgetMin, suggestion.budgetMax] = [suggestion.budgetMax, suggestion.budgetMin];
  }

  /**
   * ОДНА СУММА — ЭТО ПОТОЛОК, А НЕ ТОЧНАЯ ЦЕНА.
   *
   * Модель, услышав «за 700 000 сомони», нередко кладёт эту сумму в обе границы —
   * формально верно, а на деле это фильтр «ровно 700 000». Подбор берёт вилку ±10%
   * (routes/clients.ts, GET /:id/match), то есть клиенту с потолком 700 000 перестали
   * бы показывать квартиры за 500 000, которым он был бы только рад. Нижнюю границу
   * оставляем только тогда, когда она РАЗНАЯ, то есть клиент действительно назвал вилку.
   */
  if (suggestion.budgetMin !== null && suggestion.budgetMin === suggestion.budgetMax) {
    suggestion.budgetMin = null;
  }

  return suggestion;
}
