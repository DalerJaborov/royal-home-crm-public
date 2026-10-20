import { Router } from "express";
import { Prisma } from "../generated/prisma/client.js";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { logAudit } from "../lib/audit.js";
import { requireElevation } from "../lib/stepUp.js";
import { LOST_LESSON_KIND } from "../lib/lostConversations.js";
import {
  distillAllPending,
  EMPTY_LESSON,
  lessonDedupKey,
  normalizeForDedup,
  PROMPT_LESSON_LIMIT,
  selectActiveLessons,
} from "../lib/botLessons.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";

/**
 * Чему бот научился и о чём он спрашивает владельца.
 *
 * Сами случаи копит и разбирает `lib/botLessons.ts` — здесь только окно наружу:
 * показать выведенные правила, дать выключить неудачное и дать владельцу самому
 * ответить там, где ночной разбор ничего не смог вывести.
 *
 * Почему это отдельный роут, а не часть Настроек: у настроек одно тело на всё, а
 * тут список с постраничным пределом и правка одной записи. Смешивать их значило бы
 * тащить весь список в каждый ответ PATCH /settings.
 */
export const botLearningRouter = Router();

// EMPTY_LESSON — из lib/botLessons.ts (единственный источник, см. комментарий там).

/**
 * Сколько групп правил и вопросов отдаём за раз (17.09.2026: было 100/50 без
 * «Показать ещё» — теперь есть, порция 20, тот же приём, что у остальных
 * восьми списков CRM, см. `useAccumulatedPages`). Группа — не строка таблицы
 * (см. groupByDedupKey ниже), поэтому страница — смещение по номеру группы,
 * тем же способом, что уже сделан для находок судьи (routes/botAudit.ts,
 * GROUPS_PAGE). Ниже по списку правила всё равно уже не участвуют в промте
 * (там свой предел, см. PROMPT_LESSON_LIMIT).
 */
const GROUPS_PAGE = 20;

/**
 * Сколько СЫРЫХ строк сканируем, чтобы собрать группы повторов (18.09.2026,
 * доделка: группировка только внутри уже загруженной страницы не годится —
 * владелец прямо сказал «повторы исключить полностью», а один и тот же вопрос
 * иначе всплывал бы на 1-й и 3-й странице отдельными карточками). Полный проход
 * по вечно растущей таблице на каждый запрос слишком дорог, а 2000 последних —
 * тот же компромисс, что уже принят для находок судьи (routes/botAudit.ts
 * сканирует 500 последних перед группировкой): на реальных числах этого экрана
 * (89 вопросов, 112 правил) это заведомо больше, чем есть в базе, то есть
 * группировка честная и без остатка. Если когда-нибудь лента разрастётся за
 * потолок — `rulesGroupsTotal`/`questionsGroupsTotal` станут нижней оценкой
 * (группы за пределами скана не увидены), это то же допущение, что уже принято
 * у судьи, и в любом случае лучше прежнего «повтор на каждой странице».
 */
const RULES_SCAN_LIMIT = 2000;
const QUESTIONS_SCAN_LIMIT = 2000;

/** Что видно снаружи. Первоисточник (что сказал бот, что ответил человек) отдаём
 *  всегда: без него правило нечем проверить, и выключать его пришлось бы вслепую. */
const LESSON_FIELDS = {
  id: true,
  createdAt: true,
  kind: true,
  channel: true,
  conversationId: true,
  botMessage: true,
  humanMessage: true,
  lesson: true,
  active: true,
} as const;

type LessonRow = Prisma.BotLessonGetPayload<{ select: typeof LESSON_FIELDS }>;

/** Сколько записей той же группы повторов показываем под «ещё N таких». Список
 *  на экране раскрывает их по требованию — держать в памяти сотню одинаковых
 *  карточек ради этого незачем. */
const DUP_EXAMPLES_LIMIT = 5;

interface GroupedLessonRow extends LessonRow {
  /** Сколько записей схлопнуто в эту строку, включая её саму. 1 — повторов нет. */
  dupCount: number;
  /** Остальные записи той же группы, без текущей, ограничено DUP_EXAMPLES_LIMIT. */
  dupExamples: LessonRow[];
}

