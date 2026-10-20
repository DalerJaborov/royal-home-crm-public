/**
 * КОД ВХОДА — ЕДИНСТВЕННЫЙ СПОСОБ ВОЙТИ БЕЗ КЛЮЧА УСТРОЙСТВА (19.10.2026).
 *
 * Владелец: «удали пароли полностью, вход только по СМС; если СМС не работает —
 * код через нашего Telegram-бота». Пароля в CRM больше нет: сотрудник вводит
 * свой номер, получает шесть цифр и входит. Тот же код подтверждает личность
 * перед Настройками (routes/auth.ts, /step-up).
 *
 * Куда уходит код (19.10.2026, второе решение владельца: «сначала пуш, он бесплатный»):
 *  - ПУШ на «живые» устройства сотрудника (не старше 30 дней, не больше трёх самых
 *    свежих). Сервис-воркер подтверждает доставку (POST /auth/login/code-ack); если
 *    за 10 секунд подтверждения нет — тот же код уходит СМС (а при её отказе в
 *    Telegram). Нет живых устройств или пуш не принят ни одной подпиской — сразу СМС;
 *  - СМС на номер из учётки (провайдер из Настроек → Каналы → СМС);
 *  - не отправилось или сотрудник сам попросил — в личный чат с CRM-ботом
 *    Telegram, если он привязан (Agent.telegramChatId). Бот бесплатный и от
 *    баланса СМС не зависит.
 *
 * Правила кода:
 *  - шесть цифр из crypto.randomInt, живёт 5 минут, одноразовый;
 *  - в базе только HMAC кода — утечка таблицы не даёт войти;
 *  - 5 неверных попыток гасят код, нужен новый;
 *  - новый код в тот же канал — не чаще раза в минуту, всего не больше 5 за час
 *    на сотрудника: каждая СМС стоит денег, а кнопка «Отправить ещё раз» под пальцем;
 *  - действует только последний выданный код.
 *
 * Код получает только номер, записанный в АКТИВНОЙ учётке сотрудника: на чужой
 * номер не уходит ничего (routes/auth.ts отвечает ему так же, как своему, чтобы
 * по ответу нельзя было узнать, чей номер есть в CRM).
 */
import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { prisma } from "../db.js";
import { secretsMatch } from "./secretCompare.js";
import { sendSms } from "./sms/index.js";
import { sendMessage as sendTelegramMessage } from "../telegram/api.js";
import { sendLoginCodePush, type PushSubscriptionRow } from "../push.js";
import { logSystemError } from "./systemError.js";

export const LOGIN_SMS_CODE_TTL_MS = 5 * 60 * 1000;
export const LOGIN_SMS_MAX_ATTEMPTS = 5;
export const LOGIN_SMS_RESEND_MS = 60 * 1000;
export const LOGIN_SMS_PER_HOUR = 5;
const TELEGRAM_TIMEOUT_MS = 15_000;

export type LoginCodeChannel = "push" | "sms" | "telegram";

/** Сколько ждём подтверждения доставки пуша, прежде чем слать запасную СМС. Тесты подменяют.
 *  30 с, а не 10 (владелец 20.10.2026): отсчёт на экране читался как срок на ввод кода. */
export const pushFallback = { delayMs: 30_000 };
export const PUSH_FALLBACK_SEC = 30;
export const LIVE_SUBSCRIPTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const LIVE_SUBSCRIPTIONS_MAX = 3;

function hashAck(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** «Живые» подписки: свежее по coalesce(lastSeenAt, createdAt) не старше 30 дней, не больше трёх. */
export async function loadLiveSubscriptions(agentId: string): Promise<PushSubscriptionRow[]> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { pushDisabled: true } });
  if (!agent || agent.pushDisabled) return [];
  const subs = await prisma.pushSubscription.findMany({ where: { agentId } });
  const edge = Date.now() - LIVE_SUBSCRIPTION_MAX_AGE_MS;
  return subs
    .map((sub) => ({ sub, seen: (sub.lastSeenAt ?? sub.createdAt).getTime() }))
    .filter((x) => x.seen >= edge)
    .sort((a, b) => b.seen - a.seen)
    .slice(0, LIVE_SUBSCRIPTIONS_MAX)
    .map((x) => x.sub);
}

function hashCode(agentId: string, code: string): string {
  return createHmac("sha256", process.env.JWT_ACCESS_SECRET ?? "")
    .update(`${agentId}:${code}`)
    .digest("hex");
}

/** Номер для подсказки на экране: •• ••• 06 61. */
export function maskPhoneForHint(phone: string): string {
  const d = phone.replace(/\D/g, "");
  return d.length >= 4 ? `•• ••• ${d.slice(-4, -2)} ${d.slice(-2)}` : "••••";
}

