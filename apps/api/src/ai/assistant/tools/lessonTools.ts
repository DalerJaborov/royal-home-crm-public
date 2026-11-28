import { z } from "zod";
import { prisma } from "../../../db.js";
import { describeError } from "../../../lib/describeError.js";
import { logSystemError } from "../../../lib/systemError.js";
import {
  catalogProblem,
  findLessonByNumber,
  formatDuration,
  lessonNumberFromQuery,
  loadLessonCatalog,
  searchLessons,
  type Lesson,
  type LessonLang,
} from "../../../lib/lessons/catalog.js";
import {
  broadcastLessons,
  lessonCaption,
  sendLessonVideo,
  takeLessonBroadcastSlot,
  takeLessonSendSlot,
} from "../../../lib/lessons/sender.js";
import type { AssistantActor } from "../actor.js";
import type { AssistantReadToolPlugin, AssistantToolContext } from "./types.js";

/**
 * ВИДЕОУРОКИ ПО CRM В ШАБНАМ (28.11.2026): найти, объяснить по тексту урока, прислать в Telegram.
 *
 *  - find_lessons — чтение: до 5 уроков и фрагмент ответа ИЗ ТЕКСТА УРОКА (lib/lessons/catalog.ts);
 *  - send_lesson — шлёт один урок: в тот чат, где попросили (личка или группа), или в личку просящему;
 *  - send_all_lessons — оглавление, все уроки по порядку, «Это все»; раз в час на чат.
 *
 * Только для сотрудников (актор с ролью): клиентов среди акторов помощницы нет, а режим просмотра (акционер)
 * не может слать общее — это `sideEffect: "shared"` (writeGate.ts). Уроки не секретны, поэтому в общей группе
 * инструменты не скрываются (GROUP_HIDDEN_TOOLS их не содержит). protect_content — только в личке.
 */
const TAJIK_LETTERS = /[ғӣқӯҳҷҒӢҚӮҲҶ]/u;

const staffAllowed = (actor: AssistantActor) => Boolean(actor.id) && Boolean(actor.role);

const langSchema = z.preprocess((v) => (v === "tg" ? "tj" : v === null || v === "" ? undefined : v), z.enum(["ru", "tj"]).optional());

/** Язык урока: назван — он; иначе таджикский, если человек писал таджикскими буквами; иначе русский. */
function defaultLang(explicit: LessonLang | undefined, ctx: AssistantToolContext): LessonLang {
  if (explicit) return explicit;
  return ctx.question && TAJIK_LETTERS.test(ctx.question) ? "tj" : "ru";
}

const NO_TELEGRAM = "Telegram не привязан: CRM → Профиль → «Личный чат с ботом CRM в Telegram» → «Привязать»";

interface ResolvedTarget {
  chatId: string;
  /** Личный чат человека — там можно запретить пересылку. */
  isPrivate: boolean;
}

async function ownChatId(actor: AssistantActor): Promise<string | null> {
  const agent = await prisma.agent.findUnique({ where: { id: actor.id }, select: { telegramChatId: true } });
  return agent?.telegramChatId ?? null;
}

/** Куда слать: "me" — в личку просящему; "here" — туда, где попросили. */
async function resolveTarget(actor: AssistantActor, target: "here" | "me"): Promise<ResolvedTarget | { error: string }> {
  if (target === "here" && actor.surface === "telegram-group") {
    if (!actor.groupChat?.chatId) return { error: "В группе я присылаю уроки, когда ко мне обращаются напрямую" };
    return { chatId: actor.groupChat.chatId, isPrivate: false };
  }
  if (target === "here" && actor.surface === "telegram-private" && actor.telegramChatId) {
    return { chatId: actor.telegramChatId, isPrivate: true };
  }
  // Личка по просьбе («мне в личку») и вход из CRM: личный чат из профиля.
  const chatId = await ownChatId(actor);
  if (!chatId) return { error: NO_TELEGRAM };
  return { chatId, isPrivate: true };
}

function describeLesson(lesson: Lesson, snippet?: string) {
  return {
    number: lesson.number,
    title: lesson.title,
    lang: lesson.lang,
    duration: formatDuration(lesson.durationSec),
    ...(snippet ? { answerFromLesson: snippet } : {}),
  };
}

// ─── find_lessons ───────────────────────────────────────────────────────────