/**
 * Схлопывает повторы в одну строку (владелец 17.09.2026: «повторы исключить
 * полностью, чтобы я сто раз не отвечал на одинаковые сообщения»). `rows` уже
 * отсортированы по `createdAt desc` запросом — первая строка группы самая
 * свежая, она и представляет группу; `Map` сохраняет порядок первого попадания
 * ключа, так что общий порядок групп остаётся «от свежих к старым».
 *
 * Группировка — по ВСЕМ строкам, полученным сканом (RULES_SCAN_LIMIT /
 * QUESTIONS_SCAN_LIMIT), а не только по одной странице (18.09.2026, доделка:
 * группировка внутри страницы разносила один и тот же вопрос по разным
 * страницам — «Показать ещё» показывал его снова как новый). Страницами
 * (GROUPS_PAGE) режется уже готовый список ГРУПП, см. вызов ниже — тот же
 * приём, что у находок судьи (routes/botAudit.ts).
 */
function groupByDedupKey(rows: LessonRow[], keyFn: (row: LessonRow) => string): GroupedLessonRow[] {
  const groups = new Map<string, LessonRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const result: GroupedLessonRow[] = [];
  for (const list of groups.values()) {
    const [head, ...rest] = list;
    result.push({ ...head, dupCount: list.length, dupExamples: rest.slice(0, DUP_EXAMPLES_LIMIT) });
  }
  return result;
}

/**
 * Разобранные случаи с выведенным правилом. Отсюда бот и берёт подсказки в промт.
 *
 * Предложения из недельной сводки по оборванным перепискам (kind="lost_client")
 * попадают сюда ТОЛЬКО после того, как владелец их включил. Пока предложение
 * выключено, оно живёт в своей карточке «Куда уходят клиенты» и не делает вид,
 * что бот чему-то научился: он ничему не научился, это гипотеза из слабого сигнала.
 * Включённое — наоборот, обязано быть в общем списке действующих правил, иначе
 * выключить его потом было бы негде.
 */
const RULE_WHERE: Prisma.BotLessonWhereInput = {
  lesson: { not: null, notIn: [EMPTY_LESSON] },
  NOT: { kind: LOST_LESSON_KIND, active: false },
};

/**
 * «Вопросы бота»: случай был, а правила из него нет — либо ночной разбор до него
 * ещё не дошёл (lesson = null), либо разбор ничего не вывел (lesson = «—»).
 * Именно здесь владелец говорит, как надо было ответить, и его слова становятся
 * подсказкой боту на будущее.
 */
const QUESTION_WHERE: Prisma.BotLessonWhereInput = { OR: [{ lesson: null }, { lesson: EMPTY_LESSON }] };

const feedQuerySchema = z.object({
  /** Сколько групп ленты правил уже показано — следующая порция начинается
   *  отсюда. Смещение по ГРУППЕ, не по сырой строке (см. GROUPS_PAGE выше). */
  rulesOffset: z.coerce.number().int().min(0).optional(),
  /** То же самое для ленты вопросов. Раздельные смещения: у лент разные
   *  фильтры и разная скорость роста, страница одной не должна двигать другую. */
  questionsOffset: z.coerce.number().int().min(0).optional(),
});

/**
 * Постраничная подгрузка ГРУПП (14.09.2026 — курсор по сырым строкам; доделка
 * 18.09.2026 — группировка по всему скану, страницы по готовым группам, тем
 * же приёмом, что уже стоит у находок судьи, см. routes/botAudit.ts).
 *
 * `rulesTotal`/`questionsTotal` — честный count() СЫРЫХ строк по всей базе (как
 * и раньше). `rulesGroupsTotal`/`questionsGroupsTotal` — сколько из них
 * УНИКАЛЬНЫХ групп в пределах скана (см. RULES_SCAN_LIMIT/QUESTIONS_SCAN_LIMIT) —
 * то число, что видно на экране и на плитках сверху; раздельно, чтобы не
 * выдавать сырое за уникальное и не наоборот.
 */
