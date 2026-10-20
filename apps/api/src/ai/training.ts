import type { ConversationMessage } from "@royal-home/shared";
import { prisma } from "../db.js";
import { callAiText } from "./client.js";
import { groundedSearchIsEnabled } from "./assistant.js";
import { callGeminiGrounded, resolveGeminiKey } from "./geminiClient.js";
import { isUselessExample, isUsableClientQuestion, rememberAgentReply, sanitizeStyleText } from "./styleLearning.js";

/**
 * ЭКРАН «ТРЕНИРОВКА» (23.08.2026, пункт 6 очереди ИИ, согласовано с владельцем).
 *
 * Идея владельца дословно: «ты задашь 20-30 вопросов, я выберу да/нет или впишу
 * свой вариант, и бот будет отвечать как я». Это НЕ жёсткий скрипт «на X отвечай
 * Y» — это few-shot обучение на предпочтениях, тот же принцип, что уже работает
 * у styleLearning.ts (образцы манеры в промте, а не переписывание промта).
 *
 * ДВЕ ПОЛОВИНЫ МОДУЛЯ:
 *  1) подбор вопроса — берём РЕАЛЬНУЮ реплику клиента из уже случившейся
 *     переписки (BotConversation/TelegramConversation), ещё не превращённую в
 *     StyleExample;
 *  2) генерация 2-3 вариантов ответа под неё — обычный callAiText с JSON-схемой.
 *
 * Само сохранение выбора владельца делает не этот модуль, а `rememberAgentReply`
 * из styleLearning.ts — он уже умеет чистить текст (sanitizeStyleText) и молча
 * проглатывать дубль (уникальность [clientText, agentText] в базе). Второй раз
 * эту логику здесь не пишем.
 */

/** Сколько последних диалогов каждого канала сканируем на кандидатов за один
 *  подбор. Не 500, как при разовом импорте истории (importStyleFromHistory) —
 *  это живой запрос с экрана, которого ждёт человек, а не фоновая задача. */
const SCAN_CONVERSATIONS = 80;

/** Потолок кандидатов, которые вообще держим в памяти за один подбор. */
const MAX_CANDIDATES = 300;

/** Вопрос клиента режем так же, как в styleLearning.ts (MAX_CLIENT_LEN) — это
 *  копия того же предела, а не общий импорт: значение стабильно с 23.08.2026,
 *  раздельные константы тут не риск разъехаться, риск был бы у логики фильтрации
 *  (isUsableClientQuestion), а она как раз общая. */
const MAX_CLIENT_LEN = 300;

export interface TrainingCandidate {
  clientText: string;
  channel: string | null;
  conversationId: string;
  /** {stage, budgetMin?, budgetMax?, districtName?, type?, rooms?, notes?} — то,
   *  что уже известно из разговора. Может быть пустым — не у каждого диалога
   *  есть черновик лида на момент этой реплики. */
  leadDraft: Record<string, unknown> | null;
}

/**
 * Сканирует последние диалоги и собирает реплики клиента, за которыми в той же
 * переписке следует ЛЮБОЙ ответ (бота или человека — неважно чей: мы всё равно
 * генерируем СВОИ варианты, а не переиспользуем прошлый ответ). Наличие ответа
 * рядом — единственный признак того, что это законченный вопрос, а не последняя
 * реплика без реакции.
 *
 * Кандидат без вопроса (одно имя, вежливость) отсекает isUsableClientQuestion —
 * та же функция, что фильтрует образцы при импорте истории, специально
 * экспортирована из styleLearning.ts, чтобы не заводить второе определение
 * «что считается вопросом».
 */
async function scanCandidates(): Promise<TrainingCandidate[]> {
  const candidates: TrainingCandidate[] = [];

  const fromMessages = (
    conversationId: string,
    rawMessages: unknown,
    channel: string | null,
    rawLeadDraft: unknown
  ): void => {
    const list = (Array.isArray(rawMessages) ? rawMessages : []) as ConversationMessage[];
    const leadDraft =
      rawLeadDraft && typeof rawLeadDraft === "object" && !Array.isArray(rawLeadDraft)
        ? (rawLeadDraft as Record<string, unknown>)
        : null;
    let lastClientText = "";
    for (const m of list) {
      const text = (m?.content ?? "").trim();
      if (!text) continue;
      if (m.role === "user") {
        lastClientText = text;
        continue;
      }
      // Ответная реплика (role="assistant") — бот или человек, не проверяем: она
      // лишь доказывает, что вопрос был отработан и годится как законченный случай.
      if (lastClientText) {
        const clientText = sanitizeStyleText(lastClientText).slice(0, MAX_CLIENT_LEN);
        if (isUsableClientQuestion(clientText)) {
          candidates.push({ clientText, channel, conversationId, leadDraft });
        }
      }
      lastClientText = "";
    }
  };

  const [botConvos, tgConvos] = await Promise.all([
    prisma.botConversation.findMany({
      orderBy: { lastMessageAt: "desc" },
      take: SCAN_CONVERSATIONS,
      select: { id: true, messages: true, channel: true, leadDraft: true },
    }),
    prisma.telegramConversation.findMany({
      orderBy: { lastMessageAt: "desc" },
      take: SCAN_CONVERSATIONS,
      select: { id: true, messages: true, leadDraft: true },
    }),
  ]);
  for (const c of botConvos) fromMessages(c.id, c.messages, c.channel, c.leadDraft);
  for (const c of tgConvos) fromMessages(c.id, c.messages, "TELEGRAM", c.leadDraft);

  return candidates.slice(0, MAX_CANDIDATES);
}

