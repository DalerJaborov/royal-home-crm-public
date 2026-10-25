import { visibleInteractionWhere } from "../lib/investigationPrivacy.js";
import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client.js";
import { pageQuerySchema } from "@royal-home/shared";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { clientNamePhoneSafe, clientPhoneFor, maskPhonesDeep, phoneSafeText } from "../lib/clientPhone.js";
import { dushanbeDayRange } from "../lib/dushanbeTime.js";
import { listEndpoints, loadAriCredentials } from "../lib/telephony/ariClient.js";
import { liveIncomingCalls, rejectedInboundStats } from "../lib/telephony/incomingCalls.js";
import { incomingInteractionIds } from "../lib/telephony/incomingInteractions.js";
import { AWAITING_REVIEW_WHERE } from "../lib/telephony/awaitingReview.js";
import { ownIncomingCallsOr } from "../lib/telephony/ownIncomingCalls.js";
import { liveOutgoingCalls } from "../lib/telephony/callTracker.js";
import { incomingOperatorIds, loadIncomingSettings } from "../lib/telephony/incomingSettings.js";
import { elapsedWorkingMinutes, findCallbackContacts } from "../lib/telephony/missedCallEscalation.js";
import { loadDisciplineRules } from "../lib/disciplineRules.js";

/** Кто «принял» входящий, на который ответил консультант на телефоне (ИИ). */
const CONSULTANT_ANSWERED_NAME = "консультант (ИИ)";

/**
 * Раздел «Звонки» — разговоры агентства одним списком.
 *
 * Раньше о работе агента можно было судить по счётчикам: сколько звонков, сколько
 * показов. Что происходило внутри разговора, не знал никто. Здесь руководитель
 * слушает записи, читает расшифровки и видит разбор: выяснил ли агент потребность,
 * ответил ли на возражение, договорился ли о следующем шаге.
 *
 * КТО СЮДА ЗАХОДИТ. Администрация — за всеми разговорами (calls.transcripts). Агент —
 * за своими (calls.ownTranscripts, владелец 15.08.2026: «его звонки он сам может и
 * видеть, и посмотреть расшифровку, или прослушать»). Всё, что показывает работу
 * ДРУГИХ людей — сводка, ночной разбор, журнал входящих и дашборд станции, — остаётся
 * администрации: список ниже сам сужается до автора, а эти маршруты сузить нечем.
 */
export const callsRouter = Router();

callsRouter.use(requireAuth, requirePermission("calls.transcripts", "calls.ownTranscripts"));

/** Маршруты «про всю команду» — только администрации. */
const supervisorOnly = requirePermission("calls.transcripts");

const PAGE_SIZE = 25;

/**
 * Список разговоров с фильтрами.
 *
 * Фильтры подобраны под вопросы, которые руководитель задаёт на самом деле:
 * «как работает конкретный агент», «что было за неделю», «где разговор не кончился
 * договорённостью», «какие разговоры прошли плохо».
 */
/**
 * Фильтры списка звонков проверяются на границе (ночная проверка 24.09.2026, №155):
 * раньше `?agentId=мусор` и `?from=вчера` молча давали пустой или неотфильтрованный
 * список вместо честного отказа.
 */
const callListFiltersSchema = z.object({
  agentId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  problems: z.enum(["0", "1"]).optional(),
});

