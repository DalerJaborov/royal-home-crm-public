import { canViewInvestigations } from "@royal-home/shared";
import { assignmentWriteDenied } from "../lib/assignmentCompletion.js";
import { commandSellerControl, SellerControlConflict } from "../lib/sellerControlEpisodes.js";
import { visibleInteractionWhere } from "../lib/investigationPrivacy.js";
import { Router, type Request } from "express";
import { z } from "zod";
import { foreignWriteDenied } from "./clients/shared.js";
import {
  activitySummaryQuerySchema,
  emptyActivitySummaryByType,
  interactionFeedQuerySchema,
  showingCancelSchema,
  showingRescheduleSchema,
  type ActivitySummary,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { dushanbeWallClock } from "../lib/dushanbeTime.js";
import { activityPeriodBounds, activityWhere } from "../lib/activityFeed.js";
import { can, requireAuth, scopeToOwnAgent } from "../auth/middleware.js";
import { canHearCall, canReadCall, presentInteractions, transcriptAccess } from "../lib/callTranscripts.js";
import { incomingInteractionIds } from "../lib/telephony/incomingInteractions.js";
import { phoneSafeText, withMaskedClient } from "../lib/clientPhone.js";
import { cancelShowingById, rescheduleShowingById, type ShowingActor } from "../lib/showingBooking.js";
import { loadEventPoints, recordScoreEvent, type ScoreEventKind } from "../lib/scoreJournal.js";
import {
  contentTypeFor,
  fetchRecording,
  isLegacyRecording,
  isRecordingSetupFailure,
  recordingFetchConfig,
  retranscribeInteraction,
} from "../lib/telephony/callRecordings.js";
import { describeError } from "../lib/describeError.js";
import { logSystemError } from "../lib/systemError.js";
import { closeStaleNextActions } from "../lib/nextActionAutoClose.js";
import { closeMeetingReminderPushes } from "../lib/meetingReminders.js";
import { interactionPropertySelect } from "../lib/interactionPropertySelect.js";

export const interactionsRouter = Router();

/** Ordinary assignee acknowledgement. No episode identifiers or private facts leave this route. */
interactionsRouter.post("/:id/work-response", requireAuth, async (req, res) => {
  const parsed = z.object({ requestKey: z.string().uuid(), action: z.enum(["RECEIPT", "ACTION"]), note: z.string().trim().min(3).max(2000).optional() })
    .strict().refine(value => value.action !== "ACTION" || !!value.note).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Проверьте ответ по задаче" });
  const task = await prisma.interaction.findUnique({ where: { id: req.params.id } });
  if (!task || task.subjectAgentId !== req.agent!.id || task.investigationOnly || task.taskCancelledAt)
    return res.status(404).json({ error: "Задача недоступна" });
  const episode = await prisma.sellerControlEpisode.findUnique({ where: { ropTaskId: task.id } });
  if (!episode || episode.executionMode !== "LIVE" || episode.ropAgentId !== req.agent!.id)
    return res.status(404).json({ error: "Задача недоступна" });
  try {
    await commandSellerControl(episode.id, { ...parsed.data, revision: episode.revision }, req.agent!.id, { taskId: task.id });
    return res.status(204).send();
  } catch (error) {
    if (error instanceof SellerControlConflict) return res.status(409).json({ error: "Задача изменилась. Обновите страницу" });
    throw error;
  }
});

/**
 * Послушать запись разговора.
 *
 * Файл лежит на АТС в офисе (решение владельца 07.08.2026: там 68 ГБ свободно, а в
 * Cloudflare R2 бесплатных 10 ГБ), поэтому CRM работает посредником — скачивает файл
 * через тот же закрытый токеном канал, что и для расшифровки, и отдаёт сотруднику.
 *
 * Прямую ссылку на станцию дать нельзя: АТС живёт во внутренней сети офиса и снаружи
 * недоступна вовсе, а её токен — общий для всего каталога записей, и в браузере
 * сотрудника ему делать нечего.
 *
 * Кто имеет право слушать (04.09.2026, сужение решения 15.08.2026): DIRECTOR/
 * ADMIN, SECURITY и MARKETING — им нужно право calls.hearRecording (см.
 * packages/shared/permissions.ts). Обычный агент и руководитель отдела
 * (calls.ownTranscripts/calls.transcripts без calls.hearRecording) по-прежнему
 * ЧИТАЮТ расшифровку и совет по своим разговорам (GET /:id/transcript), но
 * прослушать саму запись не могут — ни свою, ни чужую. Разговор с клиентом — не
 * общедоступная запись внутри агентства: коллега чужую беседу не слушает.
 */
interactionsRouter.get("/:id/recording", requireAuth, async (req, res) => {
  const interaction = await prisma.interaction.findUnique({
    where: { id: req.params.id },
    select: { investigationOnly: true, id: true, agentId: true, recordingUrl: true, createdAt: true, clientId: true },
  });
  if (!interaction?.recordingUrl) return res.status(404).json({ error: "Записи этого разговора нет" });

  if (interaction.investigationOnly && !canViewInvestigations(req.agent?.role)) return res.status(404).json({ error: "Разговор не найден" });
  const access = transcriptAccess(req.agent);
  // Входящий, принятый оператором по очереди, — тоже «свой» для агента, за которым
  // СЕЙЧАС закреплён клиент (см. шапку lib/callTranscripts.ts). Лишний запрос
  // делаем только когда запись не открывается по основному правилу и вообще есть
  // смысл проверять — иначе каждое прослушивание своего звонка тянуло бы клиента
  // и IncomingCall без необходимости.
  let routedToViewersClient = false;
  if (!access.all && access.own && interaction.agentId !== access.viewerId && interaction.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: interaction.clientId },
      select: { assignedAgentId: true },
    });
    if (client?.assignedAgentId === access.viewerId) {
      routedToViewersClient = (await incomingInteractionIds([interaction.id])).has(interaction.id);
    }
  }

  // Единственное правило доступа к разговору живёт в lib/callTranscripts.ts —
  // здесь оно только применяется (иначе маршрутов с собственным пониманием «свой
  // разговор» станет столько же, сколько маршрутов).
  if (!canHearCall(access, interaction.agentId, routedToViewersClient)) {
    return res.status(403).json({
      // «Не то право» и «не тот разговор» — разные причины, и с 04.09.2026 первая
      // встречается ЧАЩЕ: у обычного агента текст своих разговоров открыт
      // по-прежнему, закрыт только звук (calls.hearRecording, см.
      // lib/callTranscripts.ts). Молчать про это и звать «чужим разговором» было
      // бы неправдой для собственного звонка.
      error: !access.hearRecording
        ? "Прослушать запись может только руководство, служба безопасности и маркетинг — расшифровка и совет по разговору вам по-прежнему доступны."
        : can(req, "calls.ownTranscripts")
          ? "Это чужой разговор — записи коллег доступны только администрации"
          : "Записи разговоров доступны только администрации",
    });
  }

  // Записи прежней эпохи лежат в R2, а не на станции, и адрес АТС им не нужен —
  // поэтому проверка настройки станции их не касается.
  const config = recordingFetchConfig();
  if (!config && !isLegacyRecording(interaction.recordingUrl)) {
    return res.status(409).json({ error: "Хранилище записей не настроено" });
  }

  try {
    const { buffer: audio, path: found } = await fetchRecording(
      interaction.recordingUrl,
      config ?? { baseUrl: "", token: null }
    );

    // Станция сжимает записи в mp3 через пять минут после разговора и удаляет
    // исходный wav — путь в карточке после этого указывает в пустоту. Запоминаем
    // найденный, чтобы следующее прослушивание шло прямо, а не перебором.
    if (found !== interaction.recordingUrl) {
      await prisma.interaction
        .update({ where: { id: interaction.id }, data: { recordingUrl: found } })
        .catch((err) => console.error("[запись] путь не обновлён:", err instanceof Error ? err.message : err));
    }

    const isMp3 = found.endsWith(".mp3");
    res.setHeader("Content-Type", contentTypeFor(found));
    // Запись разговора доступна только администрации — общий кэш (Cloudflare перед
    // CRM) не должен отдать её тому, кому мы только что ответили 403.
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    // По умолчанию inline — разговор проигрывается прямо в разделе, слушать нужно
    // чаще, чем сохранять. С ?download=1 тот же файл отдаётся вложением: иногда
    // запись нужно переслать или приложить к разбору.
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    // Дата в имени файла — по Душанбе: ночную запись искали под вчерашним числом.
    const name = `Разговор-${dushanbeWallClock(interaction.createdAt).toISOString().slice(0, 10)}-${interaction.id.slice(0, 8)}`;
    res.setHeader(
      "Content-Disposition",
      // filename* с кодировкой — имя русское, а старые клиенты по обычному filename
      // получат латинскую запасную версию вместо мусора.
      `${disposition}; filename="call-${interaction.id.slice(0, 8)}.${isMp3 ? "mp3" : "wav"}"; filename*=UTF-8''${encodeURIComponent(name)}.${isMp3 ? "mp3" : "wav"}`
    );
    res.send(audio);
  } catch (err) {
    // Станция может быть недоступна (обрыв туннеля) или запись уже удалена ротацией.
    //
    // Код 400, а НЕ 502: Cloudflare перед CRM подменяет тело ответов 5xx своей
    // типовой страницей, и понятная причина до интерфейса не доходит — вместо неё
    // агент читает голое «Ошибка запроса: 502». Тот же приём уже применён в
    // routes/properties.ts (публикация на сайт) и routes/settings.ts (курс валют),
    // и ровно на этом маршруте он стоил дня разбирательств 11.08.2026.
    const reason = describeError(err);

    /**
     * В ЖУРНАЛ — ТОЛЬКО ПОЛОМКА ДОСТУПА, А НЕ КАЖДЫЙ НЕУДАВШИЙСЯ «PLAY» (12.08.2026).
     *
     * Раньше сюда писалась любая неудача: ротация записи, сжатие в mp3 «на пять
     * минут раньше», моргнувший туннель. Причина в ту же секунду показывается
     * агенту в ответе 400 прямо на экране — то есть журнал директора дублировал
     * увиденное человеком, которому по этой записи делать нечего. Дедупликация не
     * спасала: текст меняется вместе с путём и причиной, и каждая запись уходила
     * в журнал как новая.
     *
     * Человеку нужно знать не «эту запись не удалось послушать», а «записи не
     * слушаются вообще»: отказ авторизации на каталоге записей или отказ самого
     * хранилища (см. isRecordingSetupFailure). Текст тревоги намеренно без пути —
     * иначе десятиминутная дедупликация опять не сработает, а путь на неё всё
     * равно не влияет.
     */
    if (isRecordingSetupFailure(err)) {
      void logSystemError(
        "telephony",
        `Каталог записей на АТС не отдаёт файлы: HTTP ${err.status}`
      );
    } else {
      console.warn(
        `[запись] ${new Date().toISOString()} запись ${interaction.recordingUrl} не отдана агенту: ${reason}`
      );
    }

    res.status(400).json({
      error: `Запись на АТС недоступна. ${reason}`,
    });
  }
});

