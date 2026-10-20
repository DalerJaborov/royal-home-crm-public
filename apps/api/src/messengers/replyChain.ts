import type { ChatMessage } from "../ai/client.js";
import { traceFilterDelta, traceReplyOrigin } from "../lib/botTurnTrace.js";
import { detectClientLanguage, type ClientLanguage } from "../ai/clientLanguage.js";
import { ensurePhoneAskKept, extractVolunteeredPhone, normalizeReplyBubbles, type LeadDraft } from "../ai/leadQualifier.js";
import { stripUntrusted } from "../ai/untrustedContent.js";
import { stripRecruiting } from "../ai/recruitingGuard.js";
import { guardDirectionQuestion, guardOwnerAsThirdParty } from "../ai/intentDirectionGuard.js";
import { enforceOneQuestionPerBubble } from "../ai/oneQuestionGuard.js";
import { dropRepeatedQuestions, ensureOpenQuestionKept } from "../ai/replyGuards.js";
import {
  MAX_PHONE_ASKS,
  dropKnownPhoneAsks,
  dropPhoneAsks,
  dropNearRepeats,
  dropRepeatedBubbles,
  effectivePhoneAsks,
  keepOnePhoneAsk,
} from "../ai/replyRepeatGuard.js";
import { EMPTY_TOPIC_STATE, type TopicState } from "../ai/topicLock.js";
import { guardFired } from "../ai/guardMetrics.js";
import { botAskedQuestion, isAckOnlyMessage } from "../ai/ackOnly.js";
import { shouldStaySilentOnBareShare } from "../ai/bareShareRepeat.js";
import { photoAlreadyAcknowledged } from "../ai/photoAckGuard.js";
import { ensureRequestedAgentNoticeKept, type RequestedAgentMatch } from "../lib/requestedAgent.js";
import { logSystemError } from "../lib/systemError.js";

/**
 * ОДИН МОЗГ НА ВСЕ КАНАЛЫ: ЦЕПОЧКА ФИЛЬТРОВ ОТВЕТА БОТА (Dan, тред «Ревизия бота»,
 * 03.10.2026; аудит audit-1-one-brain, находки 7 и 9).
 *
 * До этой правки цепочка жила только в messengers/conversation.ts (каналы Meta и
 * сайт), а Telegram (telegram/bot.ts) и Direct Messages канала
 * (messengers/telegramDirectMessages.ts) собирали ответ своими копиями — и копии
 * отстали: продавец в Telegram получал «мо агентони фурӯшро ба кор қабул мекунем»
 * (stripRecruiting), бот сам угадывал «Шумо ин хонаро мефурӯшед?»
 * (guardDirectionQuestion), принятого клиента снова просил номер
 * (dropKnownPhoneAsks), а русская заглушка «не расслышал» уходила и тогда, когда
 * ответ вычистили наши же проверки. Теперь порядок и правила — здесь, один раз;
 * три окончания хода зовут эту функцию и не могут разойтись.
 *
 * Здесь только чистая обработка текста и журнал о молчании. Запись в переписку,
 * счётчики в базе и отправка остаются у канала: у каждого своя таблица и транспорт.
 */

/** Заготовленная фраза на двух языках — см. inClientLanguage. */
export type FallbackText = { tg: string; ru: string };

/**
 * ЗАГОТОВЛЕННАЯ ФРАЗА — НА ЯЗЫКЕ КЛИЕНТА (20.09.2026, разбор 775 переписок,
 * docs/bot-razbor-20-09.md; перенесено сюда из messengers/conversation.ts).
 *
 * Слова клиента — от самых свежих к старым; первый узнанный язык побеждает.
 * Не распознан ни в одном — таджикский: в Душанбе он чаще, а выдуманное
 * указание хуже отсутствующего (та же логика, что в languageInstruction).
 */