callsRouter.get("/", async (req, res) => {
  const parsedPage = pageQuerySchema.safeParse(req.query);
  if (!parsedPage.success) {
    return res.status(400).json({ error: "Неверный номер страницы", details: parsedPage.error.flatten() });
  }
  const { page } = parsedPage.data;
  const parsedFilters = callListFiltersSchema.safeParse(req.query);
  if (!parsedFilters.success) {
    return res.status(400).json({ error: "Неверный фильтр списка звонков", details: parsedFilters.error.flatten() });
  }
  const { from, to } = parsedFilters.data;
  /** «Только проблемные»: без договорённости о следующем шаге либо со счётом ниже 50. */
  const problemsOnly = parsedFilters.data.problems === "1";
  /**
   * ЧЕЙ СПИСОК. Без права на чужие разговоры выборка сужается до собственных — и
   * сужается ЗДЕСЬ, а не фильтром в интерфейсе: `?agentId=<чужой>` руками уходит тем
   * же запросом. Тот же приём, что в ленте активности (routes/interactions.ts).
   */
  const seesEveryone = req.agent!.can("calls.transcripts");
  /**
   * Право на РАЗГОВОР и право на НОМЕР — разные (владелец 30.08.2026). Ниже в этом
   * же файле номер входящего честно маскируется (`clientPhoneFor`), а расшифровка
   * того же разговора уходила открытой — клиенту достаточно продиктовать номер
   * голосом, чтобы правило `clients.viewPhone` перестало работать.
   */
  const canSeePhone = req.agent!.can("clients.viewPhone");
  /**
   * ПРОСЛУШИВАНИЕ — ОТДЕЛЬНОЕ ПРАВО ОТ ЧТЕНИЯ (владелец 04.09.2026, см.
   * lib/callTranscripts.ts). Раздел «Звонки» открыт правом на РАЗГОВОР
   * (calls.transcripts/calls.ownTranscripts — это то, что сужает `where` выше и
   * решает `seesEveryone`), но звук теперь закрыт ДОПОЛНИТЕЛЬНО отдельным правом
   * calls.hearRecording — оно НЕ зависит от того, чей это звонок: если его нет,
   * агент не слышит даже собственный разговор, хотя текст ему по-прежнему открыт.
   */
  const canHear = req.agent!.can("calls.hearRecording");
  const requestedAgentId = parsedFilters.data.agentId;
  const agentId = seesEveryone ? requestedAgentId : req.agent!.id;

  const where: Prisma.InteractionWhereInput = {
    ...visibleInteractionWhere(req.agent?.role),
    type: "CALL",
    // В разделе — то, где есть что смотреть (запись/расшифровка), И недозвоны
    // через CRM (callAttempt заполнен станцией: NO_ANSWER/AGENT_NO_PICKUP/
    // CANCELLED — см. schema.prisma). Раньше сюда попадали только состоявшиеся
    // разговоры: агент звонил, клиент не брал трубку — а звонок исчезал из
    // журнала целиком (18.09.2026, жалоба владельца — «когда звонил, а там не
    // ответили»). Ручные отметки «созвонился» без записи и без callAttempt
    // (созданы руками до 27.08.2026 или не через станцию) по-прежнему не
    // попадают — смотреть/знать о них нечего.
    OR: [{ recordingUrl: { not: null } }, { transcript: { not: null } }, { callAttempt: { not: null } }],
  };
  if (agentId) where.agentId = agentId;
  if (from && !Number.isNaN(from.getTime())) where.createdAt = { gte: from };
  if (to && !Number.isNaN(to.getTime())) {
    where.createdAt = { ...(where.createdAt as object), lte: to };
  }
  if (problemsOnly) {
    where.callAnalysis = { OR: [{ agreedNextStep: false }, { score: { lt: 50 } }] };
  }

  const [items, total] = await Promise.all([
    prisma.interaction.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        createdAt: true,
        notes: true,
        recordingUrl: true,
        recordingDurationSec: true,
        transcript: true,
        transcriptRu: true,
        // Чем кончился дозвон (TALKED/NO_ANSWER/AGENT_NO_PICKUP/CANCELLED/null) —
        // отдаём наружу, чтобы интерфейс показал недозвон недозвоном, а не пустой
        // строкой с «0:00» (см. комментарий у поля в schema.prisma).
        callAttempt: true,
        // Живой статус конвейера — см. lib/telephony/callRecordings.ts, setStage.
        transcriptionStage: true,
        transcriptionProgress: true,
        agent: { select: { id: true, fullName: true, avatarUrl: true } },
        client: { select: { id: true, shortId: true, fullName: true } },
        callAnalysis: true,
      },
    }),
    prisma.interaction.count({ where }),
  ]);

  // Вырезать содержимое построчно здесь не нужно и было бы обманом: выборка выше уже
  // сужена до тех разговоров, которые этому сотруднику слушать можно (свои или все).
  res.json({
    /** Список сужен до собственных разговоров — интерфейс подписывает его иначе. */
    ownOnly: !seesEveryone,
    items: items.map((i) => ({
      id: i.id,
      createdAt: i.createdAt,
      notes: phoneSafeText(i.notes, canSeePhone),
      // Наружу отдаём факт наличия записи, а не путь на станции: путь ничего не даёт
      // браузеру (АТС во внутренней сети), слушают через /interactions/:id/recording.
      hasRecording: !!i.recordingUrl,
      // Может ли ИМЕННО ЭТОТ смотрящий послушать звук (04.09.2026) — интерфейс
      // прячет плеер по этому флагу, а не по одному hasRecording (см. коммент к
      // canHear выше).
      canHear,
      durationSec: i.recordingDurationSec,
      callAttempt: i.callAttempt,
      // Оригинал и перевод отдаются оба: разговор ведётся по-таджикски, читать
      // удобнее по-русски, а спорные места разбираются по тому, что человек сказал.
      transcript: phoneSafeText(i.transcript, canSeePhone),
      transcriptRu: phoneSafeText(i.transcriptRu, canSeePhone),
      transcriptionStage: i.transcriptionStage,
      transcriptionProgress: i.transcriptionProgress,
      agent: i.agent,
      // Имя карточки незнакомого звонившего CRM составляет из номера — то же
      // правило, что в presentClient (routes/clients/shared.ts).
      client: i.client ? { ...i.client, fullName: clientNamePhoneSafe(i.client.fullName, canSeePhone) } : i.client,
      analysis: maskPhonesDeep(i.callAnalysis, canSeePhone),
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
  });
});

/**
 * ОДНА ЛЕНТА ЗВОНКОВ — исходящие, входящие и пропущенные вперемешку, по времени.
 *
 * ЗАЧЕМ (владелец 20.08.2026, дословно): «сегменты звонков не надо добавлять,
 * можно один общий список, где видно время звонка, дата полная… общий список
 * звонков, где видно пропущенные, исходящие и так далее».
 *
 * До этого у агента в разделе были ТОЛЬКО его исходящие разговоры: входящие лежали
 * в другом списке под правом администрации — наследство роли оператора, которую
 * отменили 18.08.2026. С тех пор входящие идут прямо агентам, и «мне звонили, а я
 * не увидел» перестало быть проблемой оператора и стало проблемой агента.
 *
 * ПАГИНАЦИЯ КУРСОРОМ, А НЕ СТРАНИЦАМИ. Список склеен из двух таблиц, и обычный
 * `skip` по каждой из них даёт кашу: пропуск двадцати строк в одной таблице не
 * соответствует никакому месту в общей ленте. Курсор — момент времени: «дай, что
 * старше этого». Он же корректно ведёт себя, когда во время листания приходит
 * новый звонок (страницы не съезжают).
 *
 * ЧТО ВИДНО. С правом на чужие разговоры — всё агентство. Без него: свои
 * исходящие плюс входящие, которые касаются лично тебя, — снял трубку сам, тебе
 * назначено перезвонить или звонил твой клиент. Сужение живёт ЗДЕСЬ, а не
 * фильтром в интерфейсе: параметром запроса чужое всё равно не выпросить.
 */
const FEED_LIMIT_DEFAULT = 30;
const FEED_LIMIT_MAX = 50;

/**
 * КУРСОР ЛЕНТЫ — СОСТАВНОЙ (находка Codex №16, 04.10.2026).
 *
 * Один момент времени курсором не годился: если у нескольких строк одинаковое
 * время до миллисекунды и граница страницы проходит между ними, остальные не
 * влезали в `limit` и отсекались строгим `< nextBefore` на следующей странице,
 * то есть пропадали из показа (в базе они целы). Теперь курсор `время|таблица|id`
 * однозначно делит общий порядок склейки: время по убыванию, при равенстве
 * исходящие (Interaction, `OUT`) раньше входящих (IncomingCall, `IN`), внутри
 * таблицы по id по убыванию, как в её `orderBy`.
 *
 * Старый формат (одно время ISO) по-прежнему принимается и работает как раньше,
 * строго «старше этого»: так живут открытые вкладки и кэш клиента. Клиент курсор
 * не разбирает, он отдаёт `nextBefore` обратно в `before` как есть.
 */
const feedCursorSchema = z.union([
  z.string().datetime().transform((t) => ({ at: new Date(t), table: null, id: null })),
  z
    .string()
    .regex(/^[^|]+\|(OUT|IN)\|[0-9a-fA-F-]{8,64}$/)
    .transform((raw) => {
      const [t, table, id] = raw.split("|") as [string, "OUT" | "IN", string];
      return { at: new Date(t), table, id };
    })
    .refine((c) => !Number.isNaN(c.at.getTime())),
]);
type FeedCursor = z.infer<typeof feedCursorSchema>;

/**
 * Условие «строго после курсора в общем порядке» для одной таблицы.
 * Та же таблица: время старше ИЛИ то же время с меньшим id (порядок `id desc`).
 * Другая таблица: при том же времени исходящие показаны раньше входящих, поэтому
 * у входящих «то же время» ещё впереди (lte), а у исходящих уже позади (lt).
 * Старый формат без таблицы: строго старше (lt).
 */
function cursorWhere(c: FeedCursor, own: "OUT" | "IN", field: "createdAt" | "startedAt") {
  if (!c.table) return { [field]: { lt: c.at } };
  if (c.table === own) return { OR: [{ [field]: { lt: c.at } }, { [field]: c.at, id: { lt: c.id! } }] };
  return own === "IN" ? { [field]: { lte: c.at } } : { [field]: { lt: c.at } };
}

/** Исходящие (Interaction) в общем порядке стоят раньше входящих (IncomingCall). */
const tableRank = (kind: "OUT" | "IN" | "MISSED") => (kind === "OUT" ? 1 : 0);
const feedCursorOf = (row: { at: Date; id: string; kind: "OUT" | "IN" | "MISSED" }) =>
  `${row.at.toISOString()}|${row.kind === "OUT" ? "OUT" : "IN"}|${row.id}`;

callsRouter.get("/feed", async (req, res) => {
  // Math.trunc обязателен: ?limit=2.5 проходил Number.isFinite, уезжал в Prisma
  // take дробным и ронял роут 500-кой вместо честной подстановки предела.
  const rawLimit = Math.trunc(Number(req.query.limit));
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : FEED_LIMIT_DEFAULT, 1), FEED_LIMIT_MAX);
  let before: FeedCursor | null = null;
  if (req.query.before !== undefined && req.query.before !== "") {
    const parsedBefore = feedCursorSchema.safeParse(req.query.before);
    if (!parsedBefore.success) return res.status(400).json({ error: "Неверный курсор ленты звонков" });
    before = parsedBefore.data;
  }

  const me = req.agent!;
  const seesEveryone = me.can("calls.transcripts");
  const canSeePhone = me.can("clients.viewPhone");
  // Тот же смысл, что в GET / выше: слушать закрыто отдельным правом (04.09.2026),
  // не зависящим от того, чей это звонок.
  const canHear = me.can("calls.hearRecording");

  // Внутренний номер нужен, чтобы узнать свои отвеченные входящие: станция пишет
  // в звонок номер, а не сотрудника (см. answeredBy в schema.prisma).
  const myExtension = seesEveryone
    ? null
    : (await prisma.agent.findUnique({ where: { id: me.id }, select: { sipExtension: true } }))?.sipExtension ?? null;

  const outWhere: Prisma.InteractionWhereInput = {
    type: "CALL",
    // Как и в списке выше: то, где есть что смотреть, плюс недозвоны через CRM
    // (callAttempt) — иначе агент звонил, клиент не ответил, а лента молчала,
    // будто звонка не было вовсе (18.09.2026).
    OR: [{ recordingUrl: { not: null } }, { transcript: { not: null } }, { callAttempt: { not: null } }],
    ...(seesEveryone ? {} : { agentId: me.id }),
    ...(before ? { AND: [cursorWhere(before, "OUT", "createdAt")] } : {}),
  };

  // Условие «касается лично меня» живёт в lib/telephony/ownIncomingCalls.ts: его же
  // читает значок «Мои звонки» на дашборде, и второй копии тут быть не должно —
  // именно из-за копии значок и список показывали разные вещи.
  const mine = ownIncomingCallsOr(me.id, myExtension);
  const inWhere: Prisma.IncomingCallWhereInput = {
    ...(seesEveryone ? {} : { OR: mine }),
    ...(before ? { AND: [cursorWhere(before, "IN", "startedAt")] } : {}),
  };

  // По limit+1 из каждой таблицы: чтобы после склейки честно ответить, есть ли
  // продолжение, не делая отдельного count по двум источникам сразу.
  const [outgoing, incoming] = await Promise.all([
    prisma.interaction.findMany({
      where: outWhere,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        createdAt: true,
        recordingUrl: true,
        recordingDurationSec: true,
        transcript: true,
        transcriptRu: true,
        callAttempt: true,
        transcriptionStage: true,
        transcriptionProgress: true,
        agent: { select: { id: true, fullName: true } },
        client: { select: { id: true, shortId: true, fullName: true } },
        callAnalysis: true,
      },
    }),
    prisma.incomingCall.findMany({
      where: inWhere,
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        phone: true,
        startedAt: true,
        answered: true,
        talkSeconds: true,
        answeredBy: true,
        answeredByConsultant: true,
        client: { select: { id: true, shortId: true, fullName: true } },
        callbackAgent: { select: { id: true, fullName: true } },
      },
    }),
  ]);

  // Имя вместо внутреннего номера — одним запросом на страницу, не по строке (N+1).
  const extensions = [...new Set(incoming.map((c) => c.answeredBy).filter((e): e is string => !!e))];
  const operators = extensions.length
    ? await prisma.agent.findMany({
        where: { sipExtension: { in: extensions } },
        select: { sipExtension: true, fullName: true },
      })
    : [];
  const nameByExtension = new Map(operators.map((a) => [a.sipExtension!, a.fullName]));

  /**
   * У исходящего отдаём и содержимое разговора — запись, расшифровку, разбор.
   * Без них строка ленты умела бы только вести на карточку клиента, а слушать
   * свой разговор прямо из журнала агент мог с 15.08.2026; терять это ради
   * объединения списков нельзя. Выборка уже сужена до тех разговоров, которые
   * смотрящему открыты (свои или все) — вырезать построчно нечего.
   */
  const rows = [
    ...outgoing.map((i) => ({
      kind: "OUT" as const,
      id: i.id,
      at: i.createdAt,
      // Имя карточки — по тому же праву (22.09.2026): у заведённых до 20.08.2026
      // номер лежит В ИМЕНИ, и лента отдавала его рядом с закрытыми расшифровкой
      // и номером. В соседнем GET /calls это место сделано верно с самого начала.
      client: i.client ? { ...i.client, fullName: clientNamePhoneSafe(i.client.fullName, canSeePhone) } : i.client,
      // Телефона у исходящего в списке нет намеренно: он и так живёт на карточке
      // клиента, а звонок из строки идёт по clientId — как и раньше.
      phone: null as string | null,
      durationSec: i.recordingDurationSec,
      callAttempt: i.callAttempt,
      agentName: i.agent?.fullName ?? null,
      hasRecording: !!i.recordingUrl,
      canHear,
      score: i.callAnalysis?.score ?? null,
      // Расшифровка и разбор — по праву на разговор, а НОМЕРА в них — по
      // clients.viewPhone: строкой выше `phone` уже закрыт маской, и открытая
      // расшифровка того же звонка сводила бы это на нет.
      transcript: phoneSafeText(i.transcript, canSeePhone),
      transcriptRu: phoneSafeText(i.transcriptRu, canSeePhone),
      transcriptionStage: i.transcriptionStage,
      transcriptionProgress: i.transcriptionProgress,
      analysis: maskPhonesDeep(i.callAnalysis, canSeePhone),
    })),
    ...incoming.map((c) => ({
      kind: (c.answered ? "IN" : "MISSED") as "IN" | "MISSED",
      id: c.id,
      at: c.startedAt,
      client: c.client ? { ...c.client, fullName: clientNamePhoneSafe(c.client.fullName, canSeePhone) } : c.client,
      // Номер закрывается тем же правилом, что и везде (см. lib/clientPhone.ts):
      // раздел открыт правом на разговоры, а видеть номера — право отдельное.
      phone: clientPhoneFor(c.phone, canSeePhone) as string | null,
      durationSec: c.talkSeconds,
      // У входящего callAttempt не бывает — это поле станции для звонков через
      // CRM (см. outgoing выше). null здесь, а не отсутствие поля: строки ленты
      // должны быть одной формы.
      callAttempt: null as string | null,
      agentName: c.answeredByConsultant
        ? CONSULTANT_ANSWERED_NAME
        : c.answeredBy
          ? (nameByExtension.get(c.answeredBy) ?? null)
          : (c.callbackAgent?.fullName ?? null),
      hasRecording: false,
      canHear,
      score: null as number | null,
      // У входящего своей записи в CRM нет: её ведёт станция и связывает уже с
      // хронологией клиента, а не со строкой журнала.
      transcript: null as string | null,
      transcriptRu: null as string | null,
      transcriptionStage: null as string | null,
      transcriptionProgress: null as number | null,
      analysis: null,
    })),
    // Сортировка устойчивая: внутри таблицы остаётся порядок БД (время, id по
    // убыванию), при равном времени исходящие идут раньше входящих, как и
    // предполагает составной курсор.
  ].sort((a, b) => b.at.getTime() - a.at.getTime() || tableRank(b.kind) - tableRank(a.kind));

  const page = rows.slice(0, limit);
  const hasMore = rows.length > page.length;

  res.json({
    items: page,
    /** Курсор следующей страницы — `время|таблица|id` последней отданной строки. */
    nextBefore: hasMore && page.length > 0 ? feedCursorOf(page[page.length - 1]) : null,
    ownOnly: !seesEveryone,
  });
});

