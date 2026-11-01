import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken, refreshTtlMs } from "../auth/jwt.js";
import { signPending2faToken, verifyPending2faToken } from "../lib/pending-2fa.js";
import { verifyTotpCode } from "../lib/totp.js";
import { decryptSecretSafe } from "../crypto.js";
import { requireAuth } from "../auth/middleware.js";
import { elevatedUntil, grantElevation, revokeElevation } from "../lib/stepUp.js";
import { settingsMaintenanceUntil } from "../lib/settingsMaintenance.js";
import { recordLogin } from "../lib/loginLog.js";
import { createOrRefreshSession, touchSession, revokeSession } from "../lib/sessions.js";
import { isTransientDbError } from "../lib/concurrency.js";
import { logSystemError } from "../lib/systemError.js";
import { clearLoginFailures, recordLoginFailure, throttleLoginIfNeeded } from "../lib/loginThrottle.js";
import { ackLoginCodePush, issueLoginCode, maskPhoneForHint, verifyLoginCode } from "../lib/loginSmsCode.js";
import { toSmsPhone } from "../lib/sms/index.js";
import { buildAuthenticationOptions, verifyAuthentication, passkeyLoginEnabled } from "../lib/passkeys.js";
import { STEP_UP_MINUTES } from "../lib/settingsConstants.js";

export const authRouter = Router();

const REFRESH_COOKIE_NAME = "refreshToken";
const REFRESH_COOKIE_PATH = "/api/v1/auth";

/** Смена пароля живёт в /me, а cookie туда не доезжает — выдаём ей готовый способ
 *  перевыпустить сессию текущего устройства, не расширяя область cookie. */
export function issueRefreshCookie(
  res: import("express").Response,
  agentId: string,
  sessionId: string
): void {
  res.cookie(REFRESH_COOKIE_NAME, signRefreshToken({ sub: agentId, sid: sessionId }), refreshCookieOptions());
}

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: REFRESH_COOKIE_PATH,
    maxAge: refreshTtlMs(),
  };
}

type SessionAgent = {
  id: string;
  fullName: string;
  phone: string;
  role: string;
  avatarUrl: string | null;
  preferences: unknown;
};

export async function issueSession(req: import("express").Request, res: import("express").Response, agent: SessionAgent) {
  // Журнал входов + уведомление о новом устройстве — в фоне, вход не тормозим.
  void recordLogin(req, { id: agent.id, fullName: agent.fullName });
  // Сессия устройства — создаёт/продлевает строку Session и, если уже 3 живых
  // устройства, вытесняет самое залежавшееся (см. lib/sessions.ts). Синхронно —
  // sid должен попасть в refresh-токен ДО того, как он подписан и уйдёт в cookie.
  const session = await createOrRefreshSession(req, agent.id);
  const accessToken = signAccessToken({ sub: agent.id, role: agent.role as never });
  const refreshToken = signRefreshToken({ sub: agent.id, sid: session.id });
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  res.json({
    accessToken,
    agent: {
      id: agent.id,
      fullName: agent.fullName,
      phone: agent.phone,
      role: agent.role,
      avatarUrl: agent.avatarUrl,
      preferences: agent.preferences,
    },
  });
}

/**
 * Вход кодом, кодом из приложения или отпечатком — это и есть свежее подтверждение
 * личности: человек секунду назад доказал, кто он. Поэтому сразу открываем окно
 * подтверждения (то же, что даёт /auth/step-up), и привязать отпечаток можно без
 * второго кода. Срок — константа STEP_UP_MINUTES (lib/settingsConstants.ts).
 */
async function grantFreshElevation(agentId: string): Promise<void> {
  // Срок окна — константа с 01.11.2026 (lib/settingsConstants.ts).
  grantElevation(agentId, STEP_UP_MINUTES);
}

const DUMMY_HINT = maskPhoneForHint("000000000");

