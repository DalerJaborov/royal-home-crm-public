import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
// express-async-errors УБРАН вместе с переходом на Express 5: там отклонённый
// промис из async-хендлера уходит в next(err) самим фреймворком. Пакет к тому же
// патчил `express/lib/router/layer`, которого в Express 5 просто нет.
import { z, ZodError } from "zod";
import { MulterError } from "multer";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { UploadRejectedError, uploadsDir } from "./upload.js";
import { verifyMediaToken } from "./auth/jwt.js";
import { signMediaUrlsInResponses } from "./lib/mediaJsonSign.js";
import { prisma } from "./db.js";
import { logSystemError } from "./lib/systemError.js";
import { StaffPhoneLeadError } from "./lib/staffPhoneGuard.js";
import { routeHitMiddleware, recordHit } from "./lib/routeHits.js";
import { requireAuth } from "./auth/middleware.js";
import { idempotencyGuard } from "./lib/idempotency.js";
import { pultWriteRefresh } from "./lib/pultWriteRefresh.js";
import { authRouter } from "./routes/auth.js";
import { testPasswordLoginRouter } from "./auth/testPasswordLogin.js";
import { meRouter } from "./routes/me.js";
import { notificationsRouter } from "./routes/notifications.js";
import { agentsRouter } from "./routes/agents.js";
import { districtsRouter } from "./routes/districts.js";
import { geoRouter } from "./routes/geo.js";
import { landmarksRouter } from "./routes/landmarks.js";
import { propertiesRouter } from "./routes/properties.js";
import { clientsRouter } from "./routes/clients.js";
import { dealsRouter } from "./routes/deals.js";
import { dealDocumentsRouter } from "./routes/dealDocuments.js";
import { dealPayoutRouter } from "./routes/dealPayout.js";
import { dealAnnulRouter } from "./routes/dealAnnul.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { missionControlRouter } from "./routes/dashboardMissionControl.js";
import { pultModulesRouter } from "./routes/pultModules.js";
import { briefingRouter } from "./routes/briefing.js";
import { calendarRouter } from "./routes/calendar.js";
import { interactionsRouter } from "./routes/interactions.js";
import { callsRouter } from "./routes/calls.js";
import { aiRouter } from "./routes/ai.js";
import { transcribeRouter } from "./routes/transcribe.js";
import { reportsRouter } from "./routes/reports.js";
import { settingsRouter } from "./routes/settings.js";
import { uiShellRouter } from "./routes/uiShell.js";
import { liveVoiceListenRouter } from "./routes/liveVoiceListen.js";
import { smsRouter } from "./routes/sms.js";
import { whatsappTemplatesRouter } from "./routes/whatsappTemplates.js";
import { settingsRestorePointsRouter } from "./routes/settingsRestorePoints.js";
import { telephonyWhisperRouter } from "./routes/telephonyWhisper.js";
import { pushRouter } from "./routes/push.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { publicFeedRouter } from "./routes/publicFeed.js";
import { expensesRouter } from "./routes/expenses.js";
import { financeRouter } from "./routes/finance.js";
import { teamRouter, agentOverviewRouter } from "./routes/team.js";
import { hallOfFameRouter } from "./routes/hallOfFame.js";
import { errorLogRouter } from "./routes/errorLog.js";
import { integrationsRouter } from "./routes/integrations.js";
import { stuckWorkRouter } from "./routes/stuckWork.js";
import { backupsRouter } from "./routes/backups.js";
import { botAuditRouter } from "./routes/botAudit.js";
import { importRouter } from "./routes/import.js";
import { siteNotificationsRouter } from "./routes/siteNotifications.js";
import { contactsRouter } from "./routes/contacts.js";
import { conversationsRouter } from "./routes/conversations.js";
import { auditLogRouter } from "./routes/auditLog.js";
import { royalScoreEventsRouter } from "./routes/royalScoreEvents.js";
import { morningReportRouter } from "./routes/morningReport.js";
import { botLearningRouter } from "./routes/botLearning.js";
import { botTrainerRouter } from "./routes/botTrainer.js";
import { botScenariosRouter } from "./routes/botScenarios.js";
import { botTrainingRouter } from "./routes/botTraining.js";
import { attachmentsRouter } from "./routes/attachments.js";
import { mediaProxyRouter } from "./routes/mediaProxy.js";
import { instagramCommentsRouter } from "./routes/instagramComments.js";
import { leadMagnetsRouter } from "./routes/leadMagnets.js";
import { vacanciesRouter } from "./routes/vacancies.js";
import { securityRouter } from "./routes/security.js";
import { manualDataCorrectionsRouter } from "./routes/manualDataCorrections.js";
import { marketingRouter } from "./routes/marketing.js";
import { socialVideosRouter } from "./routes/socialVideos.js";
import { adsRouter, adsCallbackRouter } from "./routes/ads.js";
import { tiktokRouter, tiktokCallbackRouter } from "./routes/tiktok.js";
import { threadsRouter, threadsCallbackRouter } from "./routes/threads.js";
import { searchConsoleRouter, searchConsoleCallbackRouter, yandexCallbackRouter } from "./routes/searchConsole.js";
import { budgetWebhookRouter } from "./routes/budgetWebhook.js";
import { oversightRouter } from "./routes/oversight.js";
import { insightsRouter } from "./routes/insights.js";
import { propertyShareRouter } from "./routes/propertyShare.js";
import { ownerReportPublicRouter } from "./routes/ownerReportPublic.js";
import { eventsRouter } from "./routes/events.js";
import { verifyAccessToken } from "./auth/jwt.js";
import { isTransientDbError } from "./lib/concurrency.js";
import { verifyPending2faToken } from "./lib/pending-2fa.js";
import { deepHealth } from "./lib/deepHealth.js";
// Побочный эффект: подписка модерации в Telegram на «объект ждёт проверки».
import "./lib/telegramModeration.js";

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";

export const app = express();
app.disable("x-powered-by");
// Express 5 сменил разбор строки запроса с "extended" (qs) на "simple"
// (querystring): вложенные `a[b]=c` перестают быть объектом и приезжают строкой
// с ключом «a[b]». Контракт с фронтом от обновления express меняться не должен —
// возвращаем прежний разбор явно, а не молча меняем поведение всех GET-роутов.
app.set("query parser", "extended");
// За реверс-прокси выставить TRUST_PROXY=1, чтобы rate-limit и логи видели реальные IP
// клиентов; без прокси держать выключенным — иначе IP можно подменить через X-Forwarded-For.
// В проде цепочка — Caddy, затем nginx контейнера web — ДВА хопа, а не один: с числовым
// значением 1 Express останавливался на первом (docker-шлюз nginx, 172.19.0.1) и все входы
// в журнале выглядели одинаковыми. Пресет "trust любой приватный/loopback адрес как прокси"
// устойчив к числу хопов и берёт первый публичный IP из X-Forwarded-For как клиентский.
app.set("trust proxy", process.env.TRUST_PROXY === "1" ? "loopback, linklocal, uniquelocal" : false);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
// helmet 8 больше не ставит Permissions-Policy сам (убрали из умолчаний —
// раньше был Feature-Policy). Пункт 6 аудита безопасности 11.09.2026 требует
// его явно: API не пользуется ни одной из этих возможностей браузера сам, и
// встроенное в страницу (если её вообще откроют напрямую, не как JSON-ответ)
// стороннее содержимое не должно получить к ним доступ через этот источник.
app.use((_req, res, next) => {
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()");
  next();
});
// exposedHeaders — иначе X-App-Build (см. ниже) уходит в ответе, но fetch() на
// фронте его молча не видит: браузер по умолчанию прячет от JS все заголовки
// ответа кроме небольшого «безопасного» списка при кросс-origin запросах.
app.use(cors({ origin: CORS_ORIGIN, credentials: true, exposedHeaders: ["X-App-Build"] }));

