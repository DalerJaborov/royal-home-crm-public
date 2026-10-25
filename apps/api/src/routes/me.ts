import { canReadInvestigations } from "../auth/investigations.js";
import path from "node:path";
import { Router, type Request } from "express";
import { z } from "zod";
import {
  leadPauseSchema,
  meUpdateSchema,
  ownerAnswerSchema,
  customerRequestTransitionSchema, customerRequestCloseSchema,
  uiPreferencesSchema,
  montageCopiesUpdateSchema,
  migrateLegacyTheme,
  type ActiveCallView,
  meTelegramModerationSchema,
  isReadOnlyRole,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { createTelegramLinkCode } from "../lib/telegramAgentLink.js";
import { can, requireAuth, requirePermission } from "../auth/middleware.js";
import { voiceMessageUpload } from "../upload.js";
import { saveVoiceNoteFile, voiceNoteFilePath, privateMimeType, isConversationAttachment } from "../lib/privateFiles.js";
import { transcribeAudio } from "../ai/transcribe.js";
import { agentSpeechLimiter } from "../lib/agentSpeechLimiter.js";
import { availabilityOf, canStartPause, loadPauseLimits, pauseEndsAt } from "../lib/agentAvailability.js";
import { endLeadPause, startLeadPause } from "../lib/agentLeadPause.js";
import { dushanbeStartOfMonth } from "../lib/dushanbeTime.js";
import { COUNTED_SHOWING_WHERE } from "../lib/tasks.js";
import { loadPendingOwnerQuestions } from "../lib/ownerQuestions.js";
import { loadPendingCallbackRequests, markCallbackDone } from "../lib/callbackRequests.js";
import { loadBotCapabilities } from "../messengers/botCapabilities.js";
import { answerOwnerQuestion } from "../lib/ownerQuestionAnswer.js";
import { transitionManagedCustomerCallback } from "../lib/customerCallbackLifecycle.js";
import { upload } from "../upload.js";
import { removeAgentAvatarFile, saveAgentAvatarFile } from "../lib/agentAvatarFile.js";
import { generateTotpSecret, generateTotpQrCode, verifyTotpCode } from "../lib/totp.js";
import { encryptSecret, decryptSecretSafe } from "../crypto.js";
import { logAudit } from "../lib/audit.js";
import {
  listActiveSessions,
  revokeSession,
  MAX_DEVICES,
} from "../lib/sessions.js";
import { isElevated, requireElevation } from "../lib/stepUp.js";
import { buildRegistrationOptions, confirmRegistration, listPasskeys, removePasskey, passkeyLoginEnabled } from "../lib/passkeys.js";
import { sendPushToAgent } from "../push.js";
import { buildRoyalScoreView } from "../lib/royalScore.js";
import { royalScoreEnabled } from "../lib/royalScoreSwitch.js";
import { canViewInvestigations } from "@royal-home/shared";
import { generateScoreAdvice, loadCachedScoreAdvice } from "../lib/scoreRecommendation.js";
import { loadEventPoints, scoreEventPoints, type ScoreEventKind } from "../lib/scoreJournal.js";
import { loadScoreEvents, buildEventPointsGuide } from "../lib/scoreJournal.js";
import { activeCallFor, markCallCancelled, talkSeconds } from "../lib/telephony/callTracker.js";
import { hangupCall, loadAriCredentials } from "../lib/telephony/ariClient.js";
import { operatorQueueState, setOperatorPaused } from "../lib/telephony/operatorQueue.js";
import { setNumberBlocked } from "../lib/telephony/stationBlacklist.js";
import { clientNamePhoneSafe, phoneSafeText } from "../lib/clientPhone.js";
import { logSystemError } from "../lib/systemError.js";
import { anyParams } from "../lib/routeParams.js";

export const meRouter = Router();

/** См. комментарий у места вызова (GET /me) — миграция слоя 4. */
function sanitizeThemeInPreferences(preferences: unknown): unknown {
  if (!preferences || typeof preferences !== "object") return preferences;
  const prefs = preferences as Record<string, unknown>;
  if (typeof prefs.theme !== "string") return preferences;
  return { ...prefs, theme: migrateLegacyTheme(prefs.theme) };
}

function toPublicAgent(agent: {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  role: string;
  avatarUrl: string | null;
}) {
  return agent;
}

meRouter.get("/", requireAuth, async (req, res) => {
  const agent = await prisma.agent.findUnique({
    where: { id: req.agent!.id },
    select: {
      id: true,
      fullName: true,
      phone: true,
      email: true,
      role: true,
      avatarUrl: true,
      preferences: true,
      totpEnabled: true,
      // Состояние приёма лидов: тумблер «не принимаю» и заморозка руководителем.
      // Отдаём оба — интерфейс обязан различать «я сам выключил» и «мне запретили».
      leadsPausedUntil: true,
      leadsPausedEndedAt: true,
      // Паузу мог поставить руководитель (24.09.2026) — тогда агент видит, кто и
      // почему, и кнопки «Вернуться в распределение» у него нет.
      leadsPausedReason: true,
      leadsPausedBy: { select: { fullName: true } },
      frozenAt: true,
      frozenReason: true,
      frozenReasonVoiceUrl: true,
      frozenReasonVoiceTranscript: true,
      // Привязка личного Telegram-чата (01.09.2026) — наружу только признак,
      // сам chatId сотруднику видеть незачем.
      telegramChatId: true,
      montageCopiesTelegram: true,
      telegramModeration: true,
      clipReviewTelegram: true,
    },
  });
  if (!agent) return res.status(404).json({ error: "Профиль не найден" });
  /* Признаки «оператор входящих» и «показывать значок телефонии» убраны 18.08.2026
   * вместе с самой ролью: рабочего места оператора и браузерной трубки больше нет,
   * а профиль не должен возить в браузер поля, по которым нечего показывать. */
  const { telegramChatId, montageCopiesTelegram, ...publicFields } = agent;
  // 14.09.2026: кнопка привязки Telegram нужна только назначенному монтажёру —
  // сверяем с Settings.videoMontajerAgentId, чтобы фронт мог спрятать её у всех
  // остальных (см. Profile.tsx::TelegramLinkSection).
  const montajerSettings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { videoMontajerAgentId: true },
  });
  res.json({
    ...toPublicAgent(publicFields),
    // Слой 4 (08.09.2026): preferences отдаются сырыми из БД (без Zod-схемы) —
    // если backfill (migrate-theme-2026.ts) на этом окружении ещё не прогнан,
    // theme может быть одним из шести удалённых id. Разворачиваем перед отдачей,
    // не полагаясь только на клиентскую страховку (store/uiPrefs.ts).
    preferences: sanitizeThemeInPreferences(publicFields.preferences),
    telegramLinked: !!telegramChatId,
    isVideoMontajer: montajerSettings?.videoMontajerAgentId === req.agent!.id,
    montageCopiesTelegram,
    permissions: [...req.agent!.permissions],
    // Акционер (10.10.2026): интерфейс прячет кнопки изменений; сервер всё равно
    // отклоняет запись по роли (auth/middleware.ts, isReadOnlyExemptRequest).
    readOnly: isReadOnlyRole(req.agent!.role),
  });
});