export function inClientLanguage(text: FallbackText, ...clientWords: (string | null | undefined)[]): string {
  for (const words of clientWords) {
    const lang = detectClientLanguage(words ?? "");
    if (lang === "ru") return text.ru;
    if (lang === "tg") return text.tg;
  }
  return text.tg;
}

/** Последние слова клиента из истории — для случаев, где в самом ходе текста нет. */
export function lastClientWords(history: ChatMessage[], take = 3): string {
  return history
    .filter((m) => m.role === "user")
    .slice(-take)
    .map((m) => m.content)
    .reverse()
    .join(" ");
}

/**
 * Что бот писал этому человеку в последних сообщениях — одной строкой (перенесено
 * из messengers/conversation.ts). По ней показ объекта видит, отправлял ли уже
 * ссылку, а ensurePhoneAskKept — просил ли номер только что. Берём немного:
 * сказанное неделю назад повтором уже не считается.
 */
const RECENT_BOT_MESSAGES = 6;
export const recentBotText = (history: ChatMessage[]): string =>
  history
    .slice(-RECENT_BOT_MESSAGES)
    .filter((m) => m.role === "assistant")
    .map((m) => m.content)
    .join("\n");

// Владелец решил 03.08.2026: при сбое ИИ клиент не получает вообще никакого
// сообщения (повтор идёт в фоне). Эта фраза — единственный оставшийся случай её
// показа: модель ОТВЕТИЛА, но текст реплики оказался пустым. Вычистили ответ наши
// же проверки — этой заглушки нет: второй ход модели или нейтральная реплика
// (finalizeBotReply, аудит 10.10.2026), но не «нужно больше времени».
export const FALLBACK_AI_DOWN: FallbackText = {
  tg:
    "Бубахшед барои таъхир, ба ҷавоб додан ҳозир бештар вақт лозим аст. Мо ҳатман ҷавоб медиҳем; " +
    "агар хоҳед, рақами телефонатонро гузоред, то агенти мо зудтар тамос гирад.",
  ru:
    "Извините за задержку, на ответ нужно немного больше времени. Мы обязательно ответим; " +
    "если хотите, оставьте номер телефона, и наш агент свяжется быстрее.",
};
// Номер уже в карточке — та же фраза без просьбы оставить его (ревизия 02.10.2026:
// клиент, давший номер час назад, читал «оставьте номер» как «вас не слушали»).
export const FALLBACK_AI_DOWN_PHONE_KNOWN: FallbackText = {
  tg: "Бубахшед барои таъхир, ба ҷавоб додан ҳозир бештар вақт лозим аст. Мо ҳатман ҷавоб медиҳем.",
  ru: "Извините за задержку, на ответ нужно немного больше времени. Мы обязательно ответим.",
};

/** Голосовое не расшифровалось — на языке клиента (то же в каналах Meta). */
export const FALLBACK_VOICE: FallbackText = {
  tg: "Бубахшед, паёми овозиро шунида наметавонам. Хоҳиш мекунем, бо матн нависед.",
  ru: "Извините, не получается расслышать голосовое сообщение. Напишите, пожалуйста, текстом.",
};

/**
 * ХОД, НА КОТОРЫЙ БОТ НЕ ОТВЕЧАЕТ ТЕКСТОМ (владелец 25.09.2026; аудит audit-1,
 * находка 8). Те же три отсечки, что в messengers/conversation.ts, — общими
 * функциями стражей, а не копией:
 *  - «Ок» / «Рахмат» после нашей реплики БЕЗ вопроса — только реакция
 *    (ai/ackOnly.ts): на «Ок» бот писал «Саломат бошед! Агар савол бошад, нависед»;
 *  - третья голая пересылка подряд — молчим (ai/bareShareRepeat.ts);
 *  - ещё фото без слов, а «фото получили» уже сказано — молчим (ai/photoAckGuard.ts).
 * Каналы без своей ветки на эти случаи (Telegram, Direct Messages) зовут это ДО
 * хода модели. Реплика клиента к этому моменту уже в переписке, агент её видит.
 */
