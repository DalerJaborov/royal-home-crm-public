import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { decryptSecretSafe } from "../crypto.js";
import { matchTotpStep } from "../lib/totp.js";
import { logAgentAudit } from "../lib/audit.js";
import { getAssistantActionExecutor } from "../lib/assistantActions.js";
import { notifyStaffChangeLater } from "../lib/staffSecurityNotify.js";

/**
 * ПОДТВЕРЖДЕНИЕ КОДОМ GOOGLE AUTHENTICATOR В ЛИЧКЕ С ПОМОЩНИЦЕЙ (10.11.2026).
 *
 * Владелец: «все возможности директора вплоть от создания или удаления работников
 * и изменения прав». В CRM эти действия стоят за подтверждением личности
 * (`requireElevation`, lib/stepUp.ts) — значит и из Telegram их нельзя исполнить
 * одним нажатием кнопки: украденный или оставленный открытым телефон директора
 * иначе раздавал бы права.
 *
 * ПРАВИЛА (каждое — тест в tests/assistant-staff-rights.test.ts):
 *  - только код Google Authenticator из 6 цифр в любой записи («123456», «123 456»,
 *    «код: 12-34-56», цифры любой письменности — parseStepUpCode), проверенный той
 *    же функцией, что `/auth/step-up` (lib/totp.ts). ПАРОЛЬ И СМС-КОД ЗДЕСЬ НЕ
 *    ПРИНИМАЮТСЯ НИКОГДА; голосом код не принимается — просим цифрами;
 *  - нет Authenticator — честный отказ (брокер не создаёт карточку, TOTP_REQUIRED);
 *  - код одноразовый: принятый 30-секундный шаг пишется в ожидание
 *    (`usedStep`, уникален на сотрудника). Тот же код второй раз — «уже использован»
 *    (это не ошибка и не попытка); соседний шаг другой карточке не мешает;
 *  - пять неверных кодов за 15 минут — подтверждение закрыто на 15 минут,
 *    карточка отменяется, руководству — одно сообщение (признак чужих рук). Счёт
 *    в базе, переживает перезапуск;
 *  - сообщение с кодом удаляется сразу, до проверки; не удалилось — просим
 *    удалить самому;
 *  - один код — одно исполнение (или одна отмена) одной карточки;
 *  - срок ожидания — 3 минуты; код после срока не уходит модели, а удаляется с
 *    подсказкой нажать ещё раз. Ожидания старше суток чистит
 *    jobs/assistantActionsSweep.ts.
 */

export const STEP_UP_CODE_TTL_MS = 3 * 60_000;
export const STEP_UP_MAX_FAILURES = 5;
export const STEP_UP_LOCK_WINDOW_MS = 15 * 60_000;
/** Код, пришедший вскоре после истёкшего ожидания, — всё ещё код: удаляем, а не отдаём модели. */
export const STEP_UP_LATE_CODE_MS = 10 * 60_000;
/** Сколько хранить закрытые ожидания: блокировке нужны 15 минут, следу — AuditLog. */
export const STEP_UP_RETENTION_MS = 24 * 60 * 60_000;

export type StepUpLanguage = "ru" | "tg";
export type StepUpKind = "confirm" | "undo";

const TEXT = {
  prompt: {
    ru: "🔐 Введите 6 цифр из Google Authenticator. Сообщение с кодом сразу удалю из чата.",
    tg: "🔐 Шаш рақами кодро аз Google Authenticator нависед. Паёми кодро баъди санҷиш аз чат нест мекунам.",
  },
  wrong: {
    ru: (left: number) => `✖️ Код не подошёл. Осталось попыток: ${left}.`,
    tg: (left: number) => `✖️ Код дуруст нест. Боз ${left} бор кӯшиш карда метавонед.`,
  },
  replay: {
    ru: "Этот код уже использован — дождитесь следующего в приложении и введите его.",
    tg: "Ин код аллакай истифода шуд — коди навбатиро аз барнома интизор шавед ва нависед.",
  },
  locked: {
    ru: "⛔ Слишком много неверных кодов. Подтверждение закрыто на 15 минут, карточка отменена.",
    tg: "⛔ Кодҳои нодуруст бисёр шуд. Тасдиқ 15 дақиқа баста аст, корт бекор шуд.",
  },
  noTotp: {
    ru: "Сначала включите Google Authenticator в CRM (Профиль → Безопасность). Без него такие изменения из Telegram не делаю.",
    tg: "Аввал дар CRM Google Authenticator-ро фаъол кунед (Профил → Бехатарӣ). Бе он ин корро аз Telegram намекунам.",
  },
  inactive: {
    ru: "Ваша учётка отключена — подтверждение невозможно.",
    tg: "Ҳисоби шумо хомӯш аст — тасдиқ имкон надорад.",
  },
  expired: {
    ru: "⌛ Время на код вышло. Нажмите кнопку на карточке ещё раз.",
    tg: "⌛ Вақти код гузашт. Тугмаи кортро боз пахш кунед.",
  },
  voice: {
    ru: "Код голосом не принимаю — введите 6 цифр текстом.",
    tg: "Кодро бо овоз қабул намекунам — шаш рақамро бо матн нависед.",
  },
  notDeleted: {
    ru: "Не получилось удалить сообщение с кодом — удалите его сами.",
    tg: "Паёми кодро нест карда натавонистам — худатон нест кунед.",
  },
} as const;