botLearningRouter.get("/", requireAuth, requirePermission("settings.view"), async (req, res) => {
  const parsed = feedQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Неверные параметры" });
  const { rulesOffset = 0, questionsOffset = 0 } = parsed.data;

  const [rawRules, rawQuestions, rulesTotal, questionsTotal, activeCount, activeLessons] = await Promise.all([
    prisma.botLesson.findMany({
      where: RULE_WHERE,
      orderBy: { createdAt: "desc" },
      take: RULES_SCAN_LIMIT,
      select: LESSON_FIELDS,
    }),
    prisma.botLesson.findMany({
      where: QUESTION_WHERE,
      orderBy: { createdAt: "desc" },
      take: QUESTIONS_SCAN_LIMIT,
      select: LESSON_FIELDS,
    }),
    prisma.botLesson.count({ where: RULE_WHERE }),
    prisma.botLesson.count({ where: QUESTION_WHERE }),
    prisma.botLesson.count({ where: { ...RULE_WHERE, active: true } }),
    // Тот же отбор, что реально видит промт (selectActiveLessons — единственный
    // источник, см. lib/botLessons.ts): без него чип «в промте» на экране был бы
    // догадкой, а не фактом.
    selectActiveLessons(),
  ]);

  const allRuleGroups = groupByDedupKey(rawRules, (r) => (r.lesson ? normalizeForDedup(r.lesson) : r.id));
  const allQuestionGroups = groupByDedupKey(rawQuestions, (r) => lessonDedupKey(r.botMessage, r.humanMessage));
  const rulePage = allRuleGroups.slice(rulesOffset, rulesOffset + GROUPS_PAGE);
  const questionPage = allQuestionGroups.slice(questionsOffset, questionsOffset + GROUPS_PAGE);

  res.json({
    rules: rulePage,
    questions: questionPage,
    rulesTotal,
    questionsTotal,
    rulesGroupsTotal: allRuleGroups.length,
    questionsGroupsTotal: allQuestionGroups.length,
    activeCount,
    // Ровно те id, что видит промт прямо сейчас (после дедупа по тексту правила,
    // см. selectActiveLessons) — честная замена «действует 112 из 112»: активных
    // может быть много, а до промта реально доходят только эти.
    promptLessonIds: activeLessons.map((l) => l.id),
    promptCount: activeLessons.length,
    promptLimit: PROMPT_LESSON_LIMIT,
    rulesNextOffset: rulesOffset + rulePage.length < allRuleGroups.length ? rulesOffset + rulePage.length : null,
    questionsNextOffset:
      questionsOffset + questionPage.length < allQuestionGroups.length ? questionsOffset + questionPage.length : null,
  });
});

/** Сколько сводок и примеров отдаём. Сводка недельная, восьми хватает на два месяца
 *  назад; примеры внутри — чтобы владелец мог проверить числа, а не выгрузка. */
const DIGESTS_LIMIT = 8;
const EXAMPLES_PER_DIGEST = 10;

/**
 * Недельные сводки «куда уходят клиенты».
 *
 * Отдельный роут от общей ленты обучения: данные другой природы (агрегаты за
 * неделю, а не отдельные случаи) и другого объёма. Тащить их в каждый ответ
 * GET /bot-learning значило бы грузить экран настроек ради карточки, на которую
 * смотрят раз в неделю.
 *
 * Отмечает дельное владелец тем же PATCH /:id (active) — второго механизма нет.
 */