/**
 * Входящие звонки — те, что клиенты сделали сами (журнал ведёт
 * lib/telephony/incomingCalls.ts).
 *
 * Отдельный список, а не общий с разговорами агентов: у входящего нет ни автора,
 * ни разбора — трубку берёт оператор, которого в CRM нет вовсе. Смотреть сюда
 * стоит ради одного вопроса: сколько обращений агентство не приняло и перезвонили
 * ли по ним. Поэтому пропущенные фильтруются одним переключателем, а у каждого
 * видно, поставлена ли задача и кому.
 */
callsRouter.get("/incoming", supervisorOnly, async (req, res) => {
  const parsedPage = pageQuerySchema.safeParse(req.query);
  if (!parsedPage.success) {
    return res.status(400).json({ error: "Неверный номер страницы", details: parsedPage.error.flatten() });
  }
  const { page } = parsedPage.data;
  const missedOnly = req.query.missed === "1";
  const unqualifiedOnly = req.query.unqualified === "1";
  // «Без перезвона» (Пачка 18, 12.09.2026): пропущенные, по которым до сих пор нет
  // исходящего контакта — см. findCallbackContacts в lib/telephony/missedCallEscalation.ts.
  // Подразумевает missed (не по делу звонки сюда не попадают, так же как в бейдже).
  const noCallbackOnly = req.query.noCallback === "1";
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  /**
   * ЗВОНОК, КОТОРЫЙ ЖДЁТ РАЗБОРА, — состоявшийся разговор с карточкой, у которого
   * оператор так и не указал тип обращения.
   *
   * Окно оператора живёт полторы минуты после того, как положили трубку, и на этом
   * его срок кончается: следующий звонок, отвлёкший разговор, срочное дело — и
   * услышанное остаётся в голове у оператора навсегда. Отсюда этот фильтр: разобрать
   * звонок задним числом должно быть можно, а найти неразобранные — легко.
   *
   * Пропущенные сюда не попадают намеренно: разговора не было, разбирать нечего.
   * Звонки без карточки — тоже: их не с чем связать (автосоздание было выключено).
   * ИСКЛЮЧЕНИЕ — сообщение на автоответчике (18.08.2026): трубку не взяли, но
   * человек рассказал, чего хочет, и если ИИ его не понял, разобрать обязан
   * человек. Само условие живёт в lib/telephony/awaitingReview.ts — его читают
   * ещё плитка телефонии и дашборд, и три разных числа у одной и той же вещи
   * были бы хуже любого лишнего модуля.
   */
  const unqualifiedWhere: Prisma.IncomingCallWhereInput = {
    startedAt: { gte: since },
    ...AWAITING_REVIEW_WHERE,
  };

  const where: Prisma.IncomingCallWhereInput = { startedAt: { gte: since } };
  if (missedOnly) where.answered = false;
  /**
   * Фильтр по оператору — по ВНУТРЕННЕМУ НОМЕРУ, а не по id сотрудника: `answeredBy`
   * хранит именно номер (в момент звонка CRM не знает, кто снял трубку). Интерфейс
   * отдаёт сюда номер, который взял из карточки сотрудника, — сопоставление живёт
   * в одном месте, а не в двух.
   */
  const operatorExtension = typeof req.query.operator === "string" ? req.query.operator.trim() : "";
  if (operatorExtension) where.answeredBy = operatorExtension;
  // Через AND, а не Object.assign: тот перетирал `answered: false` полем
  // `answered: true` из условия неразобранных, и пара включённых фильтров молча
  // отдавала прямо противоположное — отвеченные звонки вместо пропущенных.
  if (unqualifiedOnly) where.AND = [unqualifiedWhere];

  /**
   * «БЕЗ ПЕРЕЗВОНА» — ДОЧИТЫВАЕМ ID ДО ОСНОВНОГО ЗАПРОСА (Пачка 18, 12.09.2026).
   *
   * Признак «есть ли исходящий контакт после звонка» не выражается фильтром Prisma
   * (нужно сравнение Interaction.createdAt с СОБСТВЕННЫМ startedAt каждого звонка) —
   * поэтому сперва выбираем id пропущенных без перезвона в пределах `since` (потолок
   * 1000 — тот же порядок, что и в countMissedCallsNoCallbackYesterday), а дальше
   * фильтруем обычный where по этому списку, чтобы skip/take и count остались честными.
   */
  if (noCallbackOnly) {
    const candidates = await prisma.incomingCall.findMany({
      where: { startedAt: { gte: since }, answered: false, irrelevant: false },
      select: { id: true, clientId: true, startedAt: true },
      take: 1000,
    });
    const calledBack = await findCallbackContacts(
      candidates.flatMap((c) => (c.clientId ? [{ id: c.id, clientId: c.clientId, since: c.startedAt }] : [])),
    );
    where.id = { in: candidates.filter((c) => !calledBack.has(c.id)).map((c) => c.id) };
  }

  const [items, total, missed, unqualified, periodTotal] = await Promise.all([
    prisma.incomingCall.findMany({
      where,
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        phone: true,
        startedAt: true,
        endedAt: true,
        answered: true,
        talkSeconds: true,
        answeredBy: true,
        answeredByConsultant: true,
        qualifiedAt: true,
        irrelevant: true,
        autoCreatedClient: true,
        /**
         * Чем кончилась автоматика (18.08.2026). Нужно ровно там, где человек
         * смотрит «Без разбора»: без этого поля неразобранный звонок с ИИ, который
         * не понял разговор, ничем не отличается от звонка, до которого разбор ещё
         * просто не дошёл, — а действия у них разные. Пусто — автоматика к звонку
         * не подходила (звонок старше возможности либо разговор ещё обрабатывается).
         * См. AutoLeadStatus в lib/telephony/autoLeadFromCall.ts.
         */
        autoLeadStatus: true,
        // Тип обращения и ответственный — чтобы по строке было видно, чем разбор
        // кончился, и не открывать карточку ради одного слова.
        client: { select: { id: true, shortId: true, fullName: true, kind: true } },
        callbackAgent: { select: { id: true, fullName: true } },
        qualifiedBy: { select: { id: true, fullName: true } },
      },
    }),
    prisma.incomingCall.count({ where }),
    prisma.incomingCall.count({ where: { startedAt: { gte: since }, answered: false } }),
    prisma.incomingCall.count({ where: unqualifiedWhere }),
    // Всего за период, БЕЗ фильтров. Раньше в шапке показывалось отфильтрованное
    // число рядом с общими счётчиками потерь: включив «только пропущенные», человек
    // видел «7 · пропущено 7» и делал вывод, что других звонков не было вовсе.
    prisma.incomingCall.count({ where: { startedAt: { gte: since } } }),
  ]);

  /**
   * ТЕЛЕФОН ЗАКРЫВАЕТСЯ ТЕМ ЖЕ ПРАВИЛОМ, ЧТО И ВЕЗДЕ. Раздел закрыт правом
   * calls.transcripts, но право видеть номера — отдельное (clients.viewPhone), и
   * директор вполне может дать одно, не давая другого. Без этой строки такой
   * сотрудник получал бы полные номера всех звонивших за полгода постранично —
   * ровно тот обход, о котором предупреждает шапка lib/clientPhone.ts: правило,
   * записанное в одном маршруте, правилом не является.
   */
  const canSeePhone = req.agent!.can("clients.viewPhone");

  /**
   * ИМЯ ВМЕСТО ВНУТРЕННЕГО НОМЕРА. `answeredBy` — строка с номером на станции
   * («1001»), потому что оператора CRM в момент звонка не знает. В журнале это
   * читалось как «оператор 1001»: чтобы понять, кто это, приходилось идти в
   * Настройки → Сотрудники и сверять номера глазами.
   *
   * Одним запросом на страницу, а не по строке на звонок: внутренних номеров на
   * страницу единицы, и запрос на каждую строку был бы тем самым N+1.
   */
  const extensions = [...new Set(items.map((c) => c.answeredBy).filter((e): e is string => !!e))];
  const operators = extensions.length
    ? await prisma.agent.findMany({
        where: { sipExtension: { in: extensions } },
        select: { sipExtension: true, fullName: true },
      })
    : [];
  const nameByExtension = new Map(operators.map((a) => [a.sipExtension!, a.fullName]));

  /**
   * БЕЙДЖ «БЕЗ ПЕРЕЗВОНА» (Пачка 18, 12.09.2026) — считаем на бэке, а не зашиваем
   * число часов в разметку: фронт получает готовый признак и порог, а не гадает,
   * что означают «2 часа». Только на странице (≤PAGE_SIZE строк) — не N+1 на весь
   * журнал за полгода.
   */
  const [{ workHoursStart, workHoursEnd }, rules] = await Promise.all([
    prisma.settings
      .findUnique({ where: { id: "singleton" }, select: { workHoursStart: true, workHoursEnd: true } })
      .then((s) => ({ workHoursStart: s?.workHoursStart ?? "09:30", workHoursEnd: s?.workHoursEnd ?? "18:00" })),
    loadDisciplineRules(),
  ]);
  const now = new Date();
  const overdue = items.filter(
    (call) =>
      !call.answered &&
      !call.irrelevant &&
      elapsedWorkingMinutes(call.startedAt, now, workHoursStart, workHoursEnd) >=
        rules.missedCallbackHours * 60,
  );
  const calledBackIds = await findCallbackContacts(
    overdue.flatMap((c) => (c.client?.id ? [{ id: c.id, clientId: c.client.id, since: c.startedAt }] : [])),
  );
  const missingCallbackById = new Map<string, boolean>();
  for (const call of overdue) {
    if (!calledBackIds.has(call.id)) missingCallbackById.set(call.id, true);
  }

  const safeItems = items.map((call) => ({
    ...call,
    phone: clientPhoneFor(call.phone, canSeePhone),
    // Имя карточки закрывается тем же правом, что и номер (22.09.2026): раздел
    // открыт правом calls.transcripts, которое есть у маркетинга и службы
    // безопасности, а clients.viewPhone у них нет — и «Входящий +992910001003»
    // проезжал мимо закрытого рядом `phone`.
    client: call.client ? { ...call.client, fullName: clientNamePhoneSafe(call.client.fullName, canSeePhone) } : call.client,
    // null — номер есть, а сотрудника с таким внутренним в CRM нет (номер выдали
    // на станции и забыли внести). Интерфейс в этом случае покажет сам номер.
    // Консультант на телефоне (ИИ, 24.09.2026) — «принял консультант (ИИ)», а не
    // пустое место: иначе такой звонок в журнале читался бы как «принял неизвестно кто».
    answeredByName: call.answeredByConsultant
      ? CONSULTANT_ANSWERED_NAME
      : call.answeredBy
        ? (nameByExtension.get(call.answeredBy) ?? null)
        : null,
    // Бейдж «без перезвона» — см. блок выше. missedCallbackHours рядом, чтобы фронт
    // мог подписать бейдж числом, не зная порога заранее.
    missingCallback: missingCallbackById.get(call.id) ?? false,
    missedCallbackHours: rules.missedCallbackHours,
  }));

  // Счётчики считаются НЕЗАВИСИМО от фильтра: включённый «только неразобранные» не
  // должен обнулять число пропущенных — иначе переключатель врёт про положение дел.
  res.json({ items: safeItems, total, periodTotal, missed, unqualified, page, pageSize: PAGE_SIZE, days });
});