/**
 * «Копии монтажа в Telegram» (22.09.2026, lib/montageObservers.ts) — админ или
 * директор включает себе копии передач монтажёру. Роль проверяется здесь, а не
 * на фронте: остальным сотрудникам видеть сырые исходники незачем.
 */
meRouter.patch("/montage-copies", requireAuth, async (req, res) => {
  const role = req.agent!.role;
  if (role !== "ADMIN" && role !== "DIRECTOR") {
    return res.status(403).json({ error: "Копии монтажа доступны только администратору" });
  }
  const parsed = montageCopiesUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Проверьте поля", details: parsed.error.flatten() });
  const updated = await prisma.agent.update({
    where: { id: req.agent!.id },
    data: { montageCopiesTelegram: parsed.data.montageCopiesTelegram },
    select: { montageCopiesTelegram: true, telegramChatId: true },
  });
  logAudit(req, "MONTAGE_COPIES_TOGGLE", "Agent", req.agent!.id, { enabled: updated.montageCopiesTelegram });
  res.json({ montageCopiesTelegram: updated.montageCopiesTelegram, telegramLinked: !!updated.telegramChatId });
});

/**
 * Шаг 1 привязки личного Telegram-чата (01.09.2026, lib/telegramAgentLink.ts) —
 * заводит одноразовый код и, если известно имя бота, готовую ссылку t.me/<бот>?start=<код>.
 * Сама привязка происходит, когда сотрудник переходит по ссылке (или пишет код
 * боту вручную) — обрабатывает telegram/bot.ts::handleAgentTelegramMessage.
 */
meRouter.post("/telegram-link", requireAuth, async (req, res) => {
  const { code, deepLink } = await createTelegramLinkCode(req.agent!.id);
  res.json({ code, deepLink });
});

/**
 * «Модерация в Telegram» (22.09.2026, lib/telegramModeration.ts): объекты на
 * проверке и досланные фото приходят в личный чат с кнопками решения. Включить
 * может только тот, у кого есть право модерации, — иначе кнопки ему всё равно
 * ответят «нет права».
 */
meRouter.patch("/telegram-moderation", requireAuth, async (req, res) => {
  const parsed = meTelegramModerationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  if (parsed.data.enabled && !req.agent!.can("properties.moderate")) {
    return res.status(403).json({ error: "Нет права модерации объектов" });
  }
  await prisma.agent.update({ where: { id: req.agent!.id }, data: { telegramModeration: parsed.data.enabled } });
  res.json({ telegramModeration: parsed.data.enabled });
});

/**
 * «Готовые ролики на проверку в Telegram» (25.09.2026, lib/clipReview.ts):
 * ролик от монтажёра приходит видео с кнопками «Одобрить» / «Вернуть монтажёру».
 * Включить может руководство или тот, у кого есть право модерации, — то же
 * правило, что проверяет каждое нажатие (canReviewClip).
 */
meRouter.patch("/clip-review-telegram", requireAuth, async (req, res) => {
  const parsed = meTelegramModerationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  const role = req.agent!.role;
  if (parsed.data.enabled && role !== "ADMIN" && role !== "DIRECTOR" && !req.agent!.can("properties.moderate")) {
    return res.status(403).json({ error: "Проверять ролики может руководство или модератор объектов" });
  }
  await prisma.agent.update({ where: { id: req.agent!.id }, data: { clipReviewTelegram: parsed.data.enabled } });
  logAudit(req, "CLIP_REVIEW_TELEGRAM_TOGGLE", "Agent", req.agent!.id, { enabled: parsed.data.enabled });
  res.json({ clipReviewTelegram: parsed.data.enabled });
});

/** Отвязка — на случай смены телефона/чата. Обычный сброс поля, без подтверждения
 *  паролем: это не способ закрыть чужой вход (в отличие от 2FA ниже). */
meRouter.post("/telegram-unlink", requireAuth, async (req, res) => {
  await prisma.agent.update({ where: { id: req.agent!.id }, data: { telegramChatId: null, telegramLinkCode: null } });
  logAudit(req, "TELEGRAM_UNLINKED", "Agent", req.agent!.id);
  res.json({ ok: true });
});

/**
 * Шаг 1 включения 2FA: генерирует новый секрет, сохраняет зашифрованным, но
 * totpEnabled остаётся false, пока не подтверждён код на /2fa/confirm — так
 * не отрезаем себе вход неподтверждённым/неверно отсканированным секретом.
 * Повторный вызов просто перезаписывает предыдущий неподтверждённый секрет.
 *
 * requireElevation (13.08.2026): включение 2FA — это способ ЗАКРЫТЬ вход другому.
 * С чужой открытой вкладки можно было привязать свой аутентификатор, и настоящий
 * владелец учётки со следующего входа упирался бы в код, которого у него нет.
 * Одной живой сессии для этого мало — нужен пароль.
 */
meRouter.post("/2fa/setup", requireAuth, requireElevation, async (req, res) => {
  const agent = await prisma.agent.findUnique({ where: { id: req.agent!.id } });
  if (!agent) return res.status(404).json({ error: "Профиль не найден" });
  if (agent.totpEnabled) {
    return res.status(409).json({ error: "2FA уже включена — сначала отключите её" });
  }
  const secret = generateTotpSecret();
  await prisma.agent.update({ where: { id: agent.id }, data: { totpSecret: encryptSecret(secret) } });
  const qrCodeDataUrl = await generateTotpQrCode(agent.phone, secret);
  res.json({ qrCodeDataUrl, secret });
});

const totpCodeSchema = z.object({ code: z.string().min(6).max(6) });

meRouter.post("/2fa/confirm", requireAuth, requireElevation, async (req, res) => {
  const parsed = totpCodeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверный код" });
  const agent = await prisma.agent.findUnique({ where: { id: req.agent!.id } });
  if (!agent?.totpSecret) {
    return res.status(400).json({ error: "Сначала запросите QR-код (/2fa/setup)" });
  }
  const secret = decryptSecretSafe(agent.totpSecret)!;
  if (!verifyTotpCode(agent.phone, secret, parsed.data.code)) {
    return res.status(401).json({ error: "Неверный код — проверьте время на телефоне и попробуйте снова" });
  }
  await prisma.agent.update({ where: { id: agent.id }, data: { totpEnabled: true } });
  // Отключение пишется (TOTP_DISABLE ниже), включение — тоже (G13, 02.10.2026).
  logAudit(req, "TOTP_ENABLE", "Agent", agent.id);
  res.json({ totpEnabled: true });
});