/**
 * Код в ответе сервера — только на локальном стенде и в e2e, чтобы войти без
 * провайдера. На проде запрещено дважды: здесь (NODE_ENV) и в env-check.ts,
 * который не даёт серверу стартовать с этой переменной в production.
 */
export function devCodeEchoEnabled(): boolean {
  return process.env.LOGIN_CODE_DEV_ECHO === "1" && process.env.NODE_ENV !== "production";
}

export type IssueResult =
  | { ok: true; channel: LoginCodeChannel; devCode?: string; fallbackAfterSec?: number }
  | { ok: false; error: string; retryAfterSec?: number };

export type CodeAgent = { id: string; phone: string; telegramChatId: string | null };

async function deliver(
  agent: CodeAgent,
  channel: "sms" | "telegram",
  code: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const text = `Royal Home CRM: код входа ${code}. Никому не сообщайте его — сотрудники Royal Home его никогда не спрашивают.`;
  if (channel === "sms") {
    const sent = await sendSms({
      phone: agent.phone,
      text,
      journalText: "Royal Home CRM: код входа ••••••",
      purpose: "LOGIN_CODE",
      agentId: agent.id,
    });
    return sent.ok ? { ok: true } : { ok: false, error: sent.error };
  }
  if (!agent.telegramChatId) return { ok: false, error: "Telegram не привязан к учётке" };
  if (process.env.VITEST) return { ok: true };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      sendTelegramMessage(agent.telegramChatId, text),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("бот не ответил за 15 с")), TELEGRAM_TIMEOUT_MS);
      }),
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Telegram: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Выдать код. `channel` не задан — пуш (если есть живые устройства), затем СМС, затем
 * Telegram; повторный запрос без канала после пуша — сразу СМС, не второй пуш.
 * Задан — только в этот канал (кнопка «Прислать в Telegram»).
 */