export function silentTurnReason(input: {
  /** Слова клиента этого хода (склеенная пачка). */
  text: string;
  /** В ходе было вложение (фото, файл, голос) — тогда это не «ок». */
  hasMedia: boolean;
  /** Переписка ДО этого хода. */
  history: ChatMessage[];
}): "ack_only" | "bare_share_repeat" | "photo_ack_repeat" | null {
  const lastBot = [...input.history].reverse().find((m) => m.role === "assistant");
  if (!input.hasMedia && lastBot && isAckOnlyMessage(input.text) && !botAskedQuestion(lastBot.content)) {
    guardFired("ack_only");
    return "ack_only";
  }
  if (!input.hasMedia && shouldStaySilentOnBareShare(input.text, input.history)) {
    guardFired("bare_share_repeat");
    return "bare_share_repeat";
  }
  if (photoAlreadyAcknowledged(input.text, lastBot)) {
    guardFired("photo_ack_repeat");
    return "photo_ack_repeat";
  }
  return null;
}

/**
 * КЛИЕНТ УЖЕ НАПИСАЛ СВОЙ НОМЕР В ЭТОМ РАЗГОВОРЕ (03.10.2026, живые сбои в
 * WhatsApp и Instagram). Карточка клиента — не единственный признак «номер у
 * нас»: номер, пришедший в этом же ходе или чуть раньше, в карточку мог ещё не
 * попасть, и бот дописывал «Рақами телефонатон ва номатонро нависед» человеку,
 * который его только что дал. Правило строгое (extractVolunteeredPhone), а номера
 * из присланных документов и видео не считаются — это не слова клиента.
 */
export function phoneSaidInDialog(clientTexts: (string | null | undefined)[]): boolean {
  return clientTexts.some((t) => !!t && !!extractVolunteeredPhone(stripUntrusted(t, ["document", "video"])));
}

export interface BotReplyFilterInput {
  /** Сырой `reply` хода модели (массив пузырей или строка). */
  reply: unknown;
  /** Диалог и канал — только для журнала о молчании. */
  conversationId: string;
  channelLabel: string;
  /** Куда вести из журнала «бот исчерпал просьбы номера». */
  openUrl: string;
  /** Бот уже отвечал в этом разговоре. */
  botSpokeBefore: boolean;
  /** Все прошлые реплики бота, по порядку. */
  botSaidBefore: string[];
  /** Слова клиента за разговор БЕЗ недоверенных вложений (документ, видео). */
  clientSaidTrusted: string;
  /** Слова клиента в этом ходе — по ним видно, что он только что прислал номер. */
  clientTurnText: string;
  /** Недавние реплики бота — ensurePhoneAskKept не повторяет просьбу подряд. */
  previousBotText: string;
  /** Язык хода; «unknown» вызывающий уже заменил языком разговора. */
  language: ClientLanguage;
  /** Слитый черновик этого хода. */
  draft: Pick<LeadDraft, "intent" | "stage">;
  /** Разговор о работе (кандидат, реклама вакансии) — про найм говорить можно. */
  jobConversation: boolean;
  /** Хранимый счётчик просьб номера (phoneAsksSent у диалога). */
  phoneAsksSent: number;
  /** Номер уже в карточке — «тот же номер» не просим, второй можно. */
  phoneKnown: boolean;
  /**
   * Удержание темы (ai/topicLock.ts). Состояние темы хранят только колонки
   * BotConversation; канал без них передаёт EMPTY_TOPIC_STATE, и фильтр темы
   * там ничего не дописывает.
   */
  topicState?: TopicState;
  mustRepeatOpenQuestion?: boolean;
  /** «Мне нужен Умед» — уточнение, которое код обязан донести (lib/requestedAgent.ts). */
  requestedAgent?: RequestedAgentMatch;
  requestedNotice?: string | null;
  /** Слова клиента для языка заглушки — от свежих к старым. */
  fallbackLanguageWords: (string | null | undefined)[];
}