/**
 * Последний ночной разбор: что получается, где теряем, что спрашивает рынок и что
 * с этим делать. Считается раз в сутки моделью (ai/callInsights.ts) — при открытии
 * страницы отдаётся готовым, чтобы просмотр раздела ничего не стоил.
 */
callsRouter.get("/insights", supervisorOnly, async (_req, res) => {
  const latest = await prisma.callInsight.findFirst({ orderBy: { createdAt: "desc" } });
  res.json(latest ?? null);
});

/**
 * Сводка по разговорам за период: как говорит команда и что мешает продавать.
 *
 * Считается запросами к базе, а не моделью: цифры должны сходиться с тем, что видно
 * в списке, и не стоить денег при каждом открытии страницы. Осмысленный разбор этих
 * цифр (ночная сводка «сильные и слабые стороны») — отдельная работа.
 */
callsRouter.get("/summary", supervisorOnly, async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const analyses = await prisma.callAnalysis.findMany({
    where: { createdAt: { gte: since } },
    // Предел выборки — единственный маршрут раздела, где его не было (у списка и
    // входящих он есть). Раздел живёт ровно тем, что ночной разбор пишет запись на
    // каждый звонок, поэтому со временем сюда попадал бы весь период целиком при
    // каждом открытии страницы. Сортировка по свежести ПЕРЕД усечением: если
    // разговоров окажется больше потолка, средние считаются по самым недавним, а не
    // по случайной выдаче базы.
    orderBy: { createdAt: "desc" },
    take: 5000,
    select: {
      interactionId: true,
      agentId: true,
      score: true,
      greeted: true,
      foundNeed: true,
      presentedValue: true,
      handledObjection: true,
      agreedNextStep: true,
      objections: true,
      agent: { select: { fullName: true } },
    },
  });

  if (analyses.length === 0) {
    return res.json({ days, total: 0, averageScore: null, steps: null, agents: [], objections: [], incoming: null });
  }

  /**
   * РАЗГОВОР ОПЕРАТОРА — НЕ РАБОТА АГЕНТА.
   *
   * У Interaction автор обязателен, а оператора входящих в карточке клиента нет,
   * поэтому входящий звонок пишется от имени оператора, а если станция его не
   * назвала — от имени ОТВЕТСТВЕННОГО АГЕНТА. Разбор наследует того же автора, и в
   * колонке агента оказывалось качество чужого разговора: агент в это время мог
   * вообще не быть на работе, а счёт ему считался. То же правило уже действует в
   * KPI и в «Активности за месяц» (см. lib/telephony/incomingInteractions.ts).
   *
   * Из общих цифр агентства входящие НЕ выбрасываются: это настоящие разговоры
   * компании, и «как у нас отвечают» — половина картины. Они лишь показываются
   * отдельной строкой, а не приписываются людям.
   */
  const incomingIds = await incomingInteractionIds(analyses.map((a) => a.interactionId));
  const byAgentSource = analyses.filter((a) => !incomingIds.has(a.interactionId));
  const incomingAnalyses = analyses.filter((a) => incomingIds.has(a.interactionId));

  const avg = (nums: number[]) => Math.round(nums.reduce((s, n) => s + n, 0) / nums.length);
  const share = (flag: (a: (typeof analyses)[number]) => boolean) =>
    Math.round((analyses.filter(flag).length / analyses.length) * 100);

  // По агентам: средний счёт и главная просадка — то, с чего начинается разговор
  // руководителя с сотрудником.
  const byAgent = new Map<string, { name: string; scores: number[]; nextSteps: number; needs: number }>();
  for (const a of byAgentSource) {
    const entry = byAgent.get(a.agentId) ?? { name: a.agent.fullName, scores: [], nextSteps: 0, needs: 0 };
    entry.scores.push(a.score);
    if (a.agreedNextStep) entry.nextSteps += 1;
    if (a.foundNeed) entry.needs += 1;
    byAgent.set(a.agentId, entry);
  }

  // Возражения считаем по нормализованному тексту: «дорого» и «Дорого.» — одно и то же.
  const objectionCounts = new Map<string, { text: string; count: number }>();
  for (const a of analyses) {
    for (const raw of a.objections) {
      const key = raw.trim().toLowerCase().replace(/[.!?]+$/, "");
      if (!key) continue;
      const entry = objectionCounts.get(key) ?? { text: raw.trim(), count: 0 };
      entry.count += 1;
      objectionCounts.set(key, entry);
    }
  }

  res.json({
    days,
    total: analyses.length,
    averageScore: avg(analyses.map((a) => a.score)),
    steps: {
      greeted: share((a) => a.greeted),
      foundNeed: share((a) => a.foundNeed),
      presentedValue: share((a) => a.presentedValue),
      handledObjection: share((a) => a.handledObjection),
      agreedNextStep: share((a) => a.agreedNextStep),
    },
    agents: [...byAgent.entries()]
      .map(([id, e]) => ({
        agentId: id,
        fullName: e.name,
        calls: e.scores.length,
        averageScore: avg(e.scores),
        nextStepShare: Math.round((e.nextSteps / e.scores.length) * 100),
        foundNeedShare: Math.round((e.needs / e.scores.length) * 100),
      }))
      .sort((a, b) => b.averageScore - a.averageScore),
    objections: [...objectionCounts.values()].sort((a, b) => b.count - a.count).slice(0, 10),
    // Разговоры операторов на входящих — отдельной строкой, а не в колонке агента.
    // null означает «за период таких не было», а не «мы их спрятали».
    incoming:
      incomingAnalyses.length > 0
        ? {
            total: incomingAnalyses.length,
            averageScore: avg(incomingAnalyses.map((a) => a.score)),
          }
        : null,
  });
});