const findSchema = z.object({
  query: z.string().trim().min(1).max(300),
  lang: langSchema,
});

export const findLessonsTool: AssistantReadToolPlugin = {
  name: "find_lessons",
  level: "A",
  description:
    "Найти видеоурок по CRM: сотрудник спрашивает «как…» про действие в CRM или просит урок. query — его слова («как принять " +
    "заявку», «звонок», «урок 5»). Вернёт до 5 уроков: номер, название (тема), язык, длительность и answerFromLesson — фрагмент " +
    "ответа ИЗ ТЕКСТА УРОКА. Ответь человеку по сути из этого фрагмента своими словами, коротко, и предложи прислать урок " +
    "(send_lesson). Не присылай урок сам без просьбы или согласия. Нет подходящего урока — так и скажи, не выдумывай. " +
    "Если пришло lessons: [] и note «Уроки пока не загружены» — скажи это честно.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Что ищет человек: «как принять заявку», «урок 5», слова темы." },
      lang: { type: "string", enum: ["ru", "tj"], description: "Язык урока; не указан — язык человека." },
    },
    required: ["query"],
  },
  statusPhrase: "Ищу урок…",
  allowed: staffAllowed,
  async run(raw, ctx) {
    if (!staffAllowed(ctx.actor)) return { error: "Уроки доступны сотрудникам CRM" };
    const parsed = findSchema.safeParse(raw ?? {});
    if (!parsed.success) return { error: "Нужен запрос: о чём урок или его номер" };
    const catalog = await loadLessonCatalog();
    const problem = catalogProblem(catalog);
    if (problem || catalog.status !== "ok") return { lessons: [], note: problem ?? "Уроки пока не загружены" };
    const lang = defaultLang(parsed.data.lang, ctx);
    const hits = searchLessons(catalog.lessons, parsed.data.query, lang, 5);
    if (hits.length === 0) {
      return { lessons: [], note: "Подходящего урока нет в каталоге. Не выдумывай урок; ответь, если знаешь сама, или скажи честно" };
    }
    return { lang, lessons: hits.map((h) => describeLesson(h.lesson, h.snippet)) };
  },
};

// ─── send_lesson ────────────────────────────────────────────────────────────

const targetSchema = z.preprocess((v) => (v === null || v === "" ? undefined : v), z.enum(["here", "me"]).default("here"));

const sendSchema = z
  .object({
    number: z.coerce.number().int().min(1).max(999).nullish(),
    query: z.string().trim().max(300).nullish(),
    lang: langSchema,
    target: targetSchema,
  })
  .refine((v) => v.number != null || Boolean(v.query), { message: "number или query" });

export const sendLessonTool: AssistantReadToolPlugin = {
  name: "send_lesson",
  level: "A",
  description:
    "Прислать видеоурок по CRM в Telegram. Звать, когда человек просит прислать урок или соглашается на твоё предложение. " +
    "number — номер урока, либо query — слова темы. lang — ru или tj (не указан — язык человека). target: «here» — в тот " +
    "чат, где просят (личка или группа; по умолчанию), «me» — в личку просящему («скинь мне в личку»). Видео уходит с " +
    "подписью «Урок N. Тема». Получил ok — скажи одной фразой, что урок отправлен. Получил error — перескажи честно. " +
    "В группе, где просят «скиньте всем», это тоже «here».",
  parameters: {
    type: "object",
    properties: {
      number: { type: "integer", description: "Номер урока." },
      query: { type: "string", description: "Слова темы, если номер неизвестен." },
      lang: { type: "string", enum: ["ru", "tj"] },
      target: { type: "string", enum: ["here", "me"], description: "here — сюда (по умолчанию); me — в личку просящему." },
    },
  },
  statusPhrase: "Отправляю урок…",
  sideEffect: "shared",
  allowed: staffAllowed,
  async run(raw, ctx) {
    const actor = ctx.actor;
    if (!staffAllowed(actor)) return { error: "Уроки доступны сотрудникам CRM" };
    const parsed = sendSchema.safeParse(raw ?? {});
    if (!parsed.success) return { error: "Назовите номер урока или тему" };
    const catalog = await loadLessonCatalog();
    const problem = catalogProblem(catalog);
    if (problem || catalog.status !== "ok") return { error: problem ?? "Уроки пока не загружены" };
    const lang = defaultLang(parsed.data.lang, ctx);

    let lesson: Lesson | null = null;
    const number = parsed.data.number ?? (parsed.data.query ? lessonNumberFromQuery(parsed.data.query) : null);
    if (number != null) {
      lesson = findLessonByNumber(catalog.lessons, number, lang);
      if (!lesson) {
        const other = catalog.lessons.find((l) => l.number === number);
        return {
          error: other
            ? `Урока ${number} на ${lang === "tj" ? "таджикском" : "русском"} пока нет, есть на ${other.lang === "tj" ? "таджикском" : "русском"} (укажите lang)`
            : `Урока ${number} в каталоге нет`,
        };
      }
    } else if (parsed.data.query) {
      lesson = searchLessons(catalog.lessons, parsed.data.query, lang, 1).find((h) => h.lesson.lang === lang)?.lesson ?? null;
      if (!lesson) return { error: "Подходящего урока не нашла. Назовите номер или тему иначе" };
    }
    if (!lesson) return { error: "Назовите номер урока или тему" };

    const target = await resolveTarget(actor, parsed.data.target);
    if ("error" in target) return target;
    const slot = takeLessonSendSlot(target.chatId, lesson);
    if (!slot.ok) return { error: slot.error };
    if (ctx.signal?.aborted) return { error: "Не успела отправить урок, попросите ещё раз", code: "ABORTED" };

    const result = await sendLessonVideo(target.chatId, lesson, { protect: target.isPrivate });
    if (!result.ok) return { error: result.error };
    return { ok: true, done: true, sent: lessonCaption(lesson), to: target.isPrivate ? "личка" : "эта группа" };
  },
};