export interface BotReplyFilterResult {
  /** Что уходит клиенту. Пусто — см. silencedBy (finalizeBotReply молчать не даёт). */
  bubbles: string[];
  /** Пузыри ДО фильтра дословного повтора — для учёта сработок. */
  finalBubbles: string[];
  modelSaidNothing: boolean;
  guardsAteReply: boolean;
  /**
   * Почему пусто, хотя модель ответила: «guards» — вырезали стражи, «repeat» —
   * остался только повтор уже сказанного. null — ответ есть (или модель сама
   * промолчала, тогда уходит заглушка про задержку).
   */
  silencedBy: EmptyReplyCause | null;
  phoneAsksSoFar: number;
  stopAskingPhone: boolean;
}

export type EmptyReplyCause = "guards" | "repeat";

/**
 * Порядок — ровно тот, что был в messengers/conversation.ts::finishQualifyTurn
 * (обоснование каждого шага — в комментариях там и в модулях стражей):
 *  1. нормализация (повторное приветствие, чужие телефоны, дословный повтор);
 *  2. про найм — только кандидату (ai/recruitingGuard.ts);
 *  3. не угадывать «покупаете или продаёте» (ai/intentDirectionGuard.ts);
 *  4. один вопрос в сообщении (ai/oneQuestionGuard.ts);
 *  5. номер: предел просьб / номер уже известен / не бросать просьбу на полпути;
 *  6. незакрытый вопрос темы (ai/topicLock.ts);
 *  7. уже заданный вопрос второй раз не задаём; две просьбы номера в одном ответе — одна;
 *  8. уточнение про названного сотрудника;
 *  9. пусто: заглушка — только если модель сама ничего не сказала; если ответ
 *     съели фильтры — не молчим, этим занимается finalizeBotReply (10.10.2026);
 * 10. дословный повтор недавней реплики не уходит;
 * 11. повтор смыслом: второе обещание звонка, та же фраза с другим приветствием,
 *     два одинаковых вопроса в одном ответе (ai/replyRepeatGuard.ts::dropNearRepeats).
 */