/**
 * Текст разговора — ЛЕНИВО, по клику «Послушать и прочитать разговор» (26.08.2026).
 *
 * Карточка клиента больше не поднимает transcript/transcriptRu на все 200 записей
 * хронологии (мегабайты при каждом открытии) — текст конкретного разговора
 * запрашивается отдельно, ровно когда человек его разворачивает. Доступ — тем же
 * правилом, что у записи и перевода (lib/callTranscripts.ts).
 */
interactionsRouter.get("/:id/transcript", requireAuth, async (req, res) => {
  const interaction = await prisma.interaction.findUnique({
    where: { id: req.params.id },
    select: { investigationOnly: true, id: true, agentId: true, clientId: true, transcript: true, transcriptRu: true },
  });
  if (!interaction) return res.status(404).json({ error: "Разговор не найден" });

  if (interaction.investigationOnly && !canViewInvestigations(req.agent?.role)) return res.status(404).json({ error: "Разговор не найден" });
  const access = transcriptAccess(req.agent);
  let routedToViewersClient = false;
  if (!access.all && access.own && interaction.agentId !== access.viewerId && interaction.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: interaction.clientId },
      select: { assignedAgentId: true },
    });
    if (client?.assignedAgentId === access.viewerId) {
      routedToViewersClient = (await incomingInteractionIds([interaction.id])).has(interaction.id);
    }
  }
  // Текст — не звук: доступ по calls.transcripts/calls.ownTranscripts, как и
  // раньше (04.09.2026 сузило только прослушивание, см. lib/callTranscripts.ts).
  if (!canReadCall(access, interaction.agentId, routedToViewersClient)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }

  // Номера внутри расшифровки — по clients.viewPhone, как и везде (22.09.2026).
  // Право на разговор и право на номер разные: lib/callTranscripts.ts и GET /calls
  // это соблюдают, а «ленивая подгрузка текста» из карточки шла мимо — клиент
  // диктует номер голосом, и агент читал его в своём же разговоре.
  const canSeePhone = can(req, "clients.viewPhone");
  res.json({
    transcript: phoneSafeText(interaction.transcript ?? null, canSeePhone),
    transcriptRu: phoneSafeText(interaction.transcriptRu ?? null, canSeePhone),
  });
});