const disable2faSchema = z.object({ code: z.string().min(6).max(6) });

/** Отключение 2FA — ТОЛЬКО по коду из приложения-аутентификатора, не по паролю:
 * иначе украденный пароль позволял бы снять 2FA и обесценить её. Потерян телефон —
 * 2FA сбрасывает директор в Настройках (см. agents.ts /2fa/reset).
 *
 * requireElevation (ночная проверка 24.09.2026): отключение меняет способ входа
 * так же, как включение, а стояло без подтверждения личности — единственное из
 * трёх действий /2fa. Перебор кода закрывает totpLimiter на /me/2fa (app.ts). */
meRouter.post("/2fa/disable", requireAuth, requireElevation, async (req, res) => {
  const parsed = disable2faSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Введите код из приложения-аутентификатора" });
  const agent = await prisma.agent.findUnique({ where: { id: req.agent!.id } });
  if (!agent) return res.status(404).json({ error: "Профиль не найден" });
  if (!agent.totpEnabled || !agent.totpSecret) {
    return res.status(400).json({ error: "2FA не включена" });
  }
  const secret = decryptSecretSafe(agent.totpSecret)!;
  if (!verifyTotpCode(agent.phone, secret, parsed.data.code)) {
    return res.status(401).json({ error: "Неверный код" });
  }
  await prisma.agent.update({ where: { id: agent.id }, data: { totpEnabled: false, totpSecret: null } });
  logAudit(req, "TOTP_DISABLE", "Agent", agent.id);
  res.json({ totpEnabled: false });
});

/**
 * КЛЮЧИ ВХОДА ПО ОТПЕЧАТКУ И ЛИЦУ (passkeys). Возвращены 19.10.2026.
 *
 * Привязка — только для уже вошедшего сотрудника и только к своей учётке: чужой
 * ключ чужому человеку привязать нельзя. Сам вход по ключу живёт в routes/auth.ts
 * (он публичный — человек ещё не вошёл).
 *
 * ПРИВЯЗКА ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ЛИЧНОСТИ (requireElevation). Привязанный ключ —
 * постоянный вход, не зависящий от сессии: минуты у чужого открытого ноутбука
 * хватало бы, чтобы приложить свой палец и получить доступ навсегда. Свежий вход
 * кодом или отпечатком уже открывает это окно (routes/auth.ts), а после его
 * истечения нужен код (/auth/step-up). О привязке уходит уведомление владельцу.
 *
 * Список (GET) подтверждения не требует: посмотреть свои устройства безопасно.
 */
meRouter.get("/passkeys", requireAuth, async (req, res) => {
  res.json(await listPasskeys(req.agent!.id));
});

meRouter.post("/passkeys/options", requireAuth, requireElevation, async (req, res) => {
  if (!(await passkeyLoginEnabled())) return res.status(403).json({ error: "Вход по отпечатку или лицу временно отключён" });
  const options = await buildRegistrationOptions(req.agent!.id);
  if (!options) return res.status(404).json({ error: "Профиль не найден" });
  res.json(options);
});

const passkeyConfirmSchema = z.object({
  response: z.record(z.string(), z.unknown()),
  deviceName: z.string().max(80).optional(),
});

meRouter.post("/passkeys/confirm", requireAuth, requireElevation, async (req, res) => {
  if (!(await passkeyLoginEnabled())) return res.status(403).json({ error: "Вход по отпечатку или лицу временно отключён" });
  const parsed = passkeyConfirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });
  const result = await confirmRegistration(req.agent!.id, parsed.data.response as never, parsed.data.deviceName);
  if (!result.ok) return res.status(400).json({ error: result.error });
  logAudit(req, "PASSKEY_ADD", "Agent", req.agent!.id);
  // Уведомление самому владельцу учётки: если ключ привязал не он, узнать об этом
  // надо сразу. В фоне и с обработкой отказа: недоставленный push не повод
  // отменять уже привязанный ключ.
  void sendPushToAgent(req.agent!.id, {
    title: "🔐 Привязано устройство для входа",
    body: `К вашей учётке привязан вход по отпечатку или лицу${
      parsed.data.deviceName ? ` (${parsed.data.deviceName})` : ""
    }. Если это не вы — отвяжите его в Профиле и сообщите директору.`,
    url: "/profile",
    tag: `passkey-added-${req.agent!.id}`,
  }).catch((err) => console.error("[passkeys] Push о привязке не отправлен:", err instanceof Error ? err.message : err));
  res.json({ ok: true });
});

meRouter.delete("/passkeys/:id", requireAuth, requireElevation, async (req, res) => {
  const removed = await removePasskey(req.agent!.id, req.params.id);
  if (!removed) return res.status(404).json({ error: "Ключ не найден" });
  logAudit(req, "PASSKEY_REMOVE", "Agent", req.agent!.id);
  res.json({ ok: true });
});

/** Настройки оформления сохраняются целиком (PUT-семантика): клиент всегда шлёт полный объект. */
meRouter.put("/preferences", requireAuth, async (req, res) => {
  const parsed = uiPreferencesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const agent = await prisma.agent.update({
    where: { id: req.agent!.id },
    data: { preferences: parsed.data },
    select: { preferences: true },
  });
  res.json(agent.preferences ?? {});
});

/**
 * Кабинет Royal Score: счёт, место, «что изменилось сегодня», динамика.
 *
 * Лежит в /me нарочно: агент видит только СВОЙ разбор. Чужие счета живут в
 * рейтинге (TOP AGENTS) и на экране «Команда» — там без построчного разбора.
 */