export async function issueLoginCode(agent: CodeAgent, channel?: LoginCodeChannel): Promise<IssueResult> {
  const now = Date.now();
  const recent = await prisma.loginSmsCode.findMany({
    where: { agentId: agent.id, createdAt: { gte: new Date(now - 60 * 60 * 1000) } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, channel: true },
  });
  // «Отправить ещё раз» после пуша — сразу СМС: пуш уже был, второй ничего не даст.
  const afterPush = recent[0]?.channel === "push" && now - recent[0].createdAt.getTime() < LOGIN_SMS_CODE_TTL_MS;
  const liveSubs = channel || afterPush ? [] : await loadLiveSubscriptions(agent.id);
  const wanted: LoginCodeChannel = channel ?? (liveSubs.length > 0 ? "push" : "sms");
  // Повтор в ТОТ ЖЕ канал — через минуту. Переключиться на Telegram, когда СМС
  // не пришла, можно сразу: в этом и смысл запасного канала.
  const sameChannel = recent.find((r) => r.channel === wanted);
  if (sameChannel && now - sameChannel.createdAt.getTime() < LOGIN_SMS_RESEND_MS) {
    const retryAfterSec = Math.ceil((LOGIN_SMS_RESEND_MS - (now - sameChannel.createdAt.getTime())) / 1000);
    return { ok: false, error: `Код уже отправлен. Новый можно запросить через ${retryAfterSec} с`, retryAfterSec };
  }
  if (recent.length >= LOGIN_SMS_PER_HOUR) {
    return { ok: false, error: "Слишком много кодов за час. Попробуйте позже или обратитесь к директору" };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const order: LoginCodeChannel[] = channel
    ? [channel]
    : [...(liveSubs.length > 0 ? (["push"] as const) : []), "sms", ...(agent.telegramChatId ? (["telegram"] as const) : [])];
  const errors: string[] = [];
  for (const ch of order) {
    const ackToken = ch === "push" ? randomBytes(24).toString("base64url") : null;
    const row = await prisma.loginSmsCode.create({
      data: {
        agentId: agent.id,
        codeHash: hashCode(agent.id, code),
        channel: ch,
        expiresAt: new Date(now + LOGIN_SMS_CODE_TTL_MS),
        ...(ackToken ? { ackTokenHash: hashAck(ackToken) } : {}),
      },
      select: { id: true },
    });
    if (ch === "push") {
      const accepted = await sendLoginCodePush(liveSubs, {
        kind: "login-code",
        code,
        ackToken,
        title: "Код входа Royal Home CRM",
        body: `${code} — никому не сообщайте`,
        tag: "login-code",
      }).catch((err) => {
        void logSystemError("api", `Код входа пушем не отправлен: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
      });
      if (accepted > 0) {
        scheduleSmsFallback(agent, row.id, code);
        return {
          ok: true,
          channel: "push",
          fallbackAfterSec: PUSH_FALLBACK_SEC,
          ...(devCodeEchoEnabled() ? { devCode: code } : {}),
        };
      }
      await prisma.loginSmsCode.delete({ where: { id: row.id } }).catch(() => {});
      errors.push("пуш не принят устройствами");
      continue;
    }
    const sent = await deliver(agent, ch, code);
    if (sent.ok) return { ok: true, channel: ch, ...(devCodeEchoEnabled() ? { devCode: code } : {}) };
    // Неотправленный код не должен ни действовать, ни занимать минуту до повтора.
    await prisma.loginSmsCode.delete({ where: { id: row.id } }).catch(() => {});
    errors.push(sent.error);
  }
  // Стенд без провайдера: код всё равно действует, его отдаёт ответ сервера.
  if (devCodeEchoEnabled()) {
    await prisma.loginSmsCode.create({
      data: { agentId: agent.id, codeHash: hashCode(agent.id, code), channel: wanted === "push" ? "sms" : wanted, expiresAt: new Date(now + LOGIN_SMS_CODE_TTL_MS) },
    });
    return { ok: true, channel: wanted === "push" ? "sms" : wanted, devCode: code };
  }
  return { ok: false, error: `Не удалось отправить код: ${errors.join("; ")}` };
}

/**
 * Запасная СМС: через pushFallback.delayMs, если доставку пуша никто не подтвердил и
 * код ещё не использован, тот же код уходит СМС, при её отказе — в Telegram. Таймер
 * живёт в процессе: перезапуск сервера его теряет — это допустимо, у человека есть
 * «Отправить ещё раз».
 */
export function scheduleSmsFallback(agent: CodeAgent, rowId: string, code: string): void {
  const timer = setTimeout(() => {
    void runSmsFallback(agent, rowId, code).catch((err) =>
      logSystemError("api", `Запасная СМС с кодом входа не отправлена: ${err instanceof Error ? err.message : String(err)}`)
    );
  }, pushFallback.delayMs);
  timer.unref?.();
}

export async function runSmsFallback(agent: CodeAgent, rowId: string, code: string): Promise<void> {
  const row = await prisma.loginSmsCode.findUnique({ where: { id: rowId } });
  if (!row || row.ackedAt || row.consumedAt || row.fallbackSentAt || row.expiresAt.getTime() < Date.now()) return;
  // Условно: два срабатывания подряд не отправят две СМС.
  const claimed = await prisma.loginSmsCode.updateMany({
    where: { id: rowId, ackedAt: null, consumedAt: null, fallbackSentAt: null },
    data: { fallbackSentAt: new Date() },
  });
  if (claimed.count === 0) return;
  const errors: string[] = [];
  for (const ch of ["sms", ...(agent.telegramChatId ? (["telegram"] as const) : [])] as const) {
    const sent = await deliver(agent, ch, code);
    if (sent.ok) return;
    errors.push(sent.error);
  }
  void logSystemError("api", `Запасная доставка кода входа не удалась: ${errors.join("; ")}`);
}

/**
 * Подтверждение доставки пуша (вызывает сервис-воркер без токена доступа). Ничего не
 * раскрывает: неверный, чужой или просроченный токен просто ничего не меняет.
 * Дополнительно отмечает подписку устройства живой.
 */
export async function ackLoginCodePush(ackToken: string, endpoint?: string): Promise<void> {
  const row = await prisma.loginSmsCode.findFirst({
    where: {
      ackTokenHash: hashAck(ackToken),
      ackedAt: null,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true, agentId: true },
  });
  if (!row) return;
  await prisma.loginSmsCode.updateMany({ where: { id: row.id, ackedAt: null }, data: { ackedAt: new Date() } });
  if (endpoint) {
    await prisma.pushSubscription.updateMany({ where: { endpoint, agentId: row.agentId }, data: { lastSeenAt: new Date() } });
  }
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

export async function verifyLoginCode(agentId: string, code: string): Promise<VerifyResult> {
  const latest = await prisma.loginSmsCode.findFirst({
    where: { agentId },
    orderBy: { createdAt: "desc" },
  });
  if (!latest || latest.consumedAt || latest.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "Код истёк. Запросите новый" };
  }
  if (latest.attempts >= LOGIN_SMS_MAX_ATTEMPTS) {
    return { ok: false, error: "Слишком много неверных попыток. Запросите новый код" };
  }
  if (!secretsMatch(hashCode(agentId, code), latest.codeHash)) {
    await prisma.loginSmsCode.update({ where: { id: latest.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, error: "Неверный код" };
  }
  // Гасим условно: два одновременных запроса с верным кодом — сессию получит один.
  const consumed = await prisma.loginSmsCode.updateMany({
    where: { id: latest.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) return { ok: false, error: "Код уже использован. Запросите новый" };
  return { ok: true };
}