/**
 * Перевод расшифровки на русский — ПО КЛИКУ, а не автоматически (владелец
 * 19.08.2026, экономия токенов). Оригинал открывается первым и его хватает
 * ИИ-разбору; перевод — только для того, кому по-русски читать удобнее.
 * Результат кэшируется в transcriptRu — повторный клик не платит снова.
 */
interactionsRouter.post("/:id/translate", requireAuth, async (req, res) => {
  const interaction = await prisma.interaction.findUnique({
    where: { id: req.params.id },
    select: { investigationOnly: true, id: true, agentId: true, clientId: true, transcript: true, transcriptRu: true },
  });
  if (!interaction) return res.status(404).json({ error: "Разговор не найден" });
  if (interaction.investigationOnly && !canViewInvestigations(req.agent?.role)) return res.status(404).json({ error: "Разговор не найден" });
  const access = transcriptAccess(req.agent);
  let routedToViewersClient = false;
  if (!access.all && access.own && interaction.agentId !== access.viewerId && interaction.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: interaction.clientId },
      select: { assignedAgentId: true },
    });
    if (client?.assignedAgentId === access.viewerId) {
      routedToViewersClient = (await incomingInteractionIds([interaction.id])).has(interaction.id);
    }
  }
  // Тот же текстовый доступ, что у GET /:id/transcript выше — перевод тоже текст,
  // не звук.
  if (!canReadCall(access, interaction.agentId, routedToViewersClient)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  // Готовый перевод — только ПОСЛЕ проверки прав: раньше он отдавался первым,
  // и текст чужого разговора получал любой вошедший (аудит 23.09.2026, №28).
  if (!interaction.transcript) return res.status(409).json({ error: "Расшифровки ещё нет" });
  if (interaction.transcriptRu) {
    return res.json({ transcriptRu: phoneSafeText(interaction.transcriptRu, can(req, "clients.viewPhone")) });
  }

  const { translateTranscript } = await import("../ai/translateTranscript.js");
  const translated = await translateTranscript(interaction.transcript);
  if (!translated) {
    return res.status(200).json({ transcriptRu: null });
  }
  await prisma.interaction.update({ where: { id: interaction.id }, data: { transcriptRu: translated } });
  // В БД перевод кладётся как есть (он же читается разбором ИИ и руководством),
  // а наружу — по праву на номер: иначе кнопка «Показать перевод» оставалась бы
  // обходом запрета, ровно как это уже чинили для переписки в
  // lib/messageAttachments.ts.
  res.json({ transcriptRu: phoneSafeText(translated, can(req, "clients.viewPhone")) });
});