meRouter.get("/royal-score", requireAuth, async (req, res) => {
  // Рубильник модуля (Настройки → Команда, владелец 15.09.2026): выключен —
  // кабинета нет вовсе, а не «пустой/нулевой». Фронт по этому маркеру не
  // рендерит карточку, даже если её вызвали в обход интерфейса.
  if (!(await royalScoreEnabled())) {
    return res.status(404).json({ error: "Royal Score отключён", disabled: true });
  }
  // Разбор и журнал — одним запросом: агент открывает кабинет один раз и должен
  // увидеть и «сколько», и «за что». Двумя запросами журнал подгружался бы вторым
  // и выглядел бы необязательным дополнением, каким он как раз не является.
  const [view, events, cachedAdvice, pointsGuide] = await Promise.all([
    buildRoyalScoreView(req.agent!.id),
    loadScoreEvents(req.agent!.id, 30),
    loadCachedScoreAdvice(req.agent!.id),
    buildEventPointsGuide(),
  ]);
  if (!view) return res.status(404).json({ error: "Агент не найден" });
  // Владелец 05.08.2026: совет должен появляться сам, а не только по кнопке.
  // Кэш пуст/старше суток — генерируем прямо в этом же запросе (Gemini отвечает
  // за секунды, кабинет открывается не на каждый чих). Отказ модели не должен
  // блокировать остальной кабинет — счёт и журнал показываем в любом случае.
  // Роль «только просмотр» (акционер, 10.10.2026): чтение кабинета не запускает
  // ИИ и не пишет кэш совета — GET для неё обязан быть без побочных действий
  // (ревью Codex: GET, который генерирует и сохраняет, обходил запрет записи).
  const advice =
    cachedAdvice ??
    (isReadOnlyRole(req.agent!.role)
      ? null
      : await generateScoreAdvice(
          req.agent!.id,
          view.liveScore,
          view.categoryBreakdown,
          events.map((e) => ({ reason: e.reason, delta: e.delta }))
        ).catch(() => null));
  res.json({ ...view, events, advice, pointsGuide });
});

/**
 * Обновить ИИ-совет по Royal Score прямо сейчас, минуя суточный кэш —
 * кнопка «Обновить» в кабинете, для того кто не хочет ждать сутки.
 * Сам совет уже появляется без неё при первом открытии кабинета за сутки
 * (см. GET выше) — кнопка только форсирует более ранний пересчёт.
 */
meRouter.post("/royal-score/advice", requireAuth, async (req, res) => {
  if (!(await royalScoreEnabled())) {
    return res.status(404).json({ error: "Royal Score отключён", disabled: true });
  }
  const [view, events] = await Promise.all([
    buildRoyalScoreView(req.agent!.id),
    loadScoreEvents(req.agent!.id, 15),
  ]);
  if (!view) return res.status(404).json({ error: "Агент не найден" });
  const advice = await generateScoreAdvice(
    req.agent!.id,
    view.liveScore,
    view.categoryBreakdown,
    events.map((e) => ({ reason: e.reason, delta: e.delta }))
  );
  if (!advice) return res.status(502).json({ error: "Не удалось получить рекомендацию, попробуйте позже" });
  res.json(advice);
});

/** Потолок событий Royal Score за один календарный месяц одного агента
 *  (22.09.2026, класс «Пагинация»): узко по agentId и месяцу, но само число
 *  строк не ограничено — с большим запасом над реальным темпом начислений. */
const SCORE_MONTH_EVENTS_CAP = 5000;

/** Сумма событий журнала (lib/scoreJournal.ts) по актуальным ценам за один
 *  период плюс три коммерческих показателя за тот же период — те же поля и
 *  определения, что в /hall-of-fame/top-agents и COUNTED_SHOWING_WHERE
 *  (проведённые показы, не назначенные). Один запрос на период, вызывается
 *  дважды в Promise.all ниже — не цикл с await по списку из базы. */
async function loadAgentMonthStats(
  agentId: string,
  start: Date,
  end: Date | undefined,
  eventPoints: Record<ScoreEventKind, number>
): Promise<{ points: number; acceptedClients: number; showings: number; deals: number }> {
  const atRange = end ? { gte: start, lt: end } : { gte: start };
  const [events, acceptedClients, showings, deals] = await Promise.all([
    prisma.royalScoreEvent.findMany({
      where: { agentId, at: atRange },
      select: { kind: true, delta: true, sourceId: true },
      take: SCORE_MONTH_EVENTS_CAP,
    }),
    // Принятые заявки — момент ПРИЁМА (acceptedAt), не назначения: агент против
    // себя сравнивает то, что сам сделал в этом месяце, а не что ему раздали.
    prisma.client.count({ where: { assignedAgentId: agentId, acceptedAt: atRange, deletedAt: null } }),
    prisma.interaction.count({
      // subjectAgentId ?? agentId (П-10, 17.09.2026): показ, записанный ботом от
      // лица держателя карточки (agentId: null), всё равно его личная статистика —
      // как и раньше, когда agentId всегда был держателем независимо от автора.
      where: { OR: [{ agentId }, { subjectAgentId: agentId }], type: "SHOWING", ...COUNTED_SHOWING_WHERE, createdAt: atRange, client: { deletedAt: null } },
    }),
    prisma.deal.count({ where: { agentId, stage: "COMPLETED", closedAt: atRange } }),
  ]);
  if (events.length >= SCORE_MONTH_EVENTS_CAP) {
    void logSystemError("api", `Royal Score агента ${agentId}: событий за месяц больше ${SCORE_MONTH_EVENTS_CAP} — очки посчитаны по первым`);
  }
  const points =
    Math.round(events.reduce((acc, e) => acc + scoreEventPoints(e, eventPoints), 0) * 100) / 100;
  return { points, acceptedClients, showings, deals };
}

/**
 * «Вы против себя» на главной агента: очки и показатели этого и прошлого
 * календарного месяца по Душанбе. Сравнение с самим собой, не с коллегами —
 * места и очки коллег этот маршрут не отдаёт (директорский рейтинг — отдельно,
 * GET /hall-of-fame/top-agents).
 *
 * Очки — НЕ то же самое, что computeRoyalScore (там скользящее окно 30 дней,
 * см. lib/scoreJournal.ts): здесь календарный месяц, тем же способом —
 * сумма delta по актуальным ценам событий (Settings.royalScoreEventPoints).
 */
meRouter.get("/score-months", requireAuth, async (req, res) => {
  const agentId = req.agent!.id;
  const currentStart = dushanbeStartOfMonth();
  const previousStart = dushanbeStartOfMonth(new Date(currentStart.getTime() - 1));
  const eventPoints = await loadEventPoints();

  const [current, previous] = await Promise.all([
    loadAgentMonthStats(agentId, currentStart, undefined, eventPoints),
    loadAgentMonthStats(agentId, previousStart, currentStart, eventPoints),
  ]);

  res.json({
    current: { ...current, monthStart: currentStart.toISOString() },
    previous: { ...previous, monthStart: previousStart.toISOString() },
    pointsDiff: Math.round((current.points - previous.points) * 100) / 100,
  });
});

/** Журнал входов — каждый видит только СВОИ входы (кто/откуда/с какого устройства). */
meRouter.get("/logins", requireAuth, async (req, res) => {
  const logins = await prisma.loginLog.findMany({
    where: { agentId: req.agent!.id },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, ip: true, device: true, isNewDevice: true, createdAt: true },
  });
  res.json(logins);
});

/**
 * Активные устройства (Session) — не путать с /logins (историческим журналом входов).
 * Здесь только ЖИВЫЕ сессии: максимум MAX_DEVICES одновременно, отзывается вручную
 * («Выйти» на карточке устройства — например, у сотрудника сдох телефон, а сессия
 * там всё ещё активна) или сама протухает без /auth/refresh дольше 7 дней.
 */