export function filterBotReply(input: BotReplyFilterInput): BotReplyFilterResult {
  const result = filterBotReplyImpl(input);
  const before = typeof input.reply === "string" ? input.reply : Array.isArray(input.reply) ? input.reply.filter((v): v is string => typeof v === "string").join("\n") : "";
  traceFilterDelta("reply_chain", before, result.bubbles.join("\n"));
  return result;
}
function filterBotReplyImpl(input: BotReplyFilterInput): BotReplyFilterResult {
  const topicState = input.topicState ?? EMPTY_TOPIC_STATE;
  const bubblesRaw = normalizeReplyBubbles(
    input.reply,
    input.botSpokeBefore,
    input.clientSaidTrusted,
    input.botSaidBefore[input.botSaidBefore.length - 1] ?? ""
  );
  const recruitingCut = input.jobConversation
    ? { bubbles: bubblesRaw, stripped: 0 }
    : stripRecruiting(bubblesRaw, input.language);
  if (recruitingCut.stripped > 0) guardFired("recruiting_off_topic", recruitingCut.stripped);
  // Собственник о себе («Ман сохибхона») — продавец: бот не говорит ему «торг с собственником»
  // (ai/intentDirectionGuard.ts::guardOwnerAsThirdParty, 28.09.2026).
  const bubblesDirectionSafe = guardOwnerAsThirdParty({
    bubbles: guardDirectionQuestion({
      bubbles: recruitingCut.bubbles,
      clientText: input.clientSaidTrusted,
      botSpokeBefore: input.botSpokeBefore,
      language: input.language,
    }),
    clientText: input.clientSaidTrusted,
    language: input.language,
  });
  const bubblesOneQuestion = enforceOneQuestionPerBubble(bubblesDirectionSafe, input.draft.intent === "sell");
  /* Хранимый счётчик, а не только лента: лента обрезана до 40 реплик (см. effectivePhoneAsks). */
  const phoneAsksSoFar = effectivePhoneAsks(input.phoneAsksSent ?? 0, input.botSaidBefore);
  const phoneKnown = input.phoneKnown || phoneSaidInDialog([input.clientSaidTrusted, input.clientTurnText]);
  const stopAskingPhone = phoneAsksSoFar >= MAX_PHONE_ASKS || phoneKnown;
  const bubbles = ensureOpenQuestionKept(
    phoneAsksSoFar >= MAX_PHONE_ASKS
      ? dropPhoneAsks(bubblesOneQuestion)
      : phoneKnown
        ? dropKnownPhoneAsks(bubblesOneQuestion)
        : ensurePhoneAskKept({
            bubbles: bubblesOneQuestion,
            stage: input.draft.stage,
            clientText: input.clientTurnText,
            previousBotText: input.previousBotText,
            language: input.language,
          }),
    topicState.openQuestion,
    input.mustRepeatOpenQuestion ?? false
  );
  const requestedAgent: RequestedAgentMatch = input.requestedAgent ?? { status: "none" };
  const requestedNotice = input.requestedNotice ?? null;
  const finalBubbles = ensureRequestedAgentNoticeKept(
    // Две просьбы номера разными словами в одном ответе — одна лишняя (keepOnePhoneAsk).
    keepOnePhoneAsk(dropRepeatedQuestions(bubbles, input.botSaidBefore, topicState.openQuestion)),
    requestedAgent,
    requestedNotice
  );
  const modelSaidNothing = !(Array.isArray(input.reply) ? input.reply : []).some(
    (b) => typeof b === "string" && b.trim().length > 0
  );
  const guardsAteReply = finalBubbles.length === 0 && !modelSaidNothing;
  const deduped =
    finalBubbles.length === 0
      ? modelSaidNothing
        ? [
            inClientLanguage(
              phoneKnown ? FALLBACK_AI_DOWN_PHONE_KNOWN : FALLBACK_AI_DOWN,
              ...input.fallbackLanguageWords
            ),
          ]
        : []
      : dropNearRepeats(
          dropRepeatedBubbles(finalBubbles, input.botSaidBefore, [topicState.openQuestion, requestedNotice]),
          input.botSaidBefore,
          { clientTurnText: input.clientTurnText, keepAnyway: [topicState.openQuestion, requestedNotice] }
        );
  if (deduped.length < finalBubbles.length) guardFired("bot_repeat", finalBubbles.length - deduped.length);
  // Журнал о пустом ответе пишет finalizeBotReply: он же решает, чем этот пустой
  // ход закрыть (второй ответ модели или нейтральная реплика), а не молчанием.
  const silencedBy: EmptyReplyCause | null = deduped.length > 0 ? null : guardsAteReply ? "guards" : "repeat";
  if (stopAskingPhone && phoneAsksSoFar === MAX_PHONE_ASKS) {
    void logSystemError(
      "ai",
      `Бот уже ${phoneAsksSoFar} раза просил номер и больше не просит (диалог ${input.conversationId}, ${input.channelLabel}) — ` +
        `нужен живой сотрудник: человек, скорее всего, не понимает вопроса.`,
      { url: input.openUrl }
    );
  }
  return { bubbles: deduped, finalBubbles, modelSaidNothing, guardsAteReply, silencedBy, phoneAsksSoFar, stopAskingPhone };
}

/* ------------------------------------------------------------------------- *
 * БОТ НЕ МОЛЧИТ ИЗ-ЗА СВОИХ ЖЕ ФИЛЬТРОВ (аудит ботов 10.10.2026, P0-1,
 * docs/audit-bots-2026-10-10-real-failures.md)
 * ------------------------------------------------------------------------- */