const retranscribeParamsSchema = z.object({ id: z.guid() });

/**
 * ЛИМИТ 1 РАЗ В 24 ЧАСА — ПАМЯТЬ ПРОЦЕССА, НЕ БАЗА (24.09.2026).
 *
 * Своей таблицы «когда в последний раз перезапускали расшифровку разговора» не
 * заводим — задание прямо исключает миграцию схемы здесь, а AiLog (расходы ИИ)
 * не хранит связи с конкретным interactionId, сверяться там нечем. Память
 * процесса — тот же компромисс, что у других лёгких ограничений в проекте:
 * после рестарта контейнера (автовыкат на каждый мерж в main) счётчик честно
 * обнуляется, и это осознанно — цена ошибки здесь «агент нажал кнопку чуть
 * раньше положенного», а не потерянные данные.
 */
const RETRANSCRIBE_LIMIT_MS = 24 * 60 * 60 * 1000;
const retranscribeLastRequestedAt = new Map<string, number>();

/**
 * Пере-расшифровать разговор ЗАНОВО, по кнопке в интерфейсе (24.09.2026) —
 * не путать с автоматическим повтором (runTranscriptionRetryAttempt), который
 * срабатывает только пока текста ЕЩЁ НЕТ. Эта кнопка — для случая «текст есть, но
 * разошёлся с тем, что сказано» (плохое распознавание шумной записи, а не отказ
 * поставщика).
 *
 * Отвечает 202 сразу — сама расшифровка занимает секунды-минуты и гоняет запись
 * через Gemini, ждать её в HTTP-ответе незачем (тот же приём, что и у первичной
 * постановки в очередь, см. ingestCallRecording). Конвейер — тот же самый, что у
 * обычного звонка (retranscribeInteraction переиспользует fetchAndTranscribe /
 * transcribeAndEnrich из lib/telephony/callRecordings.ts, второй копии нет).
 *
 * Права — ровно те же, что у чтения расшифровки (GET /:id/transcript): кнопка не
 * открывает ничего нового, только пересчитывает то, что этому сотруднику и так
 * можно прочитать.
 */