/**
 * ОТМЕТКА ВЕРСИИ СЕРВЕРА — независимый от service worker сигнал «сервер уже
 * обновился, а моя открытая вкладка — ещё нет» (владелец 20.08.2026, второе
 * исследование: агент может держать вкладку открытой весь день не сворачивая
 * и не переходя между разделами — оба триггера автообновления в
 * UpdatePrompt.tsx тогда молчат, а API тем временем уже сменил контракт).
 *
 * Момент запуска процесса, а не версия из package.json/git — каждый деплой
 * перезапускает процесс, значения хватает ровно на то, чтобы отличить «до
 * этого деплоя» от «после», без git/CI-плюмбинга. Фронт запоминает первое
 * увиденное значение за сессию и требует полной перезагрузки, если оно
 * поменялось — см. lib/appVersion.ts на фронте.
 */
const APP_BUILD_MARK = String(Date.now());
app.use((_req, res, next) => {
  res.setHeader("X-App-Build", APP_BUILD_MARK);
  next();
});
// JSON-боди ограничен явно: самые большие легитимные тела (описания объектов) — единицы КБ.
app.use(
  express.json({
    limit: "1mb",
    // Сырое тело нужно вебхуку Meta: он подписан HMAC по исходным байтам, а
    // пересобранный из объекта JSON отличается пробелами и порядком ключей —
    // подпись перестаёт сходиться. Сохраняем буфер, а не строку: подпись
    // считается по байтам, и перекодировка через строку её ломает.
    verify: (req, _res, buf) => {
      (req as { rawBody?: Buffer }).rawBody = buf;
    },
  })
);
/**
 * Express 5 отдаёт `req.body === undefined`, когда тело не разобрано (нет
 * заголовка Content-Type, пустой POST) — в Express 4 там был `{}`. Все роуты
 * читают тело только через zod (`safeParse(req.body)`), и `undefined` дал бы им
 * не «поле не заполнено», а «неверные данные» целиком. Возвращаем прежнюю
 * форму: обновление express не должно менять тексты ошибок валидации.
 */
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});
app.use(cookieParser());

/**
 * КАРТА ОБСЛЕДОВАННОГО (08.09.2026) — см. lib/routeHits.ts.
 *
 * Стоит ЗДЕСЬ, до роутеров, а считает на `finish`: `req.route` появляется
 * только после того, как express выбрал обработчик, поэтому раньше конца
 * ответа шаблон маршрута неизвестен. Наблюдение не трогает ни ответ, ни его
 * скорость — счёт идёт в памяти, в базу уходит пачкой раз в минуту.
 */
app.use(routeHitMiddleware);

// К11 (аудит безопасности 11.09.2026): подписываем ссылки на закрытые
// подкаталоги ПРЯМО В ОТВЕТЕ, до того как он уйдёт роутерам — см.
// lib/mediaJsonSign.ts, почему это одна точка, а не охота по местам.
app.use(signMediaUrlsInResponses);

/**
 * ГЕЙТ ПЕРЕД СТАТИКОЙ (К11). `video/`, `automontage/`, `handoff/` — черновики
 * монтажа и сырые исходники, не то же самое, что фото объектов (те публичны на
 * сайте намеренно и остаются открытыми как были). Пропускаем запрос дальше, к
 * `express.static`, только если у него есть НАШ подписанный токен (см.
 * lib/mediaJsonSign.ts / lib/crmPublicUrl.ts — обе точки, откуда ссылка вообще
 * может появиться снаружи) либо действующий access-токен CRM в заголовке —
 * второе на случай прямого обращения инструментом, у которого нет ссылки из
 * ответа API (Bearer добавить руками может только тот, кто уже вошёл в CRM).
 */
function requireMediaAccess(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const requestPath = req.baseUrl + req.path;
  const token = typeof req.query.t === "string" ? req.query.t : undefined;
  if (token && verifyMediaToken(token, requestPath)) return next();

  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    try {
      verifyAccessToken(auth.slice("Bearer ".length));
      return next();
    } catch {
      // невалидный/просроченный — падаем на отказ ниже, как и без заголовка
    }
  }
  res.status(403).json({ error: "Доступ к файлу закрыт" });
}

/**
 * Замок решает по тому же пути, который увидит раздача файлов: раскодированному
 * и нормализованному. Буквальный префикс обходился записью /uploads/%76ideo/…,
 * /uploads//video/… и /uploads/%2Fvideo/… — express.static сам раскодирует и
 * сводит их к той же закрытой папке (аудит 23.09.2026, №27; nginx передаёт
 * адрес как есть). Нераскодируемый путь не отдаём вовсе.
 */
const PRIVATE_UPLOAD_DIRS = /^\/(video|automontage|handoff)(\/|$)/i;
app.use("/uploads", (req, res, next) => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(req.path);
  } catch {
    res.status(400).json({ error: "Неверный адрес файла" });
    return;
  }
  const normalized = path.posix.normalize(decoded.replace(/\\/g, "/")).replace(/^\/+/, "/");
  if (PRIVATE_UPLOAD_DIRS.test(normalized)) return requireMediaAccess(req, res, next);
  next();
});
app.use("/uploads", express.static(uploadsDir));