/**
 * ВХОД ПО КОДУ — ШАГ 1 (19.10.2026, пароли убраны решением владельца).
 *
 * Сотрудник вводит свой номер, код уходит СМС, при её отказе — в Telegram-бот
 * (lib/loginSmsCode.ts). На номер, которого нет среди активных учёток, не
 * уходит ничего, а ответ ему такой же, как своему: по ответу нельзя узнать,
 * чей номер есть в CRM, и нельзя заставить нас тратить СМС на чужие номера.
 * Подобрать код нельзя: 5 попыток на код, 5 кодов в час, общий лимит по адресу
 * (authLimiter на /auth/login в app.ts).
 */
const loginCodeSchema = z.object({
  phone: z.string().trim().min(5).max(32),
  channel: z.enum(["sms", "telegram"]).optional(),
});

/** Номер в базе записан как «+992…»; человек набирает как угодно. */
function phoneCandidates(raw: string): string[] {
  const sms = toSmsPhone(raw);
  return [...new Set([raw, ...(sms ? [`+${sms}`, sms] : [])])];
}

authRouter.post("/login/code", async (req, res) => {
  const parsed = loginCodeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Введите номер телефона" });
  const { phone, channel } = parsed.data;
  await throttleLoginIfNeeded(phone);

  const agent = await prisma.agent.findFirst({
    where: { phone: { in: phoneCandidates(phone) }, isActive: true },
    select: { id: true, phone: true, telegramChatId: true },
  });
  if (!agent) {
    recordLoginFailure(phone);
    // Тот же вид ответа, что у настоящей учётки. Токен подписан на несуществующий
    // id — проверка кода по нему всегда скажет «Неверный код».
    return res.json({
      pendingToken: signPending2faToken(`none:${randomUUID()}`, "sms"),
      channel: "sms",
      phoneHint: DUMMY_HINT,
      resendAfterSec: 60,
      telegramAvailable: false,
    });
  }

  const issued = await issueLoginCode(agent, channel);
  if (!issued.ok) {
    if (issued.retryAfterSec !== undefined) {
      res.set("Retry-After", String(issued.retryAfterSec));
      return res.status(429).json({ error: issued.error, resendAfterSec: issued.retryAfterSec });
    }
    return res.status(503).json({ error: issued.error });
  }
  res.json({
    pendingToken: signPending2faToken(agent.id, "sms"),
    channel: issued.channel,
    phoneHint: maskPhoneForHint(agent.phone),
    resendAfterSec: 60,
    telegramAvailable: !!agent.telegramChatId,
    ...(issued.fallbackAfterSec ? { fallbackAfterSec: issued.fallbackAfterSec } : {}),
    ...(issued.devCode ? { devCode: issued.devCode } : {}),
  });
});

const codeAckSchema = z.object({ ackToken: z.string().min(10).max(128), endpoint: z.string().url().max(2000).optional() });

/**
 * Подтверждение доставки кода пушем. Публичный: его вызывает сервис-воркер, у
 * которого нет токена доступа. Всегда 204 — по ответу нельзя ничего узнать.
 */
authRouter.post("/login/code-ack", async (req, res) => {
  const parsed = codeAckSchema.safeParse(req.body);
  if (parsed.success) {
    await ackLoginCodePush(parsed.data.ackToken, parsed.data.endpoint).catch((err) =>
      logSystemError("api", `Подтверждение доставки кода входа: ${err instanceof Error ? err.message : String(err)}`)
    );
  }
  res.status(204).end();
});

const verifyCodeSchema = z.object({ pendingToken: z.string(), code: z.string().regex(/^\d{6}$/) });

/** Вход по коду — шаг 2. У кого включён код из приложения (TOTP), спрашивается и он. */
authRouter.post("/login/verify-code", async (req, res) => {
  const parsed = verifyCodeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Введите шесть цифр кода" });
  const agentId = verifyPending2faToken(parsed.data.pendingToken, "sms");
  if (!agentId) return res.status(401).json({ error: "Время входа истекло, запросите код заново" });
  if (agentId.startsWith("none:")) return res.status(401).json({ error: "Неверный код" });
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent || !agent.isActive) return res.status(401).json({ error: "Неверный код" });
  const checked = await verifyLoginCode(agent.id, parsed.data.code);
  if (!checked.ok) {
    recordLoginFailure(agent.phone);
    return res.status(401).json({ error: checked.error });
  }
  clearLoginFailures(agent.phone);
  if (agent.totpEnabled) {
    return res.json({ requiresTotp: true, pendingToken: signPending2faToken(agent.id) });
  }
  await grantFreshElevation(agent.id);
  await issueSession(req, res, agent);
});

