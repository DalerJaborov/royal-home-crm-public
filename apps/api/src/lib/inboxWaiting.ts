import { Prisma } from "../generated/prisma/client.js";
import { BW, EW } from "../ai/wordBoundary.js";
import { staffContactAfterSql } from "./noContact.js";
import { lastMessageSql } from "./lastMessageSql.js";

/**
 * «ЖДУТ» В «ЧАТАХ» — ТОЛЬКО ТЕ, КОМУ РЕАЛЬНО НАДО ОТВЕТИТЬ СЕЙЧАС (владелец 21.11.2026:
 * «ждут 514» — а агент с клиентами уже общался; «зачем мне эта информация?»).
 *
 * Раньше срез значил «последняя реплика — от клиента», и в него падали мёртвые переписки
 * месячной давности, финальные «ок, спасибо» и клиенты, которым уже позвонили. Теперь
 * диалог «ждёт», только когда одновременно:
 *  1. последняя реплика от клиента и она моложе `NEEDS_HUMAN_WINDOW_HOURS` часов;
 *  2. после неё с клиентом не связывались другим путём — звонок, встреча/показ, сообщение
 *     агента из CRM (правило контакта — lib/noContact.ts, не своё);
 *  3. реплика не «закрывающая»: не «ок/спасибо/рахмат/хоп», не смайлик и не стикер
 *     без вопроса («спасибо, а сколько стоит?» — НЕ закрывающая).
 *
 * ОДНА ДВЕРЬ: условие собирает `waitingForHumanSql`, и его берут список страницы, число на
 * кнопке, сгруппированный список и красная плашка сверху — иначе число и список за ним
 * разойдутся (ровно то, от чего в routes/conversations.ts уже страхуются).
 */

/** Старше этого срока последняя реплика клиента — не «ждут», а просто диалог в «Все». */
export const NEEDS_HUMAN_WINDOW_HOURS = 48;

/**
 * Слова, которыми разговор закрывают: благодарность и согласие. Русский и таджикский
 * (латиницей — «ok», «spasibo» набирают с телефона). ЕДИНСТВЕННОЕ место словаря:
 * JS-проверка и SQL-шаблон строятся отсюда, расхождение ловит тест на каждое слово.
 */
export const CLOSING_WORDS: readonly string[] = [
  // русский
  "ок", "окей", "оки", "окай", "ok", "okay",
  "спасибо", "спс", "благодарю", "благодарствую", "thanks", "thx",
  "хорошо", "ладно", "понятно", "понял", "поняла", "ясно", "отлично", "супер", "договорились", "принято",
  // таджикский
  "рахмат", "раҳмат", "ташаккур", "мерси", "хуб", "майли", "хоп", "ҳоп", "дуруст", "баракалло",
];

/** Слова, которые только сопровождают закрытие («большое спасибо вам», «бисёр ташаккур»). */
export const CLOSING_FILLERS: readonly string[] = [
  "большое", "огромное", "вам", "вас", "за", "всё", "все", "очень", "хорошего", "дня", "вечера",
  "бисёр", "калон", "аз", "шумо", "ба", "ҳам", "аст",
];

const SPEC_CHARS = /[.*+?^${}()|[\]\\]/g;

/** Все слова словаря без повторов, нижним регистром. */
function uniqueWords(words: readonly string[]): string[] {
  return [...new Set(words.map((w) => w.toLowerCase().replace(/[^\p{L}]/gu, "")).filter(Boolean))];
}

const CLOSING = uniqueWords(CLOSING_WORDS);
const FILLERS = uniqueWords(CLOSING_FILLERS);

const NOT_WORD_CHARS = "[^\\p{L}\\p{N}]";
const JS_CLOSING_ONLY = new RegExp(
  `^${NOT_WORD_CHARS}*(?:${BW}(?:${[...CLOSING, ...FILLERS].map((w) => w.replace(SPEC_CHARS, "\\$&")).join("|")})${EW}${NOT_WORD_CHARS}*)+$`,
  "iu",
);
const JS_HAS_CLOSING = new RegExp(`${BW}(?:${CLOSING.join("|")})${EW}`, "iu");
const JS_NO_WORDS = new RegExp(`^${NOT_WORD_CHARS}*$`, "u");
const STICKER_ONLY = /^\s*\[вложение:\s*sticker\]\s*$/iu;

/**
 * «Закрывающая» реплика — после неё человеку отвечать не на что: только слова словаря,
 * смайлик/знаки без слов, пустое сообщение или стикер. Любой вопросительный знак или
 * постороннее слово («спасибо, а сколько стоит?») — реплика настоящая.
 */