/**
 * ЗВУКИ ТЕЛЕФОНИИ БЕЗ СЛЕДА В ЖУРНАЛЕ (найдено 11.09.2026, docs/TASKS.md:
 * «Файлы озвучки телефонии отдают 404 (~100 обращений за 20 часов)»,
 * docs/ui-audit-07-09-2026.md — «отдельно, вне скриншотов»).
 *
 * Станция (royalhome-audio-sync.sh на FreePBX, крон раз в 5 минут) сама ходит
 * за постоянными адресами `/uploads/telephony/(moh|greeting|queue|
 * agentDeclined).(wav|mp3)` — см. routes/settings.ts. Файлы туда кладёт ТОЛЬКО
 * ручная загрузка в Настройках (POST /settings/telephony-audio/:kind); пока
 * владелец не загрузил звук, файла на диске нет, и express.static выше честно
 * отвечает 404 — это ожидаемое состояние, не поломка (см. GET
 * /settings/telephony-audio: экран сам показывает, что не загружено). Но эта
 * строка тонет в сыром логе контейнера: «Здоровье системы» её не видит, и
 * директор узнаёт только руками залезая в docker logs, как и было найдено при
 * разборе скриншотов.
 *
 * Отдельная гонка «файл в базе есть, а на диске уже стёрт» в СОСЕДНЕМ
 * механизме — call-whisper-подсказках агенту (lib/telephony/whisperSync.ts,
 * routes/telephonyWhisper.ts, свой путь `/api/v1/telephony/whisper/file/:name`,
 * не под `/uploads`) — уже почищена 10.09.2026 (коммит `fa40aa26`) и логируется
 * там же своим кодом. Здесь другой мост: чисто статический, без обработчика
 * маршрута, значит без единой точки, где можно было бы записать отказ, — эта
 * ловушка ровно такая точка. Честный отказ станции не подменяется: файла как
 * не было, так и не будет, ниже просто дублируем факт в ErrorLog, дедуп —
 * заботами logSystemError (10 минут).
 */
const TELEPHONY_AUDIO_MISSING_RE = /^\/telephony\/(moh|greeting|queue|agentDeclined)\.(wav|mp3)$/;
/**
 * ПОЧЕМУ ЗДЕСЬ ПРОВЕРКА СОСЕДНЕГО РАСШИРЕНИЯ, А НЕ ПРОСТО ЗАПИСЬ (11.09.2026).
 *
 * Станция спрашивает КАЖДЫЙ звук в двух расширениях подряд и берёт то, которое
 * нашлось: на проде лежат `greeting.wav`, `moh.wav`, `queue.wav`, и три запроса
 * на `.mp3` получают 404 штатно, при полностью настроенной телефонии. Запись без
 * этой проверки давала бы четыре строки каждые десять минут (дедуп у
 * logSystemError по тексту), то есть около шестисот записей в сутки на пустом
 * месте — ровно тот класс, из-за которого журнал уже один раз распухал до 741
 * ошибки (память `royalhome-ai-retry-infinite-loop-07-09`). Пишем, только когда
 * звука нет НИ В ОДНОМ из расширений: вот это и есть «станция слышит тишину».
 */
app.use("/uploads", (req, res, next) => {
  const match = TELEPHONY_AUDIO_MISSING_RE.exec(req.path);
  if (match) {
    const kind = match[1];
    const anyPresent = ["wav", "mp3"].some((ext) =>
      existsSync(path.join(uploadsDir, "telephony", `${kind}.${ext}`))
    );
    if (!anyPresent) {
      void logSystemError(
        "telephony",
        `Станция запросила звук телефонии «${kind}» — файла нет на диске ни в wav, ни в mp3. ` +
          `Загрузите его в Настройках → Телефония → Звуки, иначе станция продолжит слышать тишину.`,
        { url: req.originalUrl }
      );
    }
  }
  next();
});

/**
 * Защита входа от перебора пароля: 20 попыток за 15 минут.
 *
 * СЧИТАЕМ ПО УЧЁТКЕ, А НЕ ПО АДРЕСУ. Тот же офисный сценарий, который раньше
 * уже чинили у refreshLimiter и totpLimiter, а здесь остался: весь офис
 * агентства выходит в интернет через один внешний адрес, и лимит в 20 попыток
 * делился на всех сразу. Один человек, трижды промахнувшийся паролем с утра,
 * подъедал общий счёт — а после чужого перебора вход закрывался для тех, кто
 * ничего не делал.
 *
 * Ключ — номер телефона из тела запроса: перебор пароля к конкретной учётке
 * упирается в лимит так же быстро, как раньше, но бьёт только по ней. Запасная
 * ветка (запрос без номера — кривое тело, сканер) считает по адресу через
 * ipKeyGenerator: он сводит IPv6 к подсети, иначе лимит обходится перебором
 * адресов внутри своей же подсети.
 *
 * Перебор САМИХ НОМЕРОВ этим лимитом не ловится — на это стоит общий лимит на
 * все запросы выше по стеку, а сам ответ на неверный вход одинаков и для
 * несуществующего номера, и для неверного пароля: узнать «есть ли такой
 * сотрудник» по ответу нельзя.
 *
 * НОМЕР ВМЕСТЕ С АДРЕСОМ, А НЕ ОДИН НОМЕР (G6, 02.10.2026). Ключ по одному
 * номеру превращал лимит в кнопку «запереть чужой вход»: номер агента отдаёт
 * публичная ссылка на объект, и двадцать запросов раз в 15 минут держали
 * директора на «Слишком много попыток» даже с верным паролем — ровно то, что
 * владелец запретил в аудите 11.09.2026 (lib/loginThrottle.ts: перебор
 * тормозить задержкой, а не блокировкой). Теперь перебор с одного адреса
 * упирается в те же двадцать попыток, а хозяин со своего адреса входит;
 * перебор с многих адресов тормозит задержка по номеру из loginThrottle.
 *
 * Только сам вход (skip): шаги второго фактора (/login/verify-totp,
 * /verify-sms, /resend-sms) номера в теле не несут, и раньше весь офис за одним
 * адресом делил на них двадцать попыток; у них свой totpLimiter по агенту.
 */
/** Шаги, где в теле есть номер: старый путь пароля (для открытых вкладок) и
 *  запрос кода (с 19.10.2026 — единственный вход без ключа устройства). */
const LOGIN_PHONE_PATHS = new Set(["/", "/code"]);

/** Подтверждение доставки кода пушем зовёт сервис-воркер без токена: потолок по адресу. */
const codeAckLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? "unknown")}`,
  message: { error: "Слишком много запросов, подождите немного" },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !LOGIN_PHONE_PATHS.has(req.path),
  keyGenerator: (req) => {
    const phone = (req.body as { phone?: unknown } | undefined)?.phone;
    // Не длиннее 20 цифр: ключ живёт в памяти процесса все 15 минут окна, и
    // мегабайтный «телефон» в теле ложился бы туда целиком (круг 3, №73).
    const digits = typeof phone === "string" ? phone.replace(/\D/g, "").slice(0, 20) : "";
    const ip = `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
    if (digits) return `phone:${digits}|${ip}`;
    return ip;
  },
  message: { error: "Слишком много попыток входа, попробуйте позже" },
});