/** Вход по паролю убран 19.10.2026. Старая вкладка получает понятный ответ. */
authRouter.post("/login", (_req, res) => {
  res.status(410).json({ error: "Вход по паролю отключён. Обновите страницу и войдите по коду из СМС" });
});

const verifyTotpSchema = z.object({ pendingToken: z.string(), code: z.string().min(6).max(6) });

authRouter.post("/login/verify-totp", async (req, res) => {
  const parsed = verifyTotpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные" });
  }
  const agentId = verifyPending2faToken(parsed.data.pendingToken);
  if (!agentId) {
    return res.status(401).json({ error: "Сессия входа истекла, войдите заново" });
  }
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent || !agent.isActive || !agent.totpEnabled || !agent.totpSecret) {
    return res.status(401).json({ error: "Двухфакторная аутентификация недоступна для этой учётки" });
  }
  const secret = decryptSecretSafe(agent.totpSecret)!;
  if (!verifyTotpCode(agent.phone, secret, parsed.data.code)) {
    return res.status(401).json({ error: "Неверный код" });
  }
  await grantFreshElevation(agent.id);
  await issueSession(req, res, agent);
});

authRouter.post("/refresh", async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!refreshToken) {
    return res.status(401).json({ error: "Сессия истекла, войдите заново" });
  }
  // Разобрать сам токен — ОТДЕЛЬНО от походов в базу (аудит 23.09.2026, круг 3,
  // №71). Стереть вход имеет право только ответ «токен плохой» или «сессии
  // нет». Любой отказ базы ниже — временный, и стирание cookie на нём
  // выкидывало агента из CRM при каждом перезапуске Postgres.
  let payload: ReturnType<typeof verifyRefreshToken>;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    return res.status(401).json({ error: "Недействительный refresh-токен" });
  }
  try {
    // Токены, выпущенные до введения Session (sid), больше не валидны — разово
    // разлогинивает все уже открытые вкладки/устройства, дальше работает как обычно.
    if (!payload.sid) {
      res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
      return res.status(401).json({ error: "Сессия устарела, войдите заново" });
    }
    const alive = await touchSession(req, payload.sid);
    if (!alive) {
      res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
      return res.status(401).json({ error: "Сессия завершена (вышли на этом устройстве или истекла неактивность), войдите заново" });
    }
    const agent = await prisma.agent.findUnique({ where: { id: payload.sub } });
    if (!agent || !agent.isActive) {
      res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
      return res.status(401).json({ error: "Агент не найден или деактивирован" });
    }
    const accessToken = signAccessToken({ sub: agent.id, role: agent.role });
    // СКОЛЬЗЯЩИЙ СРОК: refresh-cookie перевыпускается на каждое обновление.
    //
    // Без этого срок отсчитывался от ввода пароля и никогда не сдвигался: строка
    // Session продлевалась (touchSession), а сам JWT — нет. Ежедневный пользователь
    // ровно через JWT_REFRESH_TTL (30 дней) выкидывало на экран входа, где он не
    // помнил пароля, потому что месяц его не вводил. Сессия при этом оставалась
    // неотозванной и занимала слот из MAX_DEVICES. Поймано 14.09.2026: агент
    // вылетел день в день через 30 суток после входа, следом шли ещё четверо,
    // включая директора. Срок неактивности (SESSION_INACTIVITY_MS, 7 дней) —
    // настоящий потолок и проверяется в touchSession выше, на каждом обновлении.
    issueRefreshCookie(res, agent.id, payload.sid);
    res.json({
      accessToken,
      // Отдаём актуальные данные агента, а не только токен — иначе фронт
      // продолжает показывать личность, запомненную в localStorage с
      // прошлой сессии в этом браузере, если она разошлась с тем, кого
      // реально аутентифицирует refresh-cookie (см. store/auth.ts setSession).
      agent: {
        id: agent.id,
        fullName: agent.fullName,
        phone: agent.phone,
        role: agent.role,
        avatarUrl: agent.avatarUrl,
        preferences: agent.preferences,
      },
    });
  } catch (err) {
    // Токен уже проверен выше, значит сюда попадает только отказ базы (пул
    // занят, Postgres перезапускается, соединение оборвалось) — временный, не
    // «токен недействителен». До 08.09.2026 этот catch разлогинивал на любую
    // ошибку; с 08.09 — на любую, кроме исчерпания пула, и после перехода на
    // Prisma 7 детектор пула перестал узнавать новую ошибку драйвера. Теперь
    // cookie здесь не трогаем вовсе: клиент повторит запрос и войдёт тем же входом.
    res.set("Retry-After", "2");
    const reason = isTransientDbError(err) ? "База недоступна или пул занят" : "Сбой";
    void logSystemError("api", `${reason} при обновлении токена: ${err instanceof Error ? err.message : String(err)}`);
    return res.status(503).json({ error: "Сервис временно недоступен, повторите запрос" });
  }
});