interactionsRouter.post("/:id/retranscribe", requireAuth, async (req, res) => {
  const parsed = retranscribeParamsSchema.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Неверный идентификатор" });

  const interaction = await prisma.interaction.findUnique({
    where: { id: parsed.data.id },
    select: { investigationOnly: true, id: true, agentId: true, clientId: true, type: true, recordingUrl: true },
  });
  if (!interaction) return res.status(404).json({ error: "Разговор не найден" });
  if (interaction.type !== "CALL" || !interaction.recordingUrl) {
    return res.status(404).json({ error: "У этого разговора нет записи для повторной расшифровки" });
  }

  if (interaction.investigationOnly && !canViewInvestigations(req.agent?.role)) return res.status(404).json({ error: "Разговор не найден" });
  const access = transcriptAccess(req.agent);
  let routedToViewersClient = false;
  if (!access.all && access.own && interaction.agentId !== access.viewerId && interaction.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: interaction.clientId },
      select: { assignedAgentId: true },
    });
    if (client?.assignedAgentId === access.viewerId) {
      routedToViewersClient = (await incomingInteractionIds([interaction.id])).has(interaction.id);
    }
  }
  if (!canReadCall(access, interaction.agentId, routedToViewersClient)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }

  const lastRequestedAt = retranscribeLastRequestedAt.get(interaction.id);
  if (lastRequestedAt !== undefined && Date.now() - lastRequestedAt < RETRANSCRIBE_LIMIT_MS) {
    return res.status(429).json({ error: "Повторная расшифровка уже запускалась за последние сутки — попробуйте позже" });
  }
  // Отметка — ДО фоновой работы, не после: пока расшифровка идёт (секунды-минуты),
  // повторный клик не должен проскочить лимит только потому, что первая попытка
  // ещё не отчиталась.
  retranscribeLastRequestedAt.set(interaction.id, Date.now());

  res.status(202).json({ queued: true });

  void retranscribeInteraction(interaction.id).catch((err) =>
    void logSystemError("ai", `Повторная расшифровка по запросу упала: ${describeError(err)}`)
  );
});

/** Лента активности с пагинацией и фильтром по периоду/агенту («Активность команды»
 * на дашборде показывает последние 5 из неё же). Для руководителя — общекомандная,
 * для рядового агента — только его собственные записи (см. scope ниже). */
interactionsRouter.get("/", requireAuth, async (req, res) => {
  /**
   * Разбор строки запроса — общей схемой, а не руками (аудит 09.08.2026).
   *
   * Ручной разбор пропускал сразу три вещи: у страницы не было потолка (а
   * `?page=…` доходит до skip/take), `new Date("вчера")` давал Invalid Date и
   * фильтр по периоду молча пропадал вместо понятного отказа, а agentId
   * принимался любой строкой. Схема `page` с потолком и `dateRangeQuerySchema`
   * уже используются в календаре и отчётах — тот же период должен вести себя
   * одинаково во всех разделах.
   */
  const parsed = interactionFeedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры запроса", details: parsed.error.flatten() });
  }
  const { page, agentId, from, to, type } = parsed.data;
  const pageSize = 30;

  // Лента задумана общекомандной как «факт звонка/показа», но отдаёт запись целиком,
  // включая notes — текст заметки агента по клиенту. Для рядового агента это был
  // обход изоляции: ?agentId=<чужой> постранично выгружал заметки коллег по
  // клиентам, чьи карточки тому же агенту отвечают 403. Агент видит только своё.
  // Само сужение и границы суток по Душанбе живут в lib/activityFeed.ts — общие
  // со сводкой ниже, чтобы плитки и список никогда не считались по-разному.
  // Даты уже разобраны и проверены схемой — Invalid Date сюда не доходит.
  const where = { ...activityWhere({ ownAgentId: scopeToOwnAgent(req), agentId, from, to, type }), ...visibleInteractionWhere(req.agent?.role) };

  const [items, total] = await Promise.all([
    prisma.interaction.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        agent: { select: { id: true, fullName: true, avatarUrl: true } },
        client: { select: { id: true, shortId: true, fullName: true } },
        property: { select: interactionPropertySelect },
      },
    }),
    prisma.interaction.count({ where }),
  ]);

  // Лента активности — второй путь, которым текст чужого разговора мог бы утечь
  // мимо права calls.transcripts: она отдаёт записи целиком, включая расшифровку.
  // Свои разговоры сотрудник здесь видит так же, как в карточке клиента.
  // Имя карточки — по clients.viewPhone (22.09.2026): у заведённых до 20.08.2026
  // номер лежит именно в нём, и лента отдавала его рядом с закрытым текстом.
  const canSeePhone = can(req, "clients.viewPhone");
  res.json({
    items: presentInteractions(items, transcriptAccess(req.agent)).map((i) => withMaskedClient(i, canSeePhone)),
    total,
    page,
    pageSize,
  });
});

/**
 * Сводка «Активности» за период: сколько звонков, сообщений, показов и встреч.
 *
 * ЗАЧЕМ. Плитки экрана считались по ЗАГРУЖЕННОЙ странице ленты — число менялось
 * от того, докрутил ли человек список, и «Звонков 30» означало лишь «на этой
 * странице тридцать». Цифра выглядела фактом за период, не будучи им; под
 * плитками стояла честная подпись «по загруженным событиям», а сама сводка была
 * заведена задачей (решение владельца 09.09.2026, docs/theme-2026-missing.md §8).
 *
 * ОДИН ЗАПРОС С ГРУППИРОВКОЙ, а не выборка всех строк с подсчётом в памяти:
 * период «Всё время» — это вся таблица взаимодействий, и считать её в Node
 * означало бы тянуть по сети десятки тысяч записей ради шести чисел.
 *
 * ПРЕДЕЛ ВЫБОРКИ. Маршрут отдаёт агрегаты, а разбивка ограничена по построению:
 * ключи — перечень INTERACTION_TYPES, шесть значений, и никакой параметр запроса
 * этого числа не увеличит (см. packages/shared/src/activitySummary.ts).
 *
 * ПРАВА. Тот же `activityWhere`, что и у ленты: у кого нет clients.viewAll, тот
 * видит в сводке только свои события, а его `?agentId=<чужой>` игнорируется.
 */