/**
 * ЖИВЫЕ ЦИФРЫ 30 ДНЕЙ: 84 хода «ответ целиком вычистили наши проверки», 99 —
 * «бот собирался повторить реплику дословно», 42 — щит исходящих поставил паузу
 * за повтор. Клиенту в этих ходах не уходило НИЧЕГО: продавец отвечал на анкету,
 * клиент договаривался о показе «после двух часов», жаловался «агент не
 * позвонил» — и получал тишину.
 *
 * Две прежние логики сводятся в одну, ни одна не теряется:
 *  - заглушка «нужно больше времени» по-прежнему уходит ТОЛЬКО когда модель
 *    сама ничего не сказала (разбор 20.09: сообщать о поломке там, где её не
 *    было, хуже всего) — здесь её нет;
 *  - стражи по-прежнему вырезают повторы и лишние просьбы номера — но пустой
 *    результат больше не означает молчание: один повторный ход модели с явной
 *    поправкой, а если и он пуст — короткая нейтральная реплика по типу
 *    последнего сообщения клиента, ДРУГАЯ, чем недавние реплики бота.
 *
 * ЗАЦИКЛИТЬСЯ НЕ МОЖЕТ: повтор модели ровно один на ход; заготовка выбирается из
 * трёх и не повторяет ни одну из недавних реплик. Если все три уже звучали в
 * последних репликах бота — это петля, и тогда молчим с громкой записью «нужен
 * живой сотрудник» (иначе бот отвечал бы заготовками бесконечно).
 */

/** Сколько последних реплик бота сверяем, выбирая заготовку. */
const NEUTRAL_RECENT_WINDOW = 8;

/** Нейтральные реплики. Ничего не обещают от имени людей (P0-2 того же аудита). */
export const NEUTRAL_REPLIES = {
  /** «Салом», «Алло», «?» — человек проверяет, на связи ли мы. */
  presence: {
    ru: "Да, я на связи. Напишите, пожалуйста, что вас интересует.",
    tg: "Бале, ман дар тамосам. Лутфан нависед, ки чӣ шуморо шавқманд мекунад.",
  },
  /** Вопрос, на который ответ съели фильтры. */
  question: {
    ru: "Понял ваш вопрос. Уточните, пожалуйста, чуть подробнее — так отвечу точнее.",
    tg: "Саволатонро фаҳмидам. Лутфан каме муфассалтар нависед — то дақиқтар ҷавоб диҳам.",
  },
  /** Сообщение-утверждение: ответ на анкету, «после двух часов», подробности. */
  statement: {
    ru: "Спасибо за уточнение. Если есть ещё вопрос — пишите.",
    tg: "Ташаккур барои маълумот. Агар боз савол бошад — нависед.",
  },
} satisfies Record<string, FallbackText>;

type NeutralKind = keyof typeof NEUTRAL_REPLIES;

/** Слова-вопросы (русский и таджикский). Без `\b`: в JS он не видит кириллицу. */
const QUESTION_WORDS = new Set([
  "сколько", "где", "когда", "как", "почему", "какой", "какая", "какие", "можно",
  "чанд", "куҷо", "кучо", "кай", "чӣ", "чи", "чаро", "оё",
]);

/** «Салом», «Алло» — только приветствие или проверка связи. */
const PRESENCE_WORDS = new Set([
  "салом", "салам", "ассалом", "ассалому", "алейкум", "алайкум", "алло", "ало", "привет", "здравствуйте",
  "добрый", "день", "вечер", "утро", "hello", "hi", "эй",
]);

/** Какого рода последнее сообщение клиента — по нему порядок заготовок. */
export function neutralKindFor(clientTurnText: string): NeutralKind {
  const text = clientTurnText.trim().toLowerCase();
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0 || words.every((w) => PRESENCE_WORDS.has(w))) return "presence";
  if (text.includes("?") || words.some((w) => QUESTION_WORDS.has(w))) return "question";
  return "statement";
}