export function stepUpText(
  key: "prompt" | "replay" | "locked" | "noTotp" | "inactive" | "expired" | "voice" | "notDeleted",
  language: StepUpLanguage
): string {
  return TEXT[key][language];
}

/** Нужна ли карточке проверка кодом: хотя бы одно действие связки стоит за step-up. */
export function bundleNeedsStepUp(actions: readonly { tool: string }[]): boolean {
  return actions.some((action) => getAssistantActionExecutor(action.tool)?.stepUp === true);
}

/** Сколько неверных кодов у сотрудника за окно блокировки (по всем ожиданиям). */
async function recentFailures(agentId: string, now: Date): Promise<number> {
  const rows = await prisma.assistantStepUpChallenge.aggregate({
    where: { agentId, createdAt: { gte: new Date(now.getTime() - STEP_UP_LOCK_WINDOW_MS) } },
    _sum: { attempts: true },
  });
  return rows._sum.attempts ?? 0;
}

export type StartStepUpOutcome =
  | { kind: "started"; challengeId: string }
  | { kind: "no_totp" }
  | { kind: "locked" };

/**
 * «Подтвердить» (или «Отменить») на карточке со step-up: вместо исполнения —
 * ожидание кода. Прежнее ожидание в этом чате гасится.
 */
export async function startStepUpChallenge(input: {
  agentId: string;
  chatId: string;
  bundleId: string;
  kind?: StepUpKind;
  cardMessageId?: number;
  language: StepUpLanguage;
  now?: Date;
}): Promise<StartStepUpOutcome> {
  const now = input.now ?? new Date();
  const agent = await prisma.agent.findUnique({ where: { id: input.agentId }, select: { totpEnabled: true, totpSecret: true } });
  if (!agent?.totpEnabled || !agent.totpSecret) return { kind: "no_totp" };
  if ((await recentFailures(input.agentId, now)) >= STEP_UP_MAX_FAILURES) return { kind: "locked" };
  const challenge = await prisma.$transaction(async (tx) => {
    await tx.assistantStepUpChallenge.updateMany({
      where: { chatId: input.chatId, status: "PENDING" },
      data: { status: "CANCELLED", closedAt: now },
    });
    return tx.assistantStepUpChallenge.create({
      data: {
        agentId: input.agentId,
        chatId: input.chatId,
        kind: input.kind ?? "confirm",
        bundleId: input.bundleId,
        cardMessageId: input.cardMessageId ?? null,
        language: input.language,
        expiresAt: new Date(now.getTime() + STEP_UP_CODE_TTL_MS),
      },
    });
  });
  return { kind: "started", challengeId: challenge.id };
}

export async function rememberStepUpPrompt(challengeId: string, promptMessageId: number | undefined): Promise<void> {
  if (!promptMessageId) return;
  await prisma.assistantStepUpChallenge.updateMany({ where: { id: challengeId }, data: { promptMessageId } });
}

/** «Отмена» на карточке: ожидание кода по ней больше не нужно. */
export async function cancelStepUpForBundle(bundleId: string, now = new Date()): Promise<void> {
  await prisma.assistantStepUpChallenge.updateMany({
    where: { bundleId, status: "PENDING" },
    data: { status: "CANCELLED", closedAt: now },
  });
}