botLearningRouter.get("/lost", requireAuth, requirePermission("settings.view"), async (_req, res) => {
  const [digests, pendingReviews] = await Promise.all([
    prisma.lostClientDigest.findMany({
      orderBy: { periodStart: "desc" },
      take: DIGESTS_LIMIT,
      include: {
        // Вложенные take вместо запроса на каждую сводку: восемь сводок — восемь
        // лишних round-trip'ов на ровном месте.
        proposals: { orderBy: { createdAt: "asc" }, select: LESSON_FIELDS },
        reviews: {
          orderBy: { lastMessageAt: "desc" },
          take: EXAMPLES_PER_DIGEST,
          select: {
            id: true,
            channel: true,
            reason: true,
            stage: true,
            lastMessageAt: true,
            clientMessages: true,
            followUpsSent: true,
            finding: true,
            suggestion: true,
            botMessage: true,
            clientMessage: true,
          },
        },
      },
    }),
    // Разборы, которые войдут в ближайшую сводку: без этого числа карточка первую
    // неделю выглядит пустой и мёртвой, хотя работа уже идёт.
    prisma.lostConversation.count({ where: { digestId: null } }),
  ]);
  // Сколько разборов всего: примеры внутри сводки обрезаны пределом, и без
  // общего числа «разобрал всё видимое» читается как «разобрал всё».
  const reviewsTotal = await prisma.lostConversation.count();
  // Честный счётчик «на решение» (14.09.2026, жалоба владельца: счётчик в
  // BotTab.tsx считал длину уже загрученных 8 сводок, а не остаток в базе — при
  // накоплении показывал меньше правды). Здесь предложений на сводку и так без
  // take (см. include.proposals выше), но сводок отдаётся только DIGESTS_LIMIT —
  // отдельный count() по всей базе не зависит от того, сколько сводок загружено.
  const pendingProposalsCount = await prisma.botLesson.count({
    where: { kind: LOST_LESSON_KIND, active: false },
  });
  res.json({ digests, pendingReviews, reviewsTotal, pendingProposalsCount });
});

/**
 * Что делать с ОТДЕЛЬНЫМ разбором оборванной переписки (30.08.2026, жалоба
 * владельца: «сотня карточек висит, и нет кнопок „бот прав“ или „удалить“»).
 *
 * Три исхода, и все три убирают запись из списка — иначе через месяц сотня
 * карточек превращается в две сотни:
 *  - bot_right — вины бота нет, человек просто ушёл. Самый частый исход;
 *  - bot_error — бот сплоховал: заводим случай в ту же очередь обучения, куда
 *    попадают живые ошибки (BotLesson с пустым правилом). Дальше он либо
 *    разбирается ночью, либо попадает в «Бот спрашивает: как отвечать?», где
 *    владелец диктует ответ сам. Отдельного конвейера «на один случай» нет и
 *    заводить его незачем — этот и есть тот же самый;
 *  - delete — просто убрать, ничего не записывая.
 *
 * ПОЧЕМУ УДАЛЕНИЕ, А НЕ ОТМЕТКА. У LostConversation нет поля «разобрано»
 * (см. prisma/schema.prisma), а править схему в этой задаче нельзя. Отсюда две
 * честные оговорки, обе вынесены в интерфейс: вердикт остаётся только в журнале
 * действий, и если переписка моложе 21 дня (MAX_AGE_MS в lib/lostConversations.ts),
 * ночной разбор может взять её снова и заплатить за неё второй раз — уникальный
 * conversationId, которым он отсеивает уже разобранное, уходит вместе с записью.
 * Нужные поля: `reviewedAt DateTime?`, `reviewedById String?`, `verdict String?`.
 */
const resolveReviewSchema = z.object({ verdict: z.enum(["bot_right", "bot_error", "delete"]) });

/** Случай, заведённый владельцем вручную из оборванной переписки. Отдельный вид,
 *  а не "lost_client": тот означает «предложение из недельной сводки, включается
 *  вручную», и подмешивать в него ручные случаи значило бы врать обоим спискам. */
const MANUAL_LOST_KIND = "lost_manual";

botLearningRouter.post(
  "/lost/reviews/:id/resolve",
  requireAuth,
  requirePermission("settings.manage"),
  async (req, res) => {
    const parsed = resolveReviewSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });
    const { verdict } = parsed.data;

    const review = await prisma.lostConversation.findUnique({ where: { id: req.params.id } });
    if (!review) return res.status(404).json({ error: "Запись не найдена" });

    // Учиться не на чем, если одна из реплик пуста: пустая пара уедет в очередь
    // разбора и будет стоить денег, ничего не дав. Отказ виден в интерфейсе.
    const canLearn = Boolean(review.botMessage.trim() && review.clientMessage.trim());
    if (verdict === "bot_error" && !canLearn) {
      return res.status(400).json({ error: "В этой переписке нечего разбирать: одна из реплик пуста" });
    }

    // Одна транзакция: случай в очередь обучения и снятие записи со списка —
    // либо оба, либо ни одного. Иначе отказ на втором шаге оставил бы карточку
    // висеть, а случай — уже заведённым, и владелец нажал бы второй раз.
    await prisma.$transaction(async (tx) => {
      if (verdict === "bot_error") {
        await tx.botLesson.create({
          data: {
            kind: MANUAL_LOST_KIND,
            channel: review.channel,
            conversationId: review.conversationId,
            botMessage: review.botMessage,
            humanMessage: review.clientMessage,
          },
        });
      }
      await tx.lostConversation.delete({ where: { id: review.id } });
    });

    // В журнал — сам разбор: запись удалена, и без этого на вопрос «а что решили
    // по той переписке» ответить будет нечем.
    logAudit(req, "LOST_REVIEW_RESOLVE", "LostConversation", review.id, {
      verdict,
      reason: review.reason,
      stage: review.stage,
      finding: review.finding.slice(0, 300),
    });
    res.json({ ok: true, id: review.id, lessonCreated: verdict === "bot_error" });
  }
);