/**
 * Один случайный кандидат, которого ЕЩЁ НЕТ в StyleExample (по clientText —
 * ровно так, как просил владелец: не проектировать сложный отбор, годится
 * случайная/недавняя выборка среди ещё не тренированных).
 *
 * null — очередь пуста: либо переписок ещё нет, либо все годные вопросы уже
 * стали образцами.
 */
export async function getTrainingCandidate(): Promise<TrainingCandidate | null> {
  const scanned = await scanCandidates();
  if (scanned.length === 0) return null;

  const texts = [...new Set(scanned.map((c) => c.clientText))];
  const already = await prisma.styleExample.findMany({
    where: { clientText: { in: texts } },
    select: { clientText: true },
  });
  const trained = new Set(already.map((e) => e.clientText));
  const fresh = scanned.filter((c) => !trained.has(c.clientText));
  if (fresh.length === 0) return null;

  return fresh[Math.floor(Math.random() * fresh.length)];
}

/**
 * ФОРМА ОТВЕТА МОДЕЛИ — через function-call (submit_reply), как и в остальном
 * ai/*: свободный текст не проверить, а `variants` обязаны быть массивом строк,
 * не строкой и не объектом. Тот же довод, что у SCORE_SCHEMA в ai/scoring.ts:
 * Gemini принимает OpenAPI-подмножество JSON Schema.
 */
const TRAINING_VARIANTS_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["variants", "needsGroundedFact"],
  properties: {
    variants: {
      type: "array",
      items: { type: "string" },
      description:
        "2 или 3 РАЗНЫХ по формулировке варианта ответа сотрудника клиенту на русском (или языке клиента, " +
        "если он писал не по-русски) — коротко и по делу, как в живой переписке, а не официальным письмом. " +
        "Варианты должны различаться подходом (например: сухо по делу / с вопросом в ответ / с предложением " +
        "следующего шага), а не быть одним и тем же текстом другими словами.",
    },
    needsGroundedFact: {
      type: "boolean",
      description:
        "true, ТОЛЬКО если честный ответ по существу требует внешнего факта, которого нет в вопросе и контексте " +
        "разговора — налоги, законы, процедуры сделок, ипотека, актуальные рыночные цены и подобное. false для " +
        "обычных вопросов про конкретный объект/цену/показ/контакты — там факта из веба не требуется, там " +
        "нужен просто хороший ответ сотрудника.",
    },
  },
};

/** Отдельная модель для grounded-варианта — та же, что и во внутреннем ассистенте
 *  (ai/assistant.ts): справочный ответ с источниками не то место, где экономия на
 *  качестве уместна. */
const GROUNDED_VARIANT_SYSTEM =
  "Ты предлагаешь сотруднику риелторского агентства Royal Home (Душанбе, Таджикистан) короткий фактический " +
  "ответ клиенту на справочный вопрос — налоги, законы, ипотека, процедуры сделок, рыночный контекст. " +
  "Отвечай кратко и по-русски, строго по актуальным данным из поиска — не выдумывай цифры, ставки и факты. " +
  "Обычный текст, без markdown-разметки, как реплика в переписке, а не официальное письмо.";

const VARIANTS_MIN = 2;
const VARIANTS_MAX = 3;
/** Один вариант — это реплика в переписке, а не письмо; тот же потолок, что у
 *  сохранённого образца (MAX_EXAMPLE_LEN в styleLearning.ts). */
const MAX_VARIANT_LEN = 300;

/** Сколько существующих образцов берём затравкой манеры — вдвое меньше, чем в
 *  промте бота (EXAMPLES_IN_PROMPT=6 в styleLearning.ts): это подсказка модели,
 *  какой тон уже прижился, а не полноценный блок для боевого разговора. */
const STYLE_SEED_COUNT = 4;