meRouter.get("/sessions", requireAuth, async (req, res) => {
  const sessions = await listActiveSessions(req.agent!.id);

  // «Это устройство» больше НЕ угадывается тут по deviceKey — тот же браузер, но с
  // сессией, заведённой ДО раскатки X-Device-Id, не совпал бы с новым сгенерированным
  // id и не подсветился бы вовсе (риск случайно отозвать самого себя). Точное сравнение —
  // на фронте, через GET /auth/session (sid из refresh-cookie, см. auth.ts).
  res.json({
    maxDevices: MAX_DEVICES,
    sessions: sessions.map((s) => ({
      id: s.id,
      device: s.device,
      ip: s.ip,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
    })),
  });
});

meRouter.delete("/sessions/:id", requireAuth, async (req, res) => {
  const ok = await revokeSession(req.agent!.id, req.params.id);
  if (!ok) return res.status(404).json({ error: "Сессия не найдена" });
  // События безопасности учётки — в журнал (G13, 02.10.2026): разбирая угон,
  // руководитель должен видеть, когда и какое устройство выкинули.
  logAudit(req, "SESSION_REVOKED", "Agent", req.agent!.id, { sessionId: req.params.id });
  res.status(204).end();
});

meRouter.patch("/", requireAuth, async (req, res) => {
  const parsed = meUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const { email, ...rest } = parsed.data;

  const existing = await prisma.agent.findUnique({ where: { id: req.agent!.id } });
  if (!existing) return res.status(404).json({ error: "Профиль не найден" });

  const data: Record<string, unknown> = { ...rest };
  if (email !== undefined) data.email = email || null;

  if (rest.phone && rest.phone !== existing.phone) {
    /**
     * Телефон — это ЛОГИН и адрес, куда уходит код входа. Одним access-токеном
     * (15 минут жизни) его менять нельзя: оставленная на чужом компьютере вкладка
     * молча уводила бы вход навсегда. Нужно свежее подтверждение личности кодом на
     * СТАРЫЙ номер (/auth/step-up).
     */
    if (!isElevated(req.agent!.id)) {
      return res.status(428).json({ error: "Подтвердите личность кодом, чтобы сменить номер", stepUpRequired: true });
    }
    const conflict = await prisma.agent.findUnique({ where: { phone: rest.phone } });
    if (conflict) return res.status(409).json({ error: "Этот телефон уже используется другим сотрудником" });
  }

  const agent = await prisma.agent.update({
    where: { id: req.agent!.id },
    data,
    select: { id: true, fullName: true, phone: true, email: true, role: true, avatarUrl: true },
  });

  // Телефон — это логин: его смена — событие безопасности (G13, 02.10.2026).
  if (rest.phone && rest.phone !== existing.phone) {
    logAudit(req, "PHONE_CHANGED", "Agent", req.agent!.id, { from: existing.phone, to: rest.phone });
  }
  res.json(toPublicAgent(agent));
});

meRouter.post("/avatar", requireAuth, upload.single("avatar"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не передан" });

  const before = await prisma.agent.findUnique({ where: { id: req.agent!.id }, select: { avatarUrl: true } });
  const avatarUrl = await saveAgentAvatarFile(req.agent!.id, req.file.buffer);
  const agent = await prisma.agent.update({
    where: { id: req.agent!.id },
    data: { avatarUrl },
    select: { id: true, fullName: true, phone: true, email: true, role: true, avatarUrl: true },
  });
  // Прежний файл больше не нужен и лежит в открытой uploads (G18, 02.10.2026).
  await removeAgentAvatarFile(agent.id, before?.avatarUrl);
  res.json(toPublicAgent(agent));
});

/**
 * «Не принимаю лиды» — агент временно выходит из распределения сам.
 *
 * Срок ставит система, а не агент: он просит часы, сервер обрезает их потолком из
 * Настроек. Без потолка тумблер превратился бы в способ не работать неделями, а
 * без самого тумблера агент на больничном молча копил бы непринятые заявки, за
 * которые ему потом падал KPI.
 *
 * KPI во время паузы идёт как обычно — прямое требование спецификации: текущие
 * клиенты никуда не делись, и если пауза обнуляла бы просрочки, её включали бы
 * ровно ради этого.
 */
meRouter.post("/lead-pause", requireAuth, async (req, res) => {
  const parsed = leadPauseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const agent = await prisma.agent.findUnique({
    where: { id: req.agent!.id },
    select: { fullName: true, leadsPausedUntil: true, leadsPausedEndedAt: true, frozenAt: true },
  });
  if (!agent) return res.status(404).json({ error: "Сотрудник не найден" });

  const limits = await loadPauseLimits();
  const verdict = canStartPause(agent, limits);
  if (!verdict.allowed) return res.status(409).json({ error: verdict.reason });

  const until = pauseEndsAt(parsed.data.hours, limits);
  // Непринятые лиды (кроме лидов по своему объекту) — обратно в раздачу, см. lib/agentLeadPause.ts.
  const { released } = await startLeadPause({
    agentId: req.agent!.id,
    until,
    actor: { id: req.agent!.id, fullName: agent.fullName },
    bySupervisor: false,
  });
  logAudit(req, "AGENT_LEAD_PAUSE", "Agent", req.agent!.id, { until: until.toISOString(), released });
  res.json({ ok: true, pausedUntil: until, maxHours: limits.maxHours, released });
});

/** Вернуться в распределение раньше срока. Отметка о конце паузы ставится здесь же —
 *  от неё считается «остыть сутки», иначе паузу включали бы заново каждый раз. */
meRouter.delete("/lead-pause", requireAuth, async (req, res) => {
  const agent = await prisma.agent.findUnique({
    where: { id: req.agent!.id },
    select: { id: true, leadsPausedUntil: true, leadsPausedById: true, frozenAt: true },
  });
  if (!agent) return res.status(404).json({ error: "Сотрудник не найден" });
  if (!availabilityOf(agent).pausedUntil) return res.status(409).json({ error: "Пауза не включена" });
  // Паузу руководителя снимает только руководитель (24.09.2026).
  if (agent.leadsPausedById && agent.leadsPausedById !== req.agent!.id) {
    return res.status(403).json({ error: "Паузу поставил руководитель — снять её может только он" });
  }

  await endLeadPause(agent);
  logAudit(req, "AGENT_LEAD_RESUME", "Agent", req.agent!.id, {});
  res.json({ ok: true });
});