const normalizeForCompare = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Заготовка на языке клиента, которой нет среди недавних реплик бота и которую
 * щит выпустит. null — все три уже звучали (петля): см. шапку раздела.
 */
export async function pickNeutralReply(
  input: Pick<BotReplyFilterInput, "clientTurnText" | "botSaidBefore" | "fallbackLanguageWords"> & Partial<Pick<BotReplyFilterInput, "language">>,
  shieldBlocked?: (bubbles: string[]) => Promise<string[]>
): Promise<string | null> {
  const first = neutralKindFor(input.clientTurnText);
  const order: NeutralKind[] = [first, ...(["presence", "question", "statement"] as NeutralKind[]).filter((k) => k !== first)];
  const recent = new Set(input.botSaidBefore.slice(-NEUTRAL_RECENT_WINDOW).map(normalizeForCompare));
  const candidates = order
    .map((k) => input.language === "ru" || input.language === "tg"
      ? NEUTRAL_REPLIES[k][input.language]
      : inClientLanguage(NEUTRAL_REPLIES[k], input.clientTurnText, ...input.fallbackLanguageWords))
    .filter((t) => !recent.has(normalizeForCompare(t)));
  if (candidates.length === 0) return null;
  const blocked = shieldBlocked ? new Set(await shieldBlocked(candidates)) : new Set<string>();
  return candidates.find((t) => !blocked.has(t)) ?? null;
}

/** Поправка для второго хода модели — последним словом промта (QualifyTurnOptions.retryDirective). */
export function emptyReplyRetryDirective(cause: EmptyReplyCause, dropped: string[]): string {
  const said = dropped
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" / ")
    .slice(0, 400);
  return (
    "\n\nПОВТОРНАЯ ПОПЫТКА ОТВЕТА (это пишет код CRM, не клиент). Твой вариант ответа на этот ход НЕ отправлен: " +
    (cause === "repeat"
      ? "он повторяет то, что бот уже писал в этом разговоре."
      : "проверки вырезали из него всё (повторный вопрос, лишняя просьба номера, угадывание «покупаете или продаёте», найм).") +
    (said ? ` Не отправленный вариант: «${said}».` : "") +
    " Напиши ДРУГОЙ короткий ответ по существу ПОСЛЕДНЕГО сообщения клиента. Не повторяй уже сказанное ботом ни дословно, " +
    "ни по смыслу; не проси номер телефона; не задавай вопрос, который уже задавали; не обещай звонок, фото или файлы. " +
    "Если по существу ответить нечего — коротко подтверди, что понял сообщение."
  );
}

export interface BotReplyRecovery {
  /**
   * Один повторный ход модели с поправкой (emptyReplyRetryDirective). Возвращает
   * сырой `reply` или null. Не передан — сразу нейтральная реплика (каналы, где
   * повторить ход нечем).
   */
  regenerate?: (directive: string) => Promise<unknown>;
  /** Какие из готовых пузырей щит исходящих не выпустит (lib/outboundShield.ts::repeatBlockedTexts). */
  shieldBlocked?: (bubbles: string[]) => Promise<string[]>;
}

export interface FinalBotReply extends BotReplyFilterResult {
  /** Чем закрыт ход: как есть, вторым ответом модели, заготовкой или (петля) ничем. */
  recovery: "none" | "regenerated" | "neutral" | "silent_loop";
}

/** Пузыри, которые щит не выпустит, снимаем ДО записи в переписку — иначе в CRM реплика, которой клиент не видел. */
async function withoutShieldRepeats(
  result: BotReplyFilterResult,
  shieldBlocked: BotReplyRecovery["shieldBlocked"]
): Promise<BotReplyFilterResult> {
  if (!shieldBlocked || result.bubbles.length === 0) return result;
  const blocked = new Set(await shieldBlocked(result.bubbles));
  if (blocked.size === 0) return result;
  const bubbles = result.bubbles.filter((b) => !blocked.has(b));
  guardFired("bot_repeat", result.bubbles.length - bubbles.length);
  return {
    ...result,
    bubbles,
    silencedBy: bubbles.length > 0 ? null : (result.silencedBy ?? "repeat"),
  };
}