/**
 * ПОТОЛОК ВХОДОВ С ОДНОГО АДРЕСА (аудит 23.09.2026, круг 3, №73).
 *
 * authLimiter выше считает по номеру, и поток входов с НОВЫМ случайным
 * номером на каждый запрос мимо него проходил целиком: общий лимит на вход
 * не действует (API_LIMIT_EXEMPT_PREFIXES), и каждая такая попытка — запрос в
 * базу и запись в память процесса. Потолок по адресу щедрый — 200 входов за
 * 15 минут (офис за одним адресом входит в разы реже), и считает только сам
 * вход, не шаги кода: он про поток, а не про человека, поэтому довод
 * lib/loginThrottle.ts про общий адрес оператора его не задевает.
 */
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? "unknown")}`,
  skip: (req) => !LOGIN_PHONE_PATHS.has(req.path),
  message: { error: "Слишком много попыток входа с этого адреса, попробуйте позже" },
});

/**
 * Обновление access-токена — операция штатная и частая: приложение ходит за ним
 * при каждой загрузке страницы и раз в четверть часа, пока вкладка открыта.
 *
 * Раньше на него висел тот же лимит, что и на подбор пароля: 20 попыток на 15
 * минут С ОДНОГО IP. В офисе агентства весь интернет идёт через один адрес, и
 * восьми сотрудников с парой открытых вкладок хватало, чтобы исчерпать лимит и
 * выкинуть на экран входа всех разом — включая тех, кто ничего не делал.
 *
 * Считаем по самой сессии (sid из refresh-cookie), а не по IP: тогда лимит бьёт
 * по конкретному злоупотребляющему клиенту и не задевает соседей за тем же
 * адресом. Подбор refresh-токена лимитом всё равно не остановить — это
 * подписанный JWT, перебирать его бессмысленно; лимит здесь защищает от шторма
 * запросов, а не от угадывания.
 */
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const cookie = (req as { cookies?: Record<string, string> }).cookies?.refreshToken;
    // Ключ — хвост токена: он уникален для сессии и не раскрывает сам токен.
    // Запасная ветка (запрос без cookie) считает по адресу через ipKeyGenerator,
    // а не по сырому req.ip: у клиента с IPv6 обычно целая подсеть адресов, и
    // лимит по одному адресу обходится их перебором. Хелпер сводит адрес к
    // подсети, поэтому лимит бьёт по владельцу, а не по конкретному адресу.
    return cookie ? `sid:${cookie.slice(-24)}` : `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
  },
  message: { error: "Слишком много запросов, подождите немного" },
});

/**
 * Код TOTP — всего 6 цифр (1 млн комбинаций), лимит жёстче обычного логина.
 *
 * Тот же офисный сценарий, что и у refreshLimiter выше: без keyGenerator лимит
 * считался по IP, и весь офис сидит за одним внешним адресом. Один сотрудник,
 * трижды промахнувшийся с кодом при входе или при подтверждении личности в
 * Настройках, блокировал бы на 5 минут ВСЕХ коллег за тем же адресом — включая
 * тех, кто в этот момент код вообще не вводил.
 *
 * Этот лимитер висит на ДВУХ разных роутах, и на обоих сессии в смысле req.agent
 * ещё нет в момент, когда отрабатывает keyGenerator (лимитер зарегистрирован
 * раньше authRouter, а сам /login/verify-totp вызывается ДО того, как токен
 * вообще выдан):
 *
 *  - /auth/login/verify-totp — ещё не залогинен, есть только pendingToken
 *    (подписан на 5 минут после проверки пароля, см. signPending2faToken).
 *    Ключ — id агента из pendingToken: он привязан к конкретному человеку,
 *    подобрать/подделать его так же трудно, как подобрать сам пароль.
 *  - /auth/step-up — уже залогинен обычной сессией, но requireAuth висит
 *    внутри authRouter, который регистрируется ПОСЛЕ этого лимитера — до
 *    req.agent тут не достучаться. Ключ — id агента из access-токена в
 *    заголовке Authorization, декодированного тем же verifyAccessToken, что
 *    использует requireAuth.
 *
 * Если токен в теле/заголовке отсутствует или не читается — это отдельный
 * случай (запрос всё равно получит 400/401 от самого роута), и лимит на это
 * время считается по IP через ipKeyGenerator (сведённому к подсети, как и у
 * refreshLimiter) — не даёт лимитер обойти, просто не бьёт по чужим сессиям.
 */
const totpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  /**
   * Считаются только попытки (POST). GET /auth/step-up — вопрос «открыт ли
   * замок», его задаёт каждый экран Настроек при открытии и строка «раздел
   * открыт до 13:17» раз в минуту; без skip восемь таких вопросов запирали
   * директора на пять минут без единой неверной попытки (10.09.2026).
   */
  skip: (req) => req.method === "GET",
  keyGenerator: (req) => {
    const pendingToken = (req.body as { pendingToken?: unknown } | undefined)?.pendingToken;
    if (typeof pendingToken === "string") {
      const agentId = verifyPending2faToken(pendingToken, "any");
      if (agentId) return `agent:${agentId}`;
    }
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      try {
        const agentId = verifyAccessToken(header.slice("Bearer ".length)).sub;
        return `agent:${agentId}`;
      } catch {
        // токен просрочен/невалиден — падаем в общий IP-ключ ниже.
      }
    }
    return `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
  },
  message: { error: "Слишком много попыток, подождите 5 минут" },
});

/**
 * Действия из шторки уведомлений — единственный маршрут, работающий без входа
 * в CRM (у service worker нет JWT, см. routes/push.ts). Право даёт одноразовый
 * маркер на 32 случайных байта — подобрать его перебором нельзя, но маршрут без
 * requireAuth обязан иметь потолок в любом случае: он ходит в базу на каждый
 * запрос. Тридцать нажатий за пять минут — заведомо больше, чем нужно человеку.
 */
const pushActionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? "unknown")}`,
  message: { ok: false, message: "Слишком много попыток — откройте CRM" },
});

/**
 * Вход по отпечатку или лицу. Оба шага публичные (человек ещё не вошёл), поэтому
 * потолок обязателен: первый шаг кладёт задание в память процесса, и без лимита
 * его можно наливать в цикле. Потолок высокий осознанно: задание запрашивается
 * при каждом открытии экрана входа, а весь офис приходит с одного адреса.
 */
const passkeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? "unknown")}`,
  message: { error: "Слишком много попыток входа, попробуйте позже" },
});

app.get("/api/v1/health", async (_req, res) => {
  res.json({ ok: true });
});

/** База и пульс фонового процесса — для ops/health-watch.sh (см. lib/deepHealth.ts). */
app.get("/api/v1/health/deep", async (_req, res) => {
  const report = await deepHealth();
  res.status(report.ok ? 200 : 503).json(report);
});

/**
 * ОБЩИЙ ПОТОЛОК НА ВЕСЬ API (владелец 21.08.2026: «поставить лимиты, чтобы не
 * класть сервер»).
 *
 * До сих пор лимиты были только точечные — логин, refresh, TOTP, действия
 * из шторки, приватная ссылка. Всё остальное (полторы сотни маршрутов, каждый
 * ходит в базу, часть — ещё и в ИИ) не имело потолка вообще: один скрипт в цикле
 * укладывал пул соединений Postgres, и никакой код внутри роутов этого не ловил.
 * Общий лимитер — не защита от подбора, а предохранитель от шторма.
 *
 * ПОЧЕМУ 600 ЗА 5 МИНУТ: два запроса в секунду подряд, без перерыва. Человек в
 * интерфейсе столько не делает даже при быстром перелистывании карточек, а
 * машинному циклу этого мало на порядок.
 *
 * ПОЧЕМУ КЛЮЧ НЕ ПРОСТО IP. Весь офис агентства выходит в интернет через один
 * адрес — та же грабля, что уже описана у refreshLimiter и totpLimiter выше:
 * общий лимит по IP делится на восьмерых, и активный день одного сотрудника
 * выкидывал бы ошибку всем остальным, включая тех, кто ничего не делал. Поэтому
 * у вошедшего ключ — его id из access-токена (лимит бьёт по тому, кто шумит), у
 * анонимного трафика — адрес, сведённый к подсети через ipKeyGenerator (у клиента
 * с IPv6 обычно целая подсеть адресов, и лимит по одному обходится их перебором).
 * Защиту это не ослабляет: чтобы получить персональный счётчик, нужен валидный
 * подписанный токен, а без него всё считается по адресу.
 *
 * ЧТО ИСКЛЮЧЕНО И ПОЧЕМУ (skip ниже):
 *  - пути со СВОИМ лимитером — общий не должен их ужесточать: у них другие окна
 *    и другие ключи, и наложение двух счётчиков давало бы предел, которого не
 *    видно ни в одном из них;
 *  - вебхуки Meta/Telegram — трафик не наш и не человеческий: платформа вправе
 *    прислать пачку событий разом (и повторить их при 429), а приходит она с
 *    чужих адресов, которые между собой не связаны. Свой потолок у вебхуков
 *    внутри роутера.
 *
 * Регистрируется ПОСЛЕ `app.set("trust proxy", ...)` в начале файла — иначе
 * req.ip показывал бы адрес прокси, и весь прод считался бы одним клиентом.
 */
const API_LIMIT_EXEMPT_PREFIXES = [
  "/api/v1/auth/login", // authLimiter + totpLimiter (verify-totp)
  "/api/v1/auth/refresh", // refreshLimiter, ключ — сессия
  "/api/v1/auth/step-up", // totpLimiter
  "/api/v1/me/2fa", // totpLimiter (ночная проверка 24.09.2026)
  "/api/v1/auth/passkey", // passkeyLimiter
  "/api/v1/push/action", // pushActionLimiter
  "/api/v1/l", // shareLinkLimiter, приватная ссылка на объект
  "/api/v1/webhooks", // Meta/Telegram
  // Поток живых событий: соединение долгоживущее, а переподключения бережёт
  // своя пауза с нарастанием на фронте. Плюс у потока СВОИ пределы —
  // MAX_STREAMS_PER_AGENT/MAX_STREAMS_TOTAL в lib/eventBus.ts, и они точнее
  // общего потолка: без исключения одна вкладка на переподключениях съедала бы
  // бюджет всего офиса, сидящего за одним внешним адресом.
  "/api/v1/events",
];

/**
 * ПОТОЛОК ЗАПРОСОВ — 600 на пять минут, и его можно поднять ТОЛЬКО вне прода.
 *
 * Живому человеку 600 запросов за пять минут не набрать, а вот e2e-стенду —
 * запросто: Playwright гоняет 114 тестов в шесть воркеров на два проекта, и все
 * двенадцать «браузеров» ходят под одной учёткой директора, то есть под одним
 * ключом лимитера. Лимит срабатывал честно, а выглядело это как поломка
 * приложения: списки объектов и клиентов застревали с надписью «Слишком много
 * запросов», и полный прогон стабильно ронял 14 тестов.
 *
 * `NODE_ENV === "production"` игнорирует переменную полностью: на бою потолок
 * обязан быть тем, что написан здесь, чем бы ни было окружение.
 */
const apiRateLimit =
  process.env.NODE_ENV !== "production" && Number(process.env.API_RATE_LIMIT) > 0
    ? Number(process.env.API_RATE_LIMIT)
    : 1500;
// 22.09.2026: было 600. Ключ — сотрудник, а не вкладка: две-три открытые
// вкладки плюс опрос идущего звонка честно набирали 600 без всякого шторма.
// 1500 (5 в секунду непрерывно) по-прежнему ловит скрипт в цикле.

const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: apiRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      try {
        return `agent:${verifyAccessToken(header.slice("Bearer ".length)).sub}`;
      } catch {
        // Просроченный или поддельный токен — считаем по адресу, как аноним.
      }
    }
    return `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
  },
  // originalUrl, а не req.path: лимитер примонтирован на /api/v1, и req.path
  // внутри него уже без этого префикса. Запрос отрезаем — считаем только путь.
  skip: (req) => {
    const path = req.originalUrl.split("?")[0];
    if (API_LIMIT_EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
      return true;
    }
    // GET активного звонка опрашивается с фронта каждые несколько секунд из
    // памяти процесса (не БД) — исключаем только чтение, POST-действия
    // (cancel и т.п.) под общим лимитом остаются.
    if (req.method === "GET" && path === "/api/v1/me/active-call") {
      return true;
    }
    return false;
  },
  message: { error: "Слишком много запросов, подождите немного" },
});
app.use("/api/v1", apiLimiter);
// Повтор записи с тем же Idempotency-Key отдаёт ответ первого запроса, а не
// создаёт второй объект/клиента/сделку — см. шапку lib/idempotency.ts.
app.use("/api/v1", idempotencyGuard);
// Действие сотрудника (любая успешная запись) обновляет пульт — lib/pultWriteRefresh.ts.
app.use("/api/v1", pultWriteRefresh);

/**
 * ЭКРАН ОТКРЫТ — вторая половина карты обследованного (см. lib/routeHits.ts).
 *
 * Маршруты сервера считаются сами, по факту запроса. С экранами так не выйдет:
 * половина из них ничего не запрашивает у сервера или отдаёт те же данные, что
 * и соседний, — по трафику их не различить. Поэтому фронт сообщает о смене
 * экрана сам, одной строкой на переход.
 *
 * ПОД requireAuth НАМЕРЕННО: карта — внутренний инструмент, и открытая ручка
 * позволила бы постороннему наотмечать посещений, то есть спрятать как раз те
 * экраны, ради поиска которых всё и делается. Ключ дополнительно сверяется со
 * схемой: принимается ШАБЛОН маршрута, а не произвольная строка.
 */
const screenSeenSchema = z.object({
  screen: z
    .string()
    .trim()
    .min(1)
    .max(200)
    // Шаблон роутера: "/clients", "/clients/:id", "/properties/:id/photos".
    .regex(/^\/[A-Za-z0-9\-_/:*]*$/, "Ожидается шаблон маршрута"),
});

app.post("/api/v1/_seen", requireAuth, (req, res) => {
  const parsed = screenSeenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Некорректный экран" });
    return;
  }
  recordHit("screen", parsed.data.screen);
  // Ответ пустой: фронт ничего не ждёт, отметка не должна ничего тормозить.
  res.status(204).end();
});