async function loadStyleSeed(): Promise<string> {
  const seed = await prisma.styleExample.findMany({
    where: { enabled: true },
    orderBy: { createdAt: "desc" },
    take: STYLE_SEED_COUNT,
    select: { clientText: true, agentText: true },
  });
  if (seed.length === 0) return "";
  const lines = seed.map((e) =>
    e.clientText.trim() ? `Клиент: ${e.clientText.trim()}\nСотрудник: ${e.agentText}` : `Сотрудник: ${e.agentText}`
  );
  return (
    "\n\nТак уже отвечают наши сотрудники (перенимай манеру — длину фразы, тон, — " +
    "а не факты из примеров, они устарели):\n" +
    lines.join("\n\n")
  );
}

export interface GroundedSource {
  url: string;
  title?: string;
}

export interface TrainingVariantsResult {
  variants: string[];
  /** Индекс в variants, у которого есть grounded-источники (для показа владельцу
   *  ПЕРЕД выбором) — не более одного за подбор. */
  groundedIndex?: number;
  groundedSources?: GroundedSource[];
}

/**
 * Генерирует варианты ответа под вопрос клиента. null — модель не ответила или
 * ответила меньше двух вариантов (звать это успехом нечестно: владельцу не из
 * чего выбирать).
 */
export async function generateTrainingVariants(
  clientText: string,
  context: { leadDraft?: Record<string, unknown> | null } = {}
): Promise<TrainingVariantsResult | null> {
  const styleSeed = await loadStyleSeed();
  const draftText =
    context.leadDraft && Object.keys(context.leadDraft).length > 0
      ? `\n\nЧто уже известно из этого разговора: ${JSON.stringify(context.leadDraft)}`
      : "";

  /**
   * ГРАЦИОЗНАЯ ДЕГРАДАЦИЯ ПРИ БЛОКИРОВКЕ ПРОМТА (16.09.2026, тот же довод, что у
   * scoreClient в scoring.ts). Раньше `onBlocked` здесь не передавался вовсе —
   * блокировка Google тонула в общей ветке "модель не ответила" наравне с пустым
   * ответом или битым JSON, и разобрать причину задним числом было нельзя.
   * promptBlocked сам по себе ничего не меняет в исходе (variants нет — экран
   * тренировки в любом случае просит попробовать другой вопрос), но фиксирует в
   * коде, что это ОЖИДАЕМАЯ деградация конкретно из-за blockReason, а не забытая
   * ветка — тот же смысл, что у `void promptBlocked` в scoring.ts.
   */
  let promptBlocked = false;
  const result = await callAiText<Record<string, unknown>>({
    endpoint: "bot-training-variants",
    onBlocked: () => {
      promptBlocked = true;
    },
    // Классификация/черновик ответа по готовому вопросу — та же простая задача,
    // что card-fill и scoring (пункт 2 очереди ИИ 23.08): дешёвая ступень.
    simple: true,
    system:
      "Ты помогаешь владельцу риелторского агентства Royal Home натренировать бота на реальном вопросе клиента " +
      "из настоящей переписки. Предложи несколько РАЗНЫХ по формулировке вариантов ответа сотрудника — владелец " +
      "выберет лучший или впишет свой. Не выдумывай цены, объекты, сроки или факты, которых нет в вопросе и в " +
      "контексте разговора — если для ответа по существу не хватает данных, вариант вправе просто уточнить или " +
      "предложить созвониться. Ответ передавай через инструмент submit_reply." +
      styleSeed,
    user: `Клиент спросил: ${clientText}${draftText}`,
    maxTokens: 700,
    schema: TRAINING_VARIANTS_SCHEMA,
  });
  if (!result || typeof result !== "object") {
    void promptBlocked;
    return null;
  }

  const raw = (result as { variants?: unknown }).variants;
  if (!Array.isArray(raw)) return null;

  const variants = raw
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim().slice(0, MAX_VARIANT_LEN))
    .slice(0, VARIANTS_MAX);

  if (variants.length < VARIANTS_MIN) return null;

  /**
   * ЧЕТВЁРТЫЙ, GROUNDED-ВАРИАНТ — ДОПОЛНИТЕЛЬНЫЙ, НЕ ЗАМЕНА (23.08.2026, пункт 4
   * очереди ИИ, второй заход). Модель сама пометила needsGroundedFact — вопрос
   * справочный (налоги/законы/ипотека/рынок), а не про конкретный объект. Тумблер
   * Settings.groundedSearchEnabled — тот же, что у REFERENCE_REAL_ESTATE во
   * внутреннем ассистенте (ai/assistant.ts): выключен по умолчанию, отказ базы
   * читаем как «выключено», а не падение. Отказ grounded-вызова НЕ роняет весь
   * подбор — владелец всё равно получит обычные variants и сможет выбрать один
   * из них или вписать свой текст, как раньше.
   *
   * ИСТОЧНИКИ НЕ ЛЕЗУТ В САМ ТЕКСТ ВАРИАНТА. Если приписать их к строке, ДВЕ вещи
   * ломаются: (1) `isUselessExample` (styleLearning.ts) отбраковывает text длиннее
   * 300 символов как мусор — список ссылок почти всегда выйдет за предел, и выбор
   * владельца молча провалится «неудачным ответом»; (2) даже уложись он в лимит —
   * `StyleExample` подмешивается few-shot ОБРАЗЦОМ МАНЕРЫ во ВСЕ будущие несвязанные
   * разговоры (см. loadStyleSeed выше: «перенимай манеру... а не факты из примеров»),
   * а не хранилищем фактов с датой протухания — ссылка на закон 2026 года не должна
   * всплывать в разговоре про совсем другую квартиру через полгода. Поэтому сам
   * grounded-текст идёт в variants КОРОТКИМ (та же длина, что у остальных), а
   * источники — отдельным полем только для экрана: помогают владельцу проверить
   * факт ПЕРЕД выбором, но в StyleExample.agentText не попадают.
   */
  const needsGroundedFact = (result as { needsGroundedFact?: unknown }).needsGroundedFact === true;
  let groundedIndex: number | undefined;
  let groundedSources: GroundedSource[] | undefined;
  if (needsGroundedFact && (await groundedSearchIsEnabled())) {
    const apiKey = await resolveGeminiKey();
    if (apiKey) {
      const grounded = await callGeminiGrounded({
        apiKey,
        system: GROUNDED_VARIANT_SYSTEM,
        query: `Клиент спросил: ${clientText}`,
        maxTokens: 300,
      });
      if (grounded && grounded.text.trim()) {
        groundedIndex = variants.push(grounded.text.trim().slice(0, MAX_VARIANT_LEN)) - 1;
        groundedSources = grounded.sources;
      }
    }
  }

  return { variants, groundedIndex, groundedSources };
}