/**
 * Цифра любой письменности (`\p{Nd}`: арабско-индийские «١٢٣», персидские «۱۲۳»,
 * полноширинные «１２３») → ASCII. Десятичные цифры в Юникоде лежат подряд блоками
 * по десять, начиная с нуля, поэтому значение — расстояние от начала блока по
 * модулю 10. Нецифра возвращается как есть.
 */
function asciiDigit(char: string): string {
  if (!/^\p{Nd}$/u.test(char)) return char;
  const cp = char.codePointAt(0)!;
  let start = cp;
  while (start > 0 && /^\p{Nd}$/u.test(String.fromCodePoint(start - 1))) start--;
  return String((cp - start) % 10);
}

/** Слова-подписи вокруг кода: «код», «мой код», «вот код», «коди ман», «code:». */
const CODE_LABEL_WORDS = /(?<!\p{L})(?:коди|код|code|kodi|kod|рамз|otp|вот|мой|ман|ана|инак|ин)(?!\p{L})/giu;
/** Разделители внутри и вокруг кода: пробелы (и неразрывные), тире, двоеточие, точки, кавычки. */
const CODE_SEPARATORS = /[\s\p{Pd}:.,;!?'"`«»()[\]*_#№=]+/gu;

/**
 * Код — сообщение, которое после снятия разделителей (пробелы, тире, двоеточие,
 * точки, кавычки) и слов-подписей («код», «мой код», «вот», «коди») становится
 * РОВНО шестью цифрами любой письменности: «123456», «123 456», «12-34-56»,
 * «код: 123 456», «１２３４５６», «۱۲۳۴۵۶». Всё остальное (пароль, «код 123456 и
 * ещё…», номер объекта «ОБ-123456», цифры внутри фразы) — не код.
 *
 * Разбор сам по себе ничего не решает: кодом сообщение считается, только пока
 * ждём код (handleAssistantStepUpMessage → findPendingStepUp). Без ожидания то
 * же «123 456» идёт помощнице как обычный текст.
 */
export function parseStepUpCode(text: string | undefined): string | null {
  const raw = (text ?? "").trim();
  // Длинное сообщение — уже фраза, а не код с подписью.
  if (!raw || raw.length > 40) return null;
  const digits = Array.from(raw, asciiDigit).join("");
  const flat = digits.replace(CODE_LABEL_WORDS, " ").replace(CODE_SEPARATORS, "");
  return /^\d{6}$/u.test(flat) ? flat : null;
}

export interface PendingStepUp {
  id: string;
  agentId: string;
  chatId: string;
  kind: StepUpKind;
  bundleId: string;
  cardMessageId: number | null;
  promptMessageId: number | null;
  language: StepUpLanguage;
  /** Срок вышел, но код пришёл вскоре — удалить и подсказать, а не отдавать модели. */
  expired: boolean;
}

/** Последнее ожидание кода в этом чате у этого сотрудника (живое или только что истёкшее). */
export async function findPendingStepUp(chatId: string, agentId: string, now = new Date()): Promise<PendingStepUp | null> {
  const row = await prisma.assistantStepUpChallenge.findFirst({
    where: { chatId, agentId, status: "PENDING", expiresAt: { gt: new Date(now.getTime() - STEP_UP_LATE_CODE_MS) } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agentId,
    chatId: row.chatId,
    kind: row.kind === "undo" ? "undo" : "confirm",
    bundleId: row.bundleId,
    cardMessageId: row.cardMessageId,
    promptMessageId: row.promptMessageId,
    language: row.language === "tg" ? "tg" : "ru",
    expired: row.expiresAt.getTime() <= now.getTime(),
  };
}

export type VerifyStepUpOutcome =
  | { kind: "passed" }
  | { kind: "wrong"; left: number; message: string }
  | { kind: "replay"; message: string }
  | { kind: "locked"; message: string }
  | { kind: "no_totp"; message: string }
  | { kind: "inactive"; message: string }
  | { kind: "expired"; message: string }
  | { kind: "gone" };

async function closeChallenge(id: string, status: "LOCKED" | "CANCELLED" | "EXPIRED", now: Date) {
  await prisma.assistantStepUpChallenge.updateMany({ where: { id, status: "PENDING" }, data: { status, closedAt: now } });
}

/** Неверный код: +1 к счёту; на пятой ошибке — блокировка и сообщение руководству. */
async function registerFailure(challenge: PendingStepUp, now: Date): Promise<VerifyStepUpOutcome> {
  const bumped = await prisma.assistantStepUpChallenge.updateMany({
    where: { id: challenge.id, status: "PENDING" },
    data: { attempts: { increment: 1 } },
  });
  if (bumped.count === 0) return { kind: "gone" };
  logAgentAudit(challenge.agentId, "ASSISTANT_TOTP_FAILED", "Agent", challenge.agentId, { source: "assistant", bundleId: challenge.bundleId });
  const failures = await recentFailures(challenge.agentId, now);
  if (failures >= STEP_UP_MAX_FAILURES) {
    await closeChallenge(challenge.id, "LOCKED", now);
    logAgentAudit(challenge.agentId, "ASSISTANT_TOTP_LOCKED", "Agent", challenge.agentId, { source: "assistant", failures });
    const agent = await prisma.agent.findUnique({ where: { id: challenge.agentId }, select: { fullName: true } });
    notifyStaffChangeLater({
      change: "lockout",
      actorId: challenge.agentId,
      targetId: challenge.agentId,
      targetName: agent?.fullName ?? "Сотрудник",
      details: `${failures} неверных кодов подряд в личке с Шабнам, подтверждение закрыто на 15 минут. Если это не он — проверьте его телефон и привязку Telegram`,
      channel: "telegram",
      at: now,
    });
    return { kind: "locked", message: TEXT.locked[challenge.language] };
  }
  const left = STEP_UP_MAX_FAILURES - failures;
  return { kind: "wrong", left, message: TEXT.wrong[challenge.language](left) };
}

/**
 * Проверка присланного кода. Ничего не исполняет: «passed» значит, что ожидание
 * закрыто ровно один раз (условная запись PENDING → PASSED) и шаг кода занят.
 */
export async function verifyStepUpCode(challenge: PendingStepUp, code: string, now = new Date()): Promise<VerifyStepUpOutcome> {
  if (challenge.expired) {
    await closeChallenge(challenge.id, "EXPIRED", now);
    return { kind: "expired", message: TEXT.expired[challenge.language] };
  }
  if ((await recentFailures(challenge.agentId, now)) >= STEP_UP_MAX_FAILURES) {
    await closeChallenge(challenge.id, "LOCKED", now);
    return { kind: "locked", message: TEXT.locked[challenge.language] };
  }
  const agent = await prisma.agent.findUnique({
    where: { id: challenge.agentId },
    select: { phone: true, isActive: true, totpEnabled: true, totpSecret: true },
  });
  if (!agent?.isActive) {
    await closeChallenge(challenge.id, "CANCELLED", now);
    return { kind: "inactive", message: TEXT.inactive[challenge.language] };
  }
  const secret = agent.totpEnabled && agent.totpSecret ? decryptSecretSafe(agent.totpSecret) : null;
  if (!secret) {
    await closeChallenge(challenge.id, "CANCELLED", now);
    return { kind: "no_totp", message: TEXT.noTotp[challenge.language] };
  }
  // Та же функция, что у /auth/step-up: метка — телефон сотрудника, окно ±1 шаг.
  const step = matchTotpStep(agent.phone, secret, code, now.getTime());
  if (step === null) return registerFailure(challenge, now);
  try {
    const claimed = await prisma.assistantStepUpChallenge.updateMany({
      where: { id: challenge.id, status: "PENDING", expiresAt: { gt: now } },
      data: { status: "PASSED", closedAt: now, usedStep: step },
    });
    if (claimed.count === 0) return { kind: "gone" };
  } catch (err) {
    // Шаг уже занят этим сотрудником — тот же код второй раз. Не ошибка: ждём следующий.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { kind: "replay", message: TEXT.replay[challenge.language] };
    }
    throw err;
  }
  logAgentAudit(challenge.agentId, "ASSISTANT_TOTP_PASSED", "Agent", challenge.agentId, { source: "assistant", bundleId: challenge.bundleId, kind: challenge.kind });
  return { kind: "passed" };
}

/** Чистка (jobs/assistantActionsSweep.ts): ожидания старше суток не нужны ни блокировке, ни следу. */
export async function sweepStepUpChallenges(now = new Date()): Promise<number> {
  const deleted = await prisma.assistantStepUpChallenge.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - STEP_UP_RETENTION_MS) } },
  });
  return deleted.count;
}