/**
 * Что сейчас со звонком этого агента — единственный источник для экрана звонка.
 *
 * Опрашивается интерфейсом раз в секунду, пока звонок идёт, поэтому маршрут
 * намеренно пустой по стоимости: читает состояние из памяти процесса
 * (lib/telephony/callTracker.ts), в базу не ходит вовсе.
 *
 * null — звонка нет, кнопки свободны.
 */
meRouter.get("/active-call", requireAuth, (req, res) => {
  const call = activeCallFor(req.agent!.id);
  if (!call) return res.json(null);
  // Форма ответа описана в @royal-home/shared (ActiveCallView) и оттуда же читается
  // экраном вызова: пока тип был объявлен на обеих сторонах порознь, копии успели
  // разъехаться, и пропажу поля заметил бы живой агент посреди разговора, а не сборка.
  // Внутреннее состояние богаче (телефон клиента, внутренний номер, id записи в
  // хронологии) — наружу оно не уходит: телефон клиента агенту закрыт.
  const view: ActiveCallView = {
    channelId: call.channelId,
    clientId: call.clientId,
    clientShortId: call.clientShortId,
    // clientNamePhoneSafe (22.09.2026): у карточек незнакомых звонивших, заведённых
    // до 20.08.2026, номер лежит В ИМЕНИ («Входящий +992910001003») — поле `phone`
    // сюда не отдаётся как раз ради правила, а имя обходило его насквозь.
    clientName: call.clientName ? clientNamePhoneSafe(call.clientName, can(req, "clients.viewPhone")) : call.clientName,
    dialingTo: call.dialingTo,
    state: call.state,
    startedAt: call.startedAt.toISOString(),
    answeredAt: call.answeredAt?.toISOString() ?? null,
    // Секунды разговора считает сервер: у телефона в кармане агента и у браузера
    // время расходится, а спорить о длительности разговора никому не полезно.
    talkSeconds: talkSeconds(call),
    outcome: call.outcome ?? null,
    // Та же граница, что в finishCall (callTracker.ts): отмена засчитывается,
    // только если разговор так и не начался — иначе клиент успел ответить, и это
    // уже состоявшийся звонок, а не отмена.
    cancelled: !!call.cancelledByAgent && !call.answeredAt,
    clientRang: !!call.clientRang,
  };
  res.json(view);
});

/**
 * «Отменить» на полосе звонка — положить трубку за агента.
 *
 * Просьба владельца 13.08.2026: «можно отменять звонки, если они случайно пошли или
 * я передумал». До этого прервать начатый вызов из CRM было нечем — оставалось ждать,
 * пока станция устанет звонить, и всё это время кнопки «Позвонить» на других карточках
 * были заблокированы (см. hasLiveCall).
 *
 * ОТМЕНИТЬ МОЖНО ТОЛЬКО ДО РАЗГОВОРА. Как только клиент ответил, «отмена» теряет
 * смысл: связь состоялась, и итог этого разговора обязан быть записан как у любого
 * другого. Класть трубку за говорящего агента CRM тем более не должна — телефон у
 * него в руке.
 *
 * ПОРЯДОК ВАЖЕН: сначала пометка в памяти, потом сброс на станции. Если станция не
 * ответит (туннель к АТС отваливается регулярно), пометку снимаем и честно говорим,
 * что вызов идёт: нарисовать успех там, где телефон продолжает звонить, — худшее
 * из возможного, агент решит, что отменил, а клиент возьмёт трубку.
 *
 * Итог по-прежнему пишет обработчик событий станции (callTracker.finishCall) по
 * фактическому состоянию — см. комментарий к `cancelledByAgent`.
 */
meRouter.post("/active-call/cancel", requireAuth, async (req, res) => {
  const call = activeCallFor(req.agent!.id);
  if (!call || call.state === "ended") return res.status(404).json({ error: "Активного звонка нет" });
  if (call.state === "talking") {
    return res.status(409).json({ error: "Разговор уже идёт — завершите его с телефона" });
  }

  const creds = await loadAriCredentials();
  if (!creds) return res.status(503).json({ error: "Телефония не настроена" });

  const marked = markCallCancelled(call.channelId);
  if (!marked) return res.status(404).json({ error: "Активного звонка нет" });

  const result = await hangupCall(creds, call.channelId);
  if (!result.ok) {
    marked.cancelledByAgent = false;
    return res.status(502).json({ error: `${result.error}. Сбросьте вызов с телефона` });
  }
  res.json({ ok: true });
});

/**
 * Кто вправе управлять приёмом входящих: тот, кто распределяет обращения или читает
 * журнал звонков.
 *
 * СПИСОК ОПЕРАТОРОВ ИЗ НАСТРОЕК ОТСЮДА УБРАН 18.08.2026 вместе с самой ролью
 * (решение владельца): оператора входящих больше нет, и проверять членство в
 * несуществующем списке значило бы держать ветку, которая никогда не выполнится.
 * Круг сузился только на бумаге — все, кто реально жал эти кнопки, обладают одним
 * из двух прав.
 */
function canManageIncoming(req: Request): boolean {
  return req.agent!.can("clients.assign") || req.agent!.can("calls.transcripts");
}

/**
 * «Я НА МЕСТЕ» / «ОТОШЁЛ» — оператор снимает себя с приёма входящих.
 *
 * Пока оператор числится в очереди, станция звонит ему и на обеде, и в дороге:
 * клиент слушает гудки пятнадцать секунд, а потом попадает в тишину. Снять себя
 * человек мог только через панель FreePBX, куда у него нет доступа.
 *
 * Состояние ЖИВЁТ НА СТАНЦИИ, а не в CRM: звонки распределяет она, и вторая копия
 * признака означала бы «в CRM отошёл, а телефон звонит».
 */
const queuePauseSchema = z.object({ paused: z.boolean() });

meRouter.post("/queue-pause", requireAuth, async (req, res) => {
  if (!canManageIncoming(req)) {
    return res.status(403).json({ error: "Управлять приёмом входящих может оператор или руководитель" });
  }
  const parsed = queuePauseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Проверьте поля", details: parsed.error.flatten() });
  const extension = req.agent!.sipExtension;
  if (!extension) return res.status(409).json({ error: "У вас не настроен внутренний номер" });

  const result = await setOperatorPaused(extension, parsed.data.paused, "CRM");
  // 502, а не 500: отказала не CRM, а станция за туннелем — и человеку важно
  // прочитать именно её причину, иначе он будет жать кнопку снова.
  if (!result.ok) return res.status(502).json({ error: result.error });
  logAudit(req, "OPERATOR_QUEUE_PAUSE", "Agent", req.agent!.id, { paused: parsed.data.paused, queue: result.queue });
  res.json({ paused: result.paused, queue: result.queue });
});