export type NextTrainingResult =
  | { status: "empty" }
  | { status: "generation_failed"; clientText: string }
  | {
      status: "ok";
      clientText: string;
      channel: string | null;
      conversationId: string;
      variants: string[];
      /** Индекс варианта с проверяемыми источниками (поиск в вебе) — для пометки в
       *  интерфейсе. Источники — справочные, в сохранённый образец не идут (см.
       *  комментарий в generateTrainingVariants). */
      groundedIndex?: number;
      groundedSources?: GroundedSource[];
    };

/** Один вопрос + сгенерированные варианты — то, что отдаёт GET /bot-training/next. */
export async function nextTrainingQuestion(): Promise<NextTrainingResult> {
  const candidate = await getTrainingCandidate();
  if (!candidate) return { status: "empty" };

  const generated = await generateTrainingVariants(candidate.clientText, { leadDraft: candidate.leadDraft });
  if (!generated) return { status: "generation_failed", clientText: candidate.clientText };

  return {
    status: "ok",
    clientText: candidate.clientText,
    channel: candidate.channel,
    conversationId: candidate.conversationId,
    variants: generated.variants,
    groundedIndex: generated.groundedIndex,
    groundedSources: generated.groundedSources,
  };
}

export type TrainingDecisionResult =
  | { ok: true }
  | { ok: false; reason: "invalid_question" | "invalid_answer" | "duplicate" };

/**
 * Сохраняет решение владельца: выбранный вариант или свой текст.
 *
 * Валидирует ДО вызова rememberAgentReply теми же функциями, которыми пользуется
 * она сама (isUsableClientQuestion, isUselessExample через саму rememberAgentReply) —
 * это позволяет отличить «неудачный текст» от «пара уже существует», хотя
 * rememberAgentReply возвращает наружу только boolean: если наши собственные
 * проверки прошли, а сохранение всё равно не удалось, единственная ожидаемая
 * причина — уникальность [clientText, agentText] в базе (см. её же комментарий).
 */
export async function decideTraining(input: {
  clientText: string;
  agentText: string;
  channel?: string | null;
}): Promise<TrainingDecisionResult> {
  const clientText = sanitizeStyleText(input.clientText).slice(0, MAX_CLIENT_LEN);
  if (!isUsableClientQuestion(clientText)) return { ok: false, reason: "invalid_question" };

  const created = await rememberAgentReply({
    clientText: input.clientText,
    agentText: input.agentText,
    agentId: null,
    source: "TRAINING",
    channel: input.channel ?? null,
  });
  if (created) return { ok: true };

  // rememberAgentReply сама отбраковывает короткий/бессмысленный ответ и сама же
  // проглатывает дубль базы — снаружи оба случая выглядят одинаково (false),
  // поэтому доопределяем причину той же проверкой, которой пользуется она сама.
  if (isUselessExample(sanitizeStyleText(input.agentText))) return { ok: false, reason: "invalid_answer" };
  return { ok: false, reason: "duplicate" };
}