export function isClosingReply(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (STICKER_ONLY.test(t)) return true;
  if (t.includes("?") || t.includes("؟")) return false;
  if (JS_NO_WORDS.test(t)) return true;
  return JS_CLOSING_ONLY.test(t) && JS_HAS_CLOSING.test(t);
}

// ───────────────────────── то же самое для Postgres ─────────────────────────
// В Postgres нет \p{L}, а [[:alpha:]] зависит от локали базы (в C-локали кириллицы нет),
// поэтому «буква» здесь — явные диапазоны кода символа, а регистр — парами [оО].

const SQL_LETTERS = "a-zA-Zа-яА-ЯёЁӣӢӯӮқҚғҒҳҲҷҶ";
const SQL_NOT_WORD = `[^${SQL_LETTERS}0-9]`;

function sqlWord(w: string): string {
  return [...w]
    .map((ch) => {
      const lo = ch.toLowerCase();
      const up = ch.toUpperCase();
      return lo !== up ? `[${lo}${up}]` : ch;
    })
    .join("");
}

const SQL_CLOSING_ALT = CLOSING.map(sqlWord).join("|");
const SQL_ANY_ALT = [...CLOSING, ...FILLERS].map(sqlWord).join("|");

/** `^<не-слово>*(слово<не-слово>*)+$` — вся реплика состоит только из слов словаря. */
export const CLOSING_ONLY_SQL_PATTERN = `^${SQL_NOT_WORD}*(?:(?:${SQL_ANY_ALT})(?:${SQL_NOT_WORD}+|$))+$`;
/** Среди слов есть хотя бы одно настоящее закрытие, а не только «вам»/«за». */
export const HAS_CLOSING_SQL_PATTERN = `(^|${SQL_NOT_WORD})(?:${SQL_CLOSING_ALT})(${SQL_NOT_WORD}|$)`;
/** Ни одной буквы и цифры: смайлик, точка, пусто. */
export const NO_WORDS_SQL_PATTERN = `^${SQL_NOT_WORD}*$`;
export const STICKER_SQL_PATTERN = "^\\s*\\[вложение:\\s*[sS][tT][iI][cC][kK][eE][rR]\\]\\s*$";

/** SQL-версия `isClosingReply` для выражения-текста `content` (text, может быть NULL). */
export function closingReplySql(content: Prisma.Sql): Prisma.Sql {
  const c = Prisma.sql`COALESCE(${content}, '')`;
  return Prisma.sql`(
    ${c} ~ ${STICKER_SQL_PATTERN}
    OR (
      position('?' IN ${c}) = 0 AND position('؟' IN ${c}) = 0
      AND (
        ${c} ~ ${NO_WORDS_SQL_PATTERN}
        OR (${c} ~ ${CLOSING_ONLY_SQL_PATTERN} AND ${c} ~ ${HAS_CLOSING_SQL_PATTERN})
      )
    )
  )`;
}

export interface WaitingSqlParts {
  /** jsonb последней реплики (`c.messages -> -1`, у не-массива NULL). */
  lastMessage: Prisma.Sql;
  /** Когда писал клиент: `COALESCE(c."lastMessageAt", c."updatedAt")`. */
  activityAt: Prisma.Sql;
  /** Id клиента диалога (может быть NULL — тогда звонков нет). */
  clientId: Prisma.Sql;
  /** `Client.lastAgentAttemptAt` того же клиента. */
  lastAgentAttemptAt: Prisma.Sql;
}

/** Колонки обычной выборки по `c` (диалог) и `cl` (клиент). */
export function conversationWaitingParts(): WaitingSqlParts {
  return {
    lastMessage: lastMessageSql(Prisma.sql`c.messages`),
    activityAt: Prisma.sql`COALESCE(c."lastMessageAt", c."updatedAt")`,
    clientId: Prisma.sql`cl.id`,
    lastAgentAttemptAt: Prisma.sql`cl."lastAgentAttemptAt"`,
  };
}

/** Булево SQL-выражение «диалог реально ждёт человека» (см. шапку файла). */
export function waitingForHumanSql(p: WaitingSqlParts): Prisma.Sql {
  return Prisma.sql`(
    (${p.lastMessage} ->> 'role') = 'user'
    AND ${p.activityAt} > now() - make_interval(hours => ${NEEDS_HUMAN_WINDOW_HOURS})
    AND NOT ${closingReplySql(Prisma.sql`${p.lastMessage} ->> 'content'`)}
    AND NOT (${p.clientId} IS NOT NULL AND ${staffContactAfterSql(p.clientId, p.activityAt, p.lastAgentAttemptAt)})
  )`;
}