/**
 * Какой Session (по id) стоит за refresh-cookie ЭТОГО запроса — единственный надёжный
 * способ показать «это устройство» в списке /me/sessions. Раньше «это устройство»
 * угадывалось совпадением deviceKey — из-за этого сразу после раскатки X-Device-Id
 * старые уже открытые сессии (заведённые ещё по старой UA-эвристике) не совпадали
 * с новым сгенерированным id, и текущее устройство агента не подсвечивалось вовсе
 * (риск случайно отозвать самого себя). sid из cookie — точное сравнение, без догадок.
 * Роут живёт под /auth (не /me) специально: только здесь refresh-cookie вообще
 * доезжает до сервера (см. REFRESH_COOKIE_PATH).
 */
authRouter.get("/session", async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!refreshToken) return res.json({ sid: null });
  try {
    const payload = verifyRefreshToken(refreshToken);
    res.json({ sid: payload.sid ?? null });
  } catch {
    res.json({ sid: null });
  }
});

/**
 * Тело выхода. `pushEndpoint` — адрес push-подписки ЭТОГО устройства (фронт берёт
 * его из `pushManager.getSubscription()`, см. web/src/lib/signOut.ts).
 *
 * Зачем он здесь. `PushSubscription` привязана к агенту, а не к устройству, и до
 * 30.08.2026 выход не снимал её вообще: сотрудник выходил из PWA на телефоне и
 * продолжал получать уведомления с именем клиента и сутью обращения на устройстве,
 * где никто не залогинен. Снимать подписку обязан и сервер тоже — шаг на клиенте
 * не выполняется, если вкладку закрыли или связи не было.
 *
 * Но удалять ВСЕ подписки агента нельзя: выход с телефона выключил бы уведомления
 * и на его рабочем компьютере. Endpoint — это и есть адрес конкретного браузера на
 * конкретном устройстве, поэтому удаляем ровно одну строку и соседние не трогаем.
 * Поле необязательное: старые вкладки (и выход без работающего Service Worker) его
 * не пришлют — тогда просто гасим сессию, как раньше.
 */
const logoutSchema = z.object({
  pushEndpoint: z.string().url().max(2000).optional(),
  /**
   * Кто выходит (id вышедшего, клиент берёт его до локального logout). Запрос
   * уходит с задержкой, и к этому моменту в браузере уже может лежать refresh-cookie
   * ДРУГОГО сотрудника, вошедшего следом (общий компьютер): без сверки мы бы отозвали
   * его сессию и стёрли его cookie (аудит 04.10.2026, №3). Необязательное: старые
   * вкладки поля не шлют и ведут себя как раньше.
   */
  agentId: z.string().min(1).max(100).optional(),
});