app.use("/api/v1/auth/login/code-ack", codeAckLimiter);
app.use("/api/v1/auth/login", loginIpLimiter, authLimiter);
app.use("/api/v1/auth/login/verify-totp", totpLimiter);
// Код СМС/Telegram — те же шесть цифр, тот же потолок попыток и тот же ключ (агент из
// pendingToken). Повторная отправка — под тем же лимитером: каждая стоит денег.
app.use("/api/v1/auth/login/verify-code", totpLimiter);
app.use("/api/v1/auth/refresh", refreshLimiter);
// Step-up принимает 6-значный TOTP/пароль — тот же жёсткий лимит, что и на 2FA-логине.
app.use("/api/v1/auth/step-up", totpLimiter);
app.use("/api/v1/auth/passkey", passkeyLimiter);
// Только в прогоне тестов: вход паролем для сотен тестов, заводящих учётку с
// паролем (auth/testPasswordLogin.ts). На проде маршрута нет — условие ниже.
if (process.env.VITEST && process.env.NODE_ENV !== "production") app.use("/api/v1/auth", testPasswordLoginRouter);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/events", eventsRouter);
// Ночная проверка 24.09.2026: /me/2fa/disable и /me/2fa/confirm принимают те же
// шесть цифр, что и вход, но стояли только под общим apiLimiter (сотни запросов
// за пять минут на агента) — из украденной сессии код подбирался перебором.
// Тот же totpLimiter, тот же ключ по агенту из Bearer-токена (см. keyGenerator).
// Стоит ДО meRouter: express идёт по порядку регистрации.
app.use("/api/v1/me/2fa", totpLimiter);
app.use("/api/v1/me", meRouter);
app.use("/api/v1/me/notifications", notificationsRouter);
app.use("/api/v1/agents", agentsRouter);
// Карточка сотрудника для руководства (GET /agents/:id/overview) живёт в team.ts —
// agents.ts занят админским CRUD, а карточка доступна и менеджеру.
app.use("/api/v1/agents", agentOverviewRouter);
app.use("/api/v1/districts", districtsRouter);
app.use("/api/v1/geo", geoRouter);
app.use("/api/v1/landmarks", landmarksRouter);
app.use("/api/v1/properties", propertiesRouter);
app.use("/api/v1/clients", clientsRouter);
app.use("/api/v1/deals", dealsRouter);
app.use("/api/v1/deals", dealDocumentsRouter);
app.use("/api/v1/deals", dealPayoutRouter);
app.use("/api/v1/deals", dealAnnulRouter);
app.use("/api/v1/dashboard", dashboardRouter);
app.use("/api/v1/dashboard", missionControlRouter);
app.use("/api/v1/dashboard", pultModulesRouter);
app.use("/api/v1/dashboard", briefingRouter);
app.use("/api/v1/calendar", calendarRouter);
app.use("/api/v1/interactions", interactionsRouter);
// Раздел «Звонки»: список сужается до собственных разговоров без права
// calls.transcripts, всё общекомандное — только с ним (внутри роутера).
app.use("/api/v1/calls", callsRouter);
// Прослушка разговоров робота в реальном времени (список и поток событий) —
// только тем, кому положено слушать записи; см. routes/liveVoiceListen.ts.
app.use("/api/v1/live-voice", liveVoiceListenRouter);
app.use("/api/v1/ai", aiRouter);
app.use("/api/v1/transcribe", transcribeRouter);
app.use("/api/v1/reports", reportsRouter);
// Раньше общего роутера настроек: у того нет своих путей под /restore-points,
// но порядок здесь и читается как «частное перед общим».
app.use("/api/v1/telephony/whisper", telephonyWhisperRouter);
app.use("/api/v1/settings/restore-points", settingsRestorePointsRouter);
app.use("/api/v1/settings", settingsRouter);
app.use("/api/v1/ui-shell", uiShellRouter);
app.use("/api/v1/sms", smsRouter);
app.use("/api/v1/whatsapp-templates", whatsappTemplatesRouter);
app.use("/api/v1/push/action", pushActionLimiter);
app.use("/api/v1/push", pushRouter);
app.use("/api/v1/webhooks", webhooksRouter);
// Открытые данные для сайта (лента Instagram) — без ключа, см. routes/publicFeed.ts.
app.use("/api/v1/public", publicFeedRouter);
app.use("/api/v1/expenses", expensesRouter);
// Расчёты поверх денег (прогноз комиссии) — рядом с расходами, но своим путём.
app.use("/api/v1/finance", financeRouter);
app.use("/api/v1/security", securityRouter);
app.use("/api/v1/maintenance/data-corrections", manualDataCorrectionsRouter);
app.use("/api/v1/marketing", marketingRouter);
// Свободные ролики в соцсети (12.10.2026): промо-ролик без объекта, кросспостинг по выбору.
app.use("/api/v1/social-videos", socialVideosRouter);
// Возврат из Facebook — до общего роутера рекламы: у него requireAuth, а сюда
// человека приводит сам Facebook, без маркера доступа CRM (см. adsCallbackRouter).
// Бюджетные оповещения Google Cloud приходят от Pub/Sub — без входа в CRM,
// подлинность подтверждает секрет в адресе (routes/budgetWebhook.ts).
app.use("/api/v1/webhooks", budgetWebhookRouter);
app.use("/api/v1/ads/callback", adsCallbackRouter);
app.use("/api/v1/ads", adsRouter);
// Возврат из TikTok — тот же приём, что у Facebook выше: до общего роутера
// TikTok (у него requireAuth), сюда приводит сам TikTok без маркера доступа CRM.
app.use("/api/v1/tiktok/oauth/callback", tiktokCallbackRouter);
app.use("/api/v1/tiktok", tiktokRouter);
app.use("/api/v1/threads/oauth/callback", threadsCallbackRouter);
app.use("/api/v1/threads", threadsRouter);
app.use("/api/v1/search-console/oauth/callback", searchConsoleCallbackRouter);
app.use("/api/v1/search-console/yandex/oauth/callback", yandexCallbackRouter);
app.use("/api/v1/search-console", searchConsoleRouter);
app.use("/api/v1/team", teamRouter);
app.use("/api/v1/hall-of-fame", hallOfFameRouter);
app.use("/api/v1/import", importRouter);
app.use("/api/v1/site-notifications", siteNotificationsRouter);
app.use("/api/v1/contacts", contactsRouter);
app.use("/api/v1/conversations", conversationsRouter);
app.use("/api/v1/audit-log", auditLogRouter);
app.use("/api/v1/royal-score-events", royalScoreEventsRouter);
app.use("/api/v1/morning-report", morningReportRouter);
app.use("/api/v1/errors", errorLogRouter);
app.use("/api/v1/integrations", integrationsRouter);
app.use("/api/v1/stuck-work", stuckWorkRouter);
app.use("/api/v1/backups", backupsRouter);
app.use("/api/v1/bot-audit", botAuditRouter);
// Чему бот научился и о чём спрашивает владельца — окно «Бот» в Настройках.
app.use("/api/v1/bot-learning", botLearningRouter);
app.use("/api/v1/bot-trainer", botTrainerRouter);
// Какая манера продажи приносит больше заявок — там же, в окне «Бот».
app.use("/api/v1/bot-scenarios", botScenariosRouter);
// Экран «Тренировка»: владелец учит бота на реальных вопросах клиентов, выбирая
// или вписывая ответ (пункт 6 очереди ИИ 23.08.2026, за рубильником в Настройках).
app.use("/api/v1/bot-training", botTrainingRouter);
// Фото и голосовые из переписки. НЕ статика: закрытое хранилище вне uploads и
// проверка права messages.viewAttachments на каждый файл.
app.use("/api/v1/attachments", attachmentsRouter);
// Фото/видео, отправленные АГЕНТОМ клиенту (R2, см. lib/outgoingMedia.ts) — без
// requireAuth, тот же компромисс, что раньше был у публичной статики /uploads.
app.use("/api/v1/media", mediaProxyRouter);
// Что бот ответил под постами Instagram и что скрыл от подписчиков — экран «Комментарии».
app.use("/api/v1/instagram-comments", instagramCommentsRouter);
app.use("/api/v1/lead-magnets", leadMagnetsRouter);
app.use("/api/v1/vacancies", vacanciesRouter);
// «Контроль руководителя» (ТЗ «Путь покупателя» п. 32) — сводный дашборд по уже
// накопленным данным: просроченные задачи, лимиты лидов, зависшие горячие клиенты,
// переводы в Неактивные, передачи. Право dashboard.analytics — внутри роутера.
app.use("/api/v1/oversight", oversightRouter);
app.use("/api/v1/insights", insightsRouter);
/**
 * Приватная ссылка на объект (docs/plan-18-08-private-listings-and-video.md §4) —
 * БЕЗ requireAuth, клиент её открывает без входа в CRM. Публичный маршрут, читающий
 * базу на каждый запрос, обязан иметь потолок — тот же принцип, что у pushActionLimiter
 * выше: токен подобрать перебором нельзя, лимит здесь только против шторма запросов.
 */
const shareLinkLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? "unknown")}`,
  message: { error: "Слишком много запросов, попробуйте позже" },
});
app.use("/api/v1/l", shareLinkLimiter, propertyShareRouter);

/**
 * «Отчёт владельцу объекта» (03.10.2026, routes/ownerReportPublic.ts) — публичная страница
 * /o/:token без входа в CRM. Путь — подпуть `/api/v1/public`, но у publicFeedRouter своих
 * совпадений с ним нет (только два точных GET), поэтому порядок не важен. Потолок строже,
 * чем у ссылки на объект: страница считает цифры по нескольким таблицам, и открывает её
 * один человек несколько раз, а не поток клиентов. Токен перебором не подобрать (256 бит) —
 * лимит только против шторма запросов.
 */
const ownerReportLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? "unknown")}`,
  message: { error: "Слишком много запросов, попробуйте позже" },
});
/**
 * Заголовки «не кэшировать / не индексировать» — ДО лимитера: его 429 отвечает, не доходя до
 * роутера, и без этого уходил бы без них (ревью 04.10.2026). Mount остаётся в одну строку:
 * по ней карта продукта (scripts/product-map.mjs) находит модуль.
 */
const ownerReportNoStore: express.RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
};
app.use("/api/v1/public/owner-report", ownerReportNoStore, ownerReportLimiter, ownerReportPublicRouter);

app.use((req, res) => {
  res.status(404).json({ error: "Не найдено" });
});