interactionsRouter.get("/summary", requireAuth, async (req, res) => {
  const parsed = activitySummaryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры запроса", details: parsed.error.flatten() });
  }
  const { agentId, from, to } = parsed.data;
  const where = { ...activityWhere({ ownAgentId: scopeToOwnAgent(req), agentId, from, to }), ...visibleInteractionWhere(req.agent?.role) };

  const grouped = await prisma.interaction.groupBy({
    by: ["type"],
    where,
    _count: { _all: true },
  });

  const byType = emptyActivitySummaryByType();
  let total = 0;
  for (const row of grouped) {
    const count = row._count._all;
    total += count;
    // Тип из базы — строка; в перечне может не оказаться, если схему расширили
    // раньше, чем @royal-home/shared. Молча приписывать такие события к чужой
    // плитке нельзя, в total они при этом честно входят.
    if (row.type in byType) byType[row.type as keyof typeof byType] = count;
  }

  const bounds = activityPeriodBounds(from, to);
  const summary: ActivitySummary = {
    total,
    byType,
    from: bounds.start?.toISOString() ?? null,
    to: bounds.end?.toISOString() ?? null,
  };
  res.json(summary);
});

/** Ступень Royal Score по завершению задачи: свой вид события для показа, встречи и
 * обычной задачи (таблица владельца различает их ценой — «Показ +3», «Встреча +2»,
 * «Задача +1»), и просрочка считается по nextActionDate, а не самим фактом закрытия. */
function completionEventKind(type: string, overdue: boolean): ScoreEventKind {
  if (type === "SHOWING") return overdue ? "showing_missed" : "showing_done";
  if (type === "MEETING") return overdue ? "meeting_overdue" : "meeting_done";
  return overdue ? "task_overdue" : "task_on_time";
}

/** Отметить задачу выполненной: проставляет completedAt (nextAction/nextActionDate
 * больше НЕ стираются — они нужны потом для расчёта KPI "Дисциплина CRM", см.
 * apps/api/src/kpi.ts). Из списка «предстоящих» (calendar.ts) она пропадает по
 * completedAt: null в фильтре, а не по факту стирания даты. */