authRouter.post("/logout", async (req, res) => {
  const parsed = logoutSchema.safeParse(req.body ?? {});
  const pushEndpoint = parsed.success ? parsed.data.pushEndpoint : undefined;
  const loggingOutAgentId = parsed.success ? parsed.data.agentId : undefined;

  // Отзываем саму запись Session этого устройства — иначе «Выйти» лишь стирал cookie
  // в браузере, а refresh-токен (если его скопировать) технически ещё жил бы 30 дней.
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (refreshToken) {
    try {
      const payload = verifyRefreshToken(refreshToken);
      // Cookie принадлежит не тому, кто выходит: это уже сессия следующего человека.
      // Ничего не отзываем и cookie не стираем (иначе он вылетит при первом refresh).
      if (loggingOutAgentId && loggingOutAgentId !== payload.sub) {
        return res.status(204).end();
      }
      if (payload.sid) await revokeSession(payload.sub, payload.sid);
      // Подписка удаляется ТОЛЬКО вместе с agentId из токена: сам по себе endpoint —
      // это данные из тела запроса, и без такой привязки любой, кто его узнал, мог бы
      // отключить уведомления чужому устройству без всякой авторизации.
      if (pushEndpoint) {
        await prisma.pushSubscription
          .deleteMany({ where: { endpoint: pushEndpoint, agentId: payload.sub } })
          .catch(() => {});
      }
      // Sudo-режим гасим вместе с сессией. Раньше здесь стояло `if (req.agent)`, но на
      // этом роуте нет requireAuth — req.agent не заполнялся никогда, и условие было
      // всегда ложным: подтверждённая элевация продолжала действовать ~10 минут ПОСЛЕ
      // выхода (на общем компьютере этого достаточно, чтобы править Настройки и
      // сотрудников без повторного подтверждения). Берём id из refresh-токена, который
      // здесь и так разбирается.
      revokeElevation(payload.sub);
    } catch {
      // Токен уже недействителен — отзывать нечего.
    }
  }
  // Подстраховка на случай запроса с валидным access-токеном, но без cookie.
  if (req.agent) revokeElevation(req.agent.id);
  res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
  res.status(204).end();
});

/** Статус sudo-режима + каким способом подтверждаться: код из приложения или код СМС/Telegram. */
authRouter.get("/step-up", requireAuth, async (req, res) => {
  const agent = await prisma.agent.findUnique({
    where: { id: req.agent!.id },
    select: { totpEnabled: true, role: true, permissions: true, isActive: true },
  });
  // expiresAt — для строки «раздел открыт до 13:17» в шапке Настроек (макет владельца).
  const until = elevatedUntil(req.agent!.id);
  res.json({
    elevated: until !== null,
    method: agent?.totpEnabled ? "totp" : "code",
    expiresAt: until ? until.toISOString() : null,
    settingsMaintenanceUntil: agent ? settingsMaintenanceUntil(agent) : null,
  });
});

const stepUpSendSchema = z.object({ channel: z.enum(["sms", "telegram"]).optional() });

/** Подтверждение личности кодом (пароля больше нет, 19.10.2026): отправить код себе. */
authRouter.post("/step-up/send-code", requireAuth, async (req, res) => {
  const parsed = stepUpSendSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });
  const agent = await prisma.agent.findUnique({
    where: { id: req.agent!.id },
    select: { id: true, phone: true, telegramChatId: true, isActive: true },
  });
  if (!agent || !agent.isActive) return res.status(401).json({ error: "Не авторизован" });
  const issued = await issueLoginCode(agent, parsed.data.channel);
  if (!issued.ok) {
    if (issued.retryAfterSec !== undefined) {
      res.set("Retry-After", String(issued.retryAfterSec));
      return res.status(429).json({ error: issued.error, resendAfterSec: issued.retryAfterSec });
    }
    return res.status(503).json({ error: issued.error });
  }
  res.json({
    channel: issued.channel,
    phoneHint: maskPhoneForHint(agent.phone),
    resendAfterSec: 60,
    telegramAvailable: !!agent.telegramChatId,
    ...(issued.fallbackAfterSec ? { fallbackAfterSec: issued.fallbackAfterSec } : {}),
    ...(issued.devCode ? { devCode: issued.devCode } : {}),
  });
});

const stepUpSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

/**
 * Подтверждение личности для критичных разделов (Настройки CRM, сотрудники).
 * С включённой 2FA принимается ТОЛЬКО код из Google Authenticator — иначе
 * перехваченная СМС обходила бы 2FA; без 2FA — код, отправленный /step-up/send-code.
 */
authRouter.post("/step-up", requireAuth, async (req, res) => {
  const parsed = stepUpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Введите шесть цифр кода" });
  }
  const agent = await prisma.agent.findUnique({ where: { id: req.agent!.id } });
  if (!agent || !agent.isActive) return res.status(401).json({ error: "Не авторизован" });

  if (agent.totpEnabled && agent.totpSecret) {
    const secret = decryptSecretSafe(agent.totpSecret);
    if (!secret || !verifyTotpCode(agent.phone, secret, parsed.data.code)) {
      return res.status(401).json({ error: "Неверный код из приложения-аутентификатора" });
    }
  } else {
    const checked = await verifyLoginCode(agent.id, parsed.data.code);
    if (!checked.ok) return res.status(401).json({ error: checked.error });
  }

  // Срок подтверждения берётся из Настроек: на разборе настроек и здоровья
  // системы десять минут истекали прямо посреди работы (решение владельца
  // 01.08.2026). Отказ базы не повод не пустить — просто действует значение по
  // умолчанию, оно же самое строгое.
  // Срок окна — константа с 01.11.2026 (lib/settingsConstants.ts).
  grantElevation(agent.id, STEP_UP_MINUTES);
  res.json({ elevated: true });
});

/**
 * ВХОД ПО ОТПЕЧАТКУ ИЛИ ЛИЦУ (passkey). Возвращён 19.10.2026 решением владельца
 * как второй способ входа без пароля, наравне с кодом. Разбор устройства и то,
 * почему это безопаснее и кода, и пароля, — в lib/passkeys.ts.
 *
 * Оба шага входа публичные (человек ещё не вошёл), привязка — только для уже
 * вошедшего (routes/me.ts): чужой ключ к чужой учётке привязать нельзя.
 */
authRouter.post("/passkey/login/options", async (_req, res) => {
  if (!(await passkeyLoginEnabled())) return res.status(403).json({ error: "Вход по отпечатку или лицу временно отключён" });
  const options = await buildAuthenticationOptions();
  res.json(options);
});

const passkeyLoginSchema = z.object({
  challenge: z.string().min(10),
  // Ответ устройства разбирает и проверяет библиотека WebAuthn — здесь только
  // убеждаемся, что это объект, а не строка или массив.
  response: z.record(z.string(), z.unknown()),
});

authRouter.post("/passkey/login/verify", async (req, res) => {
  if (!(await passkeyLoginEnabled())) return res.status(403).json({ error: "Вход по отпечатку или лицу временно отключён" });
  const parsed = passkeyLoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });

  const result = await verifyAuthentication(parsed.data.challenge, parsed.data.response as never);
  // Одинаковый ответ на любую неудачу: существование ключа наружу не утекает.
  if (!result) return res.status(401).json({ error: "Не удалось войти по ключу устройства" });

  const agent = await prisma.agent.findUnique({ where: { id: result.agentId } });
  if (!agent || !agent.isActive) return res.status(401).json({ error: "Не удалось войти по ключу устройства" });

  // Второй фактор здесь не спрашиваем намеренно: ключ устройства уже подтверждён
  // отпечатком или лицом — это и есть два фактора (устройство + биометрия).
  await grantFreshElevation(agent.id);
  await issueSession(req, res, agent);
});