/**
 * «Разобрать сейчас» — кнопка на экране «Обучение бота» (19.08.2026, просьба
 * владельца: не ждать до двух часов, пока крон сам доберётся до очереди).
 *
 * Разбирает всю ТЕКУЩУЮ очередь сырых случаев (диалоги, где вместо бота ответил
 * сотрудник, или клиент не понял) — те же случаи, что копятся сами по себе в
 * реальном времени (см. lib/botLessons.ts, recordLesson). Кнопка не «читает всю
 * историю переписок заново» — учиться можно только на случаях, где уже виден
 * явный сигнал ошибки, а не на любом сообщении подряд.
 */
botLearningRouter.post("/distill-now", requireAuth, requirePermission("settings.manage"), async (_req, res) => {
  try {
    const result = await distillAllPending();
    res.json(result);
  } catch (err) {
    await logSystemError("ai", `Ручной разбор обучения бота не удался: ${describeError(err)}`);
    res.status(502).json({ error: "Разбор не удался, подробности в журнале ошибок" });
  }
});

/** Сколько записей одной группы повторов можно поправить одним нажатием.
 *  Та же страховка, что у любого группового действия в этом файле/репозитории
 *  (ср. POST /bot-audit/resolve-all): без предела один клик способен переписать
 *  всю таблицу разом. DUP_EXAMPLES_LIMIT ограничивает то, что видно на экране,
 *  а этот предел — то, что реально можно отправить одним запросом; он заведомо
 *  шире витрины (1 представитель + до DUP_EXAMPLES_LIMIT примеров = максимум
 *  DUP_EXAMPLES_LIMIT+1 id на клиенте), запас — на случай, если группа успела
 *  вырасти между загрузкой страницы и нажатием кнопки.
 */
const GROUP_UPDATE_MAX = 50;

const groupUpdateSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(GROUP_UPDATE_MAX),
    active: z.boolean().optional(),
    lesson: z.string().max(300).optional(),
  })
  .refine((v) => v.active !== undefined || v.lesson !== undefined, { message: "Нечего менять" });

/**
 * Правка ЦЕЛОЙ ГРУППЫ повторов одним нажатием (владелец 17.09.2026: «повторы
 * исключить полностью, чтобы я сто раз не отвечал на одинаковые сообщения»).
 * Та же логика PATCH /:id, но по списку id — ответ на вопрос или выключение
 * правила применяется сразу ко всем схлопнутым на экране карточкам, а не к
 * одной. Объявлена ДО `PATCH /:id`: иначе Express принял бы «group» за id.
 */
botLearningRouter.patch(
  "/group",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  async (req, res) => {
    const parsed = groupUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
    }
    const { ids, lesson: rawLesson, active: rawActive } = parsed.data;
    const lesson = rawLesson?.trim();
    const data: { active?: boolean; lesson?: string } = {};
    if (lesson !== undefined) {
      data.lesson = lesson || EMPTY_LESSON;
      data.active = lesson ? true : false;
    }
    if (rawActive !== undefined) data.active = rawActive;

    const result = await prisma.botLesson.updateMany({ where: { id: { in: ids } }, data });
    logAudit(req, "BOT_LESSON_UPDATE_GROUP", "BotLesson", ids[0], {
      count: result.count,
      ids,
      ...(lesson !== undefined ? { lessonEdited: true } : {}),
    });
    res.json({ ok: true, count: result.count });
  }
);