interactionsRouter.patch("/:id/complete", requireAuth, async (req, res) => {
  const ownAgentId = scopeToOwnAgent(req);
  const interaction = await prisma.interaction.findUnique({ where: { id: req.params.id } });
  if (!interaction) return res.status(404).json({ error: "Взаимодействие не найдено" });
  // Владелец задачи — subjectAgentId, если запись сделана не агентом (SYSTEM/AI,
  // П-10, 17.09.2026), иначе обычный agentId.
  const taskOwnerId = interaction.subjectAgentId ?? interaction.agentId;
  if (ownAgentId && taskOwnerId !== ownAgentId) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  {
    const denied = await foreignTaskWriteDenied(req, interaction, ownAgentId);
    if (denied) return res.status(403).json({ error: denied });
  }

  const now = new Date();
  /**
   * ПЕРЕХОД «не выполнено → выполнено» ЗАБИРАЕТСЯ АТОМАРНО.
   *
   * Признаком первого перехода было прочитанное выше `interaction.completedAt` —
   * но между чтением и записью помещается второй такой же запрос (двойной клик,
   * повтор с телефона): оба видели `null`, оба заходили в начисление. От двойных
   * баллов спасала только уникальность `sourceId` в журнале — то есть защита жила
   * не там, где гонка, и любое событие без sourceId её бы не получило.
   *
   * `updateMany` с условием `completedAt: null` делает переход однократным на
   * стороне базы: `count > 0` ровно у одного запроса (тот же приём, что в
   * lib/telephony/qualifyIncoming.ts).
   */
  const claimed = await prisma.interaction.updateMany({
    where: { id: req.params.id, completedAt: null, taskCancelledAt: null },
    data: { completedAt: now },
  });

  // Событие пишем только на переходе «не выполнено → выполнено» — повторный вызов
  // на уже закрытой задаче (двойной клик, повтор запроса) не должен начислять
  // баллы второй раз. sourceId = id взаимодействия даёт ту же защиту на уровне БД.
  if (claimed.count > 0) {
    const overdue = interaction.nextActionDate != null && interaction.nextActionDate < now;
    const kind = completionEventKind(interaction.type, overdue);
    // Цена — из настроек НА МОМЕНТ события: computeRoyalScore при расчёте всё равно
    // берёт актуальную цену по kind (см. scoreJournal.ts), а здесь delta нужна только
    // для того, что видит агент в журнале — «за что и сколько» без пересчёта задним числом.
    const points = await loadEventPoints();
    // await обязателен. Без него ответ 200 уходил раньше записи события, и всё, что
    // случалось дальше (падение процесса, откат соединения с базой), теряло балл
    // агента совсем: повторный PATCH уже видит completedAt и в эту ветку не заходит,
    // то есть второго шанса начислить не будет. Сам recordScoreEvent не бросает —
    // отказ пишется в журнал ошибок внутри него (аудит 12.08.2026, пункт К).
    if (taskOwnerId) {
      await recordScoreEvent({
        agentId: taskOwnerId,
        kind,
        delta: points[kind],
        reason: overdue ? "Закрыто с опозданием" : "Закрыто вовремя",
        sourceId: interaction.id,
      });
    }

    // ЗАКРЫТЬ СТАРЫЕ ПОДСКАЗКИ КЛИЕНТА (18.08.2026, см. lib/nextActionAutoClose.ts):
    // только для показа/встречи — сама встреча состоялась, значит это реальный
    // контакт, а не просто «отметили галочку» на произвольной задаче. Обычную
    // задачу (type=TASK/SYSTEM) закрывать чужие подсказки клиента не заставляет —
    // не всякая закрытая галочка означает, что с клиентом что-то произошло.
    if (interaction.type === "SHOWING" || interaction.type === "MEETING") {
      void closeStaleNextActions(interaction.clientId, interaction.id).catch((err) =>
        console.error("[interactions] закрытие старых подсказок:", err instanceof Error ? err.message : err)
      );
    }

    // Задача закрыта — все пуши про неё (наблюдателям показа, «не отмечен»,
    // «просрочено») больше не актуальны ни для кого, кроме исполнителя.
    if (taskOwnerId) void closeMeetingReminderPushes(interaction.id, taskOwnerId).catch((err) =>
      console.error("[interactions] закрытие пушей по задаче:", err instanceof Error ? err.message : err)
    );

    // «Итог показа» больше не заводится здесь (переработка 12.08.2026): окно
    // открывается ПО ВРЕМЕНИ показа (+90 минут после nextActionDate), независимо от
    // того, отметил ли агент задачу «выполненной» — см.
    // lib/pendingSummaries.ts::requireMeetingSummaries и cron.ts. Раньше агент, не
    // заходивший в CRM после показа, обязательного окна не получал вовсе.
  }
  // Отдаём запись такой, какая она в базе сейчас: при повторном вызове переход
  // забрал кто-то другой, и `completedAt` там от ПЕРВОГО закрытия, а не от этого.
  //
  // Через presentInteractions, как и все чтения этого файла (глубокая проверка
  // 02.10.2026, A2): сырой ответ отдавал расшифровку чужого звонка руководителю
  // без calls.transcripts, ссылку на запись — без calls.hearRecording, а номер,
  // продиктованный в разговоре, — агенту без clients.viewPhone.
  const row = (await prisma.interaction.findUnique({ where: { id: req.params.id } })) ?? { ...interaction, completedAt: now };
  res.json(presentInteractions([row], transcriptAccess(req.agent))[0]);
});

/* ─────────────── Отмена и перенос показа руками, из календаря ────────────────
 *
 * До этого отменить или подвинуть показ умел только бот. Агент мог либо соврать
 * («отметить выполненной» встречу, которой не было — она уйдёт в отчёты и в KPI),
 * либо оставить её висеть просроченной и получить минус к дисциплине за то, что
 * передумал клиент. Ни то ни другое не годится.
 *
 * Логика здесь НЕ своя: маршруты только проверяют права и зовут те же функции
 * lib/showingBooking.ts, которыми пользуется бот. Два места, где отменяется показ,
 * рано или поздно разойдутся — одно забудет declinedAt, и отменённый показ вернётся
 * в отчёты; другое забудет сбросить напоминания, и клиенту придёт просьба
 * подтвердить встречу, которой нет.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * «Видеть — но не менять» (clients.viewAll без clients.assign, служба
 * безопасности) и для задач и показов по чужой карточке — то же правило, что у
 * правки самой карточки (foreignWriteDenied, routes/clients/shared.ts). Своя
 * задача сотрудника — его. Аудит 23.09.2026, №29.
 */