// Централизованный обработчик ошибок — ловит и синхронные throw, и отклонённые промисы
// в async-роутах (в Express 5 это делает сам фреймворк). Должен быть последним middleware
// с 4 аргументами.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Неверные данные", details: err.flatten() });
  }
  // Лид из канала (webhooks.ts POST /website-lead) на номер сотрудника —
  // createLeadFromChannel бросает эту ошибку, а не отдаёт clientId, чтобы не
  // трогать сигнатуру, на которую завязан десяток вызывающих мест (см.
  // lib/staffPhoneGuard.ts). Остальные каналы (бот, мессенджеры) ловят её сами.
  if (err instanceof StaffPhoneLeadError) {
    return res.status(409).json({ error: err.message, code: err.code });
  }
  // Ошибки multer (лимиты загрузки) — внятный ответ вместо «Внутренняя ошибка»:
  // агент должен понять, что не так с файлами, а не гадать.
  //
  // БЕЗ КОНКРЕТНОГО ЧИСЛА в тексте: обработчик один на все загрузчики, а пределы у
  // них разные и часть настраиваемая — 30 МБ у фото, 15 у музыки ожидания, 300 у
  // медиа в переписке, 700 у видео объекта (плюс собственная настройка
  // propertyVideoMaxSizeMb). Прежнее «максимум 30 МБ» было правдой ровно для
  // одного из них и врало во всех остальных случаях (аудит лимитов 21.08.2026).
  if (err instanceof MulterError) {
    // К9 (11.09.2026): видео-загрузчики теперь на diskStorage (upload.ts) — на
    // LIMIT_FILE_SIZE multer уже успел записать на диск то, что принял до
    // превышения предела, и сам это не убирает. Без явной уборки временный
    // каталог копил бы недописанные ролики на каждую отклонённую загрузку.
    const leftoverPath = (_req.file as { path?: string } | undefined)?.path;
    if (leftoverPath) void fs.rm(leftoverPath, { force: true });
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "Файл слишком большой — превышен предел загрузки для этого раздела. Фото сжимаются автоматически: обновите страницу и попробуйте снова, видео загружайте меньшего размера."
        : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
          ? "Слишком много файлов за один раз — загрузите порциями."
          : "Не удалось принять файлы, попробуйте ещё раз";
    return res.status(413).json({ error: message });
  }
  if (err instanceof Error && err.message === "Допустимы только изображения") {
    return res.status(400).json({ error: "Допустимы только изображения (JPG, PNG, WebP)" });
  }
  // Диктовка (routes/transcribe.ts) отклоняет не-аудио тем же приёмом fileFilter —
  // без этой ветки отказ падал в catch-all: 500 «Внутренняя ошибка» (враньё — виноват
  // вход) плюс запись в журнал, которая будила директора (26.08.2026).
  if (err instanceof Error && err.message === "Допустимо только аудио") {
    return res.status(400).json({ error: "Допустимо только аудио (голосовая запись)" });
  }
  // Любой другой отказ загрузчика по типу файла (документы сделки, звуки
  // станции, медиа в переписку, ролики, шаблоны обложек) — тоже вина файла:
  // 400 с текстом фильтра, без строки в журнале ошибок (G11, 02.10.2026).
  if (err instanceof UploadRejectedError) {
    return res.status(400).json({ error: err.message });
  }
  // Битый JSON в теле запроса — вина клиента (сканер, рука, старая вкладка), не сервера.
  // body-parser (внутри express.json()) бросает SyntaxError с type "entity.parse.failed"
  // и status 400 — раньше это падало в общий catch-all ниже и отвечало 500 «Внутренняя
  // ошибка сервера» (враньё: сервер жив, тело просто нечитаемое) да ещё писалось в журнал,
  // который будит директора «новым видом ошибки» (найдено 25.08.2026: «Bad escaped
  // character in JSON» на /auth/login). Не логируем — это не наш баг, гоняться не за чем.
  if (err instanceof SyntaxError && (err as SyntaxError & { type?: string }).type === "entity.parse.failed") {
    return res.status(400).json({ error: "Некорректный JSON в теле запроса" });
  }
  // ОСТАЛЬНЫЕ ОТКАЗЫ РАЗБОРА ТЕЛА — ТОЖЕ ВИНА ВХОДА (аудит 23.09.2026, круг 3, №82).
  // body-parser бросает http-ошибки с `expose: true` и кодом 4xx: тело больше
  // лимита (entity.too.large, 413), клиент оборвал запрос (request.aborted, 400),
  // незнакомая кодировка (415). Раньше всё это отвечало 500 и писало в журнал
  // ошибок строку на КАЖДЫЙ такой запрос, без дедупа, — поток больших тел
  // превращался в поток записей в базу. Отвечаем их же кодом и ничего не пишем.
  {
    const httpErr = err as { expose?: unknown; status?: unknown; type?: unknown } | null;
    if (
      httpErr?.expose === true &&
      typeof httpErr.status === "number" &&
      httpErr.status >= 400 &&
      httpErr.status < 500 &&
      typeof httpErr.type === "string"
    ) {
      const messages: Record<string, string> = {
        "entity.too.large": "Слишком большое тело запроса",
        "request.aborted": "Запрос прерван",
      };
      return res.status(httpErr.status).json({ error: messages[httpErr.type] ?? "Некорректный запрос" });
    }
  }
  // Обрыв multipart клиентом (найдено 17.09.2026, отчёт «×14 Unexpected end of
  // form» на /properties/:id/photos у Нозы) — плохая связь или свёрнутое
  // приложение посреди аплоада на мобильном рвёт запрос до конца формы. Busboy
  // в этом случае бросает обычный Error с этим текстом, не MulterError, и падал
  // в общий catch-all ниже: 500 клиенту — это ОК и не меняем, uploadQueue.ts
  // штатно считает 5xx повторяемым и сам досылает файл.
  //
  // ПОЧЕМУ ВСЁ-ТАКИ logSystemError, А НЕ ТИШИНА. Фикс 17.09 (см. коммит выше)
  // убрал запись в errorLog целиком, чтобы не будить директора «новым багом» на
  // каждый обрыв связи — и это правильно избавило от 112 одинаковых строк за
  // вечер. Но вместе со спамом исчезла и единственная зацепка, чтобы понять, ГДЕ
  // рвётся тело (на проде без лимитов Caddy, без логов nginx за тот вечер — см.
  // docs/archive/agent-briefs/upload-queue-honest-17-09.md). logSystemError — не то же
  // самое, что прямая запись в errorLog: у него свой дедуп на 10 минут по
  // source+dedupKey (systemError.ts), поэтому одна строка на объект за десять
  // минут не превращается обратно в поток и не шлёт директору пуш повторно
  // (шлёт только на действительно новый источник). content-length заголовка и
  // req.socket.bytesRead вместе показывают, оборвал ли клиент запрос до того,
  // как отправил заявленный объём (реальный обрыв связи), или тело пришло
  // целиком, а порвал его кто-то посередине (прокси/таймаут) — это и есть ответ
  // на вопрос «где именно рвётся».
  if (err instanceof Error && /unexpected end of form/i.test(err.message)) {
    const propertyId = typeof _req.params?.id === "string" ? _req.params.id : null;
    void logSystemError(
      "api",
      `Обрыв загрузки фото (Unexpected end of form): объект ${propertyId ?? "?"}, ` +
        `Content-Length ${_req.headers["content-length"] ?? "?"}, получено байт ${_req.socket.bytesRead}, ` +
        `UA ${String(_req.headers["user-agent"] ?? "?").slice(0, 200)}`,
      { url: _req.originalUrl.split("?")[0], dedupKey: `upload-abort:${propertyId ?? "unknown"}` }
    );
    // retryable — очередь на клиенте (uploadQueue.ts) и так считает 5xx
    // повторяемым сама по коду ответа, но явное поле в теле дешёвое и снимает
    // догадку для любого другого потребителя этого маршрута.
    return res.status(500).json({ error: "Загрузка прервалась — попробуем ещё раз", retryable: true });
  }
  // ПУЛ СОЕДИНЕНИЙ КОНЧИЛСЯ — ЭТО 503, А НЕ 500 (19.09.2026).
  //
  // P2024 значит «база жива, свободного соединения не нашлось за pool_timeout».
  // Отдавая 500, мы говорили клиенту «сломано» — а react-query до 19.09 такой
  // ответ вообще не повторял, и агент видел «раздел не загрузился» там, где
  // хватило бы подождать секунду. 503 — честный код «зайди попозже»: очередь
  // запросов на клиенте (lib/queryClient.ts) повторяет его с нарастающей
  // паузой, uploadQueue.ts считает повторяемым по тому же признаку.
  //
  // Детектор общий с requireAuth — lib/concurrency.ts, чтобы «пул кончился» не
  // читалось в одном месте как «токен недействителен», а в другом как «баг».
  // В errorLog такое НЕ пишем: строк было бы столько же, сколько запросов в
  // минуту голодания, и утренний дайджест директору потонул бы в них.
  if (isTransientDbError(err)) {
    console.error("[pool] соединений не хватило:", `${_req.method} ${_req.originalUrl.split("?")[0]}`);
    res.set("Retry-After", "2");
    return res.status(503).json({ error: "Сервер занят, повторите через секунду", retryable: true });
  }
  console.error("[unhandled]", err instanceof Error ? err.stack ?? err.message : err);
  // Каждая необработанная ошибка сервера — в журнал (best-effort): по нему утром
  // приходит дайджест директору, баги не ждут, пока о них расскажут агенты.
  prisma.errorLog
    .create({
      data: {
        source: "api",
        message: err instanceof Error ? err.message.slice(0, 2000) : String(err).slice(0, 2000),
        stack: err instanceof Error ? err.stack?.slice(0, 8000) : undefined,
        // Без query: там едет секрет вебхука, а журнал ошибок читают люди.
      url: `${_req.method} ${_req.originalUrl.split("?")[0]}`.slice(0, 500),
        agentId: _req.agent?.id ?? null,
      },
    })
    .catch(() => {});
  res.status(500).json({ error: "Внутренняя ошибка сервера" });
});