/**
 * ДАШБОРД ТЕЛЕФОНИИ (владелец 11.08.2026: «сделать полноценный дашборд звонилки,
 * как у настоящей АТС, со всеми функциями»).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ЭКРАН. До него состояние телефонии было размазано: связь со
 * станцией проверялась кнопкой в Настройках, внутренние номера лежали в карточках
 * сотрудников, живые звонки были видны только тому, кто говорит, а счётчики за день
 * приходилось складывать глазами из двух журналов. Вопрос «работает ли телефония
 * прямо сейчас и что на ней происходит» не имел одного ответа нигде.
 *
 * ОДИН ЗАПРОС, А НЕ ПЯТЬ. Дашборд опрашивается раз в несколько секунд, и пять
 * маршрутов означали бы пять запросов к станции и базе на каждый тик у каждого
 * открывшего. Здесь всё собирается разом, а тяжёлое (список аппаратов со станции)
 * не срывает ответ при обрыве туннеля — просто приезжает пустым с признаком
 * `stationOnline: false`.
 */
callsRouter.get("/telephony/dashboard", supervisorOnly, async (req, res) => {
  const canSeePhone = req.agent!.can("clients.viewPhone");
  const { start: dayStart } = dushanbeDayRange(new Date());

  const creds = await loadAriCredentials();

  /**
   * Станция и база опрашиваются ПАРАЛЛЕЛЬНО и независимо: обрыв туннеля до АТС —
   * штатная ситуация (станция в офисе, CRM на VPS), и он не должен прятать
   * статистику, которая целиком лежит в базе.
   */
  const [endpointsResult, incomingToday, outgoingToday, missedToday, unqualified] = await Promise.all([
    creds
      ? listEndpoints(creds)
          .then((list) => ({ online: true, list }))
          .catch(() => ({ online: false, list: [] as Awaited<ReturnType<typeof listEndpoints>> }))
      : Promise.resolve({ online: false, list: [] as Awaited<ReturnType<typeof listEndpoints>> }),
    prisma.incomingCall.count({ where: { startedAt: { gte: dayStart } } }),
    prisma.interaction.count({ where: { type: "CALL", createdAt: { gte: dayStart }, ...visibleInteractionWhere(req.agent?.role) } }),
    prisma.incomingCall.count({ where: { startedAt: { gte: dayStart }, answered: false } }),
    prisma.incomingCall.count({
      where: { startedAt: { gte: dayStart }, ...AWAITING_REVIEW_WHERE },
    }),
  ]);

  /**
   * Внутренние номера сотрудников сопоставляем с аппаратами станции: без имён
   * список читается как «1001 online, 1004 unknown» — то есть требует держать
   * нумерацию в голове. Ровно эту проблему уже чинили в журнале входящих.
   */
  const agents = await prisma.agent.findMany({
    where: { isActive: true, sipExtension: { not: null } },
    select: { id: true, fullName: true, sipExtension: true, phone: true },
    // Потолок обязателен даже там, где агентов десяток — см. hallOfFame.ts.
    orderBy: { fullName: "asc" },
    take: 500,
  });
  const stateByExtension = new Map(endpointsResult.list.map((e) => [e.resource, e.state]));

  /**
   * Имя принявшего живой входящий (№223 ночной проверки 24.09): раньше панель
   * писала «принял 1003». Отдельный запрос, а не список `agents` выше: тот только
   * по действующим, а трубку мог снять сотрудник, которого за время разговора
   * отключили, — журнал входящих делает так же (GET /calls/incoming).
   */
  const liveIncoming = liveIncomingCalls();
  const liveExtensions = [
    ...new Set(liveIncoming.filter((c) => !c.answeredByConsultant).map((c) => c.answeredBy).filter((e): e is string => !!e)),
  ];
  const liveOperators = liveExtensions.length
    ? await prisma.agent.findMany({
        where: { sipExtension: { in: liveExtensions } },
        select: { sipExtension: true, fullName: true },
        take: 500,
      })
    : [];
  const liveNameByExtension = new Map(liveOperators.map((a) => [a.sipExtension!, a.fullName]));

  const settings = await loadIncomingSettings();
  // Плитка «Операторы» считает первую линию — сотрудников с признаком
  // «Принимает незнакомые звонки» (владелец 20.09.2026). Пока ни один не назначен,
  // incomingOperatorIds() отдаёт запасной список по праву clients.assign.
  const operatorCount = (await incomingOperatorIds()).length;

  res.json({
    station: {
      configured: !!creds,
      online: endpointsResult.online,
      // Сколько аппаратов реально зарегистрировано — главный ответ на вопрос
      // «почему звонки не доходят»: у FreePBX номер может существовать, но не
      // иметь ни одной живой регистрации, и тогда звонить на него бессмысленно.
      registered: endpointsResult.list.filter((e) => e.state === "online").length,
      total: endpointsResult.list.length,
    },
    extensions: agents
      .map((a) => ({
        agentId: a.id,
        fullName: a.fullName,
        extension: a.sipExtension!,
        // «unknown» у chan_sip означает «заведён, но ни разу не регистрировался» —
        // для человека это то же самое, что «не на связи», и различать их на экране
        // незачем: важен ответ «дозвонятся ли до него».
        online: stateByExtension.get(a.sipExtension!) === "online",
        knownToStation: stateByExtension.has(a.sipExtension!),
      }))
      .sort((a, b) => a.extension.localeCompare(b.extension)),
    live: {
      incoming: liveIncoming.map((c) => ({
        channelId: c.channelId,
        phone: clientPhoneFor(c.phone, canSeePhone),
        // Имя — тем же правом, что и номер строкой выше (22.09.2026).
        clientName: c.clientName ? clientNamePhoneSafe(c.clientName, canSeePhone) : null,
        clientShortId: c.clientShortId ?? null,
        answered: !!c.answeredAt,
        answeredBy: c.answeredBy ?? null,
        // null — трубку ещё не сняли или внутреннего номера нет в CRM: экран
        // тогда покажет сам номер (так же, как журнал входящих).
        answeredByName: c.answeredByConsultant
          ? CONSULTANT_ANSWERED_NAME
          : c.answeredBy
            ? (liveNameByExtension.get(c.answeredBy) ?? null)
            : null,
        seconds: c.talkSeconds,
      })),
      outgoing: liveOutgoingCalls().map((c) => ({
        channelId: c.channelId,
        clientName: c.clientName ? clientNamePhoneSafe(c.clientName, canSeePhone) : c.clientName,
        clientShortId: c.clientShortId,
        state: c.state,
        seconds: Math.max(0, Math.round((Date.now() - (c.answeredAt ?? c.startedAt).getTime()) / 1000)),
      })),
    },
    today: {
      incoming: incomingToday,
      outgoing: outgoingToday,
      missed: missedToday,
      unqualified,
    },
    /**
     * ОТБРОШЕННЫЕ КАНДИДАТЫ ВО ВХОДЯЩИЕ — ответ на вопрос «почему звонков нет в CRM».
     *
     * Без него «звонков не было» и «все звонки отброшены по неопознанному контексту»
     * выглядят на экране одинаково — пустым журналом. Один такой случай уже стоил
     * недели расследования по SSH (11.08.2026).
     *
     * `sinceProcessStart` — честное предупреждение: счётчик живёт в памяти процесса и
     * обнуляется рестартом и деплоем. Это диагностика «здесь и сейчас», а не
     * отчётность; без этого признака обнуление примут за «проблема ушла».
     *
     * Номеров звонивших здесь нет и не будет: в статистике только имя канала
     * (`SIP/out-00000012`), клиентских цифр оно не содержит.
     */
    rejected: {
      sinceProcessStart: true,
      items: rejectedInboundStats()
        .slice(0, 20)
        .map((r) => ({
          reason: r.reason,
          context: r.context,
          count: r.count,
          lastAt: r.lastAt,
          sample: r.sampleChannelName,
        })),
    },
    settings: {
      operators: operatorCount,
      pushEnabled: settings.pushEnabled,
      panelEnabled: settings.panelEnabled,
      autoCreateClient: settings.autoCreateClient,
      hoursEnabled: settings.hoursEnabled,
      hoursStart: settings.hoursStart,
      hoursEnd: settings.hoursEnd,
      forwardPhone: settings.forwardPhone,
      primaryTarget: settings.primaryTarget,
      primaryExtension: settings.primaryExtension,
    },
  });
});