async function foreignTaskWriteDenied(
  req: Request,
  interaction: { clientId: string | null; agentId: string | null; subjectAgentId: string | null; investigationOnly?: boolean; taskCancelledAt?: Date | null },
  ownAgentId: string | undefined
): Promise<string | null> {
  if (interaction.investigationOnly && !canViewInvestigations(req.agent?.role)) return "Недостаточно прав";
  if (interaction.taskCancelledAt) return "Задача отменена";
  const current = interaction.clientId ? await prisma.client.findUnique({ where: { id: interaction.clientId }, select: { assignmentCompletedAt: true } }) : null;
  const completed = current && assignmentWriteDenied(current, req.agent?.role);
  if (completed) return completed;
  if (ownAgentId) return null;
  if ((interaction.subjectAgentId ?? interaction.agentId) === req.agent!.id) return null;
  if (!interaction.clientId) return null;
  const client = await prisma.client.findUnique({ where: { id: interaction.clientId }, select: { assignedAgentId: true } });
  return client ? foreignWriteDenied(req, client, ownAgentId) : null;
}

/** Ошибки showingBooking → коды HTTP. Разные причины — разные подсказки человеку. */
const SHOWING_ERRORS: Record<string, { status: number; error: string }> = {
  not_found: { status: 404, error: "Запись не найдена" },
  not_showing: { status: 409, error: "Это не показ с назначенным временем" },
  already_cancelled: { status: 409, error: "Показ уже отменён или отмечен выполненным" },
  past: { status: 400, error: "Перенести показ можно только на будущее время" },
  no_client: { status: 404, error: "Клиент не найден" },
  no_showing: { status: 409, error: "Показ уже снят с календаря" },
};

/**
 * Проверка доступа и «кем подписать» действие в одном запросе.
 *
 * Свой показ агент правит сам, чужой — только руководство (та же развилка, что у
 * PATCH /complete). Имя берём из базы: в req.agent лежат лишь id, роль и права, а
 * в карточке клиента и в push должно стоять, КТО снял встречу, — иначе через месяц
 * не разобрать, показ отменил клиент или руководитель.
 */
async function authorizeShowingAction(req: Request, interactionId: string, actorId: string, ownAgentId?: string) {
  const [interaction, actor] = await Promise.all([
    prisma.interaction.findUnique({
      where: { id: interactionId },
      select: { agentId: true, subjectAgentId: true, clientId: true, investigationOnly: true },
    }),
    prisma.agent.findUnique({ where: { id: actorId }, select: { fullName: true } }),
  ]);
  if (!interaction) return { ok: false as const, ...SHOWING_ERRORS.not_found };
  // Показ, назначенный ботом или системой, хранит агента в subjectAgentId, а
  // agentId пуст (П-10) — проверка только по agentId не пускала своего же
  // агента (аудит 23.09.2026, №29).
  if (ownAgentId && (interaction.subjectAgentId ?? interaction.agentId) !== ownAgentId) {
    return { ok: false as const, status: 403, error: "Недостаточно прав" };
  }
  const denied = await foreignTaskWriteDenied(req, interaction, ownAgentId);
  if (denied) return { ok: false as const, status: 403, error: denied };
  const showingActor: ShowingActor = { kind: "agent", agentId: actorId, agentName: actor?.fullName ?? "сотрудник" };
  return { ok: true as const, actor: showingActor };
}

/** Причина обязательна (владелец 16.08.2026) — без неё отмена/перенос руками
 *  ничем не отличались от исчезновения встречи: ни следа в хронологии, ни того,
 *  что видит следующий агент, который откроет карточку через месяц. */
interactionsRouter.patch("/:id/showing/cancel", requireAuth, async (req, res) => {
  const parsed = showingCancelSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Укажите причину отмены", details: parsed.error.flatten() });
  }
  const access = await authorizeShowingAction(req, req.params.id, req.agent!.id, scopeToOwnAgent(req));
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const result = await cancelShowingById({ interactionId: req.params.id, actor: access.actor, reason: parsed.data.reason });
  if (!result.ok) {
    const mapped = SHOWING_ERRORS[result.reason] ?? { status: 409, error: "Показ отменить не удалось" };
    return res.status(mapped.status).json({ error: mapped.error });
  }
  res.json({ interactionId: result.interactionId, at: result.at });
});

interactionsRouter.patch("/:id/showing/reschedule", requireAuth, async (req, res) => {
  const parsed = showingRescheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Укажите новое время и причину переноса", details: parsed.error.flatten() });
  }
  const access = await authorizeShowingAction(req, req.params.id, req.agent!.id, scopeToOwnAgent(req));
  if (!access.ok) return res.status(access.status).json({ error: access.error });

  const result = await rescheduleShowingById({
    interactionId: req.params.id,
    at: parsed.data.at,
    actor: access.actor,
    reason: parsed.data.reason,
  });
  if (!result.ok) {
    const mapped = SHOWING_ERRORS[result.reason] ?? { status: 409, error: "Показ перенести не удалось" };
    return res.status(mapped.status).json({ error: mapped.error });
  }
  res.json({ interactionId: result.interactionId, at: result.at });
});