/**
 * ЦЕПОЧКА ФИЛЬТРОВ + «НЕ МОЛЧАТЬ». Все три окончания хода (каналы Meta и сайт,
 * Telegram, Direct Messages) зовут это вместо голого filterBotReply.
 */
export async function finalizeBotReply(input: BotReplyFilterInput, recovery: BotReplyRecovery = {}): Promise<FinalBotReply> {
  const result = await finalizeBotReplyImpl(input, recovery);
  if (result.recovery === "neutral" || result.recovery === "regenerated") {
    traceReplyOrigin(result.recovery);
    traceFilterDelta("recovery", "", result.bubbles.join("\n"), "recovery");
  }
  return result;
}
async function finalizeBotReplyImpl(input: BotReplyFilterInput, recovery: BotReplyRecovery = {}): Promise<FinalBotReply> {
  const first = await withoutShieldRepeats(filterBotReply(input), recovery.shieldBlocked);
  if (first.bubbles.length > 0 || !first.silencedBy) return { ...first, recovery: "none" };
  const cause = first.silencedBy;
  const where = `диалог ${input.conversationId}, ${input.channelLabel}`;
  const causeText = cause === "guards" ? "ответ модели целиком вырезали наши фильтры" : "ответ модели оказался повтором уже сказанного";

  if (recovery.regenerate) {
    // Что модель хотела сказать: после стражей (повтор) или, если стражи съели всё, сырой ответ.
    const modelBubbles = Array.isArray(input.reply) ? input.reply.filter((b): b is string => typeof b === "string") : [];
    const dropped = first.finalBubbles.length > 0 ? first.finalBubbles : modelBubbles;
    let raw: unknown = null;
    try {
      raw = await recovery.regenerate(emptyReplyRetryDirective(cause, dropped));
    } catch (err) {
      console.error(`[бот] повторный ход после пустого ответа (${where}):`, err instanceof Error ? err.message : err);
    }
    if (raw != null) {
      const second = await withoutShieldRepeats(filterBotReply({ ...input, reply: raw }), recovery.shieldBlocked);
      // Пустой второй ответ модели дал бы заглушку «нужно больше времени» — её здесь не шлём.
      if (second.bubbles.length > 0 && !second.modelSaidNothing) {
        guardFired("reply_regenerated");
        void logSystemError("ai", `Бот: ${causeText} (${where}) — модель ответила второй раз, ответ ушёл.`, {
          dedupKey: "bot-reply-regenerated",
          dedupScope: input.conversationId,
          silent: true,
        });
        return { ...second, recovery: "regenerated" };
      }
    }
  }

  const neutral = await pickNeutralReply(input, recovery.shieldBlocked);
  if (neutral) {
    guardFired("reply_neutral_fallback");
    void logSystemError(
      "ai",
      `Бот: ${causeText} (${where})${recovery.regenerate ? ", второй ответ модели тоже не прошёл" : ""} — ` +
        `клиенту ушла короткая нейтральная реплика вместо молчания. Посмотрите диалог: ответ по существу за человеком.`,
      { dedupKey: "bot-reply-neutral-fallback", dedupScope: input.conversationId, url: input.openUrl }
    );
    return { ...first, bubbles: [neutral], silencedBy: null, recovery: "neutral" };
  }

  void logSystemError(
    "ai",
    `Бот промолчал: ${causeText} (${where}), а все нейтральные реплики уже звучали в последних ответах — ` +
      `похоже на петлю. Нужен живой сотрудник: клиенту в этом ходе не ушло ничего.`,
    { dedupKey: "bot-reply-silent-loop", dedupScope: input.conversationId, url: input.openUrl }
  );
  return { ...first, recovery: "silent_loop" };
}