/** Текущее состояние в очереди — кнопка обязана показывать правду станции. */
meRouter.get("/queue-pause", requireAuth, async (req, res) => {
  if (!canManageIncoming(req)) return res.json(null);
  const extension = req.agent!.sipExtension;
  if (!extension) return res.json(null);
  const state = await operatorQueueState(extension);
  if (!state.ok) return res.json({ available: false, error: state.error });
  if (!state.membership) return res.json({ available: false, error: "Вы не числитесь в очереди станции" });
  res.json({ available: true, paused: state.membership.paused, queue: state.membership.queue });
});

/**
 * «БОЛЬШЕ НЕ ЗВОНИТЬ С ЭТОГО НОМЕРА» — реклама, автообзвон, ошиблись номером.
 *
 * Отбивает звонок САМА СТАНЦИЯ, до того как чей-то телефон зазвонил: пометка в
 * карточке этого не умеет — человек всё равно снимает трубку. Работает без правки
 * станции: проверка чёрного списка уже стоит во входящем маршруте FreePBX, а сам
 * список лежит в её внутренней базе (см. lib/telephony/stationBlacklist.ts).
 *
 * Номер берётся ИЗ ЗВОНКА, а не из тела запроса: так его нельзя подставить чужим и
 * заблокировать, скажем, номер конкурента... или собственного клиента.
 */
const blockCallerSchema = z.object({ blocked: z.boolean() });

meRouter.post("/incoming-call/:id/block-caller", requireAuth, async (req, res) => {
  if (!canManageIncoming(req)) {
    return res.status(403).json({ error: "Блокировать номера может оператор или руководитель" });
  }
  const parsed = blockCallerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Проверьте поля", details: parsed.error.flatten() });

  const call = await prisma.incomingCall.findUnique({ where: { id: req.params.id }, select: { phone: true } });
  if (!call) return res.status(404).json({ error: "Звонок не найден" });

  const result = await setNumberBlocked(call.phone, parsed.data.blocked);
  if (!result.ok) return res.status(502).json({ error: result.error });
  logAudit(req, "CALLER_BLACKLIST", "IncomingCall", req.params.id, { blocked: parsed.data.blocked });
  res.json({ blocked: parsed.data.blocked });
});

/* Обязательные окна итогов убраны 14.09.2026 вместе с механизмом (решение владельца):
   ветвления «Итог показа»/«Итог объекта»/«Итог приёмки»/«Итог звонка»/«Проверьте карточку»,
   их схемы и обработчики жили здесь. Отказ клиента и передача карточки остались
   собственными формами (POST /clients/:id/refuse, lib/clientTransfer.ts) — они от окон
   не зависели. */
/** Сохранить файл в закрытое хранилище и расшифровать — для
 *  generic-эндпоинта /me/voice-notes (см. его докстринг). url — путь ЧЕРЕЗ api() (BASE_URL уже "/api/v1" на фронте), не
 *  голый /uploads/... — иначе тег <audio src> ушёл бы за проверку прав. */
async function saveAndTranscribeVoiceNote(file: Express.Multer.File): Promise<{ url: string; transcript: string | null }> {
  // Свой подкаталог, а не общая папка вложений: ночная уборка вложений через
  // 180 дней стирала и заметки (G2, 02.10.2026, lib/privateFiles.ts).
  const filename = await saveVoiceNoteFile(file.buffer, file.mimetype);
  if (!filename) throw new Error(`Неподдерживаемый формат аудио: ${file.mimetype}`);
  const url = `/me/voice-notes/${filename}`;
  const transcript = await transcribeAudio(file.buffer, file.originalname || "voice.webm", file.mimetype);
  return { url, transcript: transcript?.trim() || null };
}

/**
 * ВЫДАЧА голосовой заметки — requireAuth и ничего больше: любой действующий
 * сотрудник CRM. Полная привязка «слушает только автор записи + руководство»
 * потребовала бы проверки владельца отдельно для каждой из шести таблиц, где
 * эти поля живут (Interaction, Agent, JobApplication, ProblemReport, Property,
 * ClientDeleteRequest/PropertyDeleteRequest) — непропорционально этой правке.
 * Главная дыра (файл открывался БЕЗ ЛОГИНА кем угодно в интернете, зная имя)
 * закрыта; сузить до «только причастные» — отдельная задача, если понадобится.
 * Имя — тот же приём, что в routes/attachments.ts: только наш uuid.ext, второй
 * рубеж от обхода пути — в privateFilePath.
 */
meRouter.get("/voice-notes/:name", requireAuth, async (req, res) => {
  const name = req.params.name;
  if (typeof name !== "string" || name.length > 128) return res.status(400).json({ error: "Неверное имя файла" });
  const found = voiceNoteFilePath(name);
  if (!found) return res.status(404).json({ error: "Файл не найден" });
  const fullPath = found.path;
  // Заметки до 02.10.2026 лежат в общей папке с вложениями клиентов из переписки
  // (23.09.2026): вложения здесь не отдаём — иначе любой сотрудник, зная имя,
  // обходил право на вложения и сверку владельца клиента (routes/attachments.ts).
  // Тот же ответ, что на «нет файла». Подкаталог заметок пишет только этот
  // маршрут, там проверка не нужна — и три скана переписок на каждую выдачу тоже.
  if (found.legacy && (await isConversationAttachment(name))) return res.status(404).json({ error: "Файл не найден" });
  // A previously disclosed URL cannot bypass the current investigation boundary.
  if (!canReadInvestigations(req) && await prisma.interaction.findFirst({
    where: { investigationOnly: true, voiceNoteUrl: { endsWith: `/${name}` } },
    select: { id: true },
  })) return res.status(404).json({ error: "Файл не найден" });
  res.setHeader("Content-Type", privateMimeType(name));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.sendFile(path.basename(fullPath), { root: path.dirname(fullPath), cacheControl: false, dotfiles: "deny" }, (err) => {
    if (!err) return;
    console.error("[voice-notes] не удалось отдать файл:", err instanceof Error ? err.message : err);
    if (res.headersSent) res.end();
    else res.status(500).json({ error: "Не удалось прочитать файл" });
  });
});

/**
 * ГОЛОСОВАЯ ЗАМЕТКА БЕЗ ПРИВЯЗКИ К ТРЕБОВАНИЮ (01.09.2026) — та же кнопка
 * микрофона, что и в форме итога (см. выше), для форм, где нет PendingSummary:
 * заморозка сотрудника, отказ вакансии, разбор проблем и т.п. Каждая из них
 * сама решает, куда положить вернувшийся url/transcript (см. агент-роут
 * /agents/:id/freeze и его аналоги) — этот эндпоинт только записывает файл и
 * расшифровывает, привязки не знает.
 */
// Платная расшифровка: свой потолок на сотрудника (находка №149).
const voiceNoteLimiter = agentSpeechLimiter("на голосовые заметки");