// ─── send_all_lessons ───────────────────────────────────────────────────────

const sendAllSchema = z.object({ lang: langSchema, target: targetSchema });

export const sendAllLessonsTool: AssistantReadToolPlugin = {
  name: "send_all_lessons",
  level: "A",
  description:
    "Прислать ВСЕ видеоуроки по CRM по порядку («скинь все уроки», «пришлите всем уроки»): сначала строка-оглавление, потом " +
    "уроки с паузами, в конце «Это все». lang — ru или tj (не указан — язык человека). target: «here» — сюда (по умолчанию), " +
    "«me» — в личку просящему. Идёт в фоне несколько минут: получил ok — скажи, что присылаю, уроки придут по очереди. " +
    "Не чаще раза в час на чат. Один урок — это send_lesson.",
  parameters: {
    type: "object",
    properties: {
      lang: { type: "string", enum: ["ru", "tj"] },
      target: { type: "string", enum: ["here", "me"], description: "here — сюда (по умолчанию); me — в личку просящему." },
    },
  },
  statusPhrase: "Готовлю все уроки…",
  sideEffect: "shared",
  allowed: staffAllowed,
  async run(raw, ctx) {
    const actor = ctx.actor;
    if (!staffAllowed(actor)) return { error: "Уроки доступны сотрудникам CRM" };
    const parsed = sendAllSchema.safeParse(raw ?? {});
    if (!parsed.success) return { error: "Язык — ru или tj" };
    const catalog = await loadLessonCatalog();
    const problem = catalogProblem(catalog);
    if (problem || catalog.status !== "ok") return { error: problem ?? "Уроки пока не загружены" };
    const lang = defaultLang(parsed.data.lang, ctx);
    const lessons = catalog.lessons.filter((l) => l.lang === lang);
    if (lessons.length === 0) return { error: `Уроков на ${lang === "tj" ? "таджикском" : "русском"} пока нет` };

    const target = await resolveTarget(actor, parsed.data.target);
    if ("error" in target) return target;
    const slot = takeLessonBroadcastSlot(target.chatId);
    if (!slot.ok) return { error: slot.error };

    // Рассылка идёт дольше срока ответа помощницы: запускаем в фоне, человеку отвечаем сразу.
    void broadcastLessons(target.chatId, lessons, { protect: target.isPrivate }).catch((err) =>
      logSystemError("api", `Рассылка всех уроков не дошла до конца: ${describeError(err)}`),
    );
    return { ok: true, done: true, started: true, count: lessons.length, to: target.isPrivate ? "личка" : "эта группа" };
  },
};

export const lessonTools: readonly AssistantReadToolPlugin[] = [findLessonsTool, sendLessonTool, sendAllLessonsTool];