/**
 * «Поднять» — сделать правило снова самым свежим (владелец 17.09.2026, решение
 * по умолчанию: сортировка промта — по `createdAt desc`, поля «важность» в схеме
 * нет и заводить его в этой задаче нельзя, а обновить дату существующей записи
 * можно без миграции). Не трогает текст правила — только его место в очереди
 * свежести, то есть шанс попасть в PROMPT_LESSON_LIMIT самых новых.
 */
botLearningRouter.post(
  "/:id/bump",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  async (req, res) => {
    try {
      const updated = await prisma.botLesson.update({
        where: { id: req.params.id },
        data: { createdAt: new Date() },
        select: LESSON_FIELDS,
      });
      logAudit(req, "BOT_LESSON_BUMP", "BotLesson", updated.id, { lesson: updated.lesson?.slice(0, 300) ?? null });
      res.json(updated);
    } catch {
      res.status(404).json({ error: "Запись не найдена" });
    }
  }
);

const updateSchema = z
  .object({
    /** Участвует ли правило в промте бота. */
    active: z.boolean().optional(),
    /**
     * Ответ владельца «как надо было отвечать». Он идёт прямо в промт, поэтому
     * длина ограничена так же, как у правил ночного разбора: длинные подсказки
     * вытесняют инструкции и рассеивают внимание модели.
     * Пустая строка — убрать правило и вернуть случай в вопросы.
     */
    lesson: z.string().max(300).optional(),
  })
  .refine((v) => v.active !== undefined || v.lesson !== undefined, {
    message: "Нечего менять",
  });

/**
 * Правка одного правила: выключить неудачное или вписать свой ответ.
 *
 * Право и повторное подтверждение личности — те же, что у Настроек: текст отсюда
 * попадает в промт бота, то есть меняет то, что бот говорит клиентам.
 */
botLearningRouter.patch(
  "/:id",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
    }
    const lesson = parsed.data.lesson?.trim();
    const data: { active?: boolean; lesson?: string } = {};
    if (lesson !== undefined) {
      data.lesson = lesson || EMPTY_LESSON;
      // Свой ответ владельца включаем сразу — он для того и написан. Очистка,
      // наоборот, обязана выключить правило, иначе прочерк уедет в промт.
      data.active = lesson ? true : false;
    }
    if (parsed.data.active !== undefined) data.active = parsed.data.active;

    try {
      const updated = await prisma.botLesson.update({
        where: { id: req.params.id },
        data,
        select: LESSON_FIELDS,
      });
      logAudit(req, "BOT_LESSON_UPDATE", "BotLesson", updated.id, {
        active: updated.active,
        ...(lesson !== undefined ? { lessonEdited: true } : {}),
      });
      res.json(updated);
    } catch {
      res.status(404).json({ error: "Запись не найдена" });
    }
  }
);

/**
 * Убрать правило совсем.
 *
 * Выключения мало: выключенное правило остаётся в списке навсегда, и через месяц
 * владелец разбирает не десяток действующих подсказок, а сотню строк, половина из
 * которых зачёркнута. Удаление необратимо (первоисточник — что сказал бот и что
 * ответил человек — исчезает вместе с записью), поэтому подтверждение спрашивает
 * интерфейс, а право и повторное подтверждение личности здесь те же, что у правки.
 */
botLearningRouter.delete(
  "/:id",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  async (req, res) => {
    try {
      const removed = await prisma.botLesson.delete({
        where: { id: req.params.id },
        select: { id: true, kind: true, lesson: true },
      });
      // В журнал — сам текст правила: восстановить запись уже нельзя, и без него
      // потом не ответить на вопрос «а что там было и кто это убрал».
      logAudit(req, "BOT_LESSON_DELETE", "BotLesson", removed.id, {
        kind: removed.kind,
        lesson: removed.lesson?.slice(0, 300) ?? null,
      });
      res.json({ ok: true, id: removed.id });
    } catch {
      res.status(404).json({ error: "Запись не найдена" });
    }
  }
);