meRouter.post("/voice-notes", requireAuth, voiceNoteLimiter, anyParams(voiceMessageUpload.single("audio")), (req, res) => {
  void (async () => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Аудио не передано" });
    res.json(await saveAndTranscribeVoiceNote(file));
  })().catch(async (err) => {
    await logSystemError("api", `Голосовая заметка не сохранена: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) res.status(500).json({ error: "Не удалось сохранить голосовую заметку" });
  });
});

/**
 * Вопросы, которые бот пообещал уточнить у собственника.
 *
 * ТОЛЬКО АДМИНИСТРАТИВНАЯ ЧАСТЬ (владелец 05.08.2026 — пересмотрел решение от
 * 01.08). Раньше было видно всем сотрудникам («обещание от имени компании,
 * ответить может тот, кто первым дозвонился собственнику»), но рядовые агенты
 * видели чужие вопросы без контекста, и это только путало. `dashboard.analytics`
 * переиспользован как маркер «руководящая часть» — заводить отдельное право под
 * один экран незачем. Право проверяется и здесь, и на фронте (`OwnerQuestionsBanner`)
 * — фронт может скрыть кнопку, но не должен быть единственной защитой.
 */
meRouter.get("/owner-questions", requireAuth, requirePermission("dashboard.analytics"), async (req, res) => {
  const fullPhone = can(req, "clients.viewPhone");
  const items = await loadPendingOwnerQuestions(20, req.agent!.id);
  res.json({ items: items.map(item => ({ ...item, question: phoneSafeText(item.question, fullPhone),
    answer: phoneSafeText(item.answer, fullPhone), clientName: phoneSafeText(item.clientName, fullPhone),
    propertyTitle: phoneSafeText(item.propertyTitle, fullPhone) })) });
});

/**
 * Очередь «клиент просит звонок» (см. lib/callbackRequests.ts). Право —
 * messages.view, а не dashboard.analytics: звонит тот, кто работает с перепиской,
 * а не тот, кто смотрит аналитику.
 *
 * ОЧЕРЕДИ НЕТ, ПОКА НЕТ ОПЕРАТОРА (владелец 23.08.2026). Выключенный рубильник
 * «Соединять с оператором» означает, что просьбы о звонке идут обычными заявками к
 * агентам, — и тогда пустой ответ гасит баннер на всех экранах сразу. Условие живёт
 * здесь, а не во фронте: одно место правды, и старая вкладка в браузере не покажет
 * очередь, которой больше нет.
 */
meRouter.get("/callback-requests", requireAuth, async (req, res) => {
  if (!can(req, "messages.view") && !can(req, "messages.viewOwn")) return res.status(403).json({ error: "Нет доступа к переписке" });
  const query = z.object({ conversationId: z.string().uuid().optional() }).strict().safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: "Неверный диалог" });
  const capabilities = await loadBotCapabilities();
  // Номер и имя — по праву на телефон клиента, а не по праву на сообщения:
  // `messages.view` есть у менеджера, `clients.viewPhone` у него нет.
  res.json({ items: await loadPendingCallbackRequests(can(req, "clients.viewPhone"), 20, {
    includeLegacy: capabilities.callback, staffAgentId: req.agent!.id, ...query.data,
  }) });
});

meRouter.post("/callback-requests/:id/transition", requireAuth, async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id), body = customerRequestTransitionSchema.safeParse(req.body);
  if (!id.success || !body.success) return res.status(400).json({ error: "Неверные данные запроса" });
  const result = await transitionManagedCustomerCallback(req, { requestId: id.data, ...body.data });
  if (result.status !== "applied") return res.status(result.status === "not_found" ? 404 : result.status === "denied" ? 403 :
    result.status === "unknown" ? 503 : 409).json({ error: "Запрос изменился или недоступен", code: result.status });
  logAudit(req, "CUSTOMER_REQUEST_TRANSITION", "CallbackRequest", id.data, { action: body.data.action });
  res.json({ ok: true, task: result.task });
});

meRouter.post("/callback-requests/:id/done", requireAuth, requirePermission("messages.view"), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id), body = customerRequestCloseSchema.safeParse(req.body ?? {});
  if (!id.success || !body.success) return res.status(400).json({ error: "Неверные данные запроса" });
  const existing = await prisma.callbackRequest.findUnique({ where: { id: id.data }, select: { customerActionId: true } });
  if (existing?.customerActionId) {
    if (!body.data.expectedRevision) return res.status(409).json({ error: "Обновите запрос перед закрытием", code: "revision_required" });
    const result = await transitionManagedCustomerCallback(req, { requestId: id.data, expectedRevision: body.data.expectedRevision, action: "close" });
    if (result.status !== "applied") return res.status(result.status === "denied" ? 403 : result.status === "unknown" ? 503 : 409)
      .json({ error: "Запрос изменился или недоступен", code: result.status });
    logAudit(req, "CUSTOMER_REQUEST_TRANSITION", "CallbackRequest", id.data, { managed: true, action: "close" });
    return res.json({ ok: true, task: result.task });
  }
  const ok = await markCallbackDone(req.params.id, req.agent!.id);
  // Уже закрыт коллегой — не ошибка, а нормальная гонка двух агентов: сообщаем как факт.
  if (!ok) return res.status(409).json({ error: "Запрос уже закрыт" });
  logAudit(req, "CALLBACK_DONE", "CallbackRequest", req.params.id, {});
  res.json({ ok: true });
});

/** Ответ уходит клиенту сам — сотрудник ничего не пересылает руками. */
meRouter.post("/owner-questions/:id/answer", requireAuth, requirePermission("dashboard.analytics"), async (req, res) => {
  const parsed = ownerAnswerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "Неверный идентификатор вопроса" });
  const result = await answerOwnerQuestion(req.params.id, parsed.data.answer, req.agent!.id,
    parsed.data.expectedRevision ? { expectedRevision: parsed.data.expectedRevision } : undefined);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  logAudit(req, "OWNER_QUESTION_ANSWER", "OwnerQuestion", req.params.id, { delivered: result.delivered });
  res.json({
    ok: true,
    delivered: result.delivered,
    ...("deliveryStatus" in result ? { deliveryStatus: result.deliveryStatus, managedRevision: result.managedRevision } : {}),
    // Честно различаем «ответил» и «клиент получил»: сеть могла подвести, и тогда
    // сотрудник должен узнать об этом сразу, а не считать вопрос закрытым.
    message: result.delivered
      ? "Ответ отправлен клиенту"
      : "deliveryStatus" in result && result.deliveryStatus === "HELD"
        ? "Ответ сохранён. Автоматическая отправка в исходный диалог пока недоступна; проверьте его перед отправкой вручную."
        : "Ответ сохранён, но отправить клиенту не удалось — напишите ему сами",
  });
});
